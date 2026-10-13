import { createCipheriv, createDecipheriv, createHash, createHmac, getDiffieHellman, randomBytes, type DiffieHellmanGroup } from 'node:crypto';

/*
 * Criptografia do IKEv1 (RFC 2409): PRF/HMAC, SKEYID com chave compartilhada, expansão de
 * chaves (apêndice B), cifra CBC com o encadeamento de IV da fase 1/fase 2 e grupos MODP.
 */

export type HashName = 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512';
export type CipherName = 'aes' | '3des' | 'des';

/** Valores do atributo "Hash Algorithm" (fase 1) e "Authentication Algorithm" (fase 2). */
export const PHASE1_HASH: Record<HashName, number> = { md5: 1, sha1: 2, sha256: 4, sha384: 5, sha512: 6 };
export const PHASE2_AUTH: Record<HashName, number> = { md5: 1, sha1: 2, sha256: 5, sha384: 6, sha512: 7 };
export const PHASE1_CIPHER: Record<CipherName, number> = { des: 1, '3des': 5, aes: 7 };
export const ESP_TRANSFORM: Record<CipherName, number> = { des: 2, '3des': 3, aes: 12 };

/** Grupos MODP do OpenSSL/Node. */
const MODP: Record<number, string> = { 1: 'modp1', 2: 'modp2', 5: 'modp5', 14: 'modp14', 15: 'modp15', 16: 'modp16', 17: 'modp17', 18: 'modp18' };

export function dhGroup(group: number): DiffieHellmanGroup {
  const name = MODP[group];
  if (!name) throw new Error(`grupo DH ${group} não suportado`);
  const dh = getDiffieHellman(name);
  dh.generateKeys();
  return dh;
}

/** Valor público com o tamanho exato do primo (zeros à esquerda). */
export function dhPublic(dh: DiffieHellmanGroup): Buffer {
  const prime = dh.getPrime().length;
  const pub = dh.getPublicKey();
  return pub.length === prime ? pub : Buffer.concat([Buffer.alloc(prime - pub.length), pub]);
}

export function dhSecret(dh: DiffieHellmanGroup, peer: Buffer): Buffer {
  const prime = dh.getPrime().length;
  if (peer.length !== prime) throw new Error('valor público DH com tamanho inválido');
  const s = dh.computeSecret(peer);
  return s.length === prime ? s : Buffer.concat([Buffer.alloc(prime - s.length), s]);
}

export const prf = (hash: HashName, key: Buffer, ...data: Buffer[]) => {
  const h = createHmac(hash, key);
  for (const d of data) h.update(d);
  return h.digest();
};

export const digest = (hash: HashName, ...data: Buffer[]) => {
  const h = createHash(hash);
  for (const d of data) h.update(d);
  return h.digest();
};

/** Expande material de chave: K1 = prf(K, 0), Kn = prf(K, Kn-1) (apêndice B). */
export function expandKey(hash: HashName, skeyidE: Buffer, length: number): Buffer {
  if (skeyidE.length >= length) return Buffer.from(skeyidE.subarray(0, length));
  const parts: Buffer[] = [];
  let k = prf(hash, skeyidE, Buffer.from([0]));
  parts.push(k);
  while (Buffer.concat(parts).length < length) {
    k = prf(hash, skeyidE, k);
    parts.push(k);
  }
  return Buffer.concat(parts).subarray(0, length);
}

export interface Phase1Keys {
  skeyid: Buffer;
  d: Buffer;
  a: Buffer;
  e: Buffer;
  /** Chave da cifra já expandida no tamanho certo. */
  encKey: Buffer;
}

/** SKEYID com chave compartilhada: prf(PSK, Ni | Nr) e as derivadas d, a, e. */
export function phase1Keys(opts: {
  hash: HashName;
  psk: Buffer;
  ni: Buffer;
  nr: Buffer;
  gxy: Buffer;
  icookie: Buffer;
  rcookie: Buffer;
  keyLength: number;
}): Phase1Keys {
  const { hash, gxy, icookie, rcookie } = opts;
  const skeyid = prf(hash, opts.psk, opts.ni, opts.nr);
  const d = prf(hash, skeyid, gxy, icookie, rcookie, Buffer.from([0]));
  const a = prf(hash, skeyid, d, gxy, icookie, rcookie, Buffer.from([1]));
  const e = prf(hash, skeyid, a, gxy, icookie, rcookie, Buffer.from([2]));
  return { skeyid, d, a, e, encKey: expandKey(hash, e, opts.keyLength) };
}

export function blockSize(cipher: CipherName): number {
  return cipher === 'aes' ? 16 : 8;
}

function cipherName(cipher: CipherName, keyLength: number): string {
  if (cipher === 'aes') return `aes-${keyLength * 8}-cbc`;
  return cipher === '3des' ? 'des-ede3-cbc' : 'des-cbc';
}

/** Tamanho da chave em bytes (AES conforme o atributo, 3DES 24, DES 8). */
export function cipherKeyLength(cipher: CipherName, aesBits = 128): number {
  if (cipher === 'aes') return aesBits / 8;
  return cipher === '3des' ? 24 : 8;
}

/** CBC sem preenchimento automático: o IKE completa com zeros até o bloco. */
export function encrypt(cipher: CipherName, key: Buffer, iv: Buffer, plain: Buffer): Buffer {
  const bs = blockSize(cipher);
  const pad = (bs - (plain.length % bs)) % bs;
  const c = createCipheriv(cipherName(cipher, key.length), key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.concat([plain, Buffer.alloc(pad)])), c.final()]);
}

export function decrypt(cipher: CipherName, key: Buffer, iv: Buffer, data: Buffer): Buffer {
  if (data.length % blockSize(cipher) !== 0) throw new Error('mensagem cifrada com tamanho inválido');
  const d = createDecipheriv(cipherName(cipher, key.length), key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

/** IV de um novo exchange depois da fase 1: hash(último bloco da fase 1 | M-ID). */
export function exchangeIv(hash: HashName, cipher: CipherName, lastPhase1Block: Buffer, messageId: number): Buffer {
  const mid = Buffer.alloc(4);
  mid.writeUInt32BE(messageId >>> 0, 0);
  return digest(hash, lastPhase1Block, mid).subarray(0, blockSize(cipher));
}

/** Material de chave da fase 2 (RFC 2409 5.5), expandido até `length` bytes. */
export function keymat(opts: {
  hash: HashName;
  skeyidD: Buffer;
  gxy?: Buffer;
  protocol: number;
  spi: Buffer;
  ni: Buffer;
  nr: Buffer;
  length: number;
}): Buffer {
  const seed = [...(opts.gxy ? [opts.gxy] : []), Buffer.from([opts.protocol]), opts.spi, opts.ni, opts.nr];
  const parts: Buffer[] = [prf(opts.hash, opts.skeyidD, ...seed)];
  while (Buffer.concat(parts).length < opts.length) parts.push(prf(opts.hash, opts.skeyidD, parts[parts.length - 1], ...seed));
  return Buffer.concat(parts).subarray(0, opts.length);
}

export const randomMessageId = () => randomBytes(4).readUInt32BE(0) || 1;

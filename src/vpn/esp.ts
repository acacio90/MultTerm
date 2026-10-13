import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EspKeys } from './ike/client.ts';
import type { HashName } from './ike/crypto.ts';

/*
 * ESP em modo túnel (RFC 4303) encapsulado em UDP (RFC 3948): o pacote UDP leva
 * SPI | seq | IV | E(IP interno | preenchimento | tam. preenchimento | próximo cabeçalho) | ICV.
 * HMAC truncado na metade (SHA-2, RFC 4868) ou em 96 bits (MD5/SHA-1, RFC 2403/2404).
 */

const ICV: Record<HashName, number> = { md5: 12, sha1: 12, sha256: 16, sha384: 24, sha512: 32 };
const NEXT_IPV4 = 4;
const WINDOW = 64;

function cipherAlgo(k: EspKeys): { name: string; block: number } {
  if (k.cipher === 'aes') return { name: `aes-${k.encKey.length * 8}-cbc`, block: 16 };
  return k.cipher === '3des' ? { name: 'des-ede3-cbc', block: 8 } : { name: 'des-cbc', block: 8 };
}

/** Lado de saída: cifra pacotes IP para o gateway. */
export class EspEncrypt {
  private seq = 0;
  readonly keys: EspKeys;

  constructor(keys: EspKeys) {
    this.keys = keys;
  }

  encapsulate(ip: Buffer): Buffer {
    const { name, block } = cipherAlgo(this.keys);
    // Preenchimento 1, 2, 3...: o total (dados + 2) fica múltiplo do bloco.
    const padLen = (block - ((ip.length + 2) % block)) % block;
    const pad = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));
    const trailer = Buffer.from([padLen, NEXT_IPV4]);
    const iv = randomBytes(block);
    const c = createCipheriv(name, this.keys.encKey, iv);
    c.setAutoPadding(false);
    const enc = Buffer.concat([c.update(Buffer.concat([ip, pad, trailer])), c.final()]);
    this.seq = (this.seq + 1) >>> 0;
    if (this.seq === 0) throw new Error('número de sequência ESP esgotado: renegocie a SA');
    const head = Buffer.alloc(8);
    this.keys.spi.copy(head, 0);
    head.writeUInt32BE(this.seq, 4);
    const signed = Buffer.concat([head, iv, enc]);
    const icv = createHmac(this.keys.hash, this.keys.authKey).update(signed).digest().subarray(0, ICV[this.keys.hash]);
    return Buffer.concat([signed, icv]);
  }
}

/** Lado de entrada: confere ICV e anti-replay, decifra e devolve o pacote IP interno. */
export class EspDecrypt {
  private highest = 0;
  private bitmap = 0n;
  readonly keys: EspKeys;

  constructor(keys: EspKeys) {
    this.keys = keys;
  }

  /** Pacote não é desta SA (SPI diferente). */
  matches(packet: Buffer): boolean {
    return packet.length >= 8 && packet.subarray(0, 4).equals(this.keys.spi);
  }

  decapsulate(packet: Buffer): Buffer {
    const { name, block } = cipherAlgo(this.keys);
    const icvLen = ICV[this.keys.hash];
    if (packet.length < 8 + block + block + icvLen) throw new Error('pacote ESP curto demais');
    if (!this.matches(packet)) throw new Error('SPI desconhecido');
    const seq = packet.readUInt32BE(4);
    if (!this.replayOk(seq)) throw new Error('pacote ESP repetido ou antigo');
    const signed = packet.subarray(0, packet.length - icvLen);
    const icv = packet.subarray(packet.length - icvLen);
    const expected = createHmac(this.keys.hash, this.keys.authKey).update(signed).digest().subarray(0, icvLen);
    if (!timingSafeEqual(expected, icv)) throw new Error('ICV do ESP inválido');
    const iv = signed.subarray(8, 8 + block);
    const body = signed.subarray(8 + block);
    if (body.length % block !== 0) throw new Error('ESP com tamanho inválido');
    const d = createDecipheriv(name, this.keys.encKey, iv);
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(body), d.final()]);
    const padLen = plain[plain.length - 2];
    const next = plain[plain.length - 1];
    if (padLen + 2 > plain.length) throw new Error('preenchimento ESP inválido');
    this.accept(seq);
    if (next !== NEXT_IPV4) throw new Error(`ESP com próximo cabeçalho ${next} (só IPv4)`);
    return plain.subarray(0, plain.length - 2 - padLen);
  }

  /** Janela anti-replay de 64 pacotes (RFC 4303 3.4.3). */
  private replayOk(seq: number): boolean {
    if (seq === 0) return false;
    if (seq > this.highest) return true;
    const diff = this.highest - seq;
    if (diff >= WINDOW) return false;
    return (this.bitmap & (1n << BigInt(diff))) === 0n;
  }

  private accept(seq: number) {
    if (seq > this.highest) {
      const shift = seq - this.highest;
      this.bitmap = shift >= WINDOW ? 1n : ((this.bitmap << BigInt(shift)) | 1n) & ((1n << BigInt(WINDOW)) - 1n);
      this.highest = seq;
    } else this.bitmap |= 1n << BigInt(this.highest - seq);
  }
}

// ---------- IPv4 (usado nos testes e no diagnóstico) ----------

export function ipChecksum(b: Buffer): number {
  let sum = 0;
  for (let i = 0; i + 1 < b.length; i += 2) sum += b.readUInt16BE(i);
  if (b.length % 2) sum += b[b.length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/** Pacote IPv4 com ICMP echo request. */
export function icmpEcho(src: string, dst: string, id: number, seq: number, data = Buffer.from('MultTerm')): Buffer {
  const icmp = Buffer.alloc(8 + data.length);
  icmp[0] = 8;
  icmp.writeUInt16BE(id, 4);
  icmp.writeUInt16BE(seq, 6);
  data.copy(icmp, 8);
  icmp.writeUInt16BE(ipChecksum(icmp), 2);
  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(20 + icmp.length, 2);
  ip.writeUInt16BE(id, 4);
  ip[8] = 64;
  ip[9] = 1;
  Buffer.from(src.split('.').map(Number)).copy(ip, 12);
  Buffer.from(dst.split('.').map(Number)).copy(ip, 16);
  ip.writeUInt16BE(ipChecksum(ip), 10);
  return Buffer.concat([ip, icmp]);
}

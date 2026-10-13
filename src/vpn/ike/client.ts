import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  attrNumber, CfgType, decodeCfg, decodeDelete, decodeHeader, decodeId, decodeNotify, decodePayloads, decodeSA, encodeCfg,
  encodeDelete, encodeHeader, encodeId, encodeNotify, encodePayloads, encodeSA, ExchangeType, Flag, HEADER_LENGTH, IdType,
  ipv4, ipv4String, Payload, Protocol, type Attribute, type Proposal, type RawPayload, type Transform,
} from './packet.ts';
import {
  blockSize, cipherKeyLength, decrypt, dhGroup, dhPublic, dhSecret, digest, encrypt, ESP_TRANSFORM, exchangeIv, keymat,
  PHASE1_CIPHER, PHASE1_HASH, PHASE2_AUTH, phase1Keys, prf, randomMessageId, type CipherName, type HashName, type Phase1Keys,
} from './crypto.ts';

/*
 * Cliente IKEv1 (iniciador): Main Mode com chave compartilhada (+ XAuth), Mode Config pull,
 * Quick Mode com PFS e NAT-T (RFC 3947, ESP em UDP 4500). O plano de dados (ESP) fica em
 * ../esp.ts; aqui só se negociam as SAs e se entregam as chaves.
 */

const VID = {
  natt: Buffer.from('4a131c81070358455c5728f20e95452f', 'hex'), // RFC 3947
  xauth: Buffer.from('09002689dfd6b712', 'hex'),
  dpd: Buffer.from('afcad71368a1f1c96b8696fc77570100', 'hex'),
  unity: Buffer.from('12f5f28c457168a9702d9fe274cc0100', 'hex'),
};

const P1Attr = { Cipher: 1, Hash: 2, Auth: 3, Group: 4, LifeType: 11, LifeDuration: 12, KeyLength: 14 } as const;
const P2Attr = { LifeType: 1, LifeDuration: 2, Group: 3, Encap: 4, Auth: 5, KeyLength: 6 } as const;
const AUTH_PSK = 1;
const AUTH_XAUTH_PSK = 65001;
const ENCAP_UDP_TUNNEL = 3; // RFC 3947

const Cfg = {
  IP4Address: 1, IP4Netmask: 2, IP4Dns: 3, IP4Nbns: 4,
  XauthType: 16520, XauthUser: 16521, XauthPassword: 16522, XauthMessage: 16526, XauthStatus: 16527,
  UnityBanner: 28672, UnityDefDomain: 28674, UnitySplitDns: 28675, UnitySplitInclude: 28676,
} as const;

const Notify = { NoProposal: 14, AuthFailed: 24, RUThere: 36136, RUThereAck: 36137, InitialContact: 24578 } as const;

export interface Phase1Proposal {
  cipher: CipherName;
  /** Bits da chave AES (ignorado nas outras cifras). */
  keyBits?: number;
  hash: HashName;
}

export interface IkeConfig {
  host: string;
  ikePort?: number;
  nattPort?: number;
  psk: Buffer;
  user?: string;
  password?: string;
  xauth: boolean;
  dhGroup: number;
  phase1: Phase1Proposal[];
  phase1Life?: number;
  phase2: Phase1Proposal[];
  /** Grupo PFS (0 = sem PFS). */
  pfsGroup: number;
  phase2Life?: number;
  /** Identificação local (padrão: endereço IP local). */
  localId?: { type: number; data: Buffer };
  /** Pede IP/DNS/redes ao gateway. */
  modeConfig: boolean;
  timeoutMs?: number;
}

export interface ModeConfig {
  address?: string;
  netmask?: string;
  dns: string[];
  domain?: string;
  banner?: string;
  /** Redes enviadas pelo gateway (Unity split include), em CIDR. */
  networks: string[];
}

export interface EspKeys {
  spi: Buffer;
  cipher: CipherName;
  encKey: Buffer;
  hash: HashName;
  authKey: Buffer;
}

export interface ChildSa {
  network: string;
  inbound: EspKeys;
  outbound: EspKeys;
  lifetime: number;
}

interface Inbound {
  exchange: number;
  messageId: number;
  payloads: RawPayload[];
  /** Bytes depois do HASH (para conferir), quando o primeiro payload é HASH. */
  afterHash?: Buffer;
  hash?: Buffer;
}

const HASH_LEN: Record<HashName, number> = { md5: 16, sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
const ICV_KEY: Record<HashName, number> = HASH_LEN;

export class IkeError extends Error {}

export class IkeClient extends EventEmitter {
  private readonly cfg: Required<Pick<IkeConfig, 'ikePort' | 'nattPort' | 'timeoutMs' | 'phase1Life' | 'phase2Life'>> & IkeConfig;
  private sock?: Socket;
  private serverIp = '';
  /** IP local da rota até o gateway (vai no ID da fase 1). */
  private localIp = '0.0.0.0';
  private natt = false;
  private floated = false;
  private icookie = randomBytes(8);
  private rcookie: Buffer = Buffer.alloc(8);
  private hash: HashName = 'sha1';
  private cipher: CipherName = 'aes';
  private keys?: Phase1Keys;
  private lastP1Block = Buffer.alloc(0);
  private ivs = new Map<number, Buffer>();
  private inbox: Inbound[] = [];
  private waiters: { match: (m: Inbound) => boolean; resolve: (m: Inbound) => void }[] = [];
  private phase1Waiter?: (msg: Buffer) => void;
  private failure?: (err: Error) => void;
  private children: ChildSa[] = [];
  private closed = false;
  private keepalive?: NodeJS.Timeout;
  /** Pacotes ESP recebidos (UDP 4500 sem o marcador não-ESP). */
  onEsp?: (packet: Buffer) => void;
  peerVendor = { natt: false, xauth: false, dpd: false, unity: false };

  constructor(cfg: IkeConfig) {
    super();
    this.cfg = { ikePort: 500, nattPort: 4500, timeoutMs: 10_000, phase1Life: 86400, phase2Life: 28800, ...cfg };
  }

  private log(msg: string) {
    this.emit('log', msg);
  }

  // ---------- transporte ----------

  private async open() {
    this.serverIp = /^\d+\.\d+\.\d+\.\d+$/.test(this.cfg.host) ? this.cfg.host : (await lookup(this.cfg.host, { family: 4 })).address;
    const sock = createSocket('udp4');
    this.sock = sock;
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(0, () => {
        sock.off('error', reject);
        resolve();
      });
    });
    sock.on('message', (msg, rinfo) => this.receive(msg, rinfo.port));
    this.localIp = await new Promise<string>((resolve) => {
      const probe = createSocket('udp4');
      probe.connect(this.cfg.ikePort, this.serverIp, () => {
        const a = probe.address().address;
        probe.close();
        resolve(a);
      });
      probe.on('error', () => resolve('0.0.0.0'));
    });
    sock.on('error', (err) => this.fail(new IkeError(`erro no socket UDP: ${err.message}`)));
  }

  private sendRaw(packet: Buffer) {
    if (this.closed || !this.sock) return;
    if (this.floated) this.sock.send(Buffer.concat([Buffer.alloc(4), packet]), this.cfg.nattPort, this.serverIp);
    else this.sock.send(packet, this.cfg.ikePort, this.serverIp);
  }

  /** ESP já encapsulado (SPI na frente) para a porta NAT-T. */
  sendEsp(packet: Buffer) {
    if (!this.closed && this.sock) this.sock.send(packet, this.cfg.nattPort, this.serverIp);
  }

  private receive(msg: Buffer, port: number) {
    let ike = msg;
    if (port === this.cfg.nattPort) {
      if (msg.length === 1 && msg[0] === 0xff) return; // keep-alive NAT-T
      if (msg.length >= 4 && msg.readUInt32BE(0) === 0) ike = msg.subarray(4);
      else {
        this.onEsp?.(msg);
        return;
      }
    }
    if (ike.length < HEADER_LENGTH) return;
    try {
      this.handleIke(ike);
    } catch (err) {
      this.log(`mensagem descartada: ${(err as Error).message}`);
    }
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.failure?.(err);
    this.emit('error', err);
  }

  /** Envia e espera a resposta, retransmitindo; o primeiro erro fatal cancela. */
  private exchange<T>(send: () => void, wait: Promise<T>): Promise<T> {
    let tries = 0;
    send();
    const timer = setInterval(() => {
      if (++tries > 4) return;
      this.log('retransmitindo…');
      send();
    }, 2000);
    return this.withTimeout(wait).finally(() => clearInterval(timer));
  }

  private withTimeout<T>(p: Promise<T>, ms = this.cfg.timeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new IkeError('o gateway não respondeu (tempo esgotado)')), ms);
      this.failure = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      p.then((v) => {
        clearTimeout(timer);
        resolve(v);
      }, (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // ---------- recepção ----------

  private handleIke(msg: Buffer) {
    const h = decodeHeader(msg);
    if (!h.icookie.equals(this.icookie)) return;
    // Notificação em claro durante a fase 1 (proposta recusada, autenticação...).
    if (h.exchange === ExchangeType.Informational && !(h.flags & Flag.Encryption)) {
      for (const p of decodePayloads(h.next, msg.subarray(HEADER_LENGTH, h.length))) {
        if (p.type === Payload.Notify) this.notifyError(decodeNotify(p.body).type);
      }
      return;
    }
    if (!this.keys) {
      this.phase1Waiter?.(msg);
      return;
    }
    if (h.exchange === ExchangeType.Main) {
      this.phase1Waiter?.(msg);
      return;
    }
    if (!(h.flags & Flag.Encryption)) throw new Error('mensagem sem cifra depois da fase 1');
    const body = msg.subarray(HEADER_LENGTH, h.length);
    const iv = this.ivs.get(h.messageId) ?? exchangeIv(this.hash, this.cipher, this.lastP1Block, h.messageId);
    const plain = decrypt(this.cipher, this.keys.encKey, iv, body);
    this.ivs.set(h.messageId, body.subarray(body.length - blockSize(this.cipher)));
    const payloads = decodePayloads(h.next, plain);
    const m: Inbound = { exchange: h.exchange, messageId: h.messageId, payloads };
    if (payloads[0]?.type === Payload.Hash) {
      const chainEnd = payloads.reduce((n, p) => n + 4 + p.body.length, 0);
      m.hash = payloads[0].body;
      m.afterHash = plain.subarray(4 + payloads[0].body.length, chainEnd);
    }
    if (h.exchange === ExchangeType.Informational) {
      this.handleInformational(m);
      return;
    }
    const w = this.waiters.findIndex((x) => x.match(m));
    if (w >= 0) this.waiters.splice(w, 1)[0].resolve(m);
    else this.inbox.push(m);
  }

  private next(match: (m: Inbound) => boolean): Promise<Inbound> {
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  private notifyError(type: number) {
    const msg = type === Notify.NoProposal ? 'o gateway recusou as propostas de criptografia (fase 1/2 não confere)'
      : type === Notify.AuthFailed ? 'falha de autenticação (chave compartilhada ou identificação não confere)'
        : type < 8192 ? `o gateway recusou a negociação (notificação ${type})` : undefined;
    if (msg) this.fail(new IkeError(msg));
  }

  private checkHash(m: Inbound, ...prefix: Buffer[]) {
    if (!m.hash || !m.afterHash) throw new IkeError('mensagem sem HASH');
    const mid = Buffer.alloc(4);
    mid.writeUInt32BE(m.messageId >>> 0, 0);
    const expected = prf(this.hash, this.keys!.a, mid, ...prefix, m.afterHash);
    if (expected.length !== m.hash.length || !timingSafeEqual(expected, m.hash)) throw new IkeError('HASH inválido na mensagem do gateway');
  }

  private handleInformational(m: Inbound) {
    try {
      this.checkHash(m);
    } catch (err) {
      this.log((err as Error).message);
      return;
    }
    for (const p of m.payloads.slice(1)) {
      if (p.type === Payload.Notify) {
        const n = decodeNotify(p.body);
        if (n.type === Notify.RUThere) {
          this.sendInformational([{ type: Payload.Notify, body: encodeNotify({ ...n, type: Notify.RUThereAck }) }]);
        } else if (n.type === Notify.RUThereAck) {
          this.dpdAck?.(n.data.length >= 4 ? n.data.readUInt32BE(0) : -1);
        } else this.notifyError(n.type);
      } else if (p.type === Payload.Delete) {
        const d = decodeDelete(p.body);
        if (d.protocol === Protocol.ISAKMP) {
          this.log('o gateway encerrou a conexão');
          this.emit('closed', 'o gateway encerrou a conexão');
          this.close(false);
        } else {
          for (const spi of d.spis) {
            const child = this.children.find((c) => c.outbound.spi.equals(spi));
            if (child) this.emit('child-deleted', child);
          }
        }
      }
    }
  }

  // ---------- envio cifrado depois da fase 1 ----------

  private sendEncrypted(exchange: number, messageId: number, payloads: RawPayload[], hashPrefix: Buffer[] = [], hashOnly = false) {
    const [, rest] = encodePayloads(payloads);
    const mid = Buffer.alloc(4);
    mid.writeUInt32BE(messageId >>> 0, 0);
    const hash = hashOnly ? prf(this.hash, this.keys!.a, ...hashPrefix) : prf(this.hash, this.keys!.a, mid, ...hashPrefix, rest);
    const [first, chain] = encodePayloads([{ type: Payload.Hash, body: hash }, ...payloads]);
    const iv = this.ivs.get(messageId) ?? exchangeIv(this.hash, this.cipher, this.lastP1Block, messageId);
    const enc = encrypt(this.cipher, this.keys!.encKey, iv, chain);
    this.ivs.set(messageId, enc.subarray(enc.length - blockSize(this.cipher)));
    const header = encodeHeader({ icookie: this.icookie, rcookie: this.rcookie, next: first, exchange, flags: Flag.Encryption, messageId, length: HEADER_LENGTH + enc.length });
    const packet = Buffer.concat([header, enc]);
    this.sendRaw(packet);
    return packet;
  }

  private sendInformational(payloads: RawPayload[]) {
    const mid = randomMessageId();
    this.sendEncrypted(ExchangeType.Informational, mid, payloads);
    this.ivs.delete(mid);
  }

  // ---------- fase 1: Main Mode ----------

  private phase1Transforms(): Transform[] {
    const auth = this.cfg.xauth ? AUTH_XAUTH_PSK : AUTH_PSK;
    return this.cfg.phase1.map((p, i) => ({
      number: i + 1,
      id: 1, // KEY_IKE
      attributes: [
        { type: P1Attr.Cipher, value: PHASE1_CIPHER[p.cipher] },
        ...(p.cipher === 'aes' ? [{ type: P1Attr.KeyLength, value: p.keyBits ?? 128 }] : []),
        { type: P1Attr.Hash, value: PHASE1_HASH[p.hash] },
        { type: P1Attr.Auth, value: auth },
        { type: P1Attr.Group, value: this.cfg.dhGroup },
        { type: P1Attr.LifeType, value: 1 },
        { type: P1Attr.LifeDuration, value: this.cfg.phase1Life },
      ],
    }));
  }

  private waitPhase1(): Promise<{ header: ReturnType<typeof decodeHeader>; body: Buffer }> {
    return new Promise((resolve) => {
      this.phase1Waiter = (msg) => {
        const header = decodeHeader(msg);
        if (header.exchange !== ExchangeType.Main) return;
        this.phase1Waiter = undefined;
        resolve({ header, body: msg.subarray(HEADER_LENGTH, header.length) });
      };
    });
  }

  private natD(ip: string, port: number): Buffer {
    const p = Buffer.alloc(2);
    p.writeUInt16BE(port, 0);
    return digest(this.hash, this.icookie, this.rcookie, ipv4(ip), p);
  }

  private async mainMode(): Promise<void> {
    // MM1: SA + VIDs.
    const sa = encodeSA([{ number: 1, protocol: Protocol.ISAKMP, spi: Buffer.alloc(0), transforms: this.phase1Transforms() }]);
    const vids = [VID.natt, VID.xauth, VID.dpd, VID.unity].map((v) => ({ type: Payload.VendorID, body: v }));
    const [first1, chain1] = encodePayloads([{ type: Payload.SA, body: sa }, ...vids]);
    const mm1 = Buffer.concat([encodeHeader({ icookie: this.icookie, rcookie: this.rcookie, next: first1, exchange: ExchangeType.Main, flags: 0, messageId: 0, length: HEADER_LENGTH + chain1.length }), chain1]);
    this.log('fase 1: enviando propostas (Main Mode)');
    const mm2 = await this.exchange(() => this.sendRaw(mm1), this.waitPhase1());
    this.rcookie = mm2.header.rcookie;
    const p2 = decodePayloads(mm2.header.next, mm2.body);
    const chosen = p2.find((p) => p.type === Payload.SA);
    if (!chosen) throw new IkeError('o gateway não escolheu proposta');
    const t = decodeSA(chosen.body)[0]?.transforms[0];
    if (!t) throw new IkeError('proposta do gateway vazia');
    this.applyPhase1Choice(t.attributes);
    for (const p of p2.filter((x) => x.type === Payload.VendorID)) {
      if (p.body.equals(VID.natt)) this.peerVendor.natt = true;
      if (p.body.subarray(0, 8).equals(VID.xauth)) this.peerVendor.xauth = true;
      if (p.body.subarray(0, 14).equals(VID.dpd.subarray(0, 14))) this.peerVendor.dpd = true;
      if (p.body.subarray(0, 14).equals(VID.unity.subarray(0, 14))) this.peerVendor.unity = true;
    }
    this.natt = this.peerVendor.natt;
    this.log(`fase 1: proposta aceita (${this.cipher}, ${this.hash}, DH ${this.cfg.dhGroup})${this.natt ? ', NAT-T' : ''}`);

    // MM3: KE + Ni + NAT-D (o NAT-D local é propositalmente falso: força o NAT-T).
    const dh = dhGroup(this.cfg.dhGroup);
    const gxi = dhPublic(dh);
    const ni = randomBytes(32);
    const mm3Payloads: RawPayload[] = [{ type: Payload.KE, body: gxi }, { type: Payload.Nonce, body: ni }];
    if (this.natt) {
      mm3Payloads.push({ type: Payload.NatD, body: this.natD(this.serverIp, this.cfg.ikePort) });
      mm3Payloads.push({ type: Payload.NatD, body: randomBytes(HASH_LEN[this.hash]) });
    }
    const [first3, chain3] = encodePayloads(mm3Payloads);
    const mm3 = Buffer.concat([encodeHeader({ icookie: this.icookie, rcookie: this.rcookie, next: first3, exchange: ExchangeType.Main, flags: 0, messageId: 0, length: HEADER_LENGTH + chain3.length }), chain3]);
    const mm4 = await this.exchange(() => this.sendRaw(mm3), this.waitPhase1());
    const p4 = decodePayloads(mm4.header.next, mm4.body);
    const gxr = p4.find((p) => p.type === Payload.KE)?.body;
    const nr = p4.find((p) => p.type === Payload.Nonce)?.body;
    if (!gxr || !nr) throw new IkeError('resposta da fase 1 sem KE/nonce');
    const gxy = dhSecret(dh, gxr);
    const keyLen = cipherKeyLength(this.cipher, this.chosenKeyBits);
    this.keys = phase1Keys({ hash: this.hash, psk: this.cfg.psk, ni, nr, gxy, icookie: this.icookie, rcookie: this.rcookie, keyLength: keyLen });

    // MM5 (cifrado, já na porta NAT-T): IDii + HASH_I.
    if (this.natt) this.floated = true;
    const id = encodeId({ type: this.cfg.localId?.type ?? IdType.IPv4, protocol: 0, port: 0, data: this.cfg.localId?.data ?? ipv4(this.localIp) });
    const hashI = prf(this.hash, this.keys.skeyid, gxi, gxr, this.icookie, this.rcookie, sa, id);
    const [first5, chain5] = encodePayloads([{ type: Payload.ID, body: id }, { type: Payload.Hash, body: hashI }]);
    let iv: Buffer = digest(this.hash, gxi, gxr).subarray(0, blockSize(this.cipher));
    const enc5 = encrypt(this.cipher, this.keys.encKey, iv, chain5);
    const mm5 = Buffer.concat([encodeHeader({ icookie: this.icookie, rcookie: this.rcookie, next: first5, exchange: ExchangeType.Main, flags: Flag.Encryption, messageId: 0, length: HEADER_LENGTH + enc5.length }), enc5]);
    // Com a chave errada o gateway não consegue decifrar o MM5 e só fica em silêncio.
    const mm6 = await this.exchange(() => this.sendRaw(mm5), this.waitPhase1()).catch((err: Error) => {
      throw /tempo esgotado/.test(err.message)
        ? new IkeError('o gateway não respondeu à autenticação (chave compartilhada ou identificação errada?)')
        : err;
    });
    iv = enc5.subarray(enc5.length - blockSize(this.cipher));
    const plain6 = decrypt(this.cipher, this.keys.encKey, iv, mm6.body);
    this.lastP1Block = Buffer.from(mm6.body.subarray(mm6.body.length - blockSize(this.cipher)));
    const p6 = decodePayloads(mm6.header.next, plain6);
    const idr = p6.find((p) => p.type === Payload.ID)?.body;
    const hashR = p6.find((p) => p.type === Payload.Hash)?.body;
    if (!idr || !hashR) throw new IkeError('resposta final da fase 1 incompleta');
    const expected = prf(this.hash, this.keys.skeyid, gxr, gxi, this.rcookie, this.icookie, sa, idr);
    if (expected.length !== hashR.length || !timingSafeEqual(expected, hashR)) {
      throw new IkeError('falha de autenticação do gateway (chave compartilhada não confere)');
    }
    this.log(`fase 1 estabelecida com ${ipv4String(decodeId(idr).data)}`);
    if (this.natt) {
      this.keepalive = setInterval(() => this.sock?.send(Buffer.from([0xff]), this.cfg.nattPort, this.serverIp), 20_000);
      this.keepalive.unref();
    }
  }

  private chosenKeyBits = 128;

  private applyPhase1Choice(attrs: Attribute[]) {
    const get = (t: number) => attrNumber(attrs.find((a) => a.type === t));
    const cipher = Object.entries(PHASE1_CIPHER).find(([, v]) => v === get(P1Attr.Cipher))?.[0] as CipherName | undefined;
    const hash = Object.entries(PHASE1_HASH).find(([, v]) => v === get(P1Attr.Hash))?.[0] as HashName | undefined;
    if (!cipher || !hash) throw new IkeError('o gateway escolheu algoritmos não suportados');
    this.cipher = cipher;
    this.hash = hash;
    this.chosenKeyBits = get(P1Attr.KeyLength) ?? 128;
    if (get(P1Attr.Group) !== this.cfg.dhGroup) throw new IkeError('o gateway escolheu outro grupo DH');
  }

  // ---------- XAuth e Mode Config (exchange Transaction) ----------

  private async xauth(): Promise<void> {
    for (;;) {
      const m = await this.withTimeout(this.next((x) => x.exchange === ExchangeType.Transaction), 30_000);
      this.checkHash(m);
      const cfg = decodeCfg(m.payloads.find((p) => p.type === Payload.Attr)!.body);
      if (cfg.type === CfgType.Request) {
        const asks = new Set(cfg.attributes.map((a) => a.type));
        const msg = cfg.attributes.find((a) => a.type === Cfg.XauthMessage);
        if (msg && Buffer.isBuffer(msg.value)) this.log(`gateway: ${msg.value.toString('utf8')}`);
        if (!this.cfg.user || !this.cfg.password) throw new IkeError('o gateway pede usuário e senha (XAuth)');
        const reply: Attribute[] = [];
        if (asks.has(Cfg.XauthType)) reply.push({ type: Cfg.XauthType, value: 0 });
        if (asks.has(Cfg.XauthUser)) reply.push({ type: Cfg.XauthUser, value: Buffer.from(this.cfg.user, 'utf8') });
        if (asks.has(Cfg.XauthPassword)) reply.push({ type: Cfg.XauthPassword, value: Buffer.from(this.cfg.password, 'utf8') });
        this.log('XAuth: enviando usuário e senha');
        this.sendEncrypted(ExchangeType.Transaction, m.messageId, [{ type: Payload.Attr, body: encodeCfg({ type: CfgType.Reply, identifier: cfg.identifier, attributes: reply }) }]);
      } else if (cfg.type === CfgType.Set) {
        const status = attrNumber(cfg.attributes.find((a) => a.type === Cfg.XauthStatus));
        this.sendEncrypted(ExchangeType.Transaction, m.messageId, [{ type: Payload.Attr, body: encodeCfg({ type: CfgType.Ack, identifier: cfg.identifier, attributes: [{ type: Cfg.XauthStatus, value: status ?? 0 }] }) }]);
        this.ivs.delete(m.messageId);
        if (status !== 1) throw new IkeError('usuário ou senha recusados pelo gateway');
        this.log('XAuth: usuário autenticado');
        return;
      }
    }
  }

  private async modeConfig(): Promise<ModeConfig> {
    const mid = randomMessageId();
    const identifier = randomBytes(2).readUInt16BE(0);
    const ask = [Cfg.IP4Address, Cfg.IP4Netmask, Cfg.IP4Dns, Cfg.UnitySplitInclude, Cfg.UnityDefDomain, Cfg.UnityBanner]
      .map((type) => ({ type, value: Buffer.alloc(0) }));
    const payloads = [{ type: Payload.Attr, body: encodeCfg({ type: CfgType.Request, identifier, attributes: ask }) }];
    let packet: Buffer | undefined;
    this.log('Mode Config: pedindo endereço, DNS e redes');
    const m = await this.exchange(
      () => {
        if (packet) this.sendRaw(packet);
        else packet = this.sendEncrypted(ExchangeType.Transaction, mid, payloads);
      },
      this.next((x) => x.exchange === ExchangeType.Transaction && x.messageId === mid),
    );
    this.checkHash(m);
    this.ivs.delete(mid);
    const cfg = decodeCfg(m.payloads.find((p) => p.type === Payload.Attr)!.body);
    const out: ModeConfig = { dns: [], networks: [] };
    for (const a of cfg.attributes) {
      if (!Buffer.isBuffer(a.value)) continue;
      if (a.type === Cfg.IP4Address && a.value.length === 4) out.address = ipv4String(a.value);
      else if (a.type === Cfg.IP4Netmask && a.value.length === 4) out.netmask = ipv4String(a.value);
      else if (a.type === Cfg.IP4Dns && a.value.length === 4) out.dns.push(ipv4String(a.value));
      else if (a.type === Cfg.UnityDefDomain) out.domain = a.value.toString('utf8');
      else if (a.type === Cfg.UnityBanner) out.banner = a.value.toString('utf8');
      else if (a.type === Cfg.UnitySplitInclude) {
        for (let o = 0; o + 8 <= a.value.length; o += 14) {
          const mask = a.value.readUInt32BE(o + 4);
          const bits = mask === 0 ? 0 : 32 - Math.log2((~mask >>> 0) + 1);
          out.networks.push(`${ipv4String(a.value.subarray(o, o + 4))}/${bits}`);
        }
      }
    }
    if (!out.address) throw new IkeError('o gateway não enviou um endereço (Mode Config)');
    this.log(`Mode Config: endereço ${out.address}${out.dns.length ? `, DNS ${out.dns.join(' ')}` : ''}${out.networks.length ? `, redes ${out.networks.join(' ')}` : ''}`);
    return out;
  }

  // ---------- fase 2: Quick Mode ----------

  async quickMode(localAddress: string, network: string): Promise<ChildSa> {
    const [net, bitsText] = network.split('/');
    const bits = Number(bitsText);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const maskBuf = Buffer.alloc(4);
    maskBuf.writeUInt32BE(mask, 0);
    const spi = randomBytes(4);
    const pfs = this.cfg.pfsGroup ? dhGroup(this.cfg.pfsGroup) : undefined;
    const transforms: Transform[] = this.cfg.phase2.map((p, i) => ({
      number: i + 1,
      id: ESP_TRANSFORM[p.cipher],
      attributes: [
        { type: P2Attr.LifeType, value: 1 },
        { type: P2Attr.LifeDuration, value: this.cfg.phase2Life },
        ...(pfs ? [{ type: P2Attr.Group, value: this.cfg.pfsGroup }] : []),
        { type: P2Attr.Encap, value: this.natt ? ENCAP_UDP_TUNNEL : 1 },
        { type: P2Attr.Auth, value: PHASE2_AUTH[p.hash] },
        ...(p.cipher === 'aes' ? [{ type: P2Attr.KeyLength, value: p.keyBits ?? 128 }] : []),
      ],
    }));
    const sa = encodeSA([{ number: 1, protocol: Protocol.ESP, spi, transforms }]);
    const ni = randomBytes(32);
    const idci = encodeId({ type: IdType.IPv4, protocol: 0, port: 0, data: ipv4(localAddress) });
    const idcr = encodeId({ type: IdType.IPv4Subnet, protocol: 0, port: 0, data: Buffer.concat([ipv4(net), maskBuf]) });
    const payloads: RawPayload[] = [
      { type: Payload.SA, body: sa }, { type: Payload.Nonce, body: ni },
      ...(pfs ? [{ type: Payload.KE, body: dhPublic(pfs) }] : []),
      { type: Payload.ID, body: idci }, { type: Payload.ID, body: idcr },
    ];
    const mid = randomMessageId();
    let packet: Buffer | undefined;
    this.log(`fase 2: negociando ${network}`);
    const m = await this.exchange(
      () => {
        if (packet) this.sendRaw(packet);
        else packet = this.sendEncrypted(ExchangeType.Quick, mid, payloads);
      },
      this.next((x) => x.exchange === ExchangeType.Quick && x.messageId === mid),
    );
    this.checkHash(m, ni);
    const nr = m.payloads.find((p) => p.type === Payload.Nonce)?.body;
    const saR = m.payloads.find((p) => p.type === Payload.SA)?.body;
    if (!nr || !saR) throw new IkeError('resposta da fase 2 incompleta');
    const prop: Proposal = decodeSA(saR)[0];
    const t = prop?.transforms[0];
    if (!prop || prop.protocol !== Protocol.ESP || prop.spi.length !== 4 || !t) throw new IkeError('o gateway respondeu uma fase 2 inválida');
    const get = (k: number) => attrNumber(t.attributes.find((a) => a.type === k));
    const cipher = Object.entries(ESP_TRANSFORM).find(([, v]) => v === t.id)?.[0] as CipherName | undefined;
    const hash = Object.entries(PHASE2_AUTH).find(([, v]) => v === get(P2Attr.Auth))?.[0] as HashName | undefined;
    if (!cipher || !hash) throw new IkeError('o gateway escolheu algoritmos de fase 2 não suportados');
    let gxy: Buffer | undefined;
    if (pfs) {
      const ke = m.payloads.find((p) => p.type === Payload.KE)?.body;
      if (!ke) throw new IkeError('o gateway não enviou o KE do PFS');
      gxy = dhSecret(pfs, ke);
    }
    // HASH(3) = prf(SKEYID_a, 0 | M-ID | Ni | Nr).
    const midBuf = Buffer.alloc(4);
    midBuf.writeUInt32BE(mid, 0);
    this.sendEncrypted(ExchangeType.Quick, mid, [], [Buffer.from([0]), midBuf, ni, nr], true);
    this.ivs.delete(mid);

    const encLen = cipherKeyLength(cipher, get(P2Attr.KeyLength) ?? 128);
    const authLen = ICV_KEY[hash];
    const keys = (s: Buffer): EspKeys => {
      const k = keymat({ hash: this.hash, skeyidD: this.keys!.d, gxy, protocol: Protocol.ESP, spi: s, ni, nr, length: encLen + authLen });
      return { spi: s, cipher, encKey: k.subarray(0, encLen), hash, authKey: k.subarray(encLen) };
    };
    const child: ChildSa = { network, inbound: keys(spi), outbound: keys(prop.spi), lifetime: get(P2Attr.LifeDuration) ?? this.cfg.phase2Life };
    this.children.push(child);
    this.log(`fase 2 estabelecida para ${network} (ESP ${cipher}/${hash})`);
    return child;
  }

  // ---------- DPD e exclusão de SA ----------

  private dpdSeq = randomBytes(4).readUInt32BE(0) & 0x7fffffff;
  private dpdAck?: (seq: number) => void;

  /** Pergunta se o gateway está vivo (RFC 3706); resolve true com a resposta. */
  probe(timeoutMs = 5000): Promise<boolean> {
    if (!this.keys || this.closed) return Promise.resolve(false);
    const seq = ++this.dpdSeq >>> 0;
    const data = Buffer.alloc(4);
    data.writeUInt32BE(seq, 0);
    const notify = encodeNotify({ doi: 1, protocol: Protocol.ISAKMP, spi: Buffer.concat([this.icookie, this.rcookie]), type: Notify.RUThere, data });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.dpdAck = undefined;
        resolve(false);
      }, timeoutMs);
      this.dpdAck = (s) => {
        if (s !== seq) return;
        clearTimeout(timer);
        this.dpdAck = undefined;
        resolve(true);
      };
      this.sendInformational([{ type: Payload.Notify, body: notify }]);
    });
  }

  /** Exclui uma SA de fase 2 (depois de renovada). */
  deleteChild(child: ChildSa) {
    this.children = this.children.filter((c) => c !== child);
    if (this.keys && !this.closed) this.sendInformational([{ type: Payload.Delete, body: encodeDelete(Protocol.ESP, [child.inbound.spi]) }]);
  }

  get supportsDpd() {
    return this.peerVendor.dpd;
  }

  // ---------- ciclo de vida ----------

  /** Fase 1, XAuth e Mode Config. */
  async connect(): Promise<ModeConfig | undefined> {
    await this.open();
    try {
      await this.mainMode();
      if (this.cfg.xauth) await this.xauth();
      return this.cfg.modeConfig ? await this.modeConfig() : undefined;
    } catch (err) {
      this.close(false);
      throw err;
    }
  }

  /** Avisa o gateway (exclui as SAs) e fecha o socket. */
  close(notify = true) {
    if (this.closed) return;
    if (notify && this.keys) {
      try {
        const spis = this.children.map((c) => c.inbound.spi);
        if (spis.length) this.sendInformational([{ type: Payload.Delete, body: encodeDelete(Protocol.ESP, spis) }]);
        this.sendInformational([{ type: Payload.Delete, body: encodeDelete(Protocol.ISAKMP, [Buffer.concat([this.icookie, this.rcookie])]) }]);
      } catch { /* melhor esforço */ }
    }
    this.closed = true;
    clearInterval(this.keepalive);
    const sock = this.sock;
    setTimeout(() => sock?.close(), 50);
  }
}


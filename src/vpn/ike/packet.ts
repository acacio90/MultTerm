/*
 * Mensagens ISAKMP/IKEv1 (RFC 2408/2409): cabeçalho, payloads genéricos e atributos.
 * Só codificação e decodificação; a criptografia fica em crypto.ts.
 */

export const ExchangeType = { Main: 2, Aggressive: 4, Informational: 5, Transaction: 6, Quick: 32 } as const;
export const Flag = { Encryption: 1, Commit: 2, AuthOnly: 4 } as const;

export const Payload = {
  None: 0, SA: 1, Proposal: 2, Transform: 3, KE: 4, ID: 5, Cert: 6, CertReq: 7, Hash: 8, Sig: 9, Nonce: 10,
  Notify: 11, Delete: 12, VendorID: 13, Attr: 14, NatD: 20, NatOA: 21,
} as const;

export const HEADER_LENGTH = 28;

export interface Header {
  icookie: Buffer;
  rcookie: Buffer;
  next: number;
  version: number;
  exchange: number;
  flags: number;
  messageId: number;
  length: number;
}

export function encodeHeader(h: Omit<Header, 'version' | 'length'> & { length: number }): Buffer {
  const b = Buffer.alloc(HEADER_LENGTH);
  h.icookie.copy(b, 0);
  h.rcookie.copy(b, 8);
  b[16] = h.next;
  b[17] = 0x10; // IKEv1 (major 1, minor 0)
  b[18] = h.exchange;
  b[19] = h.flags;
  b.writeUInt32BE(h.messageId >>> 0, 20);
  b.writeUInt32BE(h.length, 24);
  return b;
}

export function decodeHeader(b: Buffer): Header {
  if (b.length < HEADER_LENGTH) throw new Error('mensagem ISAKMP curta demais');
  const length = b.readUInt32BE(24);
  if (length < HEADER_LENGTH || length > b.length) throw new Error('tamanho ISAKMP inválido');
  return {
    icookie: Buffer.from(b.subarray(0, 8)),
    rcookie: Buffer.from(b.subarray(8, 16)),
    next: b[16],
    version: b[17],
    exchange: b[18],
    flags: b[19],
    messageId: b.readUInt32BE(20),
    length,
  };
}

export interface RawPayload {
  type: number;
  /** Corpo sem o cabeçalho genérico de 4 bytes. */
  body: Buffer;
}

/** Encadeia payloads com os cabeçalhos genéricos; devolve [tipo do primeiro, bytes]. */
export function encodePayloads(payloads: RawPayload[]): [number, Buffer] {
  const parts = payloads.map((p, i) => {
    const h = Buffer.alloc(4);
    h[0] = i + 1 < payloads.length ? payloads[i + 1].type : Payload.None;
    h.writeUInt16BE(p.body.length + 4, 2);
    return Buffer.concat([h, p.body]);
  });
  return [payloads[0]?.type ?? Payload.None, Buffer.concat(parts)];
}

/** Lê a cadeia de payloads; bytes depois do último (preenchimento da cifra) são ignorados. */
export function decodePayloads(first: number, data: Buffer): RawPayload[] {
  const out: RawPayload[] = [];
  let type = first;
  let off = 0;
  while (type !== Payload.None) {
    if (off + 4 > data.length) throw new Error('payload ISAKMP truncado');
    const next = data[off];
    const len = data.readUInt16BE(off + 2);
    if (len < 4 || off + len > data.length) throw new Error('tamanho de payload ISAKMP inválido');
    out.push({ type, body: Buffer.from(data.subarray(off + 4, off + len)) });
    off += len;
    type = next;
  }
  return out;
}

/** Atributo de dados (TV quando cabe em 16 bits e não é forçado TLV). */
export interface Attribute {
  type: number;
  value: number | Buffer;
}

export function encodeAttributes(attrs: Attribute[]): Buffer {
  return Buffer.concat(attrs.map((a) => {
    if (typeof a.value === 'number' && a.value >= 0 && a.value <= 0xffff) {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(0x8000 | a.type, 0);
      b.writeUInt16BE(a.value, 2);
      return b;
    }
    let v: Buffer;
    if (typeof a.value === 'number') {
      v = Buffer.alloc(4);
      v.writeUInt32BE(a.value >>> 0, 0);
    } else v = a.value;
    const h = Buffer.alloc(4);
    h.writeUInt16BE(a.type & 0x7fff, 0);
    h.writeUInt16BE(v.length, 2);
    return Buffer.concat([h, v]);
  }));
}

export function decodeAttributes(data: Buffer): Attribute[] {
  const out: Attribute[] = [];
  let off = 0;
  while (off + 4 <= data.length) {
    const t = data.readUInt16BE(off);
    if (t & 0x8000) {
      out.push({ type: t & 0x7fff, value: data.readUInt16BE(off + 2) });
      off += 4;
    } else {
      const len = data.readUInt16BE(off + 2);
      if (off + 4 + len > data.length) throw new Error('atributo ISAKMP truncado');
      out.push({ type: t, value: Buffer.from(data.subarray(off + 4, off + 4 + len)) });
      off += 4 + len;
    }
  }
  return out;
}

/** Valor numérico de um atributo (TLV de até 4 bytes também vira número). */
export function attrNumber(a: Attribute | undefined): number | undefined {
  if (!a) return undefined;
  if (typeof a.value === 'number') return a.value;
  if (a.value.length === 0 || a.value.length > 4) return undefined;
  return a.value.readUIntBE(0, a.value.length);
}

// ---------- SA / proposta / transformação ----------

export interface Transform {
  number: number;
  id: number;
  attributes: Attribute[];
}

export interface Proposal {
  number: number;
  protocol: number;
  spi: Buffer;
  transforms: Transform[];
}

export const DOI_IPSEC = 1;
export const SIT_IDENTITY_ONLY = 1;
export const Protocol = { ISAKMP: 1, AH: 2, ESP: 3 } as const;

export function encodeSA(proposals: Proposal[]): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(DOI_IPSEC, 0);
  head.writeUInt32BE(SIT_IDENTITY_ONLY, 4);
  const props = proposals.map((p, pi) => {
    const transforms = p.transforms.map((t, ti) => {
      const attrs = encodeAttributes(t.attributes);
      const b = Buffer.alloc(8);
      b[0] = ti + 1 < p.transforms.length ? Payload.Transform : Payload.None;
      b.writeUInt16BE(8 + attrs.length, 2);
      b[4] = t.number;
      b[5] = t.id;
      return Buffer.concat([b, attrs]);
    });
    const body = Buffer.concat(transforms);
    const b = Buffer.alloc(8);
    b[0] = pi + 1 < proposals.length ? Payload.Proposal : Payload.None;
    b.writeUInt16BE(8 + p.spi.length + body.length, 2);
    b[4] = p.number;
    b[5] = p.protocol;
    b[6] = p.spi.length;
    b[7] = p.transforms.length;
    return Buffer.concat([b, p.spi, body]);
  });
  return Buffer.concat([head, ...props]);
}

export function decodeSA(body: Buffer): Proposal[] {
  if (body.length < 8) throw new Error('SA curto demais');
  if (body.readUInt32BE(0) !== DOI_IPSEC) throw new Error('DOI do SA não é IPsec');
  const out: Proposal[] = [];
  let off = 8;
  let more = body.length > off;
  while (more) {
    if (off + 8 > body.length) throw new Error('proposta truncada');
    const next = body[off];
    const len = body.readUInt16BE(off + 2);
    const spiSize = body[off + 6];
    const count = body[off + 7];
    if (len < 8 + spiSize || off + len > body.length) throw new Error('proposta com tamanho inválido');
    const spi = Buffer.from(body.subarray(off + 8, off + 8 + spiSize));
    const transforms: Transform[] = [];
    let t = off + 8 + spiSize;
    for (let i = 0; i < count; i++) {
      if (t + 8 > off + len) throw new Error('transformação truncada');
      const tlen = body.readUInt16BE(t + 2);
      if (tlen < 8 || t + tlen > off + len) throw new Error('transformação com tamanho inválido');
      transforms.push({ number: body[t + 4], id: body[t + 5], attributes: decodeAttributes(body.subarray(t + 8, t + tlen)) });
      t += tlen;
    }
    out.push({ number: body[off + 4], protocol: body[off + 5], spi, transforms });
    off += len;
    more = next === Payload.Proposal;
  }
  return out;
}

// ---------- identificação ----------

export const IdType = { IPv4: 1, FQDN: 2, UserFQDN: 3, IPv4Subnet: 4, KeyId: 11 } as const;

export interface Identity {
  type: number;
  protocol: number;
  port: number;
  data: Buffer;
}

export function encodeId(id: Identity): Buffer {
  const b = Buffer.alloc(4);
  b[0] = id.type;
  b[1] = id.protocol;
  b.writeUInt16BE(id.port, 2);
  return Buffer.concat([b, id.data]);
}

export function decodeId(body: Buffer): Identity {
  if (body.length < 4) throw new Error('identificação curta demais');
  return { type: body[0], protocol: body[1], port: body.readUInt16BE(2), data: Buffer.from(body.subarray(4)) };
}

export const ipv4 = (s: string) => Buffer.from(s.split('.').map(Number));
export const ipv4String = (b: Buffer) => [...b.subarray(0, 4)].join('.');

// ---------- notificação e exclusão ----------

export interface Notification {
  doi: number;
  protocol: number;
  spi: Buffer;
  type: number;
  data: Buffer;
}

export function encodeNotify(n: Notification): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(n.doi, 0);
  b[4] = n.protocol;
  b[5] = n.spi.length;
  b.writeUInt16BE(n.type, 6);
  return Buffer.concat([b, n.spi, n.data]);
}

export function decodeNotify(body: Buffer): Notification {
  if (body.length < 8) throw new Error('notificação curta demais');
  const spiSize = body[5];
  return {
    doi: body.readUInt32BE(0),
    protocol: body[4],
    spi: Buffer.from(body.subarray(8, 8 + spiSize)),
    type: body.readUInt16BE(6),
    data: Buffer.from(body.subarray(8 + spiSize)),
  };
}

export function encodeDelete(protocol: number, spis: Buffer[]): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(DOI_IPSEC, 0);
  b[4] = protocol;
  b[5] = spis[0]?.length ?? 0;
  b.writeUInt16BE(spis.length, 6);
  return Buffer.concat([b, ...spis]);
}

export function decodeDelete(body: Buffer): { protocol: number; spis: Buffer[] } {
  if (body.length < 8) throw new Error('exclusão curta demais');
  const size = body[5];
  const count = body.readUInt16BE(6);
  const spis: Buffer[] = [];
  for (let i = 0; i < count; i++) spis.push(Buffer.from(body.subarray(8 + i * size, 8 + (i + 1) * size)));
  return { protocol: body[4], spis };
}

// ---------- Mode Config / XAuth (payload de atributos) ----------

export const CfgType = { Request: 1, Reply: 2, Set: 3, Ack: 4 } as const;

export interface CfgPayload {
  type: number;
  identifier: number;
  attributes: Attribute[];
}

export function encodeCfg(c: CfgPayload): Buffer {
  const b = Buffer.alloc(4);
  b[0] = c.type;
  b.writeUInt16BE(c.identifier, 2);
  return Buffer.concat([b, encodeAttributes(c.attributes)]);
}

export function decodeCfg(body: Buffer): CfgPayload {
  if (body.length < 4) throw new Error('payload de atributos curto demais');
  return { type: body[0], identifier: body.readUInt16BE(2), attributes: decodeAttributes(body.subarray(4)) };
}

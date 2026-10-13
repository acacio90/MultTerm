import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  attrNumber, decodeAttributes, decodeCfg, decodeHeader, decodeId, decodePayloads, decodeSA, encodeAttributes, encodeCfg,
  encodeHeader, encodeId, encodePayloads, encodeSA, ExchangeType, IdType, ipv4, Payload, Protocol,
} from '../src/vpn/ike/packet.ts';
import { decrypt, dhGroup, dhPublic, dhSecret, encrypt, exchangeIv, expandKey, keymat, phase1Keys, prf } from '../src/vpn/ike/crypto.ts';
import { EspDecrypt, EspEncrypt, icmpEcho, ipChecksum } from '../src/vpn/esp.ts';
import type { EspKeys } from '../src/vpn/ike/client.ts';

test('cabeçalho e cadeia de payloads ISAKMP', () => {
  const [first, chain] = encodePayloads([{ type: Payload.Nonce, body: Buffer.from('abc') }, { type: Payload.VendorID, body: Buffer.alloc(16, 7) }]);
  assert.equal(first, Payload.Nonce);
  const h = encodeHeader({ icookie: Buffer.alloc(8, 1), rcookie: Buffer.alloc(8, 2), next: first, exchange: ExchangeType.Main, flags: 0, messageId: 0xdeadbeef, length: 28 + chain.length });
  const msg = Buffer.concat([h, chain, Buffer.alloc(5)]); // bytes extras (preenchimento) são ignorados
  const hd = decodeHeader(msg);
  assert.equal(hd.version, 0x10);
  assert.equal(hd.messageId, 0xdeadbeef);
  assert.equal(hd.length, 28 + chain.length);
  const p = decodePayloads(hd.next, msg.subarray(28, hd.length));
  assert.deepEqual(p.map((x) => [x.type, x.body.length]), [[Payload.Nonce, 3], [Payload.VendorID, 16]]);
  assert.throws(() => decodePayloads(Payload.Nonce, Buffer.from([0, 0, 0, 99])), /tamanho/);
});

test('atributos TV/TLV, SA, ID e payload de configuração', () => {
  const attrs = encodeAttributes([{ type: 1, value: 7 }, { type: 12, value: 86400 }, { type: 16521, value: Buffer.from('ana') }]);
  const back = decodeAttributes(attrs);
  assert.equal(attrNumber(back[0]), 7);
  assert.equal(attrNumber(back[1]), 86400); // > 16 bits vira TLV
  assert.equal((back[2].value as Buffer).toString(), 'ana');

  const sa = encodeSA([{ number: 1, protocol: Protocol.ESP, spi: Buffer.from('a1b2c3d4', 'hex'), transforms: [
    { number: 1, id: 12, attributes: [{ type: 6, value: 256 }] }, { number: 2, id: 3, attributes: [] },
  ] }]);
  const [prop] = decodeSA(sa);
  assert.equal(prop.protocol, Protocol.ESP);
  assert.equal(prop.spi.toString('hex'), 'a1b2c3d4');
  assert.deepEqual(prop.transforms.map((t) => t.id), [12, 3]);
  assert.equal(attrNumber(prop.transforms[0].attributes[0]), 256);

  const id = decodeId(encodeId({ type: IdType.IPv4Subnet, protocol: 0, port: 0, data: Buffer.concat([ipv4('10.0.0.0'), ipv4('255.0.0.0')]) }));
  assert.equal(id.type, IdType.IPv4Subnet);
  assert.equal(id.data.toString('hex'), '0a000000ff000000');

  const cfg = decodeCfg(encodeCfg({ type: 1, identifier: 0x1234, attributes: [{ type: 1, value: Buffer.alloc(0) }] }));
  assert.deepEqual([cfg.type, cfg.identifier, cfg.attributes[0].type], [1, 0x1234, 1]);
});

test('derivação de chaves da fase 1 e da fase 2 (RFC 2409)', () => {
  const psk = Buffer.from('chave');
  const ni = Buffer.alloc(16, 1);
  const nr = Buffer.alloc(16, 2);
  const gxy = Buffer.alloc(256, 3);
  const ic = Buffer.alloc(8, 4);
  const rc = Buffer.alloc(8, 5);
  const k = phase1Keys({ hash: 'sha1', psk, ni, nr, gxy, icookie: ic, rcookie: rc, keyLength: 32 });
  const h = (key: Buffer, ...d: Buffer[]) => d.reduce((m, x) => m.update(x), createHmac('sha1', key)).digest();
  const skeyid = h(psk, ni, nr);
  const d = h(skeyid, gxy, ic, rc, Buffer.from([0]));
  const a = h(skeyid, d, gxy, ic, rc, Buffer.from([1]));
  const e = h(skeyid, a, gxy, ic, rc, Buffer.from([2]));
  assert.deepEqual([k.skeyid, k.d, k.a, k.e], [skeyid, d, a, e]);
  // SKEYID_e de 20 bytes expandido para 32: K1 = prf(e, 0), K2 = prf(e, K1).
  const k1 = h(e, Buffer.from([0]));
  assert.deepEqual(k.encKey, Buffer.concat([k1, h(e, k1)]).subarray(0, 32));
  assert.deepEqual(expandKey('sha256', Buffer.alloc(40, 9), 32), Buffer.alloc(32, 9));

  const spi = Buffer.from('01020304', 'hex');
  const km = keymat({ hash: 'sha1', skeyidD: d, protocol: 3, spi, ni, nr, length: 52 });
  const km1 = h(d, Buffer.from([3]), spi, ni, nr);
  assert.deepEqual(km, Buffer.concat([km1, h(d, km1, Buffer.from([3]), spi, ni, nr), h(d, h(d, km1, Buffer.from([3]), spi, ni, nr), Buffer.from([3]), spi, ni, nr)]).subarray(0, 52));
  assert.equal(prf('md5', Buffer.from('k'), Buffer.from('x')).length, 16);
});

test('DH, cifra CBC com zeros e IV de exchange', () => {
  const a = dhGroup(14);
  const b = dhGroup(14);
  assert.equal(dhPublic(a).length, 256);
  assert.deepEqual(dhSecret(a, dhPublic(b)), dhSecret(b, dhPublic(a)));
  assert.throws(() => dhSecret(a, Buffer.alloc(10)), /tamanho inválido/);
  assert.throws(() => dhGroup(99), /não suportado/);
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(16, 1);
  const enc = encrypt('aes', key, iv, Buffer.from('dados de teste'));
  assert.equal(enc.length, 16);
  assert.equal(decrypt('aes', key, iv, enc).subarray(0, 14).toString(), 'dados de teste');
  assert.equal(exchangeIv('sha256', 'aes', Buffer.alloc(16), 1).length, 16);
  assert.equal(encrypt('3des', Buffer.alloc(24, 1), Buffer.alloc(8), Buffer.alloc(9)).length, 16);
});

const espKeys = (spi: string): EspKeys => ({ spi: Buffer.from(spi, 'hex'), cipher: 'aes', encKey: Buffer.alloc(32, 1), hash: 'sha256', authKey: Buffer.alloc(32, 2) });

test('ESP: cifra, decifra, detecta adulteração e repetição', () => {
  const out = new EspEncrypt(espKeys('11223344'));
  const inn = new EspDecrypt(espKeys('11223344'));
  const ping = icmpEcho('10.98.0.10', '10.99.0.1', 7, 1);
  assert.equal(ipChecksum(ping.subarray(0, 20)), 0);
  const p1 = out.encapsulate(ping);
  assert.equal(p1.readUInt32BE(4), 1); // seq
  assert.equal((p1.length - 8 - 16 - 16) % 16, 0); // IV 16, ICV 16 (SHA-256/128)
  assert.deepEqual(inn.decapsulate(p1), ping);
  assert.throws(() => inn.decapsulate(p1), /repetido/);
  const p2 = out.encapsulate(ping);
  const bad = Buffer.from(p2);
  bad[30] ^= 1;
  assert.throws(() => inn.decapsulate(bad), /ICV/);
  assert.deepEqual(inn.decapsulate(p2), ping);
  // Fora de ordem dentro da janela é aceito; muito antigo, não.
  const later = Array.from({ length: 70 }, () => out.encapsulate(ping));
  inn.decapsulate(later[69]);
  assert.deepEqual(inn.decapsulate(later[60]), ping);
  assert.throws(() => inn.decapsulate(later[0]), /repetido ou antigo/);
  assert.equal(inn.matches(new EspEncrypt(espKeys('99999999')).encapsulate(ping)), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { normalizeMac } from '../src/sessions/model.ts';
import { parseSessions, serializeSessions } from '../src/sessions/store.ts';
import { magicPacket, sendWol, validateWol } from '../src/network/wol.ts';

test('normalizeMac aceita os formatos comuns e recusa o resto', () => {
  for (const v of ['00:1A:2b:3c:4d:5e', '00-1a-2b-3c-4d-5e', '001a.2b3c.4d5e', '001a2b3c4d5e', ' 00:1a:2b:3c:4d:5e ']) {
    assert.equal(normalizeMac(v), '00:1a:2b:3c:4d:5e', v);
  }
  for (const v of ['', '00:1a:2b:3c:4d', '00:1a:2b:3c:4d:5g', '00:1a-2b:3c:4d:5e', '001a.2b3c4d5e']) {
    assert.equal(normalizeMac(v), undefined, v);
  }
});

test('campo mac da sessão: validado, normalizado e gravado no YAML', () => {
  const [s] = parseSessions('sessions:\n  - {name: pc, host: 10.0.0.5, mac: "00-1A-2B-3C-4D-5E"}');
  assert.equal(s.mac, '00:1a:2b:3c:4d:5e');
  assert.match(serializeSessions([s]), /mac: 00:1a:2b:3c:4d:5e/);
  assert.throws(() => parseSessions('sessions:\n  - {name: pc, host: h, mac: "xx"}'), /"mac" inválido/);
});

test('validateWol: padrões e erros', () => {
  assert.deepEqual(validateWol({ mac: '001a2b3c4d5e' }), { mac: '00:1a:2b:3c:4d:5e', address: '255.255.255.255', port: 9 });
  assert.deepEqual(validateWol({ mac: '001a2b3c4d5e', address: '10.0.0.255', port: '7' }).port, 7);
  assert.throws(() => validateWol({ mac: 'x' }), /MAC inválido/);
  assert.throws(() => validateWol({ mac: '001a2b3c4d5e', address: 'rede' }), /broadcast inválido/);
  assert.throws(() => validateWol({ mac: '001a2b3c4d5e', port: 0 }), /porta inválida/);
});

test('pacote mágico: 6×FF + MAC 16 vezes, entregue por UDP', async () => {
  const p = magicPacket('00:1a:2b:3c:4d:5e');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), '001a2b3c4d5e');

  // Receptor local: o pacote enviado chega íntegro.
  const rx = createSocket('udp4');
  await new Promise<void>((r) => rx.bind(0, '127.0.0.1', r));
  const got = new Promise<Buffer>((r) => rx.once('message', (msg) => r(msg)));
  await sendWol({ mac: '00:1a:2b:3c:4d:5e', address: '127.0.0.1', port: rx.address().port });
  assert.deepEqual(await got, p);
  rx.close();
});

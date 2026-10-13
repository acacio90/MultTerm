import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeOid, formatOctets, formatTimeTicks, resolveOid, runSnmp, validateSnmpRequest, type SnmpRequest,
} from '../src/network/snmp.ts';
import { startAgent, V3_USER } from './snmp-agent.ts';

// ---------- validação e formatação ----------

test('resolveOid: nomes, instâncias, prefixo "." e erros', () => {
  assert.equal(resolveOid('sysName'), '1.3.6.1.2.1.1.5.0');
  assert.equal(resolveOid('sysName', { scalarInstance: false }), '1.3.6.1.2.1.1.5');
  assert.equal(resolveOid('ifdescr.3'), '1.3.6.1.2.1.2.2.1.2.3');
  assert.equal(resolveOid('system'), '1.3.6.1.2.1.1');
  assert.equal(resolveOid('.1.3.6.1.2.1.1.5.0'), '1.3.6.1.2.1.1.5.0');
  assert.throws(() => resolveOid('naoExiste'), /desconhecido/);
  assert.throws(() => resolveOid('1.3.x'), /inválido/);
  assert.throws(() => resolveOid('1.3.99999999999'), /inválido/);
});

test('describeOid usa o prefixo conhecido mais longo', () => {
  assert.equal(describeOid('1.3.6.1.2.1.2.2.1.2.3'), 'ifDescr.3');
  assert.equal(describeOid('1.3.6.1.2.1.1.5.0'), 'sysName.0');
  assert.equal(describeOid('1.3.6.1.4.1.9.1'), 'enterprises.9.1');
  assert.equal(describeOid('1.2.3'), '');
});

test('validateSnmpRequest: versões, operações e regras do protocolo', () => {
  const base = { host: '10.0.0.1', version: '2c', operation: 'get', oids: 'sysName sysDescr' };
  const r = validateSnmpRequest(base);
  assert.deepEqual([r.port, r.community, r.oids.length, r.timeoutMs], [161, 'public', 2, 3000]);
  assert.equal(validateSnmpRequest({ ...base, operation: 'walk', oids: 'system' }).oids[0], '1.3.6.1.2.1.1');
  assert.throws(() => validateSnmpRequest({ ...base, host: '-x' }), /host inválido/);
  assert.throws(() => validateSnmpRequest({ ...base, version: '4' }), /versão/);
  assert.throws(() => validateSnmpRequest({ ...base, version: '1', operation: 'getbulk' }), /não existe no SNMPv1/);
  assert.throws(() => validateSnmpRequest({ ...base, operation: 'walk' }), /um único OID/);
  assert.throws(() => validateSnmpRequest({ ...base, oids: ' ' }), /ao menos um OID/);
  assert.throws(() => validateSnmpRequest({ ...base, port: 70000 }), /porta/);

  const v3 = { ...base, version: '3', user: 'u', level: 'authPriv', authProtocol: 'sha', authKey: '12345678', privProtocol: 'aes', privKey: '12345678' };
  assert.deepEqual(validateSnmpRequest(v3).user, { name: 'u', level: 'authPriv', authProtocol: 'sha', authKey: '12345678', privProtocol: 'aes', privKey: '12345678' });
  assert.equal(validateSnmpRequest(v3).community, undefined);
  assert.deepEqual(validateSnmpRequest({ ...v3, level: 'noAuthNoPriv' }).user, { name: 'u', level: 'noAuthNoPriv' });
  assert.throws(() => validateSnmpRequest({ ...v3, user: '' }), /usuário/);
  assert.throws(() => validateSnmpRequest({ ...v3, authKey: 'curta' }), /autenticação deve ter ao menos 8/);
  assert.throws(() => validateSnmpRequest({ ...v3, privKey: 'curta' }), /privacidade deve ter ao menos 8/);
  assert.throws(() => validateSnmpRequest({ ...v3, authProtocol: 'rot13' }), /autenticação inválido/);
});

test('formatação de TimeTicks e OctetString', () => {
  assert.equal(formatTimeTicks(27_000_000), '3d 03:00:00 (27000000)');
  assert.equal(formatTimeTicks(6_100), '00:01:01 (6100)');
  assert.equal(formatOctets(Buffer.from('Laboratório')), 'Laboratório');
  assert.equal(formatOctets(Buffer.from([0, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e])), '00:1a:2b:3c:4d:5e');
  assert.equal(formatOctets(Buffer.from([0xff, 0xfe])), 'ff:fe');
  assert.equal(formatOctets(Buffer.alloc(0)), '');
});

// ---------- ponta a ponta contra um agente local ----------

let agent: Awaited<ReturnType<typeof startAgent>>;
before(async () => {
  agent = await startAgent();
});
after(async () => {
  await agent.close();
});

const req = (extra: Record<string, unknown>): SnmpRequest =>
  validateSnmpRequest({ host: '127.0.0.1', port: agent.port, version: '2c', timeoutMs: 2000, retries: 0, ...extra });
const v3 = (extra: Record<string, unknown> = {}) => ({
  version: '3', user: V3_USER.name, level: 'authPriv',
  authProtocol: V3_USER.authProtocol, authKey: V3_USER.authKey, privProtocol: V3_USER.privProtocol, privKey: V3_USER.privKey, ...extra,
});

test('v2c get: valores formatados e nomes conhecidos', async () => {
  const r = await runSnmp(req({ operation: 'get', oids: 'sysName sysUpTime sysObjectID' }));
  assert.deepEqual(r.map((x) => [x.name, x.type, x.value]), [
    ['sysName.0', 'OctetString', 'agente-teste'],
    ['sysUpTime.0', 'TimeTicks', '3d 03:00:00 (27000000)'],
    ['sysObjectID.0', 'OID', '1.3.6.1.4.1.99999'],
  ]);
});

test('v2c getnext, getbulk e walk', async () => {
  const next = await runSnmp(req({ operation: 'getnext', oids: 'sysDescr' }));
  assert.deepEqual(next.map((x) => [x.name, x.value]), [['sysDescr.0', 'Agente de teste do MultTerm']]);

  const bulk = await runSnmp(req({ operation: 'getbulk', oids: 'system', maxRepetitions: 3 }));
  assert.deepEqual(bulk.map((x) => x.name), ['sysDescr.0', 'sysObjectID.0', 'sysUpTime.0']);

  const seen: string[] = [];
  const walk = await runSnmp(req({ operation: 'walk', oids: 'system' }), { onResult: (x) => seen.push(x.name) });
  assert.deepEqual(walk.map((x) => x.name), ['sysDescr.0', 'sysObjectID.0', 'sysUpTime.0', 'sysName.0', 'sysLocation.0']);
  assert.equal(seen.length, 5);
  assert.equal(walk.at(-1)?.value, 'Laboratório');

  const limited = await runSnmp(req({ operation: 'walk', oids: '1.3.6.1', maxResults: 2 }));
  assert.equal(limited.length, 2);
});

test('get inexistente vira "não existe", MAC em hex e Counter64 grande', async () => {
  const r = await runSnmp(req({ operation: 'get', oids: '1.3.6.1.2.1.1.9.0 1.3.6.1.4.1.99999.1.0 1.3.6.1.4.1.99999.2.0' }));
  assert.deepEqual(r.map((x) => x.value), ['(objeto não existe)', '00:1a:2b:3c:4d:5e', '4294967296']);
});

test('v1 get funciona; community errada dá timeout com mensagem clara', async () => {
  const r = await runSnmp(req({ version: '1', operation: 'get', oids: 'sysName' }));
  assert.equal(r[0].value, 'agente-teste');
  await assert.rejects(runSnmp(req({ community: 'errada', operation: 'get', oids: 'sysName', timeoutMs: 400 })),
    /sem resposta em 400 ms — confira host, porta, versão e community/);
});

test('v3 authPriv: credenciais certas respondem, senha errada é recusada', async () => {
  const r = await runSnmp(req({ ...v3(), operation: 'get', oids: 'sysName' }));
  assert.equal(r[0].value, 'agente-teste');
  const walk = await runSnmp(req({ ...v3(), operation: 'walk', oids: 'system' }));
  assert.equal(walk.length, 5);
  await assert.rejects(runSnmp(req({ ...v3({ authKey: 'senha-errada-1' }), operation: 'get', oids: 'sysName', timeoutMs: 600 })),
    /confira host, porta, usuário, senhas e protocolos do SNMPv3/);
  await assert.rejects(runSnmp(req({ ...v3({ user: 'ninguem' }), operation: 'get', oids: 'sysName', timeoutMs: 600 })),
    /usuário desconhecido no agente/);
});

test('cancelamento antes de começar devolve vazio', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  assert.deepEqual(await runSnmp(req({ operation: 'walk', oids: 'system' }), { signal: ctrl.signal }), []);
});

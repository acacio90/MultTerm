import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, ZabbixClient, ZabbixError } from '../src/zabbix/client.ts';
import { startFakeZabbix, type FakeZabbixOptions } from './zabbix-fake.ts';

const LINUX = { groupid: '2', name: 'Linux servers' };
const WIN = { groupid: '11', name: 'Windows' };

const base = (version: string): FakeZabbixOptions => ({
  version,
  token: 'token-123',
  user: 'Admin',
  password: 'zabbix',
  groups: [LINUX, WIN],
  hosts: [
    { hostid: '1', host: 'web01', interfaces: [{ type: '1', main: '1', useip: '1', ip: '10.0.0.1', dns: '' }], groups: [LINUX] },
    { hostid: '2', host: 'ad01', interfaces: [{ type: '1', main: '1', useip: '1', ip: '10.0.0.2', dns: '' }], groups: [WIN] },
  ],
});

test('apiUrl completa o caminho do api_jsonrpc.php e recusa outros protocolos', () => {
  assert.equal(apiUrl('https://zabbix.acme.com').href, 'https://zabbix.acme.com/api_jsonrpc.php');
  assert.equal(apiUrl('https://acme.com/zabbix/').href, 'https://acme.com/zabbix/api_jsonrpc.php');
  assert.equal(apiUrl('http://acme.com/zabbix/api_jsonrpc.php?x=1').href, 'http://acme.com/zabbix/api_jsonrpc.php');
  assert.throws(() => apiUrl('ftp://acme.com'), ZabbixError);
  assert.throws(() => apiUrl('zabbix'), /endereço inválido/);
});

// O servidor falso só aceita a credencial no lugar certo para a versão ("auth" até 6.2, Bearer na 6.4+).
for (const [version, groupsKey, filter] of [
  ['6.0.30', 'selectGroups', 'real_hosts'],
  ['7.0.5', 'selectHostGroups', 'with_hosts'],
] as const) {
  test(`Zabbix ${version}: token, grupos e hosts com os parâmetros da versão`, async () => {
    const fake = await startFakeZabbix(base(version));
    try {
      const client = await ZabbixClient.connect({ url: fake.url, auth: { token: 'token-123' } });
      assert.equal(client.version, version);
      assert.deepEqual(await client.groups(), [{ ...LINUX, hosts: 1 }, { ...WIN, hosts: 1 }]);
      const hosts = await client.hosts(['11']);
      assert.deepEqual(hosts.map((h) => h.host), ['ad01']);
      assert.deepEqual(hosts[0].hostgroups ?? hosts[0].groups, [WIN]);

      const groupCall = fake.calls.find((c) => c.method === 'hostgroup.get')!;
      assert.equal(groupCall.params[filter], true);
      const hostCall = fake.calls.find((c) => c.method === 'host.get')!;
      assert.ok(groupsKey in hostCall.params);
      assert.ok(fake.calls.filter((c) => c.method !== 'apiinfo.version').every((c) => c.credential === 'token-123'));
      await client.close();
      assert.equal(fake.calls.some((c) => c.method === 'user.logout'), false);
    } finally {
      await fake.close();
    }
  });
}

test('usuário e senha: faz login, usa a sessão e sai no fim', async () => {
  const fake = await startFakeZabbix(base('7.0.5'));
  try {
    const client = await ZabbixClient.connect({ url: fake.url, auth: { user: 'Admin', password: 'zabbix' } });
    await client.groups();
    await client.close();
    assert.deepEqual(fake.calls.map((c) => c.method), ['apiinfo.version', 'user.login', 'hostgroup.get', 'user.logout']);
    assert.equal(fake.calls[2].credential, 'sessao-de-teste');
  } finally {
    await fake.close();
  }
});

test('erros: token errado, senha errada, versão antiga e endereço que não é a API', async () => {
  const fake = await startFakeZabbix(base('6.4.0'));
  const old = await startFakeZabbix(base('5.0.40'));
  try {
    await assert.rejects(ZabbixClient.connect({ url: fake.url, auth: { token: 'errado' } }), /Not authorised/);
    await assert.rejects(ZabbixClient.connect({ url: fake.url, auth: { user: 'Admin', password: 'x' } }), /Incorrect user name/);
    await assert.rejects(ZabbixClient.connect({ url: old.url, auth: { token: 'token-123' } }), /5\.0\.40 não é suportado/);
    await assert.rejects(ZabbixClient.connect({ url: fake.url.replace('/zabbix', '/outro'), auth: { token: 'token-123' } }), /HTTP 404/);
  } finally {
    await fake.close();
    await old.close();
  }
});

test('erro de conexão vira mensagem legível', async () => {
  await assert.rejects(
    ZabbixClient.connect({ url: 'http://127.0.0.1:1/zabbix', auth: { token: 'x' }, timeoutMs: 2000 }),
    (err: Error) => err instanceof ZabbixError && /ECONNREFUSED/.test(err.message),
  );
});

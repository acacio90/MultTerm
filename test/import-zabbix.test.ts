import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAddress, zabbixToSessions, type ZabbixHost } from '../src/sessions/import-zabbix.ts';
import { parseSessions, serializeSessions } from '../src/sessions/store.ts';

const LINUX = { groupid: '2', name: 'Linux servers' };
const PROD = { groupid: '10', name: 'Clientes/ACME/Produção' };
const WIN = { groupid: '11', name: 'Windows' };

const agent = (ip: string, dns = '', useip = '1') => ({ type: '1', main: '1', useip, ip, dns });

const HOSTS: ZabbixHost[] = [
  {
    hostid: '10501', host: 'web01', name: 'Web 01', interfaces: [agent('10.0.0.1')],
    inventory: { os: 'Ubuntu 24.04', macaddress_a: 'AA-BB-CC-DD-EE-01' },
    tags: [{ tag: 'multterm.user', value: 'deploy' }, { tag: 'multterm.port', value: '2222' }],
    hostgroups: [LINUX, PROD],
  },
  {
    hostid: '10502', host: 'ad01', name: 'AD/01', interfaces: [agent('', 'ad01.acme.local', '0')],
    inventory: [], hostgroups: [WIN], parentTemplates: [{ name: 'Windows by Zabbix agent' }],
  },
  {
    hostid: '10503', host: 'sw01', interfaces: [{ type: '2', main: '1', useip: '1', ip: '10.0.9.1', dns: '' }],
    tags: [{ tag: 'multterm.type', value: 'SSH' }], groups: [PROD],
  },
  { hostid: '10504', host: 'sem-interface', interfaces: [], hostgroups: [LINUX] },
  {
    hostid: '10505', host: 'tipo-ruim', interfaces: [agent('10.0.0.5')],
    tags: [{ tag: 'multterm.type', value: 'telnet' }], hostgroups: [LINUX],
  },
];

test('endereço: agente principal (IP ou DNS conforme useip); sem agente, SNMP', () => {
  assert.equal(hostAddress(HOSTS[0]), '10.0.0.1');
  assert.equal(hostAddress(HOSTS[1]), 'ad01.acme.local');
  assert.equal(hostAddress(HOSTS[2]), '10.0.9.1');
  assert.equal(hostAddress(HOSTS[3]), undefined);
  // useip=1 sem IP cai para o DNS
  assert.equal(hostAddress({ hostid: '1', host: 'x', interfaces: [agent('', 'x.local')] }), 'x.local');
});

test('cada grupo escolhido vira pasta; host em vários grupos entra em cada um', () => {
  const { sessions } = zabbixToSessions(HOSTS, ['2', '10', '11'], 'Zabbix');
  const keys = sessions.map((s) => `${s.folder}/${s.name}`).sort();
  assert.deepEqual(keys, [
    'Zabbix/Clientes/ACME/Produção/Web 01',
    'Zabbix/Clientes/ACME/Produção/sw01',
    'Zabbix/Linux servers/Web 01',
    'Zabbix/Windows/AD-01',
  ]);
});

test('só os grupos escolhidos entram', () => {
  const { sessions } = zabbixToSessions(HOSTS, ['11'], '');
  assert.deepEqual(sessions.map((s) => `${s.folder}/${s.name}`), ['Windows/AD-01']);
});

test('campos: tags multterm.*, MAC do inventário, Windows vira RDP e hostid guardado', () => {
  const { sessions } = zabbixToSessions(HOSTS, ['2', '10', '11'], 'Zabbix');
  assert.deepEqual(sessions.find((s) => s.name === 'Web 01' && s.folder === 'Zabbix/Linux servers'), {
    name: 'Web 01', folder: 'Zabbix/Linux servers', type: 'ssh', host: '10.0.0.1', port: 2222, user: 'deploy',
    mac: 'aa:bb:cc:dd:ee:01', zabbixHostId: '10501',
  });
  assert.equal(sessions.find((s) => s.name === 'AD-01')?.type, 'rdp');
  assert.equal(sessions.find((s) => s.name === 'sw01')?.type, 'ssh');
});

test('host sem interface ou com tipo inválido gera aviso e fica de fora', () => {
  const { sessions, warnings } = zabbixToSessions(HOSTS, ['2'], 'Zabbix');
  assert.equal(sessions.some((s) => s.zabbixHostId === '10504' || s.zabbixHostId === '10505'), false);
  assert.ok(warnings.some((w) => /sem-interface: sem interface/.test(w)));
  assert.ok(warnings.some((w) => /tipo-ruim.*"type" deve ser/.test(w)));
});

test('zabbixHostId sobrevive à gravação e à leitura do arquivo', () => {
  const { sessions } = zabbixToSessions(HOSTS, ['11'], 'Zabbix');
  const text = serializeSessions(sessions);
  assert.match(text, /zabbixHostId: "10502"/);
  assert.equal(parseSessions(text)[0].zabbixHostId, '10502');
  assert.throws(() => parseSessions('sessions:\n  - { name: a, host: a, zabbixHostId: abc }'), /zabbixHostId/);
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAddress, isLoopback, planZabbixSync, zabbixToSessions, type ZabbixHost } from '../src/sessions/import-zabbix.ts';
import type { Session } from '../src/sessions/model.ts';
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

test('endereço local (localhost, 127.x, ::1) fica de fora com aviso', () => {
  for (const a of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.ok(isLoopback(a), a);
  for (const a of ['10.0.0.1', '127.example.org', 'localhost.acme.com', '::2']) assert.equal(isLoopback(a), false, a);

  const server = { groupid: '4', name: 'Zabbix servers' };
  const hosts: ZabbixHost[] = [
    { hostid: '10084', host: 'Zabbix server', interfaces: [agent('127.0.0.1')], hostgroups: [server] },
    { hostid: '10085', host: 'proxy', interfaces: [agent('', 'localhost', '0')], hostgroups: [server] },
    { hostid: '10086', host: 'web', interfaces: [agent('10.0.0.8')], hostgroups: [server] },
  ];
  const { sessions, warnings } = zabbixToSessions(hosts, ['4'], 'Zabbix');
  assert.deepEqual(sessions.map((s) => s.name), ['web']);
  assert.deepEqual(warnings, [
    'Zabbix server: endereço local (127.0.0.1), ignorado',
    'proxy: endereço local (localhost), ignorado',
  ]);
});

test('zabbixHostId sobrevive à gravação e à leitura do arquivo', () => {
  const { sessions } = zabbixToSessions(HOSTS, ['11'], 'Zabbix');
  const text = serializeSessions(sessions);
  assert.match(text, /zabbixHostId: "10502"/);
  assert.equal(parseSessions(text)[0].zabbixHostId, '10502');
  assert.throws(() => parseSessions('sessions:\n  - { name: a, host: a, zabbixHostId: abc }'), /zabbixHostId/);
});

describe('sincronização', () => {
  const web: Session = { name: 'web01', folder: 'Zabbix/Linux', type: 'ssh', host: '10.0.0.1', zabbixHostId: '1' };
  const db: Session = { name: 'db01', folder: 'Zabbix/Linux', type: 'ssh', host: '10.0.0.2', zabbixHostId: '2' };
  const manual: Session = { name: 'roteador', folder: 'Rede', type: 'ssh', host: '10.0.0.254' };

  test('novas entram, iguais não contam como mudança, as que sumiram saem; manuais ficam', () => {
    const plan = planZabbixSync([web, db, manual], [web, { ...db, name: 'db02', zabbixHostId: '3' }]);
    assert.deepEqual(plan.added.map((s) => s.name), ['db02']);
    assert.deepEqual(plan.updated, []);
    assert.deepEqual(plan.removed.map((s) => s.name), ['db01']);
    assert.deepEqual(plan.sessions.map((s) => s.name).sort(), ['db02', 'roteador', 'web01']);
  });

  test('atualiza endereço, nome e pasta do Zabbix e mantém o que foi editado aqui', () => {
    const edited: Session = { ...web, type: 'rdp', user: 'pedro', identityFile: '~/.ssh/id', vpn: 'campus', tags: ['x'] };
    const plan = planZabbixSync([edited], [{ ...web, name: 'Web 01', folder: 'Zabbix/Servidores', host: '10.0.0.10' }]);
    assert.deepEqual(plan.updated, [{
      name: 'Web 01', folder: 'Zabbix/Servidores', type: 'rdp', host: '10.0.0.10', user: 'pedro',
      identityFile: '~/.ssh/id', vpn: 'campus', tags: ['x'], zabbixHostId: '1',
    }]);
    assert.deepEqual(plan.removed, []);
    assert.equal(plan.sessions.length, 1);
  });

  test('usuário, porta e MAC do Zabbix só substituem quando existem', () => {
    const edited = { ...web, user: 'pedro', port: 2200 };
    assert.equal(planZabbixSync([edited], [web]).sessions[0].user, 'pedro');
    const plan = planZabbixSync([edited], [{ ...web, user: 'deploy', mac: 'aa:bb:cc:dd:ee:ff' }]);
    assert.equal(plan.sessions[0].user, 'deploy');
    assert.equal(plan.sessions[0].port, 2200);
    assert.equal(plan.sessions[0].mac, 'aa:bb:cc:dd:ee:ff');
  });

  test('host em dois grupos: cada sessão casa com a sua pasta', () => {
    const other = { ...web, folder: 'Zabbix/Produção', user: 'prod' };
    const plan = planZabbixSync([web, other], [web, { ...web, folder: 'Zabbix/Produção' }]);
    assert.deepEqual(plan.updated, []);
    assert.equal(plan.sessions.find((s) => s.folder === 'Zabbix/Produção')?.user, 'prod');
  });

  test('mesma pasta/nome de uma sessão manual: a manual fica e o conflito é avisado', () => {
    const plan = planZabbixSync([manual], [{ ...manual, zabbixHostId: '9' }]);
    assert.deepEqual(plan.sessions, [manual]);
    assert.deepEqual(plan.conflicts.map((s) => s.name), ['roteador']);
  });
});

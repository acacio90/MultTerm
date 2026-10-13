import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { diagCommand, validateDiag } from '../src/network/diag.ts';
import { dnsErrorMessage, formatRecords, normalizeQuery, normalizeServer, pickDnsServers } from '../src/network/dns.ts';
import { parseTargets, probeHost } from '../src/network/hosts.ts';
import { formatEndpoint, parseWindowsConnections, stateLabel } from '../src/network/local-ports.ts';
import { parsePorts, probePort, runPool, scanPorts } from '../src/network/ports.ts';

// Servidor TCP local para testar portas aberta/fechada sem depender da rede.
async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port };
}
async function freePort(): Promise<number> {
  const { server, port } = await listen();
  await new Promise((r) => server.close(r));
  return port;
}

// ---------- ping / traceroute ----------

test('diag: monta ping/tracert por plataforma e valida o pedido', () => {
  assert.deepEqual(diagCommand({ kind: 'ping', host: 'h.example.org' }, 'win32'), { file: 'ping.exe', args: ['-t', 'h.example.org'] });
  assert.deepEqual(diagCommand({ kind: 'ping', host: 'h', count: 4 }, 'win32'), { file: 'ping.exe', args: ['-n', '4', 'h'] });
  assert.deepEqual(diagCommand({ kind: 'ping', host: 'h', count: 4 }, 'linux'), { file: 'ping', args: ['-c', '4', 'h'] });
  assert.deepEqual(diagCommand({ kind: 'traceroute', host: 'h' }, 'win32'), { file: 'tracert.exe', args: ['h'] });
  assert.deepEqual(validateDiag({ kind: 'ping', host: ' 10.0.0.1 ', count: '3' }), { kind: 'ping', host: '10.0.0.1', count: 3 });
  assert.equal(validateDiag({ kind: 'ping', host: 'h', count: '' }).count, undefined);
  assert.throws(() => validateDiag({ kind: 'ping', host: '-t' }), /host inválido/);
  assert.throws(() => validateDiag({ kind: 'ping', host: 'a b' }), /host inválido/);
  assert.throws(() => validateDiag({ kind: 'rm', host: 'h' }), /ferramenta inválida/);
  assert.throws(() => validateDiag({ kind: 'ping', host: 'h', count: 0 }), /quantidade/);
});

// ---------- portas ----------

test('parsePorts: listas, faixas, predefinições, ordem e erros', () => {
  assert.deepEqual(parsePorts('443, 22,80-82 22'), [22, 80, 81, 82, 443]);
  assert.ok(parsePorts('windows').includes(3389));
  assert.deepEqual(parsePorts('web,22').slice(0, 2), [22, 80]);
  assert.equal(parsePorts('1-65535').length, 65535);
  for (const bad of ['', 'abc', '0', '70000', '90-80', '22-']) assert.throws(() => parsePorts(bad), /porta|faixa/);
});

test('probePort/scanPorts: aberta, fechada e filtrada', async () => {
  const { server, port: open } = await listen();
  const closed = await freePort();
  try {
    assert.equal(await probePort('127.0.0.1', open, 1000), 'open');
    assert.equal(await probePort('127.0.0.1', closed, 1000), 'closed');
    // 192.0.2.0/24 (TEST-NET-1) não é roteável: sem resposta = filtrada.
    assert.equal(await probePort('192.0.2.1', 9, 300), 'filtered');

    const seen: number[] = [];
    const results = await scanPorts('127.0.0.1', [closed, open], { timeoutMs: 1000, onResult: (r) => seen.push(r.port) });
    assert.deepEqual(results.map((r) => [r.port, r.state]), [[closed, 'closed'], [open, 'open']].sort((a, b) => Number(a[0]) - Number(b[0])));
    assert.equal(seen.length, 2);
  } finally {
    server.close();
  }
});

test('runPool respeita a concorrência e o cancelamento', async () => {
  let running = 0;
  let peak = 0;
  const ctrl = new AbortController();
  const done: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    done.push(n);
    if (n === 2) ctrl.abort();
  }, ctrl.signal);
  assert.equal(peak, 2);
  assert.ok(done.length < 6, `cancelou cedo (${done.length} feitos)`);
});

// ---------- scanner de rede ----------

test('parseTargets: CIDR sem rede/broadcast, faixas, listas e limites', () => {
  assert.deepEqual(parseTargets('10.0.0.0/30'), ['10.0.0.1', '10.0.0.2']);
  assert.equal(parseTargets('10.0.0.0/24').length, 254);
  assert.deepEqual(parseTargets('10.0.0.7/32'), ['10.0.0.7']);
  assert.deepEqual(parseTargets('10.0.0.254-10.0.1.1'), ['10.0.0.254', '10.0.0.255', '10.0.1.0', '10.0.1.1']);
  assert.deepEqual(parseTargets('10.0.0.10-12'), ['10.0.0.10', '10.0.0.11', '10.0.0.12']);
  assert.deepEqual(parseTargets('a.example.org, 10.0.0.1 10.0.0.1'), ['a.example.org', '10.0.0.1']);
  assert.throws(() => parseTargets('10.0.0.0/8'), /grande demais/);
  assert.throws(() => parseTargets('10.0.0.0/24', 100), /grande demais/);
  assert.throws(() => parseTargets('10.0.0.9-10.0.0.1'), /invertida/);
  assert.throws(() => parseTargets('-oX'), /inválido/);
  assert.throws(() => parseTargets('  '), /informe/);
});

test('probeHost: porta recusada já prova que o host existe', async () => {
  const closed = await freePort();
  const r = await probeHost('127.0.0.1', { ports: [closed], timeoutMs: 1000 });
  assert.equal(r.alive, true);
  assert.deepEqual(r.open, []);
  const none = await probeHost('192.0.2.1', { ports: [22], timeoutMs: 300 });
  assert.equal(none.alive, false);
});

// ---------- DNS ----------

test('DNS: normaliza consulta e servidor', () => {
  assert.deepEqual(normalizeQuery('example.org.', 'MX'), { name: 'example.org', type: 'MX' });
  assert.deepEqual(normalizeQuery('8.8.8.8', 'A'), { name: '8.8.8.8', type: 'PTR' });
  assert.deepEqual(normalizeQuery('2001:db8::1', 'A'), { name: '2001:db8::1', type: 'PTR' });
  assert.throws(() => normalizeQuery('-x', 'A'), /inválido/);
  assert.throws(() => normalizeQuery('example.org', 'ANY'), /tipo/);
  assert.throws(() => normalizeQuery('example.org', 'PTR'), /PTR exige/);
  assert.equal(normalizeServer(''), undefined);
  assert.equal(normalizeServer('1.1.1.1:5353'), '1.1.1.1:5353');
  assert.equal(normalizeServer('[2606:4700::1111]:53'), '[2606:4700::1111]:53');
  assert.throws(() => normalizeServer('dns.example.org'), /deve ser um IP/);
});

test('DNS: formata registros e traduz erros', () => {
  assert.deepEqual(formatRecords('A', [{ address: '1.2.3.4', ttl: 60 }]), ['1.2.3.4  (TTL 60s)']);
  assert.deepEqual(formatRecords('MX', [{ priority: 20, exchange: 'b' }, { priority: 10, exchange: 'a' }]), ['10 a', '20 b']);
  assert.deepEqual(formatRecords('TXT', [['v=spf1 ', 'include:x -all']]), ['v=spf1 include:x -all']);
  assert.deepEqual(formatRecords('SRV', [{ priority: 0, weight: 5, port: 5060, name: 'sip.x' }]), ['0 5 5060 sip.x']);
  assert.equal(formatRecords('SOA', { nsname: 'ns', hostmaster: 'h', serial: 1, refresh: 2, retry: 3, expire: 4, minttl: 5 }).length, 4);
  assert.equal(dnsErrorMessage({ code: 'ENOTFOUND' }), 'nome não encontrado (NXDOMAIN)');
  assert.equal(dnsErrorMessage(new Error('x')), 'x');
});

test('DNS: filtra servidores inválidos do sistema', () => {
  assert.deepEqual(pickDnsServers(['10.0.0.53', '0.0.0.0', 'fec0:0:0:ffff::1', '8.8.8.8', '10.0.0.53', 'lixo']), ['10.0.0.53', '8.8.8.8']);
  assert.deepEqual(pickDnsServers('1.1.1.1'), ['1.1.1.1']);
  assert.deepEqual(pickDnsServers(null), []);
});

// ---------- portas locais ----------

test('parseWindowsConnections: TCP/UDP, objeto único e ordenação', () => {
  const json = JSON.stringify([
    { proto: 'UDP', la: '0.0.0.0', lp: 5353, ra: '', rp: null, st: 'Bound', pid: 40, name: 'svchost' },
    { proto: 'TCP', la: '::', lp: 135, ra: '::', rp: 0, st: 'Listen', pid: 10, name: 'svchost' },
    { proto: 'TCP', la: '10.0.0.5', lp: 50000, ra: '10.0.0.9', rp: 22, st: 'Established', pid: 20, name: null },
  ]);
  const rows = parseWindowsConnections(json);
  assert.deepEqual(rows.map((r) => `${r.proto}:${r.localPort}`), ['TCP:135', 'TCP:50000', 'UDP:5353']);
  assert.equal(rows[1].process, '');
  assert.equal(rows[1].remotePort, 22);
  assert.equal(rows[2].remotePort, null);
  assert.equal(parseWindowsConnections(JSON.stringify(JSON.parse(json)[1])).length, 1);
  assert.deepEqual(parseWindowsConnections('  '), []);
  assert.equal(stateLabel('Listen'), 'escutando');
  assert.equal(formatEndpoint('::', 135), '[::]:135');
  assert.equal(formatEndpoint('10.0.0.5', 22), '10.0.0.5:22');
  assert.equal(formatEndpoint('', null), '*');
});

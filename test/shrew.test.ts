import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseSessions, serializeSessions } from '../src/sessions/store.ts';
import {
  findShrew, importSite, isSafeSiteName, listSites, parseSiteFile, parseVpnNetworks, ShrewConnection, shrewErrorMessage,
  shrewPhase, siteInfo, type ControllerProcess, type VpnStatus,
} from '../src/network/shrew.ts';

const SITE = [
  's:network-host:vpn.example.org',
  'n:network-ike-port:500',
  's:auth-method:mutual-psk-xauth',
  's:client-saved-username:ana',
  'b:auth-mutual-psk:c2VncmVkbw==',
  's:policy-list-include:10.0.0.0 / 255.0.0.0',
  '',
].join('\r\n');

test('findShrew procura o ipsecc.exe nas pastas de programas', () => {
  const exe = join('C:', 'PF', 'ShrewSoft', 'VPN Client', 'ipsecc.exe');
  assert.equal(findShrew({ programFiles: ['', join('C:', 'PF')], fileExists: (p) => p === exe }), exe);
  assert.equal(findShrew({ programFiles: [join('C:', 'PF')], fileExists: () => false }), undefined);
});

test('parseSiteFile e siteInfo leem o formato do Shrew', () => {
  const cfg = parseSiteFile(SITE);
  assert.equal(cfg.get('network-host'), 'vpn.example.org');
  assert.equal(cfg.get('policy-list-include'), '10.0.0.0 / 255.0.0.0');
  assert.deepEqual(siteInfo('Matriz', SITE, false), {
    name: 'Matriz', host: 'vpn.example.org', auth: 'mutual-psk-xauth', credentials: true, savedUser: 'ana', public: false,
  });
  const psk = siteInfo('Filial', 's:network-host:1.2.3.4\nn:network-ike-port:4500\ns:auth-method:mutual-psk\n', true);
  assert.deepEqual(psk, { name: 'Filial', host: '1.2.3.4', port: 4500, auth: 'mutual-psk', credentials: false, public: true });
});

test('isSafeSiteName recusa nomes que viram caminho ou argumento', () => {
  for (const ok of ['Matriz', 'VPN Campus 2', 'site.vpn', 'São Paulo']) assert.ok(isSafeSiteName(ok), ok);
  for (const bad of ['', '..', 'a/b', 'a\\b', 'a"b', '-r', ' x', 'x ', 'a\nb', 'c:x', 'x'.repeat(101)]) assert.ok(!isSafeSiteName(bad), bad);
});

test('listSites junta usuário e públicos, sem repetir nem aceitar lixo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multterm-shrew-'));
  try {
    const user = join(root, 'user');
    const pub = join(root, 'public');
    await mkdir(user);
    await mkdir(pub);
    await writeFile(join(user, 'Matriz'), SITE);
    await writeFile(join(user, 'sem-host'), 's:auth-method:mutual-psk\n');
    await writeFile(join(pub, 'matriz'), 's:network-host:outro\n'); // escondido pelo do usuário
    await writeFile(join(pub, 'Filial'), 's:network-host:10.9.9.9\n');
    const sites = await listSites({ user, public: pub });
    assert.deepEqual(sites.map((s) => [s.name, s.host, s.public]), [['Filial', '10.9.9.9', true], ['Matriz', 'vpn.example.org', false]]);
    assert.deepEqual(await listSites({ user: join(root, 'nao-existe') }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('importSite copia o .vpn e evita sobrescrever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multterm-shrew-'));
  try {
    const file = join(root, 'Matriz.vpn');
    await writeFile(file, SITE);
    const dir = join(root, 'sites');
    assert.equal((await importSite(file, dir)).name, 'Matriz');
    const again = await importSite(file, dir);
    assert.equal(again.name, 'Matriz (2)');
    assert.equal(again.host, 'vpn.example.org');
    assert.deepEqual((await readdir(dir)).sort(), ['Matriz', 'Matriz (2)']);
    assert.equal(await readFile(join(dir, 'Matriz (2)'), 'utf8'), SITE);
    const bad = join(root, 'x.vpn');
    await writeFile(bad, 'qualquer coisa');
    await assert.rejects(importSite(bad, dir), /não é um site do Shrew/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shrewErrorMessage traduz o log do cliente', () => {
  const cases: [string, RegExp | undefined][] = [
    ["config loaded for site 'x'\r\nbringing up tunnel ...\r\nnegotiation timout occurred\r\ntunnel disabled", /tempo esgotado/],
    ['config error : phase1-hash undefined', /falta "phase1-hash"/],
    ['failed to attach to key daemon', /IKE Daemon/],
    ['user authentication error', /usuário ou senha/],
    ["failed to load 'x'", /"x" não encontrado/],
    ['bringing up tunnel ...\r\ntunnel enabled', undefined],
  ];
  for (const [log, re] of cases) {
    const msg = shrewErrorMessage(log);
    if (re) assert.match(msg ?? '', re, log);
    else assert.equal(msg, undefined);
  }
});

test('shrewPhase deduz o estado pelos botões da janela', () => {
  assert.equal(shrewPhase({ connect: 'Disconnect', connectEnabled: true, cancel: 'Exit', log: '' }), 'connected');
  assert.equal(shrewPhase({ connect: 'Connect', connectEnabled: false, cancel: 'Cancel', log: '' }), 'connecting');
  assert.equal(shrewPhase({ connect: 'Connect', connectEnabled: true, cancel: 'Exit', log: '' }), 'idle');
});

test('parseVpnNetworks fica com as redes úteis do adaptador', () => {
  const json = JSON.stringify({
    ip: '10.255.0.7',
    routes: ['10.0.0.0/8', '255.255.255.255/32', '224.0.0.0/4', '10.255.0.7/32', '172.16.0.0/12', '169.254.0.0/16', '0.0.0.0/0', '10.0.0.0/8'],
  });
  assert.deepEqual(parseVpnNetworks(json), { ip: '10.255.0.7', networks: ['10.0.0.0/8', '172.16.0.0/12'] });
  assert.deepEqual(parseVpnNetworks('{"routes":"192.168.5.0/24"}'), { networks: ['192.168.5.0/24'] });
  assert.deepEqual(parseVpnNetworks('{}'), { networks: [] });
  assert.deepEqual(parseVpnNetworks('lixo'), { networks: [] });
});

test('campo vpn da sessão: validado e gravado no YAML', () => {
  const [s] = parseSessions('sessions:\n  - {name: srv, host: 10.0.0.5, vpn: Matriz}');
  assert.equal(s.vpn, 'Matriz');
  assert.match(serializeSessions([s]), /vpn: Matriz/);
  assert.throws(() => parseSessions('sessions:\n  - {name: srv, host: h, vpn: "a/b"}'), /"vpn" inválido/);
});

/** Controlador falso: guarda o que o app escreve e deixa o teste emitir estados. */
function fakeController() {
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const written: string[] = [];
  let ended = false;
  const proc: ControllerProcess = {
    stdin: {
      write: (s: string) => written.push(s),
      end: () => {
        ended = true;
        setTimeout(() => {
          state('Connect', 'Exit', 'tunnel disabled');
          stdout.write('{"event":"exited"}\n');
          events.emit('exit', 0);
        }, 5);
      },
    },
    stdout,
    on: (ev, cb) => events.on(ev, cb),
    kill: () => events.emit('exit', null),
  };
  const state = (connect: string, cancel: string, log: string) =>
    stdout.write(`${JSON.stringify({ event: 'state', connect, connectEnabled: true, cancel, log })}\n`);
  return { proc, written, state, emit: (o: object) => stdout.write(`${JSON.stringify(o)}\n`), isEnded: () => ended };
}

const req = { exe: 'ipsecc.exe', site: 'Matriz', user: 'ana', password: 'p@ss "x"' };

test('ShrewConnection: conecta, informa o estado e desconecta', async () => {
  const fake = fakeController();
  const c = new ShrewConnection(req, () => fake.proc);
  const states: VpnStatus['state'][] = [];
  c.on('status', (s: VpnStatus) => states.push(s.state));
  const connected = c.connect();
  // A senha vai só no pedido em base64 pelo stdin.
  const sent = JSON.parse(Buffer.from(fake.written[0].trim(), 'base64').toString('utf8'));
  assert.deepEqual(sent, { exe: 'ipsecc.exe', site: 'Matriz', user: 'ana', password: 'p@ss "x"', show: false });
  fake.emit({ event: 'window', pid: 1 });
  fake.state('Connect', 'Cancel', 'bringing up tunnel ...');
  fake.state('Disconnect', 'Exit', 'bringing up tunnel ...\r\ntunnel enabled');
  await connected;
  assert.equal(c.status.state, 'connected');
  assert.ok(c.status.since);
  assert.equal(c.status.log, 'bringing up tunnel ...\ntunnel enabled');
  await c.disconnect();
  assert.ok(fake.isEnded());
  assert.equal(c.status.state, 'off');
  assert.equal(c.status.error, undefined);
  assert.deepEqual([...new Set(states)], ['connecting', 'connected', 'disconnecting', 'off']);
});

test('ShrewConnection: falha traduzida, queda do túnel e erro do controlador', async () => {
  let fake = fakeController();
  let c = new ShrewConnection(req, () => fake.proc);
  let p = c.connect();
  fake.state('Connect', 'Cancel', 'bringing up tunnel ...');
  fake.state('Connect', 'Exit', 'bringing up tunnel ...\r\nnegotiation timout occurred\r\ntunnel disabled');
  await assert.rejects(p, /o gateway não respondeu \(tempo esgotado\)/);
  assert.equal(c.status.state, 'off');

  fake = fakeController();
  c = new ShrewConnection(req, () => fake.proc);
  const errors: string[] = [];
  c.on('status', (s: VpnStatus) => s.error && errors.push(s.error));
  p = c.connect();
  fake.state('Disconnect', 'Exit', 'tunnel enabled');
  await p;
  fake.state('Connect', 'Exit', 'tunnel enabled\r\ntunnel disabled');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.status.state, 'off');
  assert.ok(errors.includes('a VPN caiu'));

  fake = fakeController();
  c = new ShrewConnection(req, () => fake.proc);
  p = c.connect();
  fake.emit({ event: 'error', message: 'a janela do cliente do Shrew não apareceu' });
  await assert.rejects(p, /não apareceu/);
});

test('ShrewConnection: cancelar durante a conexão', async () => {
  const fake = fakeController();
  const c = new ShrewConnection(req, () => fake.proc);
  const p = c.connect();
  fake.state('Connect', 'Cancel', 'bringing up tunnel ...');
  await new Promise((r) => setTimeout(r, 10));
  await c.disconnect();
  await assert.rejects(p, /conexão cancelada/);
  assert.equal(c.status.state, 'off');
});

// Com o Shrew instalado: tenta um gateway que não responde (192.0.2.1, rede de documentação) e
// cancela; confere que o cliente abre, negocia e fecha sem sobrar processo.
const IPSECC = 'C:/Program Files/ShrewSoft/VPN Client/ipsecc.exe';
test('Shrew real: abre o cliente, negocia e cancela', { skip: !existsSync(IPSECC) && 'Shrew Soft VPN não instalado', timeout: 90_000 }, async () => {
  const dir = join(process.env.LOCALAPPDATA ?? '', 'Shrew Soft VPN', 'sites');
  const name = `multterm-teste-${process.pid}`;
  const site = [
    's:network-host:192.0.2.1', 'n:network-ike-port:500', 's:client-auto-mode:pull', 's:client-iface:virtual',
    'n:client-addr-auto:1', 's:auth-method:mutual-psk-xauth', 's:ident-client-type:address', 's:ident-server-type:address',
    'b:auth-mutual-psk:dGVzdGU=', 's:phase1-exchange:aggressive', 's:phase1-cipher:auto', 's:phase1-hash:auto',
    'n:phase1-dhgroup:2', 'n:phase1-keylen:0', 'n:phase1-life-secs:86400', 's:phase2-transform:auto', 's:phase2-hmac:auto',
    'n:phase2-keylen:0', 'n:phase2-pfsgroup:0', 'n:phase2-life-secs:3600', 's:ipcomp-transform:disabled',
    's:network-natt-mode:enable', 'n:network-natt-port:4500', 'n:network-natt-rate:15', 's:network-frag-mode:disable',
    'n:network-dpd-enable:1', 'n:network-mtu-size:1380', 'n:policy-level:0', 'n:policy-nailed:0', 'n:policy-list-auto:1',
    'n:client-dns-used:0', 'n:client-wins-used:0', 'n:client-banner-enable:0', 'n:network-notify-enable:1', 'n:version:4', '',
  ].join('\n');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), site);
  try {
    const c = new ShrewConnection({ exe: IPSECC, site: name, user: 'usuário', password: 'senha' });
    const negotiating = new Promise<void>((resolve) => c.on('status', (s: VpnStatus) => {
      if (/bringing up tunnel/.test(s.log)) resolve();
    }));
    const p = c.connect();
    p.catch(() => {});
    await negotiating;
    await c.disconnect();
    await assert.rejects(p, /conexão cancelada/);
    assert.match(c.status.log, /pre-shared key configured/);
  } finally {
    await rm(join(dir, name), { force: true });
  }
});

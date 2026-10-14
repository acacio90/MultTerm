import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHost, listenOptions, resolveInRoot } from '../src/servers/common.ts';
import { fromNetascii, parseRequest, startTftp, toNetascii, validateTftp } from '../src/servers/tftp.ts';

const CURL = 'C:/Windows/System32/curl.exe';
const hasCurl = existsSync(CURL);
const curl = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
  execFile(CURL, ['-s', '-S', ...args], { encoding: 'latin1', maxBuffer: 1 << 26, timeout: 60_000 }, (e, out, err) => {
    resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out, err });
  });
});

async function tmp() {
  const root = await mkdtemp(join(tmpdir(), 'multterm-srv-'));
  await mkdir(join(root, 'sub'));
  return realpath(root); // o tmpdir pode vir com nome curto (8.3), como no CI
}

test('resolveInRoot não deixa sair da raiz', async () => {
  const root = await tmp();
  try {
    await writeFile(join(root, 'a.txt'), 'x');
    await writeFile(join(root, 'sub', 'b.txt'), 'y');
    assert.equal(await resolveInRoot(root, 'a.txt'), join(root, 'a.txt'));
    assert.equal(await resolveInRoot(root, '/sub/b.txt'), join(root, 'sub', 'b.txt'));
    assert.equal(await resolveInRoot(root, '\\sub\\b.txt'), join(root, 'sub', 'b.txt'));
    for (const bad of ['../x', 'sub/../../x', '..\\x', 'C:\\Windows\\win.ini', 'c:/x', 'a\0b']) {
      assert.equal(await resolveInRoot(root, bad, false), undefined, bad);
    }
    assert.equal(await resolveInRoot(root, 'nao-existe.bin'), undefined);
    assert.equal(await resolveInRoot(root, 'novo.bin', false), join(root, 'novo.bin'));
    assert.equal(await resolveInRoot(root, 'pasta-inexistente/novo.bin', false), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TFTP: pedido, netascii e validação', () => {
  const req = parseRequest(Buffer.concat([Buffer.from([0, 1]), Buffer.from('fw.bin\0octet\0BLKSIZE\x001428\0tsize\x000\0', 'latin1')]));
  assert.deepEqual(req, { file: 'fw.bin', mode: 'octet', options: new Map([['blksize', '1428'], ['tsize', '0']]) });
  assert.equal(parseRequest(Buffer.from([0, 1, 0])), undefined);
  const text = Buffer.from('a\nb\rc');
  assert.deepEqual(toNetascii(text), Buffer.from('a\r\nb\r\0c'));
  assert.deepEqual(fromNetascii(toNetascii(text)), text);
  assert.throws(() => validateTftp({ root: 'relativo' }), /pasta raiz/);
  assert.throws(() => validateTftp({ root: tmpdir(), port: 70000 }), /porta/);
  assert.throws(() => validateTftp({ root: tmpdir(), maxBlockSize: 4 }), /bloco/);
  assert.equal(validateTftp({ root: tmpdir() }).port, 69);
});

test('TFTP com o curl: download, upload, blocos grandes, volta do bloco e fora da raiz', { skip: !hasCurl && 'sem curl' }, async () => {
  const root = await tmp();
  const logs: string[] = [];
  const transfers: string[] = [];
  const srv = await startTftp({ root, port: 0, host: '127.0.0.1', onTransfer: (t) => transfers.push(`${t.dir}:${t.file}:${t.bytes}`) }, (l) => logs.push(l));
  try {
    const url = (p: string) => `tftp://127.0.0.1:${srv.port}/${p}`;
    const small = randomBytes(1500);
    await writeFile(join(root, 'cfg.txt'), small);
    let r = await curl([url('cfg.txt')]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(Buffer.from(r.out, 'latin1'), small);

    // 40 MB com blocos de 512: mais de 65535 blocos (o número volta para 0).
    const big = randomBytes(40 * 1024 * 1024);
    await writeFile(join(root, 'sub', 'firmware.bin'), big);
    const outFile = join(root, 'baixado.bin');
    r = await curl(['--tftp-blksize', '512', '-o', outFile, url('sub/firmware.bin')]);
    assert.equal(r.code, 0, r.err);
    assert.ok((await readFile(outFile)).equals(big));
    r = await curl(['--tftp-blksize', '8192', '-o', outFile, url('sub/firmware.bin')]);
    assert.equal(r.code, 0, r.err);
    assert.ok((await readFile(outFile)).equals(big));

    const up = join(root, 'local.bin');
    const upData = randomBytes(70_000);
    await writeFile(up, upData);
    r = await curl(['-T', up, url('enviado.bin')]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await readFile(join(root, 'enviado.bin')), upData);

    r = await curl([url('nao-existe.bin')]);
    assert.notEqual(r.code, 0);
    r = await curl([url('..%2F..%2Fwindows%2Fwin.ini')]);
    assert.notEqual(r.code, 0);
    assert.ok(transfers.includes('download:cfg.txt:1500'));
    assert.ok(transfers.includes('upload:enviado.bin:70000'));
    assert.ok(logs.some((l) => /nao-existe\.bin.*fora da raiz ou inexistente/.test(l)));
  } finally {
    await srv.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('TFTP: envio desativado e sem sobrescrever', { skip: !hasCurl && 'sem curl' }, async () => {
  const root = await tmp();
  await writeFile(join(root, 'existe.bin'), 'original');
  const up = join(root, 'up.bin');
  await writeFile(up, 'novo');
  try {
    let srv = await startTftp({ root, port: 0, host: '127.0.0.1', allowUpload: false }, () => {});
    let r = await curl(['-T', up, `tftp://127.0.0.1:${srv.port}/x.bin`]);
    assert.notEqual(r.code, 0);
    await srv.stop();
    srv = await startTftp({ root, port: 0, host: '127.0.0.1', allowOverwrite: false }, () => {});
    r = await curl(['-T', up, `tftp://127.0.0.1:${srv.port}/existe.bin`]);
    assert.notEqual(r.code, 0);
    assert.equal(await readFile(join(root, 'existe.bin'), 'utf8'), 'original');
    await srv.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP: arquivos, Range, HEAD, listagem e raiz protegida', async () => {
  const { startHttp, parseRange } = await import('../src/servers/http.ts');
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=200-', 100), null);
  assert.equal(parseRange(undefined, 100), undefined);
  const root = await tmp();
  await writeFile(join(root, 'fw.bin'), Buffer.from('0123456789'));
  await writeFile(join(root, 'sub', "a&b'c.txt"), 'x');
  const logs: string[] = [];
  let srv = await startHttp({ root, port: 0, host: '127.0.0.1', listing: true }, (l) => logs.push(l));
  const base = () => `http://127.0.0.1:${srv.port}`;
  try {
    let r = await fetch(`${base()}/fw.bin`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '0123456789');
    r = await fetch(`${base()}/fw.bin`, { headers: { Range: 'bytes=2-4' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(await r.text(), '234');
    r = await fetch(`${base()}/fw.bin`, { method: 'HEAD' });
    assert.equal(r.headers.get('content-length'), '10');
    r = await fetch(`${base()}/sub/`);
    const html = await r.text();
    assert.match(html, />a&amp;b&#39;c\.txt</); // nome escapado
    assert.doesNotMatch(html, />a&b'c/);
    r = await fetch(`${base()}/sub`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal((await fetch(`${base()}/..%2F..%2Fwindows%2Fwin.ini`)).status, 404);
    assert.equal((await fetch(`${base()}/nao-existe`)).status, 404);
    assert.equal((await fetch(`${base()}/fw.bin`, { method: 'POST' })).status, 405);
    await srv.stop();
    srv = await startHttp({ root, port: 0, host: '127.0.0.1', listing: false }, () => {});
    assert.equal((await fetch(`${base()}/sub/`)).status, 403);
    await writeFile(join(root, 'sub', 'index.html'), '<p>ok</p>');
    assert.equal(await (await fetch(`${base()}/sub/`)).text(), '<p>ok</p>');
    assert.ok(logs.some((l) => /GET \/fw\.bin → 206/.test(l)));
  } finally {
    await srv.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('FTP com o curl: login, listagem, download, upload, retomada, renomear, apagar e raiz', { skip: !hasCurl && 'sem curl' }, async () => {
  const { startFtp, validateFtp } = await import('../src/servers/ftp.ts');
  assert.throws(() => validateFtp({ root: tmpdir(), user: '', password: '' }), /usuário e senha/);
  assert.equal(validateFtp({ root: tmpdir(), anonymous: true }).port, 21);
  const root = await tmp();
  await writeFile(join(root, 'fw.bin'), randomBytes(300_000));
  await writeFile(join(root, 'sub', 'nota.txt'), 'olá');
  const logs: string[] = [];
  const srv = await startFtp({ root, port: 0, host: '127.0.0.1', user: 'ana', password: 's3nha', anonymous: true }, (l) => logs.push(l));
  const base = `ftp://127.0.0.1:${srv.port}`;
  const auth = ['-u', 'ana:s3nha'];
  try {
    let r = await curl([...auth, `${base}/`]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /fw\.bin/);
    assert.match(r.out, /^d.* sub$/m);
    r = await curl([...auth, '--list-only', `${base}/sub/`]);
    assert.equal(r.out.trim(), 'nota.txt');
    const out = join(root, 'baixado.bin');
    r = await curl([...auth, '-o', out, `${base}/fw.bin`]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await readFile(out), await readFile(join(root, 'fw.bin')));
    r = await curl([...auth, '--ftp-port', '127.0.0.1', '-o', out, `${base}/sub/nota.txt`]); // modo ativo
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(out, 'utf8'), 'olá');
    r = await curl([...auth, '-r', '299990-', `${base}/fw.bin`]); // REST
    assert.equal(r.out.length, 10);

    const up = join(root, 'local.bin');
    await writeFile(up, randomBytes(123_456));
    r = await curl([...auth, '-T', up, `${base}/sub/enviado.bin`]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await readFile(join(root, 'sub', 'enviado.bin')), await readFile(up));
    r = await curl([...auth, '-Q', '-RNFR sub/enviado.bin', '-Q', '-RNTO sub/renomeado.bin', '-Q', '-DELE fw.bin', `${base}/`]);
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(join(root, 'sub', 'renomeado.bin')), true);
    assert.equal(existsSync(join(root, 'fw.bin')), false);

    // Senha errada, anônimo só leitura, fora da raiz.
    r = await curl(['-u', 'ana:errada', `${base}/`]);
    assert.notEqual(r.code, 0);
    r = await curl([`${base}/sub/nota.txt`]); // curl usa anonymous por padrão
    assert.equal(Buffer.from(r.out, 'latin1').toString('utf8'), 'olá');
    r = await curl(['-T', up, `${base}/anon.bin`]);
    assert.notEqual(r.code, 0);
    assert.equal(existsSync(join(root, 'anon.bin')), false);
    r = await curl([...auth, `${base}/../../windows/win.ini`]);
    assert.notEqual(r.code, 0);
    assert.ok(logs.some((l) => /senha errada para "ana"/.test(l)));
    assert.ok(logs.some((l) => /enviou \/sub\/enviado\.bin \(123456 bytes/.test(l)));
  } finally {
    await srv.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('FTPS implícito com certificado autoassinado', { skip: !hasCurl && 'sem curl', timeout: 120_000 }, async () => {
  const { startFtp } = await import('../src/servers/ftp.ts');
  const { ensureSelfSignedPfx } = await import('../src/servers/cert.ts');
  const root = await tmp();
  try {
    const cert = await ensureSelfSignedPfx(join(root, 'cert', 'ftps.pfx'), undefined);
    assert.equal(cert.created, true);
    const again = await ensureSelfSignedPfx(join(root, 'cert', 'ftps.pfx'), cert.passphrase);
    assert.equal(again.created, false);
    await writeFile(join(root, 'seguro.txt'), 'cifrado');
    const srv = await startFtp({ root, port: 0, host: '127.0.0.1', user: 'ana', password: 'x', tls: { pfx: cert.pfx, passphrase: cert.passphrase } }, () => {});
    try {
      const r = await curl(['-k', '-u', 'ana:x', `ftps://127.0.0.1:${srv.port}/seguro.txt`]);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, 'cifrado');
    } finally {
      await srv.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const IPERF3 = process.env.MULTTERM_IPERF3
  ?? join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages', 'ar51an.iPerf3_Microsoft.Winget.Source_8wekyb3d8bbwe', 'iperf3.exe');

test('Iperf com o cliente iperf3: envio, reverso, vários fluxos e UDP recusado', { skip: !existsSync(IPERF3) && 'iperf3 não instalado', timeout: 120_000 }, async () => {
  const { startIperf, validateIperf } = await import('../src/servers/iperf.ts');
  assert.equal(validateIperf({}).port, 5201);
  const logs: string[] = [];
  const srv = await startIperf({ port: 0, host: '127.0.0.1' }, (l) => logs.push(l));
  const run = (args: string[]) => new Promise<{ error?: string; end?: { sum_received: { bytes: number; bits_per_second: number } } }>((resolve) => {
    execFile(IPERF3, ['-c', '127.0.0.1', '-p', String(srv.port), '-t', '1', '-J', ...args], { timeout: 30_000, maxBuffer: 1 << 24 }, (_e, out) => resolve(JSON.parse(out)));
  });
  try {
    let r = await run([]);
    assert.equal(r.error, undefined);
    assert.ok(r.end!.sum_received.bytes > 1_000_000);
    r = await run(['-R']);
    assert.equal(r.error, undefined);
    assert.ok(r.end!.sum_received.bits_per_second > 100e6);
    r = await run(['-P', '3', '-l', '32K']);
    assert.equal(r.error, undefined);
    assert.ok(r.end!.sum_received.bytes > 1_000_000);
    r = await run(['-u']);
    assert.match(r.error ?? '', /not implemented/);
    assert.ok(logs.some((l) => /reverso \(servidor envia\), 1 fluxo/.test(l)));
    assert.ok(logs.some((l) => /3 fluxo\(s\)/.test(l)));
    assert.ok(logs.some((l) => /MB em .* s = .*bit\/s/.test(l)));
  } finally {
    await srv.stop();
  }
});

test('Telnet: comandos IAC, NAWS e fim de linha', async () => {
  const { parseTelnet, escapeIac, Tn, validateTelnet } = await import('../src/servers/telnet.ts');
  const naws = Buffer.from([Tn.IAC, Tn.SB, Tn.NAWS, 0, 120, 0, 40, Tn.IAC, Tn.SE]);
  const r = parseTelnet(Buffer.concat([Buffer.from([Tn.IAC, Tn.DO, Tn.ECHO]), Buffer.from('ab\r\0c\r\n'), naws, Buffer.from([Tn.IAC, Tn.IAC]), Buffer.from('x\r')]));
  assert.deepEqual(r.data, Buffer.from([0x61, 0x62, 0x0d, 0x63, 0x0d, 0xff, 0x78]));
  assert.deepEqual(r.sizes, [{ cols: 120, rows: 40 }]);
  assert.deepEqual(r.rest, Buffer.from('\r')); // CR no fim espera o próximo pedaço
  assert.deepEqual(parseTelnet(Buffer.from([Tn.IAC, Tn.SB, Tn.NAWS, 0])).rest.length, 4); // incompleto
  assert.deepEqual(escapeIac(Buffer.from([1, 255, 2])), Buffer.from([1, 255, 255, 2]));
  assert.throws(() => validateTelnet({ password: '' }), /senha/);
  assert.equal(validateTelnet({ password: 'abcd' }).port, 23);
});

test('Telnet: senha, shell pelo ConPTY e saída', { timeout: 60_000 }, async () => {
  const { startTelnet } = await import('../src/servers/telnet.ts');
  const { connect } = await import('node:net');
  const logs: string[] = [];
  const srv = await startTelnet({ port: 0, host: '127.0.0.1', password: 'segredo', shell: 'cmd', cwd: tmpdir() }, (l) => logs.push(l));
  try {
    const sock = connect(srv.port, '127.0.0.1');
    let text = '';
    sock.on('data', (d: Buffer) => { text += d.toString('latin1'); });
    const until = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(text); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(text, re);
    };
    await until(/Senha: $/);
    sock.write(Buffer.from([255, 250, 31, 0, 100, 0, 30, 255, 240])); // NAWS 100x30
    sock.write('errada\r\n');
    await until(/Senha incorreta\.\r\nSenha: $/);
    text = '';
    sock.write('segredo\r\n');
    await until(/>/); // prompt do cmd
    sock.write('set /a 40+2\r\n');
    await until(/\b42\b/);
    const closed = new Promise((r) => sock.on('close', r));
    sock.write('exit\r\n');
    await closed;
    assert.ok(logs.some((l) => /senha errada/.test(l)));
    assert.ok(logs.some((l) => /login feito/.test(l)));
  } finally {
    await srv.stop();
  }
});

test('endereço de escuta: vazio = todas; só IP literal; opções com as placas desta máquina', () => {
  assert.equal(checkHost(''), undefined);
  assert.equal(checkHost(undefined), undefined);
  assert.equal(checkHost(' 127.0.0.1 '), '127.0.0.1');
  assert.equal(checkHost('::1'), '::1');
  assert.throws(() => checkHost('meu-pc'), /endereço de escuta inválido/);
  assert.throws(() => checkHost('10.0.0.300'), /endereço de escuta inválido/);
  const ifaces = {
    Ethernet: [
      { address: '10.0.0.5', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '10.0.0.5/24' },
      { address: 'fe80::1', family: 'IPv6', internal: false, netmask: 'ffff::', mac: '00:00:00:00:00:01', cidr: 'fe80::1/64', scopeid: 1 },
    ],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' }],
  } as unknown as ReturnType<typeof import('node:os').networkInterfaces>;
  assert.deepEqual(listenOptions('', ifaces), [
    ['', 'Todas as interfaces'], ['127.0.0.1', 'Só esta máquina (127.0.0.1)'], ['10.0.0.5', 'Ethernet (10.0.0.5)'],
  ]);
  // Endereço gravado que sumiu continua visível, marcado.
  assert.deepEqual(listenOptions('192.168.1.9', ifaces).at(-1), ['192.168.1.9', '192.168.1.9 (não disponível agora)']);
});

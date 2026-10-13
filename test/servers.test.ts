import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInRoot } from '../src/servers/common.ts';
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
  return root;
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

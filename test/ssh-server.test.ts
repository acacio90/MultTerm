import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHostKey, startSsh, validateSsh } from '../src/servers/ssh.ts';

const SSH = 'C:/Windows/System32/OpenSSH/ssh.exe';
const SFTP = 'C:/Windows/System32/OpenSSH/sftp.exe';
const hasOpenSsh = existsSync(SSH) && existsSync(SFTP);

/** Roda o ssh/sftp do Windows com a senha via SSH_ASKPASS (sem terminal). */
function run(exe: string, args: string[], dir: string, password: string, input = '') {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const askpass = join(dir, 'askpass.cmd');
    void writeFile(askpass, `@echo ${password}\r\n`).then(() => {
      const p = spawn(exe, ['-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
        '-o', 'PreferredAuthentications=password', '-o', 'NumberOfPasswordPrompts=1', ...args], {
        env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'x' },
        windowsHide: true,
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, out, err }));
      p.stdin.end(input);
    });
  });
}

test('validação e chave de host reutilizada', async () => {
  assert.throws(() => validateSsh({ root: tmpdir(), user: '', password: 'abcdef' }), /usuário/);
  assert.throws(() => validateSsh({ root: tmpdir(), user: 'ana', password: '123' }), /senha/);
  assert.equal(validateSsh({ root: tmpdir(), user: 'ana', password: 'abcdef' }).port, 22);
  const dir = await mkdtemp(join(tmpdir(), 'multterm-hostkey-'));
  try {
    const a = await ensureHostKey(join(dir, 'k', 'ssh_host_ed25519'));
    const b = await ensureHostKey(join(dir, 'k', 'ssh_host_ed25519'));
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.fingerprint, b.fingerprint);
    assert.match(a.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    // Muitas chaves seguidas: o gerador do ssh2 erra 1 em 256; nenhuma pode sair malformada.
    for (let i = 0; i < 600; i++) {
      const p = join(dir, 'n', String(i));
      assert.equal((await ensureHostKey(p)).created, true);
    }
    // Chave gravada que não pode ser lida: fica guardada e uma nova é gerada.
    const bad = join(dir, 'k', 'ruim');
    await writeFile(bad, '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
    const c = await ensureHostKey(bad);
    assert.equal(c.created, true);
    assert.match(await readFile(`${bad}.invalida`, 'utf8'), /AAAA/);
    assert.equal((await ensureHostKey(bad)).fingerprint, c.fingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SSH/SFTP com o OpenSSH do Windows: comando, envio, download, listagem, renomear e raiz', { skip: !hasOpenSsh && 'sem OpenSSH', timeout: 120_000 }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'multterm-ssh-')));
  const root = join(dir, 'raiz');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'config.txt'), 'hostname sw-01\n');
  const local = join(dir, 'local.bin');
  await writeFile(local, Buffer.alloc(200_000, 7));
  const { key } = await ensureHostKey(join(dir, 'hostkey'));
  const logs: string[] = [];
  const srv = await startSsh({ root, port: 0, host: '127.0.0.1', user: 'tecnico', password: 'senha-123', shell: 'cmd', hostKey: key }, (l) => logs.push(l));
  const target = ['-p', String(srv.port), 'tecnico@127.0.0.1'];
  try {
    let r = await run(SSH, [...target, 'echo ok-via-ssh'], dir, 'senha-123');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ok-via-ssh/);

    const sftpTarget = ['-P', String(srv.port), 'tecnico@127.0.0.1'];
    const out = join(dir, 'baixado.txt');
    r = await run(SFTP, sftpTarget, dir, 'senha-123', [
      `put "${local}" sub/enviado.bin`,
      `get config.txt "${out}"`,
      'mkdir nova',
      'rename sub/enviado.bin sub/renomeado.bin',
      'ls sub',
      'get ../../windows/win.ini nada.ini',
      'bye',
    ].join('\n'));
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(out, 'utf8'), 'hostname sw-01\n');
    assert.deepEqual(await readFile(join(root, 'sub', 'renomeado.bin')), await readFile(local));
    assert.ok(existsSync(join(root, 'nova')));
    assert.match(r.out, /renomeado\.bin/);
    assert.match(r.err, /not found|No such file/i); // fora da raiz
    assert.ok(!existsSync(join(dir, 'nada.ini')));

    r = await run(SSH, [...target, 'echo x'], dir, 'errada');
    assert.notEqual(r.code, 0);
    assert.ok(logs.some((l) => /senha errada para "tecnico"/.test(l)));
    assert.ok(logs.some((l) => /SFTP enviou \/sub\/enviado\.bin \(200000 bytes\)/.test(l)));
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

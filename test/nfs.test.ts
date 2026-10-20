import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clientAllowed, NFS_PROGRAMS, parseCidr, startNfs, validateNfs } from '../src/servers/nfs.ts';
import { XdrReader, XdrWriter } from '../src/servers/rpc.ts';

const { PORTMAP, MOUNT, NFS } = NFS_PROGRAMS;

const freeTcpPort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});

/** Porta livre em TCP e em UDP (o Windows reserva faixas de portas só para um dos protocolos). */
async function freePort(): Promise<number> {
  for (;;) {
    const p = await freeTcpPort();
    const udp = createSocket('udp4');
    const ok = await new Promise<boolean>((resolve) => {
      udp.once('error', () => resolve(false));
      udp.bind(p, '127.0.0.1', () => resolve(true));
    });
    await new Promise<void>((r) => (ok ? udp.close(() => r()) : r()));
    if (ok) return p;
  }
}

let xidSeq = 1;

/** Chamada RPC (AUTH_UNIX) por UDP ou TCP; devolve o leitor do resultado ou o accept_stat de erro. */
async function rpc(transport: 'udp' | 'tcp', port: number, prog: number, vers: number, proc: number, args = Buffer.alloc(0)) {
  const xid = xidSeq++;
  const cred = new XdrWriter().u32(0).string('teste').u32(0).u32(0).u32(0).toBuffer();
  const call = new XdrWriter().u32(xid).u32(0).u32(2).u32(prog).u32(vers).u32(proc)
    .u32(1).opaque(cred).u32(0).u32(0).raw(args).toBuffer();
  const reply = transport === 'udp'
    ? await new Promise<Buffer>((resolve, reject) => {
      const s = createSocket('udp4');
      const t = setTimeout(() => { s.close(); reject(new Error('timeout UDP')); }, 3000);
      s.on('message', (m) => { clearTimeout(t); s.close(); resolve(m); });
      s.send(call, port, '127.0.0.1');
    })
    : await new Promise<Buffer>((resolve, reject) => {
      const s = connect(port, '127.0.0.1');
      let buf = Buffer.alloc(0);
      s.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= 4 && buf.length >= 4 + (buf.readUInt32BE(0) & 0x7fffffff)) {
          s.end();
          resolve(buf.subarray(4, 4 + (buf.readUInt32BE(0) & 0x7fffffff)));
        }
      });
      s.on('error', reject);
      const head = Buffer.alloc(4);
      head.writeUInt32BE((0x80000000 | call.length) >>> 0);
      s.write(Buffer.concat([head, call]));
    });
  const r = new XdrReader(reply);
  assert.equal(r.u32(), xid);
  assert.equal(r.u32(), 1); // REPLY
  assert.equal(r.u32(), 0); // aceito
  r.u32(); r.opaque(); // verificador
  const stat = r.u32();
  return { stat, r };
}

const fhArg = (fh: Buffer) => new XdrWriter().opaque(fh);

async function setup(extra: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'multterm-nfs-')));
  await mkdir(join(root, 'boot'));
  await mkdir(join(root, 'sub'));
  const kernel = randomBytes(100 * 1024);
  await writeFile(join(root, 'boot', 'kernel.bin'), kernel);
  await writeFile(join(root, 'readme.txt'), 'olá NFS\n');
  for (let i = 0; i < 40; i++) await writeFile(join(root, 'sub', `arquivo-${String(i).padStart(2, '0')}.txt`), `${i}`);
  const portmapPort = await freePort();
  const log: string[] = [];
  const server = await startNfs(validateNfs({ root, port: 0, host: '127.0.0.1', portmapPort, ...extra }), (l) => log.push(l));
  return { root, kernel, server, port: server.port, portmapPort, log };
}

async function mountRoot(port: number, transport: 'udp' | 'tcp' = 'tcp') {
  const { stat, r } = await rpc(transport, port, MOUNT, 3, 1, new XdrWriter().string('/').toBuffer());
  assert.equal(stat, 0);
  assert.equal(r.u32(), 0); // MNT3_OK
  return Buffer.from(r.opaque());
}

async function lookup(port: number, dir: Buffer, name: string) {
  const { r } = await rpc('tcp', port, NFS, 3, 3, fhArg(dir).string(name).toBuffer());
  const status = r.u32();
  return { status, fh: status === 0 ? Buffer.from(r.opaque()) : undefined };
}

test('NFS: validação e clientes permitidos', () => {
  assert.deepEqual(parseCidr('10.0.0.0/24'), { net: 0x0a000000, mask: 0xffffff00 });
  assert.equal(parseCidr('10.0.0.0/33'), undefined);
  assert.equal(parseCidr('meu-pc'), undefined);
  assert.equal(clientAllowed('10.0.0.7', ['10.0.0.0/24']), true);
  assert.equal(clientAllowed('::ffff:10.0.0.7', ['10.0.0.0/24']), true);
  assert.equal(clientAllowed('10.0.1.7', ['10.0.0.0/24', '192.168.1.5']), false);
  assert.equal(clientAllowed('192.168.1.5', ['10.0.0.0/24', '192.168.1.5']), true);
  assert.equal(clientAllowed('1.2.3.4', []), true);
  assert.throws(() => validateNfs({ root: 'C:\\x', allow: '10.0.0.0/24, xpto' }), /cliente permitido inválido: xpto/);
  assert.deepEqual(validateNfs({ root: 'C:\\x', allow: '10.0.0.0/24; 10.1.1.1' }).allow, ['10.0.0.0/24', '10.1.1.1']);
});

test('NFS: portmapper, montagem, leitura e listagem (UDP e TCP), somente leitura', async () => {
  const { root, kernel, server, port, portmapPort, log } = await setup();
  try {
    // Portmapper v2: acha o MOUNT e o NFS; v4 (rpcbind) recebe PROG_MISMATCH 2..2.
    const gp = (prog: number, vers: number, prot: number) => new XdrWriter().u32(prog).u32(vers).u32(prot).u32(0).toBuffer();
    let res = await rpc('udp', portmapPort, PORTMAP, 2, 3, gp(MOUNT, 3, 17));
    assert.equal(res.r.u32(), port);
    res = await rpc('tcp', portmapPort, PORTMAP, 2, 3, gp(NFS, 3, 6));
    assert.equal(res.r.u32(), port);
    res = await rpc('udp', portmapPort, PORTMAP, 2, 3, gp(NFS, 4, 6));
    assert.equal(res.r.u32(), 0); // NFSv4 não existe aqui
    res = await rpc('udp', portmapPort, PORTMAP, 4, 3, gp(NFS, 3, 6));
    assert.equal(res.stat, 2);
    assert.deepEqual([res.r.u32(), res.r.u32()], [2, 2]);

    // MOUNT v3 e EXPORT.
    const rootFh = await mountRoot(port);
    assert.equal(rootFh.length, 16);
    assert.ok(log.some((l) => /127\.0\.0\.1 montou \//.test(l)));
    res = await rpc('udp', port, MOUNT, 3, 5);
    assert.equal(res.r.bool(), true);
    assert.equal(res.r.string(), '/');

    // LOOKUP + GETATTR.
    const boot = await lookup(port, rootFh, 'boot');
    assert.equal(boot.status, 0);
    const k = await lookup(port, boot.fh!, 'kernel.bin');
    assert.equal(k.status, 0);
    res = await rpc('udp', port, NFS, 3, 1, fhArg(k.fh!).toBuffer());
    assert.equal(res.r.u32(), 0);
    assert.equal(res.r.u32(), 1); // NF3REG
    assert.equal(res.r.u32(), 0o444);
    res.r.u32(); res.r.u32(); res.r.u32();
    assert.equal(res.r.u64(), BigInt(kernel.length));
    assert.equal((await lookup(port, rootFh, 'nao-existe')).status, 2);

    // READ em pedaços, alternando UDP e TCP.
    const parts: Buffer[] = [];
    for (let off = 0, i = 0; ; i++) {
      const args = fhArg(k.fh!).u64(off).u32(32768).toBuffer();
      const { r } = await rpc(i % 2 ? 'udp' : 'tcp', port, NFS, 3, 6, args);
      assert.equal(r.u32(), 0);
      if (r.bool()) for (let j = 0; j < 21; j++) r.u32(); // fattr3 = 84 bytes
      const count = r.u32();
      const eof = r.bool();
      const data = Buffer.from(r.opaque());
      assert.equal(data.length, count);
      parts.push(data);
      off += count;
      if (eof) break;
    }
    assert.deepEqual(Buffer.concat(parts), kernel);
    assert.ok(log.some((l) => l.includes('lendo /boot/kernel.bin (102400 bytes)')));

    // READDIRPLUS com paginação (resposta pequena força várias chamadas pelo cookie).
    const sub = await lookup(port, rootFh, 'sub');
    const names: string[] = [];
    let cookie = 0n;
    let calls = 0;
    for (;;) {
      calls++;
      const args = fhArg(sub.fh!).u64(cookie).fixed(Buffer.alloc(8)).u32(1024).u32(1024).toBuffer();
      const { r } = await rpc('tcp', port, NFS, 3, 17, args);
      assert.equal(r.u32(), 0);
      if (r.bool()) for (let j = 0; j < 21; j++) r.u32();
      r.fixed(8);
      while (r.bool()) {
        r.u64();
        names.push(r.string());
        cookie = r.u64();
        if (r.bool()) for (let j = 0; j < 21; j++) r.u32();
        if (r.bool()) r.opaque();
      }
      if (r.bool()) break;
    }
    assert.ok(calls > 1, 'esperava paginação');
    assert.equal(names.length, 42); // ".", ".." e 40 arquivos
    assert.deepEqual(names.slice(0, 3), ['.', '..', 'arquivo-00.txt']);

    // Nunca sai da raiz: ".." na raiz é a própria raiz; nomes com barra são recusados.
    const up = await lookup(port, rootFh, '..');
    assert.equal(up.status, 0);
    assert.deepEqual(up.fh, rootFh);
    assert.equal((await lookup(port, rootFh, '../etc')).status, 22);
    assert.equal((await lookup(port, rootFh, '..\\windows')).status, 22);

    // Somente leitura.
    res = await rpc('tcp', port, NFS, 3, 7, fhArg(k.fh!).u64(0).u32(1).u32(2).opaque(Buffer.from('x')).toBuffer());
    assert.equal(res.r.u32(), 30); // NFS3ERR_ROFS
    res = await rpc('tcp', port, NFS, 3, 12, fhArg(rootFh).string('readme.txt').toBuffer());
    assert.equal(res.r.u32(), 30);

    // Identificador de outra execução: STALE.
    const old = Buffer.from(rootFh);
    old[0] ^= 0xff;
    res = await rpc('tcp', port, NFS, 3, 1, fhArg(old).toBuffer());
    assert.equal(res.r.u32(), 70);

    // MOUNT v1: identificador fixo de 32 bytes.
    res = await rpc('udp', port, MOUNT, 1, 1, new XdrWriter().string('/').toBuffer());
    assert.equal(res.r.u32(), 0);
    assert.equal(res.r.fixed(32).length, 32);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('NFS: cliente fora da lista de permitidos não monta', async () => {
  const { root, server, port, log } = await setup({ allow: '10.0.0.0/8' });
  try {
    const { r } = await rpc('tcp', port, MOUNT, 3, 1, new XdrWriter().string('/').toBuffer());
    assert.equal(r.u32(), 13); // MNT3ERR_ACCES
    assert.ok(log.some((l) => l.includes('montagem recusada para 127.0.0.1')));
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('NFS: portmapper ocupado dá erro claro', async () => {
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
  const busyPort = (busy.address() as { port: number }).port;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'multterm-nfs-')));
  try {
    await assert.rejects(startNfs(validateNfs({ root, port: 0, host: '127.0.0.1', portmapPort: busyPort }), () => {}), /portmapper\) já está em uso/);
  } finally {
    busy.close();
    await rm(root, { recursive: true, force: true });
  }
});

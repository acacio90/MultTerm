import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countPcapngPackets, findPktmon, pktmonScript, psQuote, runPktmonCapture, validatePktmonRequest, type Elevate,
} from '../src/network/pktmon.ts';

/** pcapng mínimo: SHB + IDB + um EPB por pacote. */
function pcapng(packets: number, bigEndian = false): Buffer {
  const block = (type: number, body: Buffer) => {
    const len = 12 + body.length;
    const b = Buffer.alloc(len);
    const w = (v: number, o: number) => (bigEndian ? b.writeUInt32BE(v, o) : b.writeUInt32LE(v, o));
    w(type, 0);
    w(len, 4);
    body.copy(b, 8);
    w(len, len - 4);
    return b;
  };
  const u32 = (...vs: number[]) => {
    const b = Buffer.alloc(vs.length * 4);
    vs.forEach((v, i) => (bigEndian ? b.writeUInt32BE(v, i * 4) : b.writeUInt32LE(v, i * 4)));
    return b;
  };
  const shbBody = Buffer.concat([u32(0x1a2b3c4d), Buffer.from(bigEndian ? [0, 1, 0, 0] : [1, 0, 0, 0]), Buffer.alloc(8, 0xff)]);
  const shb = block(0x0a0d0d0a, shbBody);
  const idb = block(1, u32(1, 0)); // linktype 1 (Ethernet) + snaplen
  const epb = block(6, Buffer.concat([u32(0, 0, 0, 4, 4), Buffer.from([1, 2, 3, 4])]));
  return Buffer.concat([shb, idb, ...Array.from({ length: packets }, () => epb)]);
}

test('findPktmon procura em System32', () => {
  const path = join('C:\\Win', 'System32', 'PktMon.exe');
  assert.equal(findPktmon({ systemRoot: 'C:\\Win', fileExists: (p) => p === path }), path);
  assert.equal(findPktmon({ systemRoot: 'C:\\Win', fileExists: () => false }), undefined);
});

test('validatePktmonRequest aceita filtros opcionais e recusa valores inválidos', () => {
  assert.deepEqual(validatePktmonRequest({ ip: ' 10.0.0.5 ', port: '22', protocol: 'tcp', maxSeconds: '30' }),
    { ip: '10.0.0.5', port: 22, protocol: 'TCP', maxSeconds: 30 });
  assert.deepEqual(validatePktmonRequest({ ip: '', port: '', protocol: '', maxSeconds: '' }), {});
  assert.deepEqual(validatePktmonRequest({ ip: 'fe80::1' }), { ip: 'fe80::1' });
  assert.throws(() => validatePktmonRequest({ ip: "10.0.0.5'; Remove-Item C:\\" }), /IP inválido/);
  assert.throws(() => validatePktmonRequest({ port: '70000' }), /porta/);
  assert.throws(() => validatePktmonRequest({ protocol: 'GRE' }), /protocolo/);
  assert.throws(() => validatePktmonRequest({ maxSeconds: '0' }), /tempo/);
});

test('pktmonScript monta os comandos com literais entre aspas simples', () => {
  const files = {
    pktmon: 'C:\\Windows\\System32\\PktMon.exe',
    etl: "C:\\Users\\d'Ávila\\Capturas\\c.etl",
    pcapng: "C:\\Users\\d'Ávila\\Capturas\\c.pcapng",
    status: 'C:\\s.status',
    stop: 'C:\\s.stop',
  };
  const script = pktmonScript(files, { ip: '10.0.0.5', port: 22, protocol: 'TCP', maxSeconds: 60 });
  assert.match(script, /Run @\('filter', 'add', 'MultTerm', '-i', '10\.0\.0\.5', '-p', '22', '-t', 'TCP'\)/);
  assert.ok(script.includes("Run @('start', '--capture', '--comp', 'nics', '--pkt-size', '0', '-f', 'C:\\Users\\d''Ávila\\Capturas\\c.etl')"));
  assert.ok(script.includes("Run @('etl2pcap', 'C:\\Users\\d''Ávila\\Capturas\\c.etl', '--out', 'C:\\Users\\d''Ávila\\Capturas\\c.pcapng')"));
  assert.match(script, /\(Get-Date\)\.AddSeconds\(60\)/);
  const plain = pktmonScript(files, {});
  assert.doesNotMatch(plain, /filter', 'add/);
  assert.match(plain, /\[datetime\]::MaxValue/);
  assert.equal(psQuote("a'b"), "'a''b'");
});

test('countPcapngPackets conta os blocos de pacote (little e big endian)', () => {
  assert.equal(countPcapngPackets(pcapng(0)), 0);
  assert.equal(countPcapngPackets(pcapng(7)), 7);
  assert.equal(countPcapngPackets(pcapng(3, true)), 3);
  const truncated = pcapng(2);
  assert.equal(countPcapngPackets(truncated.subarray(0, truncated.length - 5)), 1);
  assert.throws(() => countPcapngPackets(Buffer.from('não é pcapng')), /pcapng inválido/);
});

/** Simula o script elevado: lê os caminhos do próprio .ps1 e segue o mesmo protocolo de arquivos. */
function fakeElevation(opts: { packets?: number; failWith?: string; never?: boolean } = {}): Elevate {
  return async (scriptPath) => {
    const { readFile } = await import('node:fs/promises');
    const script = await readFile(scriptPath, 'utf8');
    const lit = (re: RegExp) => script.match(re)![1].replace(/''/g, "'");
    const status = lit(/\$status = '((?:[^']|'')*)'/);
    const stop = lit(/Test-Path -LiteralPath '((?:[^']|'')*)'/);
    const etl = lit(/'-f', '((?:[^']|'')*)'/);
    const out = lit(/'--out', '((?:[^']|'')*)'/);
    if (opts.never) return;
    void (async () => {
      if (opts.failWith) return writeFile(status, `error: ${opts.failWith}`);
      await writeFile(etl, Buffer.alloc(2048));
      await writeFile(status, 'capturing');
      while (!existsSync(stop)) await new Promise((r) => setTimeout(r, 10));
      await writeFile(status, 'converting');
      await writeFile(out, pcapng(opts.packets ?? 0));
      await rm(etl, { force: true });
      await writeFile(status, 'done');
    })();
  };
}

test('runPktmonCapture: inicia, informa o tamanho, para pelo sinal e conta os pacotes', async () => {
  const dir = await mkdtemp(join(tmpdir(), "multterm-pktmon-d'x-"));
  try {
    const file = join(dir, 'multterm-captura-20260101-000000.pcapng');
    const ac = new AbortController();
    const sizes: number[] = [];
    const result = await runPktmonCapture({
      pktmon: 'PktMon.exe', file, workDir: dir, request: { port: 22 }, signal: ac.signal, pollMs: 10,
      elevate: fakeElevation({ packets: 5 }),
      onBytes: (n) => {
        sizes.push(n);
        if (n > 0) ac.abort();
      },
    });
    assert.deepEqual(result, { file, packets: 5 });
    assert.ok(sizes.includes(2048));
    // Script, status e pedido de parada são apagados; só o .pcapng fica.
    assert.deepEqual(await readdir(dir), ['multterm-captura-20260101-000000.pcapng']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runPktmonCapture: erro do script, UAC recusado e script que não inicia', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-pktmon-'));
  try {
    const file = join(dir, 'c.pcapng');
    const base = { pktmon: 'PktMon.exe', file, workDir: dir, request: {}, pollMs: 10 };
    await assert.rejects(runPktmonCapture({ ...base, elevate: fakeElevation({ failWith: 'Access is denied.' }) }),
      /o pktmon falhou: Access is denied\./);
    await assert.rejects(runPktmonCapture({ ...base, elevate: () => Promise.reject(new Error('a elevação foi recusada no UAC')) }),
      /recusada no UAC/);
    await assert.rejects(runPktmonCapture({ ...base, startTimeoutMs: 50, elevate: fakeElevation({ never: true }) }),
      /não iniciou/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

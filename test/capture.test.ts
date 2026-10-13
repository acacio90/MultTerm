import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  captureArgs, captureErrorMessage, captureFileName, findCaptureTools, parseInterfaces, parsePacketCount,
  runCapture, validateCapture,
} from '../src/network/capture.ts';

test('findCaptureTools procura o Wireshark nas pastas de programas', () => {
  const base = join('C:', 'PF');
  const present = new Set([join(base, 'Wireshark', 'dumpcap.exe')]);
  const tools = findCaptureTools({ programFiles: ['', base], fileExists: (p) => present.has(p) });
  assert.deepEqual(tools, { dumpcap: join(base, 'Wireshark', 'dumpcap.exe'), wireshark: undefined });
  assert.deepEqual(findCaptureTools({ programFiles: [base], fileExists: () => false }), { dumpcap: undefined, wireshark: undefined });
});

test('parseInterfaces lê a saída de "dumpcap -D"', () => {
  const out = [
    '1. \\Device\\NPF_{A1B2} (Ethernet)',
    '11. \\Device\\NPF_Loopback (Adapter for loopback traffic capture)',
    '12. etwdump (Event Tracing for Windows (ETW) reader)',
    'lixo',
  ].join('\r\n');
  assert.deepEqual(parseInterfaces(out), [
    { index: '1', device: '\\Device\\NPF_{A1B2}', name: 'Ethernet' },
    { index: '11', device: '\\Device\\NPF_Loopback', name: 'Adapter for loopback traffic capture' },
    { index: '12', device: 'etwdump', name: 'Event Tracing for Windows (ETW) reader' },
  ]);
});

test('validateCapture e captureArgs', () => {
  const req = validateCapture({ iface: '\\Device\\NPF_Loopback', filter: ' host 10.0.0.5 and port 22 ', maxPackets: '100', maxSeconds: '' });
  assert.deepEqual(req, { iface: '\\Device\\NPF_Loopback', filter: 'host 10.0.0.5 and port 22', maxPackets: 100, maxSeconds: undefined });
  assert.deepEqual(captureArgs(req, 'C:/x.pcapng'), ['-i', '\\Device\\NPF_Loopback', '-f', 'host 10.0.0.5 and port 22', '-c', '100', '-w', 'C:/x.pcapng']);
  assert.deepEqual(captureArgs({ iface: '3', filter: '', maxSeconds: 60 }, 'f'), ['-i', '3', '-a', 'duration:60', '-w', 'f']);
  assert.throws(() => validateCapture({ iface: '' }), /interface/);
  assert.throws(() => validateCapture({ iface: 'C:\\Windows' }), /interface/);
  assert.throws(() => validateCapture({ iface: '1', filter: '-w C:/outro' }), /filtro/);
  assert.throws(() => validateCapture({ iface: '1', filter: 'port 22\nport 23' }), /filtro/);
  assert.throws(() => validateCapture({ iface: '1', maxPackets: 0 }), /limite de pacotes/);
});

test('contagem, nome do arquivo e tradução de erros', () => {
  assert.equal(parsePacketCount('\rPackets: 1 \rPackets: 98 '), 98);
  assert.equal(parsePacketCount('Packets captured: 175\r\nPackets received/dropped'), 175);
  assert.equal(parsePacketCount('nada'), undefined);
  assert.equal(captureFileName(new Date(2026, 9, 13, 15, 4, 5)), 'multterm-captura-20261013-150405.pcapng');
  assert.match(captureErrorMessage('dumpcap: Invalid capture filter "x" for interface \'y\'.\r\n\r\nThat string isn\'t a valid capture filter (can\'t parse filter expression: syntax error).'), /^filtro de captura inválido/);
  assert.match(captureErrorMessage('dumpcap: The capture session could not be initiated on capture device "z".\r\nPlease check that you have the proper interface or pipe specified.'), /não foi possível abrir a interface/);
  assert.match(captureErrorMessage('You don\'t have permission to capture on that device'), /restrito a administradores/);
  assert.equal(captureErrorMessage('dumpcap: algo estranho\r\nPlease check that you have the proper interface'), 'o dumpcap falhou: algo estranho');
});

// Ponta a ponta: só roda onde há Wireshark/Npcap com o adaptador de loopback (não no CI).
const DUMPCAP = 'C:/Program Files/Wireshark/dumpcap.exe';
test('captura real no loopback, parada pelo cancelamento', { skip: !existsSync(DUMPCAP) && 'Wireshark não instalado' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-cap-'));
  try {
    const file = join(dir, 'teste.pcapng');
    const ctrl = new AbortController();
    const seen: number[] = [];
    const running = runCapture(DUMPCAP, validateCapture({ iface: '\\Device\\NPF_Loopback', filter: 'tcp port 9' }), file, {
      signal: ctrl.signal, onPackets: (n) => seen.push(n),
    });
    await new Promise((r) => setTimeout(r, 1500));
    // Conexões TCP recusadas na porta 9 geram SYN/RST no loopback (o fetch bloqueia a porta 9).
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => connect({ port: 9, host: '127.0.0.1' }).once('error', () => r()).once('connect', function (this: { destroy(): void }) { this.destroy(); r(); }));
    }
    await new Promise((r) => setTimeout(r, 1500));
    ctrl.abort();
    const result = await running;
    assert.equal(result.file, file);
    assert.ok(result.packets > 0, `pacotes capturados: ${result.packets}`);
    assert.ok(existsSync(file));
    assert.ok(seen.length > 0, 'contagem ao vivo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filtro inválido vira erro traduzido', { skip: !existsSync(DUMPCAP) && 'Wireshark não instalado' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-cap-'));
  try {
    await assert.rejects(
      runCapture(DUMPCAP, validateCapture({ iface: '\\Device\\NPF_Loopback', filter: 'port and lixo' }), join(dir, 'x.pcapng')),
      /filtro de captura inválido/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

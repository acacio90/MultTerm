import { app, dialog, ipcMain, shell, type WebContents } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { captureFileName, findCaptureTools, parseInterfaces, runCapture, validateCapture } from '../network/capture.ts';
import { findPktmon, runPktmonCapture, validatePktmonRequest } from '../network/pktmon.ts';
import { diagCommand, validateDiag } from '../network/diag.ts';
import { dnsQuery } from '../network/dns.ts';
import { parseTargets, scanNetwork } from '../network/hosts.ts';
import { listConnections } from '../network/local-ports.ts';
import { parsePorts, scanPorts } from '../network/ports.ts';
import { runSnmp, validateSnmpRequest, type SnmpRequest } from '../network/snmp.ts';
import { sendWol, validateWol } from '../network/wol.ts';
import { isSafeHost } from '../sessions/model.ts';
import { openTerminal } from './terminals.ts';

/** Varreduras em andamento, por janela + id da aba; canceláveis. */
const jobs = new Map<string, AbortController>();
const jobKey = (owner: WebContents, id: unknown) => `${owner.id}:${String(id)}`;

function timeout(ms: unknown, fallback: number): number {
  const n = Number(ms);
  return Number.isFinite(n) && n >= 100 && n <= 30_000 ? n : fallback;
}

async function runJob<T>(owner: WebContents, id: unknown, work: (signal: AbortSignal) => Promise<T>) {
  const key = jobKey(owner, id);
  jobs.get(key)?.abort();
  const ctrl = new AbortController();
  jobs.set(key, ctrl);
  try {
    // Os resultados vão também na resposta: os eventos 'tools:result' podem chegar à página
    // depois dela (o Electron não garante a ordem entre resposta e eventos).
    const results = await work(ctrl.signal);
    return { cancelled: ctrl.signal.aborted, results };
  } finally {
    if (jobs.get(key) === ctrl) jobs.delete(key);
  }
}

export function cancelJobsOf(owner: WebContents): void {
  for (const [key, ctrl] of jobs) {
    if (key.startsWith(`${owner.id}:`)) {
      ctrl.abort();
      jobs.delete(key);
    }
  }
}

/**
 * Credenciais SNMP opcionais do scanner de rede (nome via sysName quando não há DNS reverso).
 * Validadas uma vez, antes da varredura, com timeout curto por host.
 */
function netscanSnmp(raw: unknown): SnmpRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (!o.version) return undefined;
  return validateSnmpRequest({
    timeoutMs: 1000,
    retries: 0,
    ...o,
    host: '127.0.0.1', // trocado pelo IP de cada host
    operation: 'get',
    oids: 'sysName',
  });
}

// MULTTERM_PROGRAM_FILES (separado por ";") troca as pastas onde o Wireshark é procurado (testes).
const captureTools = () => findCaptureTools({
  programFiles: process.env.MULTTERM_PROGRAM_FILES?.split(';')
    ?? [process.env.ProgramFiles ?? '', process.env['ProgramFiles(x86)'] ?? ''],
  fileExists: existsSync,
});
// MULTTERM_SYSTEM_ROOT troca a pasta do Windows onde o pktmon é procurado (testes).
const pktmonPath = () => findPktmon({
  systemRoot: process.env.MULTTERM_SYSTEM_ROOT ?? process.env.SystemRoot,
  fileExists: existsSync,
});
// MULTTERM_CAPTURES_DIR muda a pasta (testes isolados).
const capturesDir = () => process.env.MULTTERM_CAPTURES_DIR || join(app.getPath('documents'), 'MultTerm', 'Capturas');

/** Só abre/mostra arquivos .pcapng que estejam na pasta de capturas. */
function captureFile(file: unknown): string {
  const path = typeof file === 'string' ? resolve(file) : '';
  if (!path.endsWith('.pcapng') || dirname(path) !== resolve(capturesDir()) || !existsSync(path)) {
    throw new Error('arquivo de captura inválido');
  }
  return path;
}

export function registerToolsIpc(): void {
  // Ping/traceroute num terminal embutido.
  ipcMain.handle('term:open-tool', (e, id: unknown, raw: unknown, cols: unknown, rows: unknown) => {
    const req = validateDiag(raw);
    const { file, args } = diagCommand(req, process.platform);
    const size = (n: unknown, fallback: number) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : fallback);
    openTerminal(e.sender, id, file, args, { cols: size(cols, 80), rows: size(rows, 24), cwd: homedir() });
  });

  ipcMain.handle('tools:portscan', (e, id: unknown, host: unknown, spec: unknown, ms: unknown) => {
    const target = typeof host === 'string' ? host.trim() : '';
    if (!isSafeHost(target)) throw new Error(`host inválido (${target || 'vazio'})`);
    const ports = parsePorts(typeof spec === 'string' ? spec : '');
    e.sender.send('tools:progress', id, 0, ports.length);
    let done = 0;
    return runJob(e.sender, id, (signal) => scanPorts(target, ports, {
      timeoutMs: timeout(ms, 1500),
      signal,
      onResult: (r) => {
        if (e.sender.isDestroyed()) return;
        e.sender.send('tools:result', id, r);
        e.sender.send('tools:progress', id, ++done, ports.length);
      },
    }));
  });

  ipcMain.handle('tools:netscan', (e, id: unknown, spec: unknown, ms: unknown, snmpRaw: unknown) => {
    const targets = parseTargets(typeof spec === 'string' ? spec : '');
    const snmpConfig = netscanSnmp(snmpRaw);
    e.sender.send('tools:progress', id, 0, targets.length);
    let last = 0;
    return runJob(e.sender, id, (signal) => scanNetwork(targets, {
      snmp: snmpConfig,
      timeoutMs: timeout(ms, 800),
      signal,
      onResult: (r) => {
        if (!e.sender.isDestroyed()) e.sender.send('tools:result', id, r);
      },
      onProgress: (done) => {
        // Limita as mensagens de progresso em varreduras grandes.
        const now = Date.now();
        if (e.sender.isDestroyed() || (done < targets.length && now - last < 150)) return;
        last = now;
        e.sender.send('tools:progress', id, done, targets.length);
      },
    }));
  });

  ipcMain.on('tools:cancel', (e, id: unknown) => {
    const key = jobKey(e.sender, id);
    jobs.get(key)?.abort();
    jobs.delete(key);
  });

  // SNMP: credenciais só em memória, nunca em log nem em disco.
  ipcMain.handle('tools:snmp', (e, id: unknown, raw: unknown) => {
    const req = validateSnmpRequest(raw);
    return runJob(e.sender, id, (signal) => runSnmp(req, {
      signal,
      onResult: (r) => {
        if (!e.sender.isDestroyed()) e.sender.send('tools:result', id, r);
      },
    }));
  });

  // Captura de pacotes: dumpcap/Npcap ou, na falta deles, o pktmon do Windows (elevado).
  // Arquivos em Documentos/MultTerm/Capturas.
  ipcMain.handle('capture:info', async () => {
    const tools = { ...captureTools(), pktmon: pktmonPath() };
    if (!tools.dumpcap) return { ...tools, interfaces: [], folder: capturesDir() };
    const interfaces = await new Promise<ReturnType<typeof parseInterfaces>>((done, fail) => {
      execFile(tools.dumpcap!, ['-D'], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) fail(new Error(`não foi possível listar as interfaces: ${(stderr || err.message).trim()}`));
        else done(parseInterfaces(stdout));
      });
    });
    return { ...tools, interfaces, folder: capturesDir() };
  });

  ipcMain.handle('capture:start', async (e, id: unknown, raw: unknown) => {
    if ((raw as { backend?: unknown } | null)?.backend === 'pktmon') {
      const pktmon = pktmonPath();
      if (!pktmon) throw new Error('pktmon não encontrado (requer Windows 10 1809 ou mais novo)');
      const request = validatePktmonRequest(raw);
      await mkdir(capturesDir(), { recursive: true });
      const file = join(capturesDir(), captureFileName());
      return runJob(e.sender, id, (signal) => runPktmonCapture({
        pktmon, file, workDir: capturesDir(), request, signal,
        onBytes: (n) => {
          if (!e.sender.isDestroyed()) e.sender.send('tools:progress', id, n, -1);
        },
      }));
    }
    const { dumpcap } = captureTools();
    if (!dumpcap) throw new Error('dumpcap não encontrado: instale o Wireshark (com o Npcap)');
    const req = validateCapture(raw);
    await mkdir(capturesDir(), { recursive: true });
    const file = join(capturesDir(), captureFileName());
    return runJob(e.sender, id, (signal) => runCapture(dumpcap, req, file, {
      signal,
      onPackets: (n) => {
        if (!e.sender.isDestroyed()) e.sender.send('tools:progress', id, n, 0);
      },
    }));
  });

  ipcMain.handle('capture:open', async (_e, file: unknown) => {
    const path = captureFile(file);
    const { wireshark } = captureTools();
    if (wireshark) spawn(wireshark, [path], { detached: true, stdio: 'ignore' }).unref();
    else {
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
    }
  });
  ipcMain.on('capture:show', (_e, file: unknown) => shell.showItemInFolder(captureFile(file)));

  ipcMain.handle('tools:wol', async (_e, raw: unknown) => {
    const req = validateWol(raw);
    await sendWol(req);
    return req;
  });

  ipcMain.handle('tools:dns', (_e, name: unknown, type: unknown, server: unknown) =>
    dnsQuery(String(name ?? ''), String(type ?? 'A'), typeof server === 'string' ? server : undefined));

  ipcMain.handle('tools:local-ports', () => listConnections());

  ipcMain.handle('tools:save-csv', async (_e, name: unknown, csv: unknown) => {
    if (typeof csv !== 'string') return null;
    const safe = typeof name === 'string' ? name.replace(/[^\w.-]+/g, '_') : 'resultado.csv';
    const result = await dialog.showSaveDialog({
      title: 'Exportar CSV',
      defaultPath: join(homedir(), 'Downloads', safe),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return null;
    // BOM para o Excel reconhecer UTF-8.
    await writeFile(result.filePath, `﻿${csv}`, 'utf8');
    return result.filePath;
  });
}

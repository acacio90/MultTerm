import { dialog, ipcMain, type WebContents } from 'electron';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { diagCommand, validateDiag } from '../network/diag.ts';
import { dnsQuery } from '../network/dns.ts';
import { parseTargets, scanNetwork } from '../network/hosts.ts';
import { listConnections } from '../network/local-ports.ts';
import { parsePorts, scanPorts } from '../network/ports.ts';
import { runSnmp, validateSnmpRequest } from '../network/snmp.ts';
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

  ipcMain.handle('tools:netscan', (e, id: unknown, spec: unknown, ms: unknown) => {
    const targets = parseTargets(typeof spec === 'string' ? spec : '');
    e.sender.send('tools:progress', id, 0, targets.length);
    let last = 0;
    return runJob(e.sender, id, (signal) => scanNetwork(targets, {
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

  ipcMain.handle('tools:dns',(_e, name: unknown, type: unknown, server: unknown) =>
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

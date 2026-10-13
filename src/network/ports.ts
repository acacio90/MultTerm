import { Socket } from 'node:net';

export type PortState = 'open' | 'closed' | 'filtered';

export const PRESETS: Record<string, string> = {
  comuns: '21,22,23,25,53,80,110,135,139,143,443,445,465,587,993,995,1433,1521,3306,3389,5432,5900,5985,5986,6379,8080,8443,9200,27017',
  web: '80,443,8000,8008,8080,8081,8443,8888,9000,9443',
  bancos: '1433,1521,3306,5432,6379,9042,9200,11211,27017',
  windows: '135,139,445,3389,5985,5986',
};

export const SERVICES: Record<number, string> = {
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 80: 'http', 110: 'pop3', 135: 'msrpc',
  139: 'netbios', 143: 'imap', 443: 'https', 445: 'smb', 465: 'smtps', 587: 'submission', 993: 'imaps',
  995: 'pop3s', 1433: 'mssql', 1521: 'oracle', 3306: 'mysql', 3389: 'rdp', 5432: 'postgresql',
  5900: 'vnc', 5985: 'winrm', 5986: 'winrm-https', 6379: 'redis', 8000: 'http-alt', 8008: 'http-alt',
  8080: 'http-proxy', 8081: 'http-alt', 8443: 'https-alt', 8888: 'http-alt', 9000: 'http-alt',
  9042: 'cassandra', 9200: 'elasticsearch', 9443: 'https-alt', 11211: 'memcached', 27017: 'mongodb',
};

export const MAX_PORTS = 65535;

/** "22,80,8000-8010" ou nome de predefinição ("comuns", "web"…) → portas únicas em ordem. */
export function parsePorts(spec: string): number[] {
  const expanded = spec
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((part) => PRESETS[part.toLowerCase()] ?? part)
    .join(',');
  const ports = new Set<number>();
  for (const part of expanded.split(',').filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part.trim());
    if (!m) throw new Error(`porta inválida: "${part}"`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to > 65535 || from > to) throw new Error(`faixa de portas inválida: "${part}"`);
    for (let p = from; p <= to; p++) ports.add(p);
  }
  if (ports.size === 0) throw new Error('informe ao menos uma porta');
  return [...ports].sort((a, b) => a - b);
}

/**
 * Testa uma porta TCP: conectou = aberta; recusada (RST) = fechada;
 * sem resposta no tempo ou rede inalcançável = filtrada.
 */
export function probePort(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<PortState> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('filtered');
    const socket = new Socket();
    let done = false;
    const finish = (state: PortState) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(state);
    };
    const onAbort = () => finish('filtered');
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('filtered'));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED' ? 'closed' : 'filtered'));
    socket.connect(port, host);
  });
}

/** Executa tarefas com concorrência limitada; para de iniciar novas quando o sinal é abortado. */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export interface PortResult {
  port: number;
  state: PortState;
  service: string;
}

export async function scanPorts(
  host: string,
  ports: number[],
  opts: { timeoutMs?: number; concurrency?: number; signal?: AbortSignal; onResult?: (r: PortResult) => void },
): Promise<PortResult[]> {
  const results: PortResult[] = [];
  await runPool(ports, opts.concurrency ?? 200, async (port) => {
    const state = await probePort(host, port, opts.timeoutMs ?? 1500, opts.signal);
    if (opts.signal?.aborted) return;
    const r = { port, state, service: SERVICES[port] ?? '' };
    results.push(r);
    opts.onResult?.(r);
  }, opts.signal);
  return results.sort((a, b) => a.port - b.port);
}

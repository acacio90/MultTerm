import { promises as dns } from 'node:dns';
import { isIPv4 } from 'node:net';
import { isSafeHost } from '../sessions/model.ts';
import { systemDnsServers } from './dns.ts';
import { probePort, runPool } from './ports.ts';

export const DEFAULT_MAX_TARGETS = 65536;

const toInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/**
 * Alvos do scanner de rede:
 * - CIDR "10.0.0.0/24" (sem endereço de rede e broadcast quando o prefixo é ≤ 30)
 * - faixa "10.0.0.10-10.0.0.50" ou "10.0.0.10-50"
 * - lista separada por vírgula/espaço (IPs ou nomes)
 */
export function parseTargets(spec: string, max = DEFAULT_MAX_TARGETS): string[] {
  const out: string[] = [];
  const add = (ip: string) => {
    if (out.length >= max) throw new Error(`faixa grande demais (máximo ${max} endereços)`);
    out.push(ip);
  };
  for (const part of spec.split(/[\s,;]+/).filter(Boolean)) {
    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(part);
    const range = /^(\d+\.\d+\.\d+\.\d+)-(\d+(?:\.\d+\.\d+\.\d+)?)$/.exec(part);
    if (cidr) {
      const [, base, bitsText] = cidr;
      const bits = Number(bitsText);
      if (!isIPv4(base) || bits > 32) throw new Error(`CIDR inválido: "${part}"`);
      const size = 2 ** (32 - bits);
      if (size > max) throw new Error(`faixa grande demais: /${bits} tem ${size} endereços (máximo ${max})`);
      const start = Math.floor(toInt(base) / size) * size;
      const skipEdges = bits <= 30;
      for (let i = skipEdges ? 1 : 0; i < (skipEdges ? size - 1 : size); i++) add(toIp(start + i));
    } else if (range) {
      const [, first, lastText] = range;
      const last = lastText.includes('.') ? lastText : first.replace(/\d+$/, lastText);
      if (!isIPv4(first) || !isIPv4(last)) throw new Error(`faixa inválida: "${part}"`);
      const a = toInt(first);
      const b = toInt(last);
      if (a > b) throw new Error(`faixa invertida: "${part}"`);
      for (let n = a; n <= b; n++) add(toIp(n));
    } else {
      if (!isSafeHost(part)) throw new Error(`alvo inválido: "${part}"`);
      add(part);
    }
  }
  if (out.length === 0) throw new Error('informe um IP, faixa ou CIDR');
  return [...new Set(out)];
}

/** Portas usadas para descobrir hosts (resposta, mesmo recusada, prova que o host existe). */
export const DISCOVERY_PORTS = [22, 80, 443, 445, 3389];

export interface HostResult {
  target: string;
  alive: boolean;
  open: number[];
  latencyMs?: number;
  name?: string;
}

export async function probeHost(
  target: string,
  opts: { ports?: number[]; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HostResult> {
  const ports = opts.ports ?? DISCOVERY_PORTS;
  const started = Date.now();
  let latencyMs: number | undefined;
  const open: number[] = [];
  let alive = false;
  await Promise.all(ports.map(async (port) => {
    const state = await probePort(target, port, opts.timeoutMs ?? 800, opts.signal);
    if (state === 'filtered') return;
    alive = true;
    latencyMs ??= Date.now() - started;
    if (state === 'open') open.push(port);
  }));
  open.sort((a, b) => a - b);
  return { target, alive, open, latencyMs };
}

/**
 * Nome do host pelo DNS reverso (PTR). Usa os mesmos servidores da consulta DNS: o resolvedor
 * padrão do Node pode cair em 127.0.0.1 no Windows e responder "não encontrado" para tudo.
 */
export async function reverseName(ip: string, timeoutMs = 1500): Promise<string | undefined> {
  if (!isIPv4(ip)) return undefined;
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  const servers = await systemDnsServers();
  if (servers.length) resolver.setServers(servers);
  const timer = new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs + 200));
  const lookup = resolver.reverse(ip).then((names) => names[0], () => undefined);
  return Promise.race([lookup, timer]);
}

export async function scanNetwork(
  targets: string[],
  opts: { timeoutMs?: number; concurrency?: number; signal?: AbortSignal; onResult?: (r: HostResult) => void; onProgress?: (done: number) => void },
): Promise<HostResult[]> {
  const alive: HostResult[] = [];
  let done = 0;
  await runPool(targets, opts.concurrency ?? 64, async (target) => {
    const r = await probeHost(target, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    if (opts.signal?.aborted) return;
    if (r.alive) {
      r.name = isIPv4(target) ? await reverseName(target) : target;
      alive.push(r);
      opts.onResult?.(r);
    }
    opts.onProgress?.(++done);
  }, opts.signal);
  return alive;
}

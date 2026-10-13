import { execFile } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { isSafeHost } from '../sessions/model.ts';

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'PTR', 'SRV'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export interface DnsAnswer {
  query: string;
  type: RecordType;
  server: string;
  records: string[];
}

/** Valida o pedido: IP informado vira consulta reversa (PTR). */
export function normalizeQuery(name: string, type: string): { name: string; type: RecordType } {
  const query = name.trim().replace(/\.$/, '');
  if (!query || !isSafeHost(query)) throw new Error(`nome ou IP inválido: "${name}"`);
  if (isIP(query)) return { name: query, type: 'PTR' };
  if (!(RECORD_TYPES as readonly string[]).includes(type)) throw new Error(`tipo de registro inválido: ${type}`);
  if (type === 'PTR') throw new Error('PTR exige um endereço IP');
  return { name: query, type: type as RecordType };
}

/** Servidor DNS opcional: IP ou IP:porta ("[::1]:53" para IPv6). */
export function normalizeServer(server: string | undefined): string | undefined {
  const s = server?.trim();
  if (!s) return undefined;
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  const host = m?.[1] ?? s;
  if (!isIP(host)) throw new Error(`servidor DNS deve ser um IP: "${s}"`);
  return s;
}

/** Formata as respostas de cada tipo em linhas legíveis. */
export function formatRecords(type: RecordType, raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  switch (type) {
    case 'A':
    case 'AAAA':
      return list.map((r) => (typeof r === 'object' && r ? `${r.address}  (TTL ${r.ttl}s)` : String(r)));
    case 'MX':
      return list
        .sort((a, b) => a.priority - b.priority)
        .map((r) => `${r.priority} ${r.exchange}`);
    case 'TXT':
      return list.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
    case 'SRV':
      return list.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`);
    case 'SOA': {
      const r = list[0];
      return [
        `primário ${r.nsname}`,
        `responsável ${r.hostmaster}`,
        `serial ${r.serial}`,
        `refresh ${r.refresh}s · retry ${r.retry}s · expire ${r.expire}s · TTL mínimo ${r.minttl}s`,
      ];
    }
    default:
      return list.map(String);
  }
}

const ERRORS: Record<string, string> = {
  ENOTFOUND: 'nome não encontrado (NXDOMAIN)',
  ENODATA: 'o nome existe, mas não tem registros desse tipo',
  ETIMEOUT: 'tempo esgotado: o servidor DNS não respondeu',
  ECONNREFUSED: 'o servidor DNS recusou a conexão',
  ESERVFAIL: 'o servidor DNS falhou ao responder (SERVFAIL)',
  EREFUSED: 'o servidor DNS recusou a consulta (REFUSED)',
};

export function dnsErrorMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code ?? '';
  return ERRORS[code] ?? (err as Error)?.message ?? String(err);
}

/** Filtra a lista de servidores do sistema: só IPs válidos e utilizáveis, sem repetição. */
export function pickDnsServers(list: unknown): string[] {
  const items = (Array.isArray(list) ? list : [list]).filter((s): s is string => typeof s === 'string');
  const valid = items
    .map((s) => s.trim())
    .filter((s) => isIP(s) && s !== '0.0.0.0' && !/^fec0:/i.test(s) && s !== '::');
  return [...new Set(valid)];
}

const WINDOWS_DNS_SCRIPT =
  "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | " +
  'ForEach-Object { $_.DNSServer | ForEach-Object { $_.ServerAddresses } } | ConvertTo-Json -Compress';

let systemServers: Promise<string[]> | undefined;

/**
 * Servidores DNS do sistema. No Windows o resolvedor do Node (c-ares) pode cair em 127.0.0.1
 * quando há adaptadores virtuais; por isso a lista vem das interfaces ativas com gateway.
 */
export function systemDnsServers(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform !== 'win32') return Promise.resolve([]);
  systemServers ??= new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DNS_SCRIPT],
      { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        try {
          resolve(err || !stdout.trim() ? [] : pickDnsServers(JSON.parse(stdout)));
        } catch {
          resolve([]);
        }
      });
  });
  return systemServers;
}

export async function dnsQuery(name: string, type: string, server?: string): Promise<DnsAnswer> {
  const q = normalizeQuery(name, type);
  const srv = normalizeServer(server);
  const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
  const servers = srv ? [srv] : await systemDnsServers();
  if (servers.length) resolver.setServers(servers);
  let raw: unknown;
  try {
    switch (q.type) {
      case 'A': raw = await resolver.resolve4(q.name, { ttl: true }); break;
      case 'AAAA': raw = await resolver.resolve6(q.name, { ttl: true }); break;
      case 'PTR': raw = await resolver.reverse(q.name); break;
      default: raw = await resolver.resolve(q.name, q.type);
    }
  } catch (err) {
    throw new Error(dnsErrorMessage(err));
  }
  return { query: q.name, type: q.type, server: resolver.getServers().join(', '), records: formatRecords(q.type, raw) };
}

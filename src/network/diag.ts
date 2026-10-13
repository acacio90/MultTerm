import { isSafeHost, SessionError } from '../sessions/model.ts';

export type DiagKind = 'ping' | 'traceroute';

export interface DiagRequest {
  kind: DiagKind;
  host: string;
  /** Ping: quantidade de pacotes; ausente = contínuo (até Ctrl+C). */
  count?: number;
}

/** Valida um pedido vindo da interface. */
export function validateDiag(raw: unknown): DiagRequest {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const kind = obj.kind;
  if (kind !== 'ping' && kind !== 'traceroute') throw new SessionError('ferramenta inválida');
  const host = typeof obj.host === 'string' ? obj.host.trim() : '';
  if (!isSafeHost(host)) throw new SessionError(`host inválido (${host || 'vazio'})`);
  let count: number | undefined;
  if (obj.count !== undefined && obj.count !== null && obj.count !== '') {
    count = Number(obj.count);
    if (!Number.isInteger(count) || count < 1 || count > 10000) throw new SessionError('quantidade inválida (1 a 10000)');
  }
  return { kind, host, count };
}

/** Comando do sistema para o diagnóstico, rodado num terminal embutido. */
export function diagCommand(req: DiagRequest, platform: NodeJS.Platform): { file: string; args: string[] } {
  const win = platform === 'win32';
  if (req.kind === 'ping') {
    const count = req.count === undefined ? (win ? ['-t'] : []) : [win ? '-n' : '-c', String(req.count)];
    return { file: win ? 'ping.exe' : 'ping', args: [...count, req.host] };
  }
  return win ? { file: 'tracert.exe', args: [req.host] } : { file: 'traceroute', args: [req.host] };
}

export function diagTitle(req: DiagRequest): string {
  return `${req.kind} ${req.host}`;
}

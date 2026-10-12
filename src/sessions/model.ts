export type SessionType = 'ssh' | 'rdp';

export const SESSION_TYPES: readonly SessionType[] = ['ssh', 'rdp'];

export const DEFAULT_PORTS: Record<SessionType, number> = { ssh: 22, rdp: 3389 };

export interface Session {
  name: string;
  /** Caminho da pasta na árvore, separado por "/". Vazio = raiz. */
  folder: string;
  type: SessionType;
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  tags?: string[];
}

export class SessionError extends Error {
  override name = 'SessionError';
}

/** Identificador único da sessão: "pasta/subpasta/nome". */
export function sessionKey(s: Pick<Session, 'folder' | 'name'>): string {
  return s.folder ? `${s.folder}/${s.name}` : s.name;
}

export function effectivePort(s: Session): number {
  return s.port ?? DEFAULT_PORTS[s.type];
}

/** Aceita "\" ou "/" como separador e remove segmentos vazios. */
export function normalizeFolder(folder: string): string {
  return folder
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

function optionalString(obj: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new SessionError(`${where}: "${key}" deve ser texto`);
  return value;
}

function checkUser(user: string | undefined, where: string): string | undefined {
  if (user !== undefined && (user.startsWith('-') || /[\x00-\x1f@]/.test(user))) {
    throw new SessionError(`${where}: "user" inválido (${user})`);
  }
  return user;
}

/** Valida um objeto vindo do YAML e devolve uma Session normalizada. */
export function validateSession(raw: unknown, where: string): Session {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SessionError(`${where}: sessão deve ser um objeto`);
  }
  const obj = raw as Record<string, unknown>;

  const name = optionalString(obj, 'name', where)?.trim();
  if (!name) throw new SessionError(`${where}: "name" é obrigatório`);
  if (name.includes('/')) throw new SessionError(`${where}: "name" não pode conter "/" (${name})`);
  where = `${where} (${name})`;

  const host = optionalString(obj, 'host', where)?.trim();
  if (!host) throw new SessionError(`${where}: "host" é obrigatório`);
  // Evita que host/usuário virem opções do ssh (ex.: "-oProxyCommand=...").
  if (host.startsWith('-') || /\s/.test(host)) throw new SessionError(`${where}: "host" inválido (${host})`);

  const type = obj.type ?? 'ssh';
  if (!SESSION_TYPES.includes(type as SessionType)) {
    throw new SessionError(`${where}: "type" deve ser ${SESSION_TYPES.join(' ou ')}`);
  }

  let port: number | undefined;
  if (obj.port !== undefined && obj.port !== null) {
    port = Number(obj.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SessionError(`${where}: "port" inválida (${String(obj.port)})`);
    }
  }

  let tags: string[] | undefined;
  if (obj.tags !== undefined && obj.tags !== null) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === 'string')) {
      throw new SessionError(`${where}: "tags" deve ser uma lista de textos`);
    }
    tags = obj.tags.length ? [...obj.tags] : undefined;
  }

  const session: Session = {
    name,
    folder: normalizeFolder(optionalString(obj, 'folder', where) ?? ''),
    type: type as SessionType,
    host,
  };
  const user = checkUser(optionalString(obj, 'user', where), where);
  const identityFile = optionalString(obj, 'identityFile', where);
  // Campos opcionais ausentes ficam fora do objeto (comparação e IPC mais limpos).
  if (port !== undefined) session.port = port;
  if (user !== undefined) session.user = user;
  if (identityFile !== undefined) session.identityFile = identityFile;
  if (tags !== undefined) session.tags = tags;
  return session;
}

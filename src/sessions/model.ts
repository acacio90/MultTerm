import { isSafeSiteName } from '../vpn/sites.ts';

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
  /** Endereço MAC para Wake-on-LAN, normalizado como "aa:bb:cc:dd:ee:ff". */
  mac?: string;
  /** Site de VPN que precisa estar conectado para alcançar o host. */
  vpn?: string;
  /** RDP: aceita TLS 1.0/cifras antigas (servidores Windows antigos). Escolha explícita por sessão. */
  legacyTls?: boolean;
  /** RDP: conectar abre o cliente do Windows em tela cheia usando todos os monitores. */
  multimon?: boolean;
  /** SSH: aceita algoritmos antigos (troca de chaves SHA-1, ssh-rsa, CBC). Escolha explícita por sessão. */
  legacySsh?: boolean;
  tags?: string[];
  /** hostid do host no Zabbix de onde a sessão foi importada. */
  zabbixHostId?: string;
}

/** Aceita aa:bb:cc:dd:ee:ff, AA-BB-…, aabb.ccdd.eeff (Cisco) ou 12 dígitos hex; devolve "aa:bb:cc:dd:ee:ff". */
export function normalizeMac(text: string): string | undefined {
  const hex = text.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2}([:-]?)(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})$/.test(hex)) return undefined;
  return hex.replace(/[^0-9a-f]/g, '').match(/../g)!.join(':');
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

/**
 * Host seguro para passar a comandos (ssh, ping, tracert…): não pode virar opção
 * (ex.: "-oProxyCommand=...") nem conter espaços ou caracteres de controle.
 */
export function isSafeHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !host.startsWith('-') && !/[\s\x00-\x1f]/.test(host);
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
  if (!isSafeHost(host)) throw new SessionError(`${where}: "host" inválido (${host})`);

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
  const macText = optionalString(obj, 'mac', where);
  const mac = macText === undefined ? undefined : normalizeMac(macText);
  if (macText !== undefined && !mac) throw new SessionError(`${where}: "mac" inválido (${macText})`);
  const vpn = optionalString(obj, 'vpn', where)?.trim() || undefined;
  if (vpn !== undefined && !isSafeSiteName(vpn)) throw new SessionError(`${where}: "vpn" inválido (${vpn})`);
  const zabbixHostId = obj.zabbixHostId === undefined || obj.zabbixHostId === null ? undefined : String(obj.zabbixHostId);
  if (zabbixHostId !== undefined && !/^\d+$/.test(zabbixHostId)) {
    throw new SessionError(`${where}: "zabbixHostId" inválido (${zabbixHostId})`);
  }
  for (const flag of ['legacyTls', 'legacySsh', 'multimon']) {
    if (obj[flag] !== undefined && obj[flag] !== null && typeof obj[flag] !== 'boolean') {
      throw new SessionError(`${where}: "${flag}" deve ser true ou false`);
    }
  }
  // Campos opcionais ausentes ficam fora do objeto (comparação e IPC mais limpos).
  if (port !== undefined) session.port = port;
  if (user !== undefined) session.user = user;
  if (identityFile !== undefined) session.identityFile = identityFile;
  if (mac !== undefined) session.mac = mac;
  if (vpn !== undefined) session.vpn = vpn;
  if (obj.legacyTls === true && session.type === 'rdp') session.legacyTls = true;
  if (obj.legacySsh === true && session.type === 'ssh') session.legacySsh = true;
  if (obj.multimon === true && session.type === 'rdp') session.multimon = true;
  if (tags !== undefined) session.tags = tags;
  if (zabbixHostId !== undefined) session.zabbixHostId = zabbixHostId;
  return session;
}

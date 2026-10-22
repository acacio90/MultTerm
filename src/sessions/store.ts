import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { DEFAULT_PORTS, normalizeFolder, SessionError, sessionKey, validateSession, type Session } from './model.ts';

export const FILE_VERSION = 1;

const HEADER = `# Sessões do MultTerm — arquivo versionável, sem limite de sessões.
# Campos: name, folder ("Pasta/Subpasta"), type (ssh|rdp), host, port, user, identityFile, mac, vpn, legacyTls, legacySsh, multimon, tags, zabbixHostId
# defaults.identityFile: chave das sessões SSH sem identityFile própria
`;

/** Valores que valem para todas as sessões do arquivo. */
export interface SessionDefaults {
  /** Chave privada das sessões SSH sem chave própria. */
  identityFile?: string;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

export function compareSessions(a: Session, b: Session): number {
  return collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name);
}

export function parseSessions(text: string, source = 'sessions.yaml'): Session[] {
  return parseSessionFile(text, source).sessions;
}

export function parseSessionFile(text: string, source = 'sessions.yaml'): { sessions: Session[]; defaults: SessionDefaults } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new SessionError(`${source}: YAML inválido — ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) return { sessions: [], defaults: {} };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new SessionError(`${source}: esperado um objeto com "version" e "sessions"`);
  }
  const { version, sessions, defaults } = doc as { version?: unknown; sessions?: unknown; defaults?: unknown };
  if (version !== undefined && version !== FILE_VERSION) {
    throw new SessionError(`${source}: versão ${String(version)} não suportada (esperado ${FILE_VERSION})`);
  }
  return {
    sessions: sessions === undefined || sessions === null ? [] : validateSessions(sessions, source),
    defaults: validateDefaults(defaults, source),
  };
}

/** Valida o bloco "defaults" (ausente = sem padrões). */
export function validateDefaults(raw: unknown, source: string): SessionDefaults {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new SessionError(`${source}: "defaults" deve ser um objeto`);
  const { identityFile } = raw as { identityFile?: unknown };
  if (identityFile === undefined || identityFile === null) return {};
  if (typeof identityFile !== 'string') throw new SessionError(`${source}: "defaults.identityFile" deve ser texto`);
  return identityFile.trim() ? { identityFile: identityFile.trim() } : {};
}

/** A sessão como é conectada: SSH sem chave própria usa a chave padrão do arquivo. */
export function withDefaults(session: Session, defaults: SessionDefaults): Session {
  if (session.type !== 'ssh' || session.identityFile || !defaults.identityFile) return session;
  return { ...session, identityFile: defaults.identityFile };
}

/** Valida uma lista vinda de qualquer origem (YAML, interface, importação) e rejeita duplicadas. */
export function validateSessions(sessions: unknown, source: string): Session[] {
  if (!Array.isArray(sessions)) throw new SessionError(`${source}: "sessions" deve ser uma lista`);
  const seen = new Set<string>();
  return sessions.map((raw, i) => {
    const session = validateSession(raw, `${source}: sessions[${i}]`);
    const key = sessionKey(session);
    if (seen.has(key)) throw new SessionError(`${source}: sessão duplicada "${key}"`);
    seen.add(key);
    return session;
  });
}

/** Saída determinística (ordem e campos fixos) para diffs limpos no git. */
export function serializeSessions(sessions: Session[], defaults: SessionDefaults = {}): string {
  const ordered = [...sessions].sort(compareSessions).map((s) => {
    const out: Record<string, unknown> = { name: s.name };
    if (s.folder) out.folder = s.folder;
    out.type = s.type;
    out.host = s.host;
    if (s.port !== undefined && s.port !== DEFAULT_PORTS[s.type]) out.port = s.port;
    if (s.user) out.user = s.user;
    if (s.identityFile) out.identityFile = s.identityFile;
    if (s.mac) out.mac = s.mac;
    if (s.vpn) out.vpn = s.vpn;
    if (s.legacyTls) out.legacyTls = true;
    if (s.legacySsh) out.legacySsh = true;
    if (s.multimon) out.multimon = true;
    if (s.tags?.length) out.tags = s.tags;
    if (s.zabbixHostId) out.zabbixHostId = s.zabbixHostId;
    return out;
  });
  const doc: Record<string, unknown> = { version: FILE_VERSION };
  if (defaults.identityFile) doc.defaults = { identityFile: defaults.identityFile };
  doc.sessions = ordered;
  return HEADER + stringify(doc, { lineWidth: 0 });
}

export async function loadSessionFile(path: string): Promise<Session[]> {
  return (await readSessionFile(path)).sessions;
}

export async function loadSessionDefaults(path: string): Promise<SessionDefaults> {
  return (await readSessionFile(path)).defaults;
}

async function readSessionFile(path: string): Promise<{ sessions: Session[]; defaults: SessionDefaults }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], defaults: {} };
    throw err;
  }
  return parseSessionFile(text, path);
}

/** Grava as sessões; sem `defaults`, mantém os padrões que já estão no arquivo. */
export async function saveSessionFile(path: string, sessions: Session[], defaults?: SessionDefaults): Promise<void> {
  // Um arquivo ilegível é sobrescrito como antes, só sem padrões.
  const kept = defaults ?? await loadSessionDefaults(path).catch(() => ({}));
  await writeFile(path, serializeSessions(sessions, kept), 'utf8');
}

export interface MergeResult {
  merged: Session[];
  added: Session[];
  skipped: Session[];
}

/** Acrescenta sessões novas; as que já existem (mesma pasta/nome) são mantidas como estão. */
export function mergeSessions(existing: Session[], incoming: Session[]): MergeResult {
  const keys = new Set(existing.map(sessionKey));
  const added: Session[] = [];
  const skipped: Session[] = [];
  for (const s of incoming) {
    const key = sessionKey(s);
    if (keys.has(key)) {
      skipped.push(s);
    } else {
      keys.add(key);
      added.push(s);
    }
  }
  return { merged: [...existing, ...added], added, skipped };
}

/** Agrupa por pasta, na mesma ordem do arquivo serializado. */
export function groupByFolder(sessions: Session[]): Map<string, Session[]> {
  const groups = new Map<string, Session[]>();
  for (const s of [...sessions].sort(compareSessions)) {
    const list = groups.get(s.folder) ?? [];
    list.push(s);
    groups.set(s.folder, list);
  }
  return groups;
}

/** Sessões de uma pasta e das subpastas (pasta vazia = todas). */
export function sessionsInFolder(sessions: Session[], folder: string): Session[] {
  const path = normalizeFolder(folder);
  return path ? sessions.filter((s) => s.folder === path || s.folder.startsWith(`${path}/`)) : [...sessions];
}

/** Nome sugerido para o arquivo exportado: multterm-sessoes-2026-10-13.yaml / multterm-Servidores-Banco-….yaml */
export function exportFileName(folder: string, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  const slug = normalizeFolder(folder).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `multterm-${slug || 'sessoes'}-${day}.yaml`;
}

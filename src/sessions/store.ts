import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { DEFAULT_PORTS, SessionError, sessionKey, validateSession, type Session } from './model.ts';

export const FILE_VERSION = 1;

const HEADER = `# Sessões do MultTerm — arquivo versionável, sem limite de sessões.
# Campos: name, folder ("Pasta/Subpasta"), type (ssh|rdp), host, port, user, identityFile, tags
`;

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

export function compareSessions(a: Session, b: Session): number {
  return collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name);
}

export function parseSessions(text: string, source = 'sessions.yaml'): Session[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new SessionError(`${source}: YAML inválido — ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new SessionError(`${source}: esperado um objeto com "version" e "sessions"`);
  }
  const { version, sessions } = doc as { version?: unknown; sessions?: unknown };
  if (version !== undefined && version !== FILE_VERSION) {
    throw new SessionError(`${source}: versão ${String(version)} não suportada (esperado ${FILE_VERSION})`);
  }
  if (sessions === undefined || sessions === null) return [];
  return validateSessions(sessions, source);
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
export function serializeSessions(sessions: Session[]): string {
  const ordered = [...sessions].sort(compareSessions).map((s) => {
    const out: Record<string, unknown> = { name: s.name };
    if (s.folder) out.folder = s.folder;
    out.type = s.type;
    out.host = s.host;
    if (s.port !== undefined && s.port !== DEFAULT_PORTS[s.type]) out.port = s.port;
    if (s.user) out.user = s.user;
    if (s.identityFile) out.identityFile = s.identityFile;
    if (s.tags?.length) out.tags = s.tags;
    return out;
  });
  return HEADER + stringify({ version: FILE_VERSION, sessions: ordered }, { lineWidth: 0 });
}

export async function loadSessionFile(path: string): Promise<Session[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return parseSessions(text, path);
}

/** Lê um arquivo de sessões para importar; ao contrário de loadSessionFile, exige que ele exista. */
export async function readSessionFile(path: string): Promise<Session[]> {
  return parseSessions(await readFile(path, 'utf8'), path);
}

export async function saveSessionFile(path: string, sessions: Session[]): Promise<void> {
  await writeFile(path, serializeSessions(sessions), 'utf8');
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

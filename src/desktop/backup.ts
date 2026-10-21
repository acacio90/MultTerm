import { isSafeSiteName, siteInfo } from '../vpn/sites.ts';

/**
 * Backup completo do MultTerm num arquivo JSON: sessões, sites de VPN (o .vpn inteiro, com a
 * chave compartilhada), configurações dos servidores e a escolha do agente. Senhas cifradas pelo
 * Windows (servidores, token do agente) ficam de fora: só abrem para o usuário que as cifrou.
 */
export const BACKUP_FORMAT = 'multterm-backup';
export const BACKUP_EXTENSION = 'multterm';
const MAX_SITE = 64 * 1024;

export interface BackupSite {
  name: string;
  content: string;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  appVersion: string;
  sessions: unknown[];
  /** Bloco "defaults" do arquivo de sessões (validado na importação, como as sessões). */
  sessionDefaults?: unknown;
  vpnSites: BackupSite[];
  servers: Record<string, Record<string, unknown>>;
  agent: { port?: number; agent?: string };
}

export function serializeBackup(parts: Omit<Backup, 'format' | 'version'>): string {
  const backup: Backup = { format: BACKUP_FORMAT, version: 1, ...parts };
  return `${JSON.stringify(backup, null, 2)}\n`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lê e confere um backup; as sessões são validadas depois, pelo validador das sessões. */
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('o arquivo não é um backup do MultTerm (JSON inválido)');
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) throw new Error('o arquivo não é um backup do MultTerm');
  if (raw.version !== 1) throw new Error(`versão de backup não suportada (${String(raw.version)}); atualize o MultTerm`);
  const sessions = raw.sessions ?? [];
  if (!Array.isArray(sessions)) throw new Error('backup inválido: "sessions" deve ser uma lista');
  const sites = raw.vpnSites ?? [];
  if (!Array.isArray(sites)) throw new Error('backup inválido: "vpnSites" deve ser uma lista');
  const vpnSites = sites.map((s, i) => {
    if (!isObject(s) || typeof s.name !== 'string' || typeof s.content !== 'string') throw new Error(`backup inválido: site de VPN ${i + 1}`);
    if (!isSafeSiteName(s.name)) throw new Error(`backup inválido: nome de site "${s.name}"`);
    if (s.content.length > MAX_SITE || !siteInfo(s.name, s.content).host) throw new Error(`backup inválido: o site "${s.name}" não tem gateway`);
    return { name: s.name, content: s.content };
  });
  const servers: Record<string, Record<string, unknown>> = {};
  if (raw.servers !== undefined) {
    if (!isObject(raw.servers)) throw new Error('backup inválido: "servers"');
    for (const [kind, cfg] of Object.entries(raw.servers)) if (isObject(cfg)) servers[kind] = cfg;
  }
  const agent: Backup['agent'] = {};
  if (isObject(raw.agent)) {
    if (Number.isInteger(raw.agent.port)) agent.port = raw.agent.port as number;
    if (typeof raw.agent.agent === 'string') agent.agent = raw.agent.agent;
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    sessions,
    ...(raw.sessionDefaults !== undefined ? { sessionDefaults: raw.sessionDefaults } : {}),
    vpnSites,
    servers,
    agent,
  };
}

/** Nome sugerido: MultTerm-backup-AAAA-MM-DD.multterm */
export function backupFileName(now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `MultTerm-backup-${d}.${BACKUP_EXTENSION}`;
}

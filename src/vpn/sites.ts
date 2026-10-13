import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/*
 * Sites de VPN: um arquivo por site no formato .vpn (linhas "s:chave:texto", "n:chave:número" e
 * "b:chave:base64"), o mesmo dos arquivos exportados por outros clientes IPsec/IKEv1, então
 * importar e exportar continuam compatíveis.
 */

/** Lê um arquivo de site (ou .vpn exportado). Valores podem conter ":". */
export function parseSiteFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([snb]):([\w-]+):(.*)$/.exec(line);
    if (m) out.set(m[2], m[3]);
  }
  return out;
}

export interface VpnSite {
  name: string;
  host: string;
  port?: number;
  auth?: string;
  /** Usa usuário e senha (XAuth). */
  credentials: boolean;
  savedUser?: string;
}

export function siteInfo(name: string, text: string): VpnSite {
  const cfg = parseSiteFile(text);
  const host = cfg.get('network-host') ?? '';
  const port = Number(cfg.get('network-ike-port'));
  const auth = cfg.get('auth-method');
  return {
    name,
    host,
    ...(Number.isInteger(port) && port > 0 && port !== 500 ? { port } : {}),
    ...(auth ? { auth } : {}),
    credentials: !auth || /xauth/i.test(auth),
    ...(cfg.get('client-saved-username') ? { savedUser: cfg.get('client-saved-username') } : {}),
  };
}

/** Nome de site seguro como nome de arquivo (sem aspas nem separadores). */
export function isSafeSiteName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[^\\/:*?"<>|\x00-\x1f]{1,100}$/.test(name) && !/^\.+$/.test(name) && name.trim() === name && !name.startsWith('-');
}

export interface SiteDirs {
  user: string;
}

export async function listSites(dirs: SiteDirs): Promise<VpnSite[]> {
  const sites: VpnSite[] = [];
  for (const name of await readdir(dirs.user).catch(() => [] as string[])) {
    if (!isSafeSiteName(name)) continue;
    const text = await readFile(join(dirs.user, name), 'utf8').catch(() => '');
    const site = siteInfo(name, text);
    if (site.host) sites.push(site);
  }
  return sites.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Copia um .vpn para a pasta de sites; nome repetido ganha " (2)", " (3)"... */
export async function importSite(file: string, userDir: string): Promise<VpnSite> {
  const text = await readFile(file, 'utf8');
  // eslint-disable-next-line no-control-regex
  const base = basename(file, extname(file)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/^[-.]+/, '') || 'site';
  const probe = siteInfo(base, text);
  if (!probe.host) throw new Error('o arquivo não é um site de VPN (falta o gateway "network-host")');
  await mkdir(userDir, { recursive: true });
  const taken = new Set((await readdir(userDir)).map((n) => n.toLowerCase()));
  let name = base.slice(0, 90);
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 90)} (${i})`;
  await copyFile(file, join(userDir, name));
  return { ...probe, name };
}

/**
 * Na primeira vez (pasta de sites ainda inexistente), copia os sites de pastas antigas — as de
 * outro cliente IPsec instalado antes — para não perder a configuração. Devolve quantos copiou.
 */
export async function migrateSites(from: string[], to: string): Promise<number> {
  if (await stat(to).then(() => true, () => false)) return 0;
  await mkdir(to, { recursive: true });
  let copied = 0;
  const taken = new Set<string>();
  for (const dir of from) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!isSafeSiteName(name) || taken.has(name.toLowerCase())) continue;
      const text = await readFile(join(dir, name), 'utf8').catch(() => '');
      if (!siteInfo(name, text).host) continue;
      await copyFile(join(dir, name), join(to, name));
      taken.add(name.toLowerCase());
      copied++;
    }
  }
  return copied;
}

export type VpnState = 'connecting' | 'connected' | 'disconnecting' | 'off';

export interface VpnStatus {
  site: string;
  state: VpnState;
  log: string;
  error?: string;
  since?: number;
}

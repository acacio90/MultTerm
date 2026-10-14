import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importSite, isSafeSiteName, listSites, migrateSites, siteInfo, type SiteDirs, type VpnStatus } from '../vpn/sites.ts';
import { deleteSite, exportSite, newSite, readSite, readSiteText, saveSite, SITE_FIELDS, type SiteSave } from '../vpn/site-editor.ts';
import { siteToVpnOptions } from '../vpn/site-config.ts';
import { NativeVpnConnection } from './native-vpn.ts';

// VPN IPsec/IKEv1 pelo motor do próprio MultTerm (IKEv1/ESP + Wintun num processo elevado). Uma
// conexão por vez, independente das abas (o indicador na barra superior mostra o estado) e
// encerrada ao sair do app.

// MULTTERM_VPN_SITES troca a pasta de sites (testes).
const siteDirs = (): SiteDirs => ({ user: process.env.MULTTERM_VPN_SITES || join(app.getPath('userData'), 'vpn-sites') });

// Pastas de sites de um cliente IPsec usado antes do MultTerm: copiadas na primeira vez.
const legacySiteDirs = () => [
  join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Shrew Soft VPN', 'sites'),
  join(process.env.ProgramData || 'C:\\ProgramData', 'Shrew Soft VPN', 'sites'),
];

let migrated: Promise<number> | undefined;
const ready = () => {
  migrated ??= process.env.MULTTERM_VPN_SITES ? Promise.resolve(0) : migrateSites(legacySiteDirs(), siteDirs().user).catch(() => 0);
  return migrated;
};

let connection: NativeVpnConnection | undefined;
let lastStatus: VpnStatus | undefined;

function broadcast(status: VpnStatus) {
  lastStatus = status;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('vpn:status', status);
  }
}

function text(v: unknown, what: string, max = 200): string {
  const s = typeof v === 'string' ? v : '';
  // eslint-disable-next-line no-control-regex
  if (s.length > max || /[\x00-\x1f"]/.test(s)) throw new Error(`${what} inválido`);
  return s;
}

export async function disconnectVpn(): Promise<void> {
  const c = connection;
  connection = undefined;
  await c?.disconnect();
}

/** Todos os sites, com o conteúdo do .vpn (para o backup). */
export async function exportVpnSites(): Promise<{ name: string; content: string }[]> {
  await ready();
  const sites = await listSites(siteDirs());
  return Promise.all(sites.map(async (s) => ({ name: s.name, content: await readSiteText(siteDirs(), s.name) })));
}

/** Restaura sites de um backup; os que já existem (mesmo nome) ficam como estão. */
export async function importVpnSites(list: { name: string; content: string }[]): Promise<{ added: number; skipped: number }> {
  await ready();
  const dir = siteDirs().user;
  await mkdir(dir, { recursive: true });
  const taken = new Set((await readdir(dir)).map((n) => n.toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const { name, content } of list) {
    if (!isSafeSiteName(name) || !siteInfo(name, content).host || taken.has(name.toLowerCase())) {
      skipped++;
      continue;
    }
    await writeFile(join(dir, name), content, 'utf8');
    taken.add(name.toLowerCase());
    added++;
  }
  return { added, skipped };
}

export function registerVpnIpc(): void {
  ipcMain.handle('vpn:info', async () => {
    await ready();
    // O motor usa o Wintun: só no Windows.
    return { supported: process.platform === 'win32', sites: await listSites(siteDirs()), sitesDir: siteDirs().user, status: lastStatus };
  });

  ipcMain.handle('vpn:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Importar site de VPN',
      filters: [{ name: 'Site de VPN', extensions: ['vpn'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
      properties: ['openFile' as const],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    return importSite(res.filePaths[0], siteDirs().user);
  });

  // Editor de sites: a PSK nunca vai para a interface (só "pskSet").
  ipcMain.handle('vpn:site-schema', () => SITE_FIELDS);
  ipcMain.handle('vpn:site-get', (_e, name: unknown) => (name ? readSite(siteDirs(), text(name, 'site', 100)) : newSite()));
  ipcMain.handle('vpn:site-save', (_e, raw: unknown) => {
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const values = (typeof o.values === 'object' && o.values !== null ? o.values : {}) as Record<string, unknown>;
    const req: SiteSave = {
      ...(o.original ? { original: text(o.original, 'site', 100) } : {}),
      name: String(o.name ?? ''),
      values,
      psk: typeof o.psk === 'string' ? o.psk : '',
    };
    return saveSite(siteDirs(), req);
  });
  ipcMain.handle('vpn:site-delete', async (_e, name: unknown) => {
    const site = text(name, 'site', 100);
    if (connection && connection.status.site.toLowerCase() === site.toLowerCase()) throw new Error('desconecte a VPN antes de excluir o site');
    await deleteSite(siteDirs(), site);
  });
  ipcMain.handle('vpn:site-export', async (e, name: unknown) => {
    const site = text(name, 'site', 100);
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Exportar site da VPN',
      defaultPath: join(app.getPath('documents'), `${site}.vpn`),
      filters: [{ name: 'Site de VPN', extensions: ['vpn'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await exportSite(siteDirs(), site, res.filePath);
    return res.filePath;
  });

  // Exporta todos os sites (um .vpn por site) numa pasta escolhida.
  ipcMain.handle('vpn:export-all', async (e) => {
    const sites = await exportVpnSites();
    if (!sites.length) throw new Error('não há sites de VPN para exportar');
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Exportar sites de VPN (escolha a pasta)',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    for (const s of sites) await writeFile(join(res.filePaths[0], `${s.name}.vpn`), s.content, 'utf8');
    return { dir: res.filePaths[0], count: sites.length };
  });

  ipcMain.handle('vpn:connect', async (_e, raw: unknown) => {
    if (process.platform !== 'win32') throw new Error('a VPN do MultTerm só funciona no Windows');
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const site = text(o.site, 'site', 100);
    if (!(await listSites(siteDirs())).some((s) => s.name === site)) throw new Error(`site "${site}" não encontrado`);
    const user = text(o.user, 'usuário');
    const password = typeof o.password === 'string' && o.password.length <= 256 ? o.password : '';
    if (connection) {
      if (connection.status.site === site && connection.status.state === 'connected') return connection.status;
      await disconnectVpn();
    }
    const c = new NativeVpnConnection(site, siteToVpnOptions(await readSiteText(siteDirs(), site), { user, password }));
    connection = c;
    c.on('status', (s: VpnStatus) => {
      if (connection === c || s.state === 'off') broadcast(s);
      if (s.state === 'off' && connection === c) connection = undefined;
    });
    await c.connect();
    return c.status;
  });

  ipcMain.handle('vpn:disconnect', () => disconnectVpn());
  ipcMain.handle('vpn:networks', () => {
    const s = connection?.status.state === 'connected' ? connection.setup : undefined;
    return { ip: s?.address, networks: (s?.networks ?? []).filter((n) => n !== '0.0.0.0/0') };
  });

  // Derruba o túnel antes de sair (o adaptador e as rotas sumiriam só com o processo auxiliar).
  let quitting = false;
  app.on('before-quit', (e) => {
    if (!connection || quitting) return;
    e.preventDefault();
    quitting = true;
    void disconnectVpn().finally(() => app.quit());
  });
}

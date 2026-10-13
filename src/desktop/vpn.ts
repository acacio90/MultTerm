import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  findShrew, importSite, listSites, parseVpnNetworks, ShrewConnection, VPN_NETWORKS_SCRIPT, type SiteDirs, type VpnStatus,
} from '../network/shrew.ts';
import { deleteSite, exportSite, newSite, readSite, readSiteText, saveSite, SITE_FIELDS, type SiteSave } from '../network/shrew-site.ts';
import { siteToVpnOptions } from '../vpn/site-config.ts';
import { NativeVpnConnection } from './native-vpn.ts';

// VPN por um de dois motores: o do próprio MultTerm (IKEv1/ESP + Wintun, processo elevado) ou o
// Shrew Soft VPN Client instalado. Uma conexão por vez, independente das abas (o indicador na
// barra superior mostra o estado) e encerrada ao sair do app.

interface Connection {
  status: VpnStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  showWindow(show: boolean): void;
  on(ev: 'status', cb: (s: VpnStatus) => void): unknown;
}

const shrewExe = () => findShrew({
  // MULTTERM_PROGRAM_FILES (separado por ";") troca as pastas de programas (testes).
  programFiles: process.env.MULTTERM_PROGRAM_FILES?.split(';')
    ?? [process.env.ProgramFiles ?? '', process.env['ProgramFiles(x86)'] ?? ''],
  fileExists: existsSync,
});

// MULTTERM_SHREW_SITES troca a pasta de sites do usuário e desliga os públicos (testes).
const siteDirs = (): SiteDirs => process.env.MULTTERM_SHREW_SITES
  ? { user: process.env.MULTTERM_SHREW_SITES }
  : {
      user: join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Shrew Soft VPN', 'sites'),
      public: join(process.env.ProgramData || 'C:\\ProgramData', 'Shrew Soft VPN', 'sites'),
    };

let connection: Connection | undefined;
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

function vpnNetworks(): Promise<ReturnType<typeof parseVpnNetworks>> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', VPN_NETWORKS_SCRIPT], { timeout: 20_000, windowsHide: true },
      (err, stdout) => resolve(err ? { networks: [] } : parseVpnNetworks(stdout.trim())));
  });
}

export async function disconnectVpn(): Promise<void> {
  const c = connection;
  connection = undefined;
  await c?.disconnect();
}

export function registerVpnIpc(): void {
  ipcMain.handle('vpn:info', async () => {
    const exe = shrewExe();
    // O motor do MultTerm só existe no Windows (Wintun); os sites valem para os dois motores.
    return { exe, native: process.platform === 'win32', sites: await listSites(siteDirs()), sitesDir: siteDirs().user, status: lastStatus };
  });

  ipcMain.handle('vpn:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Importar site do Shrew Soft VPN',
      filters: [{ name: 'Site do Shrew Soft VPN', extensions: ['vpn'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
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
      filters: [{ name: 'Site do Shrew Soft VPN', extensions: ['vpn'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await exportSite(siteDirs(), site, res.filePath);
    return res.filePath;
  });

  ipcMain.handle('vpn:connect', async (_e, raw: unknown) => {
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const engine = o.engine === 'shrew' ? 'shrew' : 'native';
    const exe = shrewExe();
    if (engine === 'shrew' && !exe) throw new Error('Shrew Soft VPN Client não encontrado');
    if (engine === 'native' && process.platform !== 'win32') throw new Error('o motor de VPN do MultTerm só funciona no Windows');
    const site = text(o.site, 'site', 100);
    if (!(await listSites(siteDirs())).some((s) => s.name === site)) throw new Error(`site "${site}" não encontrado`);
    const user = text(o.user, 'usuário');
    const password = typeof o.password === 'string' && o.password.length <= 256 ? o.password : '';
    if (connection) {
      if (connection.status.site === site && connection.status.state === 'connected') return connection.status;
      await disconnectVpn();
    }
    const c: Connection = engine === 'shrew'
      ? new ShrewConnection({ exe: exe!, site, user, password, show: o.show === true })
      : new NativeVpnConnection(site, siteToVpnOptions(await readSiteText(siteDirs(), site), { user, password }));
    connection = c;
    c.on('status', (s: VpnStatus) => {
      if (connection === c || s.state === 'off') broadcast(s);
      if (s.state === 'off' && connection === c) connection = undefined;
    });
    await c.connect();
    return c.status;
  });

  ipcMain.handle('vpn:disconnect', () => disconnectVpn());
  ipcMain.on('vpn:show-window', (_e, show: unknown) => connection?.showWindow(show === true));
  ipcMain.handle('vpn:networks', () => {
    if (connection?.status.state !== 'connected') return { networks: [] };
    if (connection instanceof NativeVpnConnection) {
      const s = connection.setup;
      return { ip: s?.address, networks: (s?.networks ?? []).filter((n) => n !== '0.0.0.0/0') };
    }
    return vpnNetworks();
  });

  // Derruba o túnel antes de sair (o cliente do Shrew ficaria aberto e conectado).
  let quitting = false;
  app.on('before-quit', (e) => {
    if (!connection || quitting) return;
    e.preventDefault();
    quitting = true;
    void disconnectVpn().finally(() => app.quit());
  });
}

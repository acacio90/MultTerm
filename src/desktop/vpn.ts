import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  findShrew, importSite, listSites, parseVpnNetworks, ShrewConnection, VPN_NETWORKS_SCRIPT, type SiteDirs, type VpnStatus,
} from '../network/shrew.ts';

// VPN pelo Shrew Soft VPN Client: uma conexão por vez, independente das abas (o indicador na
// barra superior mostra o estado) e encerrada ao sair do app.

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

let connection: ShrewConnection | undefined;
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
    return { exe, sites: exe ? await listSites(siteDirs()) : [], sitesDir: siteDirs().user, status: lastStatus };
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

  ipcMain.handle('vpn:connect', async (_e, raw: unknown) => {
    const exe = shrewExe();
    if (!exe) throw new Error('Shrew Soft VPN Client não encontrado');
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const site = text(o.site, 'site', 100);
    if (!(await listSites(siteDirs())).some((s) => s.name === site)) throw new Error(`site "${site}" não encontrado`);
    const user = text(o.user, 'usuário');
    const password = typeof o.password === 'string' && o.password.length <= 256 ? o.password : '';
    if (connection) {
      if (connection.status.site === site && connection.status.state === 'connected') return connection.status;
      await disconnectVpn();
    }
    const c = new ShrewConnection({ exe, site, user, password, show: o.show === true });
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
  ipcMain.handle('vpn:networks', () => (connection?.status.state === 'connected' ? vpnNetworks() : { networks: [] }));

  // Derruba o túnel antes de sair (o cliente do Shrew ficaria aberto e conectado).
  let quitting = false;
  app.on('before-quit', (e) => {
    if (!connection || quitting) return;
    e.preventDefault();
    quitting = true;
    void disconnectVpn().finally(() => app.quit());
  });
}

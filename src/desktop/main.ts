import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, webContents } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  embeddedSshCommand,
  parseAgentList,
  parseSshQuery,
  planLaunch,
  sshAddProgram,
  sshProgram,
  type AgentStatus,
  type LaunchPlan,
  type SshAlgorithms,
} from '../sessions/launch.ts';
import { checkForUpdates, downloadUpdate, getUpdateStatus, initUpdates, installUpdate } from './updates.ts';
import { closeTerminal, closeTerminalsOf, moveTerminal, openTerminal, resizeTerminal, writeTerminal } from './terminals.ts';
import { cancelJobsOf, registerToolsIpc } from './tools.ts';
import { exportVpnSites, importVpnSites, registerVpnIpc } from './vpn.ts';
import { exportServerConfigs, importServerConfigs, registerServersIpc } from './servers.ts';
import { agentLaunch, exportAgentPrefs, importAgentPrefs, registerAgentIpc } from './agent.ts';
import { closeRdpOf, registerRdpIpc } from './rdp.ts';
import { buildAppMenu } from './menu.ts';
import { BACKUP_EXTENSION, backupFileName, parseBackup, serializeBackup } from './backup.ts';
import { localShellCommand, type LocalShell } from './local-terminal.ts';
import { wintunDllPath } from './native-vpn.ts';
import { HELPER_FLAG, runVpnHelper } from '../vpn/helper.ts';
import { readImportFile } from '../sessions/import.ts';
import { exportFileName, loadSessionFile, mergeSessions, saveSessionFile, sessionsInFolder, validateSessions } from '../sessions/store.ts';

// Pasta de dados alternativa (testes isolados, perfis separados). Precisa vir antes do "ready".
if (process.env.MULTTERM_USER_DATA) app.setPath('userData', resolve(process.env.MULTTERM_USER_DATA));

const appRoot = app.getAppPath();
const configPath = () => join(app.getPath('userData'), 'config.json');
let sessionsPath = '';

async function resolveSessionsPath(): Promise<string> {
  if (process.env.MULTTERM_SESSIONS) return resolve(process.env.MULTTERM_SESSIONS);
  try {
    const config = JSON.parse(await readFile(configPath(), 'utf8')) as { sessionsFile?: unknown };
    if (typeof config.sessionsFile === 'string') return config.sessionsFile;
  } catch {
    // sem config: usa o padrão
  }
  return join(app.getPath('userData'), 'sessions.yaml');
}

/**
 * Algoritmos que o ssh local suporta ("ssh -Q"), consultados uma vez: sessões com "algoritmos
 * antigos" só pedem os que existem (um nome desconhecido faria o ssh recusar a linha de comando).
 */
let sshAlgorithmsCache: Promise<SshAlgorithms | undefined> | undefined;
function sshAlgorithms(): Promise<SshAlgorithms | undefined> {
  sshAlgorithmsCache ??= (async () => {
    const program = sshProgram({ platform: process.platform, fileExists: existsSync, systemRoot: process.env.SystemRoot });
    const query = (kind: string) => new Promise<string[]>((resolve, reject) => {
      execFile(program, ['-Q', kind], { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(parseSshQuery(stdout))));
    });
    try {
      const [kex, cipher, mac, key] = await Promise.all(['kex', 'cipher', 'mac', 'key'].map(query));
      return { kex, cipher, mac, key };
    } catch {
      return undefined; // sem a consulta, pede todos os da lista (o ssh avisa se algum não existir)
    }
  })();
  return sshAlgorithmsCache;
}

async function snapshot() {
  return { path: sessionsPath, sessions: await loadSessionFile(sessionsPath) };
}

async function persist(raw: unknown) {
  const sessions = validateSessions(raw, 'interface');
  await mkdir(dirname(sessionsPath), { recursive: true });
  await saveSessionFile(sessionsPath, sessions);
  return snapshot();
}

function hasWindowsTerminal(): boolean {
  if (process.platform !== 'win32') return false;
  // wt.exe é um alias de execução (reparse point): stat/existsSync falham nele, lstat não.
  try {
    lstatSync(join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe'));
    return true;
  } catch {
    return false;
  }
}

function run(plan: LaunchPlan): Promise<void> {
  return new Promise<void>((ok, fail) => {
    const child = spawn(plan.command, plan.args, {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: plan.verbatim ?? false,
    });
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref();
      ok();
    });
  });
}

function registerIpc(): void {
  ipcMain.handle('sessions:load', () => snapshot());

  ipcMain.handle('sessions:save', (_e, raw: unknown) => persist(raw));

  ipcMain.handle('sessions:choose-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Arquivo de sessões',
      defaultPath: sessionsPath,
      filters: [{ name: 'Sessões YAML', extensions: ['yaml', 'yml'] }],
      properties: ['openFile', 'promptToCreate'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    sessionsPath = result.filePaths[0];
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ sessionsFile: sessionsPath }, null, 2), 'utf8');
    return snapshot();
  });

  // Exporta todas as sessões, ou só uma pasta (com subpastas), no mesmo YAML que a importação lê.
  ipcMain.handle('sessions:export', async (_e, folder: unknown) => {
    const scope = typeof folder === 'string' ? folder : '';
    const sessions = sessionsInFolder(await loadSessionFile(sessionsPath), scope);
    if (sessions.length === 0) throw new Error(scope ? `a pasta "${scope}" não tem sessões para exportar` : 'não há sessões para exportar');
    const result = await dialog.showSaveDialog({
      title: scope ? `Exportar a pasta "${scope}"` : 'Exportar sessões',
      defaultPath: join(app.getPath('documents'), exportFileName(scope)),
      filters: [{ name: 'Sessões YAML', extensions: ['yaml', 'yml'] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (resolve(result.filePath) === resolve(sessionsPath)) throw new Error('escolha outro arquivo: este é o arquivo de sessões em uso');
    await saveSessionFile(result.filePath, sessions);
    return { path: result.filePath, count: sessions.length };
  });

  ipcMain.handle('sessions:import', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importar sessões',
      defaultPath: dirname(sessionsPath),
      filters: [
        { name: 'Sessões ou inventário do Ansible', extensions: ['yaml', 'yml', 'ini', 'cfg', 'hosts'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const { format, sessions: imported, warnings } = await readImportFile(result.filePaths[0]);
    const { merged, added, skipped } = mergeSessions(await loadSessionFile(sessionsPath), imported);
    return { ...(await persist(merged)), format, added: added.length, skipped: skipped.length, warnings };
  });

  // Backup completo: sessões, sites de VPN, configurações dos servidores e do agente.
  ipcMain.handle('backup:export', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Exportar backup completo',
      defaultPath: join(app.getPath('documents'), backupFileName()),
      filters: [{ name: 'Backup do MultTerm', extensions: [BACKUP_EXTENSION] }],
    });
    if (result.canceled || !result.filePath) return null;
    const sessions = await loadSessionFile(sessionsPath);
    const vpnSites = await exportVpnSites();
    const servers = await exportServerConfigs();
    await writeFile(result.filePath, serializeBackup({
      createdAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      sessions,
      vpnSites,
      servers,
      agent: exportAgentPrefs(),
    }), 'utf8');
    return { path: result.filePath, sessions: sessions.length, vpnSites: vpnSites.length, servers: Object.keys(servers).length };
  });

  ipcMain.handle('backup:import', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importar backup completo',
      defaultPath: app.getPath('documents'),
      filters: [{ name: 'Backup do MultTerm', extensions: [BACKUP_EXTENSION] }, { name: 'Todos os arquivos', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const backup = parseBackup(await readFile(result.filePaths[0], 'utf8'));
    // Valida tudo antes de gravar qualquer coisa.
    const imported = validateSessions(backup.sessions, 'backup');
    const { merged, added, skipped } = mergeSessions(await loadSessionFile(sessionsPath), imported);
    const snap = added.length ? await persist(merged) : await snapshot();
    const sites = await importVpnSites(backup.vpnSites);
    const servers = await importServerConfigs(backup.servers);
    await importAgentPrefs(backup.agent);
    return { ...snap, added: added.length, skipped: skipped.length, sites, servers };
  });

  ipcMain.handle('session:connect', async (_e, raw: unknown) => {
    const [session] = validateSessions([raw], 'conexão');
    const env = {
      platform: process.platform,
      windowsTerminal: hasWindowsTerminal(),
      home: homedir(),
      tmp: tmpdir(),
      fileExists: existsSync,
      systemRoot: process.env.SystemRoot,
      sshAlgorithms: session.legacySsh ? await sshAlgorithms() : undefined,
    };
    let plan = planLaunch(session, env);
    if (plan.file) {
      await mkdir(dirname(plan.file.path), { recursive: true });
      await writeFile(plan.file.path, plan.file.content, 'utf8');
    }
    try {
      await run(plan);
    } catch (err) {
      if (!env.windowsTerminal || session.type !== 'ssh') {
        throw new Error(`não foi possível executar ${plan.command}: ${(err as Error).message}`);
      }
      // Windows Terminal não abriu: tenta uma janela de console comum.
      plan = planLaunch(session, { ...env, windowsTerminal: false });
      plan.warnings.push(`Windows Terminal indisponível (${(err as Error).message}); usando console comum`);
      await run(plan);
    }
    return { warnings: plan.warnings, via: plan.command };
  });

  // Terminal embutido (abas).
  // Terminal local (PowerShell, cmd, WSL) ou o agente numa aba local.
  ipcMain.handle('term:open-local', async (e, id: unknown, kind: unknown, cols: unknown, rows: unknown) => {
    const size = (n: unknown, fallback: number) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : fallback);
    const shells: LocalShell[] = ['powershell', 'cmd', 'wsl'];
    const cmd = kind === 'agent' ? await agentLaunch()
      : shells.includes(kind as LocalShell) ? localShellCommand(kind as LocalShell) : undefined;
    if (!cmd) throw new Error('tipo de terminal local inválido');
    if (!existsSync(cmd.file)) throw new Error(kind === 'wsl' ? 'o WSL não está instalado' : `não encontrado: ${cmd.file}`);
    openTerminal(e.sender, id, cmd.file, cmd.args, { cols: size(cols, 80), rows: size(rows, 24), cwd: homedir() });
  });

  ipcMain.handle('term:open', async (e, id: unknown, raw: unknown, cols: unknown, rows: unknown) => {
    const [session] = validateSessions([raw], 'conexão');
    const { file, args, warnings } = embeddedSshCommand(session, {
      platform: process.platform,
      home: homedir(),
      fileExists: existsSync,
      systemRoot: process.env.SystemRoot,
      sshAlgorithms: session.legacySsh ? await sshAlgorithms() : undefined,
    });
    const size = (n: unknown, fallback: number) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : fallback);
    openTerminal(e.sender, id, file, args, { cols: size(cols, 80), rows: size(rows, 24), cwd: homedir() });
    // Avisos vão para a faixa da aba: o ConPTY limpa a tela ao iniciar e apagaria texto escrito antes.
    return { warnings };
  });
  ipcMain.on('term:input', (e, id: unknown, data: unknown) => writeTerminal(e.sender, id, data));
  ipcMain.on('term:resize', (e, id: unknown, cols: unknown, rows: unknown) => resizeTerminal(e.sender, id, cols, rows));
  ipcMain.on('term:close', (e, id: unknown) => closeTerminal(e.sender, id));

  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.on('clipboard:write', (_e, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  // Tela de ajuda.
  ipcMain.handle('app:info', async () => {
    const env = { platform: process.platform, fileExists: existsSync, systemRoot: process.env.SystemRoot };
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      sessionsPath,
      ssh: sshProgram(env),
      agent: await agentStatus(sshAddProgram(env)),
      repoUrl: REPO_URL,
    };
  });
  ipcMain.on('app:open-repo', (_e, path: unknown) => {
    // Só abre páginas do repositório do projeto.
    const suffix = typeof path === 'string' && /^[\w/.-]*$/.test(path) ? path : '';
    void shell.openExternal(`${REPO_URL}${suffix}`);
  });
  ipcMain.on('app:show-sessions-file', () => shell.showItemInFolder(sessionsPath));

  ipcMain.handle('update:status', () => getUpdateStatus());
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.on('update:install', () => installUpdate());
}

const REPO_URL = 'https://github.com/acacio90/MultTerm';

function agentStatus(sshAdd: string): Promise<AgentStatus> {
  return new Promise((done) => {
    execFile(sshAdd, ['-l'], { timeout: 3000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      if (err && code === null) {
        done({ available: false, message: `${sshAdd}: ${err.message}` });
        return;
      }
      done(parseAgentList(code, stdout, stderr));
    });
  });
}

// Janela principal (com a árvore de sessões); as demais são abas destacadas.
let mainWindow: BrowserWindow | undefined;

async function createWindow(opts: { detached?: boolean; title?: string } = {}): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: opts.detached ? 900 : 1100,
    height: opts.detached ? 560 : 700,
    minWidth: 720,
    minHeight: 420,
    icon: join(appRoot, 'desktop', 'icon.png'),
    title: opts.title ? `${opts.title} — MultTerm` : 'MultTerm',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: join(appRoot, 'desktop', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (!opts.detached) mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  const contents = win.webContents;
  contents.on('destroyed', () => {
    closeTerminalsOf(contents);
    closeRdpOf(contents);
    cancelJobsOf(contents);
  });
  // Janela de aba destacada: só as abas, sem o menu do topo.
  if (opts.detached) win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Modo de verificação: salva um print da janela e encerra.
  const screenshot = process.env.MULTTERM_SCREENSHOT;
  if (screenshot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        await writeFile(screenshot, image.toPNG());
        app.quit();
      }, 800);
    });
  }

  await win.loadFile(join(appRoot, 'desktop', 'index.html'), opts.detached ? { query: { detached: '1' } } : undefined);
  return win;
}

/*
 * Destacar/devolver abas de terminal: a janela de origem oferece a aba, a de destino a adota
 * (o processo continua o mesmo; só troca o dono) e só então a origem tira a aba da tela.
 */
const offers = new Map<string, number>(); // "janela:aba" de origem → janela de destino

// O destino já carregou (createWindow espera o loadFile); o preload guarda a oferta até o app pedir.
function offerTab(from: Electron.WebContents, id: number, meta: unknown, target: BrowserWindow) {
  offers.set(`${from.id}:${id}`, target.webContents.id);
  target.webContents.send('term:adopt', { fromWc: from.id, fromId: id, meta });
}

function registerDetachIpc() {
  ipcMain.handle('term:detach', async (e, id: unknown, meta: unknown) => {
    if (!Number.isInteger(id)) throw new Error('aba inválida');
    const title = typeof (meta as { title?: unknown })?.title === 'string' ? (meta as { title: string }).title.slice(0, 80) : undefined;
    const win = await createWindow({ detached: true, title });
    offerTab(e.sender, id as number, meta, win);
  });
  ipcMain.handle('term:reattach', async (e, id: unknown, meta: unknown) => {
    if (!Number.isInteger(id)) throw new Error('aba inválida');
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : await createWindow();
    target.show();
    target.focus();
    offerTab(e.sender, id as number, meta, target);
  });
  ipcMain.handle('term:adopt', (e, fromWc: unknown, fromId: unknown, toId: unknown) => {
    const key = `${fromWc}:${fromId}`;
    if (offers.get(key) !== e.sender.id || !Number.isInteger(fromId) || !Number.isInteger(toId)) throw new Error('aba não oferecida a esta janela');
    offers.delete(key);
    const from = webContents.fromId(fromWc as number);
    if (!from || from.isDestroyed()) throw new Error('a janela de origem fechou');
    const moved = moveTerminal(from, fromId as number, e.sender, toId as number);
    from.send('term:released', fromId);
    return moved;
  });
}

// Processo auxiliar da VPN (elevado): só o túnel, sem janela nem IPC.
const vpnHelper = process.argv.includes(HELPER_FLAG);
if (vpnHelper) void runVpnHelper(process.argv, wintunDllPath(), (code) => app.exit(code));

if (!vpnHelper) app.whenReady().then(async () => {
  sessionsPath = await resolveSessionsPath();
  registerIpc();
  registerToolsIpc();
  registerVpnIpc();
  registerServersIpc();
  registerAgentIpc();
  registerDetachIpc();
  registerRdpIpc();
  Menu.setApplicationMenu(buildAppMenu({
    // Os comandos agem na janela principal (abre de novo se só restaram janelas destacadas).
    send: async (command) => {
      const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : await createWindow();
      if (target.isMinimized()) target.restore();
      target.focus();
      target.webContents.send('menu:command', command);
    },
    openProject: () => void shell.openExternal(REPO_URL),
    about: () => {
      const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const opts = {
        type: 'info' as const,
        title: 'Sobre o MultTerm',
        message: `MultTerm ${app.getVersion()}`,
        detail: `Gerenciador de sessões SSH/RDP com terminal em abas, VPN, servidores locais e agente MCP.\n\n` +
          `Licença GPL-3.0. Inclui o FreeRDP (Apache 2.0) e o Wintun.\n${REPO_URL}\n\n` +
          `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
        buttons: ['OK', 'Página do projeto'],
        defaultId: 0,
        noLink: true,
      };
      void (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).then((r) => {
        if (r.response === 1) void shell.openExternal(REPO_URL);
      });
    },
  }));
  initUpdates();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !vpnHelper) app.quit();
});

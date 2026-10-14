import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  embeddedSshCommand,
  parseAgentList,
  planLaunch,
  sshAddProgram,
  sshProgram,
  type AgentStatus,
  type LaunchPlan,
} from '../sessions/launch.ts';
import { checkForUpdates, downloadUpdate, getUpdateStatus, initUpdates, installUpdate } from './updates.ts';
import { closeTerminal, closeTerminalsOf, openTerminal, resizeTerminal, writeTerminal } from './terminals.ts';
import { cancelJobsOf, registerToolsIpc } from './tools.ts';
import { registerVpnIpc } from './vpn.ts';
import { registerServersIpc } from './servers.ts';
import { registerAgentIpc } from './agent.ts';
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

  ipcMain.handle('session:connect', async (_e, raw: unknown) => {
    const [session] = validateSessions([raw], 'conexão');
    const env = {
      platform: process.platform,
      windowsTerminal: hasWindowsTerminal(),
      home: homedir(),
      tmp: tmpdir(),
      fileExists: existsSync,
      systemRoot: process.env.SystemRoot,
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
  ipcMain.handle('term:open', (e, id: unknown, raw: unknown, cols: unknown, rows: unknown) => {
    const [session] = validateSessions([raw], 'conexão');
    const { file, args, warnings } = embeddedSshCommand(session, {
      platform: process.platform,
      home: homedir(),
      fileExists: existsSync,
      systemRoot: process.env.SystemRoot,
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

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 720,
    minHeight: 420,
    icon: join(appRoot, 'desktop', 'icon.png'),
    title: 'MultTerm',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: join(appRoot, 'desktop', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const contents = win.webContents;
  contents.on('destroyed', () => {
    closeTerminalsOf(contents);
    cancelJobsOf(contents);
  });
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

  await win.loadFile(join(appRoot, 'desktop', 'index.html'));
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
  initUpdates();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !vpnHelper) app.quit();
});

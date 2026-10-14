import { app, BrowserWindow, dialog, ipcMain, safeStorage, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer, type ShareMode, type SharedTerminal } from '../agent/mcp.ts';
import { startAgentHttp, type AgentHttp } from '../agent/http.ts';
import { timestamp } from '../servers/common.ts';
import { onTerminalMoved, terminalKey, terminalOutput, terminalRunning, waitTerminalQuiet, writeTerminalByKey } from './terminals.ts';
import { agentLaunchCommand } from './local-terminal.ts';

/*
 * Agente MCP: servidor local (HTTP em 127.0.0.1 + ponte stdio) que expõe só as abas de terminal
 * que o usuário compartilhar, com o modo escolhido por aba (leitura, aprovar cada envio ou
 * controle livre). Desligado por padrão; tudo o que o agente faz vai para o registro.
 */

interface Share {
  owner: WebContents;
  tab: number;
  key: string;
  mode: ShareMode;
  title: string;
  detail?: string;
}

const shares = new Map<string, Share>();
const activity: string[] = [];
let http: AgentHttp | undefined;
let prefs: { enabled?: boolean; port?: number; tokenSealed?: string; agentCommand?: string } = {};
let token = '';

const prefsFile = () => join(app.getPath('userData'), 'agent.json');
/** Arquivo lido pela ponte stdio (porta e token do servidor em execução). */
export const connectionFile = () => join(app.getPath('userData'), 'agent-connection.json');
const DEFAULT_PORT = 47830;
/** Configuração MCP (stdio) para o comando do agente: o {mcp} do comando aponta para cá. */
export const mcpConfigFile = () => join(app.getPath('userData'), 'agent-mcp.json');

/** Cada janela recebe só as próprias abas compartilhadas (os ids de aba são por janela). */
function broadcast(extra: Record<string, unknown> = {}) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('agent:event', { ...status(w.webContents), ...extra });
  }
}

function log(line: string) {
  const entry = `[${timestamp()}] ${line}`;
  activity.push(entry);
  if (activity.length > 500) activity.splice(0, activity.length - 500);
  broadcast({ line: entry });
}

async function savePrefs() {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(prefsFile(), JSON.stringify(prefs, null, 2));
}

function loadToken(): string {
  if (prefs.tokenSealed && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(prefs.tokenSealed, 'base64'));
    } catch { /* gera outro */ }
  }
  return '';
}

async function newToken() {
  token = randomBytes(24).toString('base64url');
  if (safeStorage.isEncryptionAvailable()) prefs.tokenSealed = safeStorage.encryptString(token).toString('base64');
  await savePrefs();
}

/** Linha de comando da ponte stdio (o próprio executável em modo Node). */
function stdioCommand() {
  const base = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath();
  return { command: process.execPath, args: [join(base, 'dist', 'agent', 'stdio-main.js'), connectionFile()], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function status(viewer?: WebContents) {
  const port = http?.port ?? prefs.port ?? DEFAULT_PORT;
  return {
    enabled: !!http,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    stdio: stdioCommand(),
    shares: [...shares.values()].filter((s) => !viewer || s.owner === viewer).map((s) => ({ tab: s.tab, mode: s.mode, title: s.title })),
    agentCommand: prefs.agentCommand ?? '',
    mcpConfig: mcpConfigFile(),
  };
}

const bridge = {
  list: (): SharedTerminal[] => [...shares.values()].filter((s) => !s.owner.isDestroyed()).map((s) => ({
    id: s.key, title: s.title, detail: s.detail, mode: s.mode, running: terminalRunning(s.key),
  })),
  find: (id: string) => shares.get(id),
  tail(id: string, lines: number) {
    const s = this.find(id);
    return s ? terminalOutput(s.key)?.tail(lines) ?? '' : '';
  },
  mark(id: string) {
    const s = this.find(id);
    return s ? terminalOutput(s.key)?.total ?? 0 : 0;
  },
  since(id: string, mark: number) {
    const s = this.find(id);
    return s ? terminalOutput(s.key)?.since(mark) ?? '' : '';
  },
  write(id: string, data: string) {
    const s = this.find(id);
    if (s) writeTerminalByKey(s.key, data);
  },
  waitQuiet(id: string, quietMs: number, timeoutMs: number) {
    const s = this.find(id);
    return s ? waitTerminalQuiet(s.key, quietMs, timeoutMs) : Promise.resolve(true);
  },
};

/** Janela de aprovação: Permitir, Permitir sempre nesta aba (vira controle livre) ou Recusar. */
async function approve(t: SharedTerminal, description: string, data: string): Promise<boolean> {
  const share = bridge.find(t.id);
  const win = (share && BrowserWindow.fromWebContents(share.owner)) ?? BrowserWindow.getAllWindows()[0];
  const shown = data.replace(/\r/g, '⏎').replace(/\x03/g, 'Ctrl+C').replace(/\x1b/g, 'Esc').replace(/[\x00-\x1f]/g, '·');
  win?.flashFrame(true);
  const opts = {
    type: 'warning' as const,
    title: 'MultTerm — agente',
    message: `O agente quer ${description.split(':')[0]} na aba "${t.title}"${t.detail ? ` (${t.detail})` : ''}.`,
    detail: `Será digitado exatamente:\n\n${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}`,
    buttons: ['Permitir', 'Permitir sempre nesta aba', 'Recusar'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  win?.flashFrame(false);
  if (response === 1 && share) {
    share.mode = 'auto';
    log(`aba "${share.title}": controle livre liberado pelo usuário`);
    broadcast();
  }
  return response !== 2;
}

const mcp = new McpServer({ bridge, approve, activity: (l) => log(`agente ${l}`), name: 'multterm', version: app.getVersion() });

async function enable() {
  if (http) return;
  if (!token) await newToken();
  try {
    http = await startAgentHttp(mcp, {
      port: prefs.port ?? DEFAULT_PORT,
      token,
      onRequest: (ok, why) => {
        if (!ok) log(`pedido recusado: ${why}`);
      },
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(e.code === 'EADDRINUSE' ? `a porta ${prefs.port ?? DEFAULT_PORT} já está em uso; escolha outra` : e.message);
  }
  await writeFile(connectionFile(), JSON.stringify({ port: http.port, token }), { mode: 0o600 });
  await writeFile(mcpConfigFile(), JSON.stringify({ mcpServers: { multterm: stdioCommand() } }, null, 2));
  prefs.enabled = true;
  await savePrefs();
  log(`agente ligado em ${status().url}`);
  broadcast();
}

async function disable(remember = true) {
  if (!http) return;
  await http.close();
  http = undefined;
  await rm(connectionFile(), { force: true });
  if (remember) {
    prefs.enabled = false;
    await savePrefs();
  }
  log('agente desligado');
  broadcast();
}

/** Liga o servidor (se preciso) e devolve a linha de comando do agente numa aba local. */
export async function agentLaunch(): Promise<{ file: string; args: string[] }> {
  await enable();
  return agentLaunchCommand(prefs.agentCommand ?? '', mcpConfigFile());
}

// A aba mudou de janela (destacar/devolver): o compartilhamento vai junto.
onTerminalMoved((from, to, owner, id) => {
  const s = shares.get(from);
  if (!s) return;
  shares.delete(from);
  shares.set(to, { ...s, owner, tab: id, key: to });
  broadcast();
});

export function registerAgentIpc(): void {
  const ready = (async () => {
    prefs = JSON.parse(await readFile(prefsFile(), 'utf8').catch(() => '{}'));
    token = loadToken();
    await rm(connectionFile(), { force: true }); // sobra de uma execução anterior
    if (prefs.enabled) await enable().catch((err: Error) => log(`não ligou ao abrir: ${err.message}`));
  })();

  ipcMain.handle('agent:status', async (_e) => {
    await ready;
    return { ...status(_e.sender), log: activity };
  });
  ipcMain.handle('agent:enable', async (_e, on: unknown) => {
    await ready;
    if (on === true) await enable();
    else await disable();
    return status(_e.sender);
  });
  ipcMain.handle('agent:set-port', async (_e, port: unknown) => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('porta inválida (1024 a 65535)');
    const was = !!http;
    await disable(false);
    prefs.port = n;
    await savePrefs();
    if (was) await enable();
    return status(_e.sender);
  });
  ipcMain.handle('agent:set-command', async (_e, cmd: unknown) => {
    const text = typeof cmd === 'string' ? cmd.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (/[\r\n\x00]/.test(text) || text.length > 2000) throw new Error('comando do agente inválido (uma linha)');
    prefs.agentCommand = text;
    await savePrefs();
    broadcast();
    return status(_e.sender);
  });
  ipcMain.handle('agent:new-token', async (_e) => {
    const was = !!http;
    await disable(false);
    await newToken();
    if (was) await enable();
    log('token trocado: atualize a configuração do agente');
    return status(_e.sender);
  });
  ipcMain.handle('agent:share', (e, tab: unknown, mode: unknown, title: unknown, detail: unknown) => {
    if (!Number.isInteger(tab)) throw new Error('aba inválida');
    const m = (['off', 'read', 'approve', 'auto'] as const).find((x) => x === mode) ?? 'off';
    const key = terminalKey(e.sender, tab as number);
    const before = shares.get(key);
    if (m === 'off') shares.delete(key);
    else shares.set(key, { owner: e.sender, tab: tab as number, key, mode: m, title: String(title ?? `terminal ${tab}`).slice(0, 120), detail: detail ? String(detail).slice(0, 200) : undefined });
    const label = { off: 'não compartilhada', read: 'somente leitura', approve: 'aprovar cada envio', auto: 'controle livre' }[m];
    if ((before?.mode ?? 'off') !== m) log(`aba "${String(title ?? tab)}": ${label}`);
    broadcast();
  });
  ipcMain.handle('agent:unshare-all', () => {
    if (shares.size) log('todas as abas deixaram de ser compartilhadas');
    shares.clear();
    broadcast();
  });

  app.on('before-quit', () => {
    void rm(connectionFile(), { force: true });
  });
}

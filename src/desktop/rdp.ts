import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { embeddedRdpArgs, rdpExitMessage, rdpStdin } from '../sessions/launch.ts';
import { validateSessions } from '../sessions/store.ts';

/*
 * Sessões RDP numa aba: o MultTerm cria uma janela nativa vinculada à janela do app (uma janela
 * "owned": fica sempre acima dela e minimiza junto), posicionada sobre a área da aba, e o cliente
 * FreeRDP (wfreerdp.exe, distribuído com o app) se encaixa nela com /parent-window. Uma janela
 * filha não serviria: o Chromium compõe a página (DirectComposition) por cima das filhas. A interface informa a posição/visibilidade da aba; menus e diálogos
 * por cima da área escondem a sessão (uma janela nativa sempre fica acima da página).
 */

const require = createRequire(import.meta.url);

// Constantes do Win32.
const WS_POPUP = 0x80000000;
const WS_CLIPCHILDREN = 0x02000000;
const WS_EX_TOOLWINDOW = 0x80; // sem botão na barra de tarefas
const SS_BLACKRECT = 0x4;
const SW_HIDE = 0;
const SW_SHOWNA = 8;
const HWND_TOP = 0;
const SWP_NOACTIVATE = 0x10;
const SWP_NOZORDER = 0x4;
const GW_CHILD = 5;
const WM_EXITSIZEMOVE = 0x232;

type Fn = (...args: unknown[]) => unknown;
let user32: Record<'CreateWindowExW' | 'DestroyWindow' | 'SetWindowPos' | 'ShowWindow' | 'GetWindow' | 'PostMessageW' | 'IsWindow' | 'ClientToScreen', Fn> | undefined;

function win32() {
  if (user32) return user32;
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  const POINT = koffi.struct('MULTTERM_POINT', { x: 'int', y: 'int' });
  user32 = {
    ClientToScreen: u.func('__stdcall', 'ClientToScreen', 'bool', ['intptr', koffi.inout(koffi.pointer(POINT))]),
    CreateWindowExW: u.func('__stdcall', 'CreateWindowExW', 'intptr',
      ['uint32', 'str16', 'str16', 'uint32', 'int', 'int', 'int', 'int', 'intptr', 'intptr', 'intptr', 'intptr']),
    DestroyWindow: u.func('__stdcall', 'DestroyWindow', 'bool', ['intptr']),
    SetWindowPos: u.func('__stdcall', 'SetWindowPos', 'bool', ['intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint32']),
    ShowWindow: u.func('__stdcall', 'ShowWindow', 'bool', ['intptr', 'int']),
    GetWindow: u.func('__stdcall', 'GetWindow', 'intptr', ['intptr', 'uint32']),
    PostMessageW: u.func('__stdcall', 'PostMessageW', 'bool', ['intptr', 'uint32', 'uintptr', 'intptr']),
    IsWindow: u.func('__stdcall', 'IsWindow', 'bool', ['intptr']),
  };
  return user32;
}

/** Cliente RDP distribuído com o app. MULTTERM_FREERDP troca o executável (testes). */
export const freerdpPath = () => process.env.MULTTERM_FREERDP
  || join(app.isPackaged ? join(process.resourcesPath, 'freerdp') : join(app.getAppPath(), 'vendor', 'freerdp'), 'wfreerdp.exe');

interface View {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

interface RdpSession {
  owner: WebContents;
  id: number;
  /** Janela do app (dona do contêiner): a posição da aba é relativa à área cliente dela. */
  window: bigint;
  container: number | bigint;
  proc: ChildProcess;
  view: View;
  child?: number | bigint;
  poll?: NodeJS.Timeout;
  resizeTimer?: NodeJS.Timeout;
  log: string[];
}

const sessions = new Map<string, RdpSession>();
const keyOf = (owner: WebContents, id: number) => `${owner.id}:${id}`;

function validView(raw: unknown): View {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
  return { x: n(o.x), y: n(o.y), width: Math.max(0, n(o.width)), height: Math.max(0, n(o.height)), visible: o.visible === true };
}

/** Aplica posição e visibilidade; com a sessão aberta, ajusta a janela do RDP e a resolução. */
function place(s: RdpSession) {
  const w = win32();
  const { x, y, width, height } = s.view;
  const show = s.view.visible && width > 0 && height > 0 && !!s.child;
  if (!show) {
    w.ShowWindow(s.container, SW_HIDE);
    return;
  }
  // A aba informa a posição na área cliente da janela; o contêiner é de nível superior (tela).
  const pt = { x, y };
  w.ClientToScreen(s.window, pt);
  w.SetWindowPos(s.container, HWND_TOP, pt.x, pt.y, width, height, SWP_NOACTIVATE);
  w.ShowWindow(s.container, SW_SHOWNA);
  w.SetWindowPos(s.child, 0, 0, 0, width, height, SWP_NOACTIVATE | SWP_NOZORDER);
  // O wfreerdp pede a nova resolução ao servidor ao fim de um redimensionamento.
  clearTimeout(s.resizeTimer);
  s.resizeTimer = setTimeout(() => {
    if (s.child) w.PostMessageW(s.child, WM_EXITSIZEMOVE, 0, 0);
  }, 300);
}

function close(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  clearInterval(s.poll);
  clearTimeout(s.resizeTimer);
  if (s.proc.exitCode === null) s.proc.kill();
  const w = win32();
  if (w.IsWindow(s.container)) w.DestroyWindow(s.container);
}

// Mover a janela do app não muda a posição da aba na página: reposiciona as sessões dela.
const followed = new WeakSet<BrowserWindow>();
function follow(win: BrowserWindow, owner: WebContents) {
  if (followed.has(win)) return;
  followed.add(win);
  const replace = () => {
    for (const s of sessions.values()) if (s.owner === owner) place(s);
  };
  win.on('move', replace);
  win.on('moved', replace);
  win.on('restore', replace);
}

export function closeRdpOf(owner: WebContents) {
  for (const [key, s] of sessions) if (s.owner === owner) close(key);
}

/** Usuário e senha digitados na interface (a senha só passa por aqui, nunca é gravada). */
function validCredentials(raw: unknown): { user?: string; password: string } {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const user = typeof o.user === 'string' ? o.user.trim() : '';
  const password = typeof o.password === 'string' ? o.password : '';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(user) || user.length > 256) throw new Error('usuário inválido');
  // A senha vai numa linha da entrada padrão: quebra de linha a cortaria.
  if (/[\r\n\x00]/.test(password) || password.length > 512) throw new Error('senha inválida');
  return { ...(user ? { user } : {}), password };
}

function open(owner: WebContents, id: unknown, rawSession: unknown, rawView: unknown, rawCredentials: unknown) {
  if (process.platform !== 'win32') throw new Error('RDP numa aba só no Windows; use Janela externa');
  if (!Number.isInteger(id) || (id as number) <= 0) throw new Error('aba inválida');
  const key = keyOf(owner, id as number);
  if (sessions.has(key)) throw new Error('esta aba já tem uma sessão RDP');
  const [saved] = validateSessions([rawSession], 'RDP');
  if (saved.type !== 'rdp') throw new Error('a sessão não é RDP');
  const credentials = validCredentials(rawCredentials);
  // O usuário digitado na hora vale para esta conexão (sem mudar a sessão gravada).
  const session = { ...saved, user: credentials.user ?? saved.user };
  const exe = freerdpPath();
  if (!existsSync(exe)) throw new Error('cliente RDP não encontrado nesta instalação; use Janela externa (botão direito na sessão)');
  const win = BrowserWindow.fromWebContents(owner);
  if (!win) throw new Error('janela não encontrada');

  const view = validView(rawView);
  const w = win32();
  const parent = win.getNativeWindowHandle().readBigUInt64LE(0);
  // Popup "owned" pela janela do app (o parâmetro de pai vira o dono); criada escondida.
  const container = w.CreateWindowExW(WS_EX_TOOLWINDOW, 'STATIC', '', WS_POPUP | WS_CLIPCHILDREN | SS_BLACKRECT,
    0, 0, Math.max(1, view.width), Math.max(1, view.height), parent, 0, 0, 0) as number | bigint;
  if (!container) throw new Error('não foi possível criar a área da sessão RDP');

  const args = embeddedRdpArgs(session, { parent: String(container), width: view.width, height: view.height });
  const proc = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
  proc.stdin?.on('error', () => {});
  proc.stdin?.end(rdpStdin(session.user, credentials.password));
  const s: RdpSession = { owner, id: id as number, window: parent, container, proc, view, log: [] };
  sessions.set(key, s);
  follow(win, owner);

  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      // Avisos fixos do FreeRDP (contatos, opções de build) só escondem o que importa.
      if (line.trim() && !/warn_contact_details|log_build_warn/.test(line)) s.log.push(line.trim());
    }
    if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);

  // Mostra a área só quando a janela do RDP existe (antes, ficaria um retângulo preto vazio).
  s.poll = setInterval(() => {
    const child = w.GetWindow(container, GW_CHILD) as number | bigint;
    if (!child) return;
    s.child = child;
    clearInterval(s.poll);
    place(s);
    if (!owner.isDestroyed()) owner.send('rdp:ready', s.id);
  }, 200);

  const finish = (code: number | null, error?: string) => {
    if (sessions.get(key) !== s) return;
    close(key);
    const end = rdpExitMessage(error ? null : code);
    if (error) end.message = `${end.message}: ${error}`;
    // O registro do cliente vai junto, para os detalhes técnicos: os erros primeiro.
    const errors = s.log.filter((l) => /\[(ERROR|FATAL)\]/.test(l));
    const log = (errors.length ? errors : s.log).slice(-12).join('\n');
    if (!owner.isDestroyed()) owner.send('rdp:exit', s.id, code, { ...end, log });
  };
  proc.on('error', (err) => finish(null, err.message));
  proc.on('exit', (code) => finish(code));
}

export function registerRdpIpc(): void {
  ipcMain.handle('rdp:open', (e, id: unknown, session: unknown, view: unknown, credentials: unknown) => open(e.sender, id, session, view, credentials));
  ipcMain.on('rdp:view', (e, id: unknown, view: unknown) => {
    const s = Number.isInteger(id) ? sessions.get(keyOf(e.sender, id as number)) : undefined;
    if (!s) return;
    s.view = validView(view);
    place(s);
  });
  ipcMain.handle('rdp:close', (e, id: unknown) => {
    if (Number.isInteger(id)) close(keyOf(e.sender, id as number));
  });
  ipcMain.handle('rdp:available', () => process.platform === 'win32' && existsSync(freerdpPath()));
  app.on('before-quit', () => {
    for (const key of [...sessions.keys()]) close(key);
  });
}

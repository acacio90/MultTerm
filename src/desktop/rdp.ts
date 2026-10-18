import { app, BrowserWindow, ipcMain, screen, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { embeddedRdpArgs, RDP_DISPLAY_CONTROL, rdpExitMessage, rdpStdin } from '../sessions/launch.ts';
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
const SW_HIDE = 0;
const SW_SHOWNA = 8;
const HWND_TOP = 0;
const SWP_NOACTIVATE = 0x10;
const SWP_NOZORDER = 0x4;
const GW_CHILD = 5;
const WM_EXITSIZEMOVE = 0x232;
const WM_ACTIVATE = 0x0006;
const WM_MOUSEACTIVATE = 0x0021;
const WM_SETFOCUS = 0x0007;
const MA_ACTIVATE = 1;
const HOST_CLASS = 'MultTermRdpHost';

type Fn = (...args: unknown[]) => unknown;
let user32: Record<'CreateWindowExW' | 'DestroyWindow' | 'SetWindowPos' | 'ShowWindow' | 'GetWindow' | 'PostMessageW' | 'IsWindow' | 'SetFocus' | 'keybd_event', Fn> | undefined;
// Mantém o procedimento de janela registrado vivo (o Windows o chama enquanto houver contêiner).
let hostProc: unknown;

/*
 * Classe de janela do contêiner. O wfreerdp encaixado só manda o teclado à sessão quando a janela
 * com foco na thread em primeiro plano é a janela-pai dele (wf_ll_kbd_proc); por isso o contêiner
 * toma o foco ao ser clicado (WM_MOUSEACTIVATE, que chega quando se clica na janela do RDP) ou
 * ativado. E, diferente de um controle STATIC (que responde HTTRANSPARENT), recebe os cliques.
 * Ao ganhar o foco, avisa a janela do wfreerdp com um WM_SETFOCUS: se ela chegou a ter o
 * foco e o perdeu (WM_KILLFOCUS), a entrada fica suspensa (FreeRDP_SuspendInput) até esse aviso.
 */
function registerHostClass(koffi: any, u: any) {
  const k32 = koffi.load('kernel32.dll');
  const gdi = koffi.load('gdi32.dll');
  const WNDPROC = koffi.proto('__stdcall', 'MULTTERM_WNDPROC', 'intptr', ['intptr', 'uint32', 'uintptr', 'intptr']);
  const WNDCLASSEXW = koffi.struct('MULTTERM_WNDCLASSEXW', {
    cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WNDPROC), cbClsExtra: 'int', cbWndExtra: 'int',
    hInstance: 'intptr', hIcon: 'intptr', hCursor: 'intptr', hbrBackground: 'intptr',
    lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'intptr',
  });
  const DefWindowProcW = u.func('__stdcall', 'DefWindowProcW', 'intptr', ['intptr', 'uint32', 'uintptr', 'intptr']);
  const SetFocus = u.func('__stdcall', 'SetFocus', 'intptr', ['intptr']);
  const RegisterClassExW = u.func('__stdcall', 'RegisterClassExW', 'uint16', [koffi.pointer(WNDCLASSEXW)]);
  const LoadCursorW = u.func('__stdcall', 'LoadCursorW', 'intptr', ['intptr', 'intptr']);
  const GetModuleHandleW = k32.func('__stdcall', 'GetModuleHandleW', 'intptr', ['str16']);
  const GetWindow = u.func('__stdcall', 'GetWindow', 'intptr', ['intptr', 'uint32']);
  const SendMessageTimeoutW = u.func('__stdcall', 'SendMessageTimeoutW', 'intptr',
    ['intptr', 'uint32', 'uintptr', 'intptr', 'uint32', 'uint32', koffi.out(koffi.pointer('uintptr'))]);
  const GetStockObject = gdi.func('__stdcall', 'GetStockObject', 'intptr', ['int']);
  hostProc = koffi.register((hwnd: unknown, msg: number, wParam: unknown, lParam: unknown) => {
    if (msg === WM_MOUSEACTIVATE) {
      SetFocus(hwnd);
      return MA_ACTIVATE;
    }
    if (msg === WM_ACTIVATE && (Number(wParam) & 0xffff) !== 0) SetFocus(hwnd);
    if (msg === WM_SETFOCUS) {
      const child = GetWindow(hwnd, GW_CHILD);
      // Síncrono (com limite): o aviso precisa chegar antes do clique que ativou o contêiner.
      if (child) SendMessageTimeoutW(child, WM_SETFOCUS, 0, 0, 0x0002, 200, [0]); // SMTO_ABORTIFHUNG
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
  }, koffi.pointer(WNDPROC));
  RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: hostProc, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: GetModuleHandleW(null), hIcon: 0, hCursor: LoadCursorW(0, 32512), hbrBackground: GetStockObject(4), // BLACK_BRUSH
    lpszMenuName: null, lpszClassName: HOST_CLASS, hIconSm: 0,
  });
}

function win32() {
  if (user32) return user32;
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  registerHostClass(koffi, u);
  user32 = {
    CreateWindowExW: u.func('__stdcall', 'CreateWindowExW', 'intptr',
      ['uint32', 'str16', 'str16', 'uint32', 'int', 'int', 'int', 'int', 'intptr', 'intptr', 'intptr', 'intptr']),
    DestroyWindow: u.func('__stdcall', 'DestroyWindow', 'bool', ['intptr']),
    SetWindowPos: u.func('__stdcall', 'SetWindowPos', 'bool', ['intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint32']),
    ShowWindow: u.func('__stdcall', 'ShowWindow', 'bool', ['intptr', 'int']),
    GetWindow: u.func('__stdcall', 'GetWindow', 'intptr', ['intptr', 'uint32']),
    PostMessageW: u.func('__stdcall', 'PostMessageW', 'bool', ['intptr', 'uint32', 'uintptr', 'intptr']),
    IsWindow: u.func('__stdcall', 'IsWindow', 'bool', ['intptr']),
    SetFocus: u.func('__stdcall', 'SetFocus', 'intptr', ['intptr']),
    keybd_event: u.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr']),
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
  container: number | bigint;
  proc: ChildProcess;
  view: View;
  child?: number | bigint;
  poll?: NodeJS.Timeout;
  resizeTimer?: NodeJS.Timeout;
  log: string[];
  /** Resolução pedida na conexão. */
  size: { width: number; height: number };
  /** O servidor abriu o canal de ajuste de resolução (Display Control). */
  dynamic: boolean;
  readyAt?: number;
  reconnectTimer?: NodeJS.Timeout;
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
  // A aba informa a posição na página (pixels físicos); o contêiner é de nível superior (tela). A
  // origem é a da área do conteúdo — o menu do topo fica dentro da área cliente da janela.
  const win = BrowserWindow.fromWebContents(s.owner);
  if (!win || win.isDestroyed()) return;
  const c = win.getContentBounds();
  const origin = screen.dipToScreenPoint({ x: c.x, y: c.y });
  w.SetWindowPos(s.container, HWND_TOP, origin.x + x, origin.y + y, width, height, SWP_NOACTIVATE);
  w.ShowWindow(s.container, SW_SHOWNA);
  w.SetWindowPos(s.child, 0, 0, 0, width, height, SWP_NOACTIVATE | SWP_NOZORDER);
  // O wfreerdp pede a nova resolução ao servidor ao fim de um redimensionamento.
  clearTimeout(s.resizeTimer);
  s.resizeTimer = setTimeout(() => {
    if (s.child) w.PostMessageW(s.child, WM_EXITSIZEMOVE, 0, 0);
  }, 300);
  scheduleReconnect(s);
}

/**
 * Servidor sem o ajuste de resolução (Windows anterior ao 2012 R2/8.1): quando a aba muda de
 * tamanho e para de mudar, a interface reconecta na resolução nova (como o mstsc faz).
 */
function scheduleReconnect(s: RdpSession) {
  clearTimeout(s.reconnectTimer);
  const { width, height } = s.view;
  const changed = Math.abs(width - s.size.width) > 16 || Math.abs(height - s.size.height) > 16;
  if (!changed || !s.view.visible) return;
  s.reconnectTimer = setTimeout(() => {
    if (sessions.get(keyOf(s.owner, s.id)) !== s || s.dynamic) return;
    // O canal abre logo depois de conectar: espera um pouco antes de concluir que não existe.
    if (!s.readyAt || Date.now() - s.readyAt < 5000) {
      scheduleReconnect(s);
      return;
    }
    if (!s.owner.isDestroyed()) s.owner.send('rdp:reconnect-size', s.id);
  }, 1500);
}

function close(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  clearInterval(s.poll);
  clearTimeout(s.resizeTimer);
  clearTimeout(s.reconnectTimer);
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
  const container = w.CreateWindowExW(WS_EX_TOOLWINDOW, HOST_CLASS, '', WS_POPUP | WS_CLIPCHILDREN,
    0, 0, Math.max(1, view.width), Math.max(1, view.height), parent, 0, 0, 0) as number | bigint;
  if (!container) throw new Error('não foi possível criar a área da sessão RDP');

  const args = embeddedRdpArgs(session, { parent: String(container), width: view.width, height: view.height });
  const proc = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
  proc.stdin?.on('error', () => {});
  proc.stdin?.end(rdpStdin(credentials.password));
  const size = { width: Math.max(200, Math.round(view.width)), height: Math.max(200, Math.round(view.height)) };
  const s: RdpSession = { owner, id: id as number, container, proc, view, log: [], size, dynamic: false };
  sessions.set(key, s);
  follow(win, owner);

  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      // Avisos fixos do FreeRDP (contatos, opções de build) só escondem o que importa.
      if (RDP_DISPLAY_CONTROL.test(line)) s.dynamic = true;
      // Avisos fixos e o registro de depuração dos canais só escondem o que importa.
      if (line.trim() && !/warn_contact_details|log_build_warn|\[DEBUG\]/.test(line)) s.log.push(line.trim());
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
    s.readyAt = Date.now();
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

/**
 * Ctrl+Alt+Del para a sessão remota. Pelo teclado, a combinação vai para o Windows local (que não
 * a repassa); simulada, o Windows local a ignora e o gancho de teclado do wfreerdp a envia ao
 * servidor, desde que o contêiner esteja com o foco.
 */
function sendCtrlAltDel(s: RdpSession) {
  if (!s.child) return;
  const w = win32();
  w.SetFocus(s.container);
  const KEYUP = 0x0002;
  const EXTENDED = 0x0001;
  const keys: [number, number, number][] = [[0x11, 0x1d, 0], [0x12, 0x38, 0], [0x2e, 0x53, EXTENDED]]; // Ctrl, Alt, Delete
  for (const [vk, scan, flags] of keys) w.keybd_event(vk, scan, flags, 0);
  for (const [vk, scan, flags] of keys.reverse()) w.keybd_event(vk, scan, flags | KEYUP, 0);
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
  ipcMain.handle('rdp:ctrl-alt-del', (e, id: unknown) => {
    const s = Number.isInteger(id) ? sessions.get(keyOf(e.sender, id as number)) : undefined;
    if (s) sendCtrlAltDel(s);
  });
  ipcMain.handle('rdp:available', () => process.platform === 'win32' && existsSync(freerdpPath()));
  app.on('before-quit', () => {
    for (const key of [...sessions.keys()]) close(key);
  });
}

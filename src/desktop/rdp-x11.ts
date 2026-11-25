import { createRequire } from 'node:module';

/*
 * Contêiner X11 das sessões RDP numa aba (Linux): uma janela filha da janela do app, criada pela
 * Xlib numa conexão própria ao servidor X, onde o xfreerdp se encaixa com /parent-window. Sendo
 * filha, acompanha a janela do app ao mover e minimizar, e fica acima do conteúdo da página.
 *
 * O teclado segue a regra do X: com a janela do app em foco, as teclas vão para a sessão enquanto o
 * ponteiro estiver sobre ela.
 */

const require = createRequire(import.meta.url);

type Fn = (...args: unknown[]) => unknown;
export type XWindow = bigint;

interface Xlib {
  display: unknown;
  XCreateSimpleWindow: Fn;
  XMapWindow: Fn;
  XUnmapWindow: Fn;
  XMoveResizeWindow: Fn;
  XDestroyWindow: Fn;
  XQueryTree: Fn;
  XFree: Fn;
  XFlush: Fn;
  XSync: Fn;
  XSetInputFocus: Fn;
  XGetInputFocus: Fn;
  XKeysymToKeycode: Fn;
  XTestFakeKeyEvent?: Fn;
  decode: (ptr: unknown, n: number) => bigint[];
}

let xlib: Xlib | undefined;
// Mantém o tratador de erros registrado vivo (a Xlib o chama a cada erro).
let errorHandler: unknown;

function load(): Xlib {
  if (xlib) return xlib;
  const koffi = require('koffi');
  const x = koffi.load('libX11.so.6');
  // Sem isto, um erro do X (ex.: a janela do xfreerdp já fechou) encerraria o app inteiro.
  const HANDLER = koffi.proto('int MULTTERM_XErrorHandler(void *display, void *event)');
  errorHandler = koffi.register(() => 0, koffi.pointer(HANDLER));
  x.func('void *XSetErrorHandler(MULTTERM_XErrorHandler *handler)')(errorHandler);
  const XOpenDisplay = x.func('void *XOpenDisplay(const char *name)');
  const display = XOpenDisplay(null);
  if (!display) throw new Error('não foi possível conectar ao servidor X (RDP numa aba precisa do X11)');
  let XTestFakeKeyEvent: Fn | undefined;
  try {
    XTestFakeKeyEvent = koffi.load('libXtst.so.6').func('int XTestFakeKeyEvent(void *display, uint keycode, int is_press, ulong delay)');
  } catch {
    // sem a libXtst: o Ctrl+Alt+Del fica indisponível
  }
  xlib = {
    display,
    XCreateSimpleWindow: x.func('ulong XCreateSimpleWindow(void *d, ulong parent, int x, int y, uint w, uint h, uint border, ulong borderPixel, ulong background)'),
    XMapWindow: x.func('int XMapWindow(void *d, ulong w)'),
    XUnmapWindow: x.func('int XUnmapWindow(void *d, ulong w)'),
    XMoveResizeWindow: x.func('int XMoveResizeWindow(void *d, ulong w, int x, int y, uint width, uint height)'),
    XDestroyWindow: x.func('int XDestroyWindow(void *d, ulong w)'),
    XQueryTree: x.func('int XQueryTree(void *d, ulong w, _Out_ ulong *root, _Out_ ulong *parent, _Out_ void **children, _Out_ uint *n)'),
    XFree: x.func('int XFree(void *data)'),
    XFlush: x.func('int XFlush(void *d)'),
    XSync: x.func('int XSync(void *d, int discard)'),
    XSetInputFocus: x.func('int XSetInputFocus(void *d, ulong focus, int revertTo, ulong time)'),
    XGetInputFocus: x.func('int XGetInputFocus(void *d, _Out_ ulong *focus, _Out_ int *revertTo)'),
    XKeysymToKeycode: x.func('uchar XKeysymToKeycode(void *d, ulong keysym)'),
    XTestFakeKeyEvent,
    decode: (ptr, n) => (koffi.decode(ptr, koffi.array('ulong', n)) as (number | bigint)[]).map((v) => BigInt(v)),
  };
  return xlib;
}

/** Identificador X da janela do app (Buffer de getNativeWindowHandle no Linux). */
export function xidFromHandle(handle: Buffer): XWindow {
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

/** Contêiner escondido, filho da janela do app. */
export function createContainer(parent: XWindow, width: number, height: number): XWindow {
  const x = load();
  const w = BigInt(x.XCreateSimpleWindow(x.display, parent, 0, 0, Math.max(1, width), Math.max(1, height), 0, 0, 0) as number | bigint);
  x.XSync(x.display, 0);
  return w;
}

/** Primeira janela filha (a do xfreerdp encaixado), ou 0n. */
export function firstChild(container: XWindow): XWindow {
  const x = load();
  const root = [0];
  const parent = [0];
  const children = [null];
  const n = [0];
  if (!x.XQueryTree(x.display, container, root, parent, children, n)) return 0n;
  if (!children[0]) return 0n;
  const list = n[0] ? x.decode(children[0], n[0]) : [];
  x.XFree(children[0]);
  return list[0] ?? 0n;
}

export function show(container: XWindow, child: XWindow, rect: { x: number; y: number; width: number; height: number }) {
  const x = load();
  x.XMoveResizeWindow(x.display, container, rect.x, rect.y, Math.max(1, rect.width), Math.max(1, rect.height));
  // A janela do xfreerdp acompanha o contêiner; ele pede a resolução nova ao servidor.
  if (child) x.XMoveResizeWindow(x.display, child, 0, 0, Math.max(1, rect.width), Math.max(1, rect.height));
  x.XMapWindow(x.display, container);
  x.XFlush(x.display);
}

export function hide(container: XWindow) {
  const x = load();
  x.XUnmapWindow(x.display, container);
  x.XFlush(x.display);
}

export function destroy(container: XWindow) {
  const x = load();
  x.XDestroyWindow(x.display, container);
  x.XFlush(x.display);
}

/** O Ctrl+Alt+Del pelo XTest, com o foco do teclado na janela da sessão (e devolvido depois). */
export function sendCtrlAltDel(child: XWindow): boolean {
  const x = load();
  if (!x.XTestFakeKeyEvent || !child) return false;
  const focus = [0];
  const revert = [0];
  x.XGetInputFocus(x.display, focus, revert);
  const RevertToParent = 2;
  x.XSetInputFocus(x.display, child, RevertToParent, 0);
  const keys = [0xffe3, 0xffe9, 0xffff].map((k) => x.XKeysymToKeycode(x.display, k) as number); // Ctrl, Alt, Delete
  for (const k of keys) x.XTestFakeKeyEvent(x.display, k, 1, 0);
  for (const k of [...keys].reverse()) x.XTestFakeKeyEvent(x.display, k, 0, 0);
  x.XSync(x.display, 0);
  if (focus[0]) x.XSetInputFocus(x.display, focus[0], revert[0], 0);
  x.XFlush(x.display);
  return true;
}

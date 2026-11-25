import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

/*
 * RDP numa aba no Linux (X11), com um cliente falso (fixtures/fake-xfreerdp.py) que se encaixa
 * como o xfreerdp: posição sobre a área da aba, some com menus por cima, clique e teclado (XTest)
 * chegando à sessão, Ctrl+Alt+Del e a senha pela entrada padrão.
 */

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-xfreerdp.py');
const require = createRequire(import.meta.url);

test.skip(process.platform !== 'linux' || !process.env.DISPLAY || !existsSync('/usr/bin/python3'), 'só no Linux com X11 e python3');

let ctx: LaunchedApp;
let dir: string;

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'multterm-fake-xrdp-'));
});

test.afterEach(async () => {
  await ctx?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Xlib do próprio teste (outra conexão ao mesmo servidor X): posição, estado e entrada sintética. */
function xlib() {
  const koffi = require('koffi');
  const x = koffi.load('libX11.so.6');
  const xtst = koffi.load('libXtst.so.6');
  // Erro do X (janela que já fechou) não pode derrubar o processo do teste.
  const HANDLER = koffi.proto('int FAKE_XErrorHandler(void *display, void *event)');
  x.func('void *XSetErrorHandler(FAKE_XErrorHandler *handler)')(koffi.register(() => 0, koffi.pointer(HANDLER)));
  const d = x.func('void *XOpenDisplay(const char *name)')(null);
  const root = x.func('ulong XDefaultRootWindow(void *d)')(d);
  const ATTRS = koffi.struct('FAKE_XWindowAttributes', {
    x: 'int', y: 'int', width: 'int', height: 'int', border_width: 'int', depth: 'int', visual: 'void *', root: 'ulong',
    class: 'int', bit_gravity: 'int', win_gravity: 'int', backing_store: 'int', backing_planes: 'ulong', backing_pixel: 'ulong',
    save_under: 'int', colormap: 'ulong', map_installed: 'int', map_state: 'int', all_event_masks: 'long',
    your_event_mask: 'long', do_not_propagate_mask: 'long', override_redirect: 'int', screen: 'void *',
  });
  const getAttrs = x.func('int XGetWindowAttributes(void *d, ulong w, _Out_ FAKE_XWindowAttributes *attrs)');
  const translate = x.func('int XTranslateCoordinates(void *d, ulong src, ulong dst, int x, int y, _Out_ int *dx, _Out_ int *dy, _Out_ ulong *child)');
  const keycode = x.func('uchar XKeysymToKeycode(void *d, ulong keysym)');
  const motion = xtst.func('int XTestFakeMotionEvent(void *d, int screen, int x, int y, ulong delay)');
  const button = xtst.func('int XTestFakeButtonEvent(void *d, uint button, int press, ulong delay)');
  const key = xtst.func('int XTestFakeKeyEvent(void *d, uint keycode, int press, ulong delay)');
  const sync = x.func('int XSync(void *d, int discard)');
  return {
    /** Retângulo na tela e se está visível (IsViewable = 2). */
    rect(win: bigint) {
      const a: Record<string, number> = {};
      if (!getAttrs(d, win, a)) return { l: 0, t: 0, r: 0, b: 0, viewable: false };
      const dx = [0];
      const dy = [0];
      translate(d, win, root, 0, 0, dx, dy, [0]);
      return { l: dx[0], t: dy[0], r: dx[0] + a.width, b: dy[0] + a.height, viewable: a.map_state === 2 };
    },
    click(px: number, py: number) {
      motion(d, -1, px, py, 0);
      button(d, 1, 1, 0);
      button(d, 1, 0, 0);
      sync(d, 0);
    },
    type(keysym: number) {
      const k = keycode(d, keysym);
      key(d, k, 1, 0);
      key(d, k, 0, 0);
      sync(d, 0);
    },
  };
}

test('cliente RDP encaixado no X11: posição, menus por cima, clique e teclado, senha', async () => {
  const logFile = join(dir, 'log.txt');
  ctx = await launchApp('version: 1\nsessions:\n  - {name: SRV, type: rdp, host: 127.0.0.1, user: pedro}\n', { MULTTERM_FREERDP: FAKE, FAKE_RDP_LOG: logFile });
  const page = ctx.page;
  const log = async () => (existsSync(logFile) ? readFile(logFile, 'utf8') : '');
  const lines = async () => (await log()).split('\n');

  await page.locator('#tree li.session', { hasText: 'SRV' }).dblclick();
  await page.locator('#rdp-auth-dialog [name=rdpPassword]').fill('s3nha');
  await page.locator('#rdp-auth-dialog button[type=submit]').click();
  await expect.poll(log, { timeout: 15_000 }).toMatch(/xid \d+/);
  expect(await log()).toContain('senha s3nha');
  // Certificado: aceita o da primeira conexão e recusa se mudar (o FreeRDP não tem como perguntar).
  expect(await log()).toMatch(/args .*\/parent-window:\d+ .*\/cert:tofu/);
  const win = BigInt((await log()).match(/xid (\d+)/)![1]);
  const x = xlib();

  // Posição: a janela do RDP cobre exatamente a área da aba (pixels da tela).
  const expected = async () => {
    const r = await page.locator('.rdp-panel:not([hidden]) .rdp-screen').evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, dpr: window.devicePixelRatio };
    });
    const origin = await ctx.app.evaluate(({ BrowserWindow, screen }) => {
      const c = BrowserWindow.getAllWindows()[0].getContentBounds();
      return screen.dipToScreenPoint({ x: c.x, y: c.y });
    });
    return { l: Math.round(origin.x + r.x * r.dpr), t: Math.round(origin.y + r.y * r.dpr), r: Math.round(origin.x + (r.x + r.w) * r.dpr), b: Math.round(origin.y + (r.y + r.h) * r.dpr) };
  };
  await expect.poll(async () => {
    const [a, e] = [x.rect(win), await expected()];
    return a.viewable ? Math.max(Math.abs(a.l - e.l), Math.abs(a.t - e.t), Math.abs(a.r - e.r), Math.abs(a.b - e.b)) : -1;
  }, { timeout: 10_000 }).toBe(0);

  // Clique e tecla com o ponteiro sobre a sessão chegam a ela.
  const a = x.rect(win);
  x.click(Math.round((a.l + a.r) / 2), Math.round((a.t + a.b) / 2));
  await expect.poll(lines, { timeout: 5000 }).toContain('clique');
  x.type(0x61); // "a"
  await expect.poll(lines, { timeout: 5000 }).toContain('tecla 0x61');

  // Menu aberto por cima da área: a sessão some (a janela nativa ficaria na frente) e volta depois.
  await page.click('#btn-tools');
  await expect.poll(() => x.rect(win).viewable, { timeout: 5000 }).toBe(false);
  await page.click('#btn-tools'); // fecha o menu
  await expect.poll(() => x.rect(win).viewable, { timeout: 5000 }).toBe(true);

  // Ctrl+Alt+Del pelo botão direito na aba: as três teclas chegam à sessão.
  await page.locator('#tabs .tab', { hasText: 'SRV' }).click({ button: 'right' });
  await page.locator('.tab-menu button', { hasText: 'Enviar Ctrl+Alt+Del' }).click();
  await expect.poll(async () => {
    const l = await lines();
    return ['tecla 0xffe3', 'tecla 0xffe9', 'tecla 0xffff'].filter((k) => l.includes(k)).length;
  }, { timeout: 5000 }).toBe(3);

  // Fechar a aba encerra o cliente e remove a área.
  await page.locator('#tabs .tab', { hasText: 'SRV' }).locator('.close').click();
  await expect.poll(() => x.rect(win).viewable, { timeout: 5000 }).toBe(false);
});

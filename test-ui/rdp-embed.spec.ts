import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

/*
 * Encaixe do cliente RDP na aba, com um cliente falso (fixtures/fake-rdp.cs) que se comporta como o
 * wfreerdp: posição sobre a área da aba, clique e teclado nativos (SendInput) chegando à sessão, e
 * a senha pela entrada padrão. Move o mouse e clica de verdade.
 */

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const require = createRequire(import.meta.url);

let dir: string;
let exe: string;
let logFile: string;
// Cliques e teclas nativos: se outra janela pegar o primeiro plano no meio (alguém usando a
// máquina), o clique cai nela; uma nova tentativa resolve.
test.describe.configure({ retries: 2 });

let ctx: LaunchedApp;

test.beforeAll(async () => {
  test.skip(!existsSync(CSC), 'sem o compilador C# do .NET Framework');
  dir = await mkdtemp(join(tmpdir(), 'multterm-fake-rdp-'));
  exe = join(dir, 'fake-rdp.exe');
  execFileSync(CSC, ['-nologo', '-target:winexe', `-out:${exe}`, join(import.meta.dirname, 'fixtures', 'fake-rdp.cs')]);
});

test.afterAll(async () => {
  if (process.env.KEEP_FAKE_LOG) return;
  if (dir) await rm(dir, { recursive: true, force: true });
});

test.afterEach(async () => {
  await ctx?.close();
});

function win32() {
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  const RECT = koffi.struct('FAKE_RECT', { l: 'int', t: 'int', r: 'int', b: 'int' });
  return {
    rect: u.func('__stdcall', 'GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]),
    setCursor: u.func('__stdcall', 'SetCursorPos', 'bool', ['int', 'int']),
    mouse: u.func('__stdcall', 'mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'int32', 'uintptr_t']),
    key: u.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr_t']),
  };
}

test('cliente RDP encaixado: posição, clique e teclado nativos, senha', async () => {
  logFile = join(dir, `log-${Date.now()}.txt`);
  ctx = await launchApp('version: 1\nsessions:\n  - {name: SRV, type: rdp, host: 127.0.0.1, user: pedro}\n', { MULTTERM_FREERDP: exe, FAKE_RDP_LOG: logFile });
  const page = ctx.page;
  const w = win32();
  const log = async () => (existsSync(logFile) ? readFile(logFile, 'utf8') : '');

  await page.locator('#tree li.session', { hasText: 'SRV' }).dblclick();
  await page.locator('#rdp-auth-dialog [name=rdpPassword]').fill('s3nha');
  await page.locator('#rdp-auth-dialog button[type=submit]').click();
  await expect.poll(log, { timeout: 15_000 }).toMatch(/hwnd \d+/);
  expect(await log()).toContain('senha s3nha');
  const hwnd = BigInt((await log()).match(/hwnd (\d+)/)![1]);
  // Os cliques são nativos: a janela do teste fica por cima de tudo (outra janela na frente
  // receberia o clique).
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setAlwaysOnTop(true);
    win.focus();
  });

  // Posição: a janela do RDP cobre exatamente a área da aba (pixels físicos da tela).
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
  const actual = () => {
    const r = { l: 0, t: 0, r: 0, b: 0 };
    w.rect(hwnd, r);
    return r;
  };
  await expect.poll(async () => {
    const [a, e] = [actual(), await expected()];
    return Math.max(Math.abs(a.l - e.l), Math.abs(a.t - e.t), Math.abs(a.r - e.r), Math.abs(a.b - e.b));
  }, { timeout: 10_000 }).toBeLessThanOrEqual(2);

  // Clique nativo no meio da sessão: chega com o foco no contêiner; tecla nativa também.
  const lines = async () => (await log()).split(/\r?\n/);
  const nativeClick = (x: number, y: number) => {
    w.setCursor(x, y);
    w.mouse(0x02, 0, 0, 0, 0);
    w.mouse(0x04, 0, 0, 0, 0);
  };
  const a = actual();
  const center = { x: Math.round((a.l + a.r) / 2), y: Math.round((a.t + a.b) / 2) };
  nativeClick(center.x, center.y);
  await expect.poll(lines, { timeout: 5000 }).toContain('clique');
  w.key(0x41, 0, 0, 0);
  w.key(0x41, 0, 2, 0);
  await expect.poll(lines, { timeout: 5000 }).toContain('tecla 65');

  // Clica fora (na barra lateral do MultTerm) e volta: o clique e o teclado continuam chegando.
  const sidebar = await page.locator('#search').boundingBox();
  const origin = await ctx.app.evaluate(({ BrowserWindow, screen }) => {
    const c = BrowserWindow.getAllWindows()[0].getContentBounds();
    return { ...screen.dipToScreenPoint({ x: c.x, y: c.y }), scale: screen.getPrimaryDisplay().scaleFactor };
  });
  nativeClick(Math.round(origin.x + (sidebar!.x + 20) * origin.scale), Math.round(origin.y + (sidebar!.y + 10) * origin.scale));
  await page.waitForTimeout(300);
  const before = (await lines()).length;
  nativeClick(center.x, center.y + 20);
  await expect.poll(async () => (await lines()).slice(before - 1), { timeout: 5000 }).toContain('clique');
  w.key(0x42, 0, 0, 0);
  w.key(0x42, 0, 2, 0);
  await expect.poll(lines, { timeout: 5000 }).toContain('tecla 66');
});

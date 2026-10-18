import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

/*
 * Mudar o tamanho da aba RDP: servidor moderno (canal Display Control) ajusta a resolução sem
 * reconectar; servidor antigo reconecta sozinho no tamanho novo, sem pedir a senha de novo.
 * Usa o cliente RDP falso (fixtures/fake-rdp.cs).
 */

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

let dir: string;
let exe: string;
let ctx: LaunchedApp;

test.beforeAll(async () => {
  test.skip(!existsSync(CSC), 'sem o compilador C# do .NET Framework');
  dir = await mkdtemp(join(tmpdir(), 'multterm-fake-rdp-'));
  exe = join(dir, 'fake-rdp.exe');
  execFileSync(CSC, ['-nologo', '-target:winexe', `-out:${exe}`, join(import.meta.dirname, 'fixtures', 'fake-rdp.cs')]);
});

test.afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test.afterEach(async () => {
  await ctx?.close();
});

async function connect(env: Record<string, string>) {
  const logFile = join(dir, `log-${Date.now()}.txt`);
  ctx = await launchApp('version: 1\nsessions:\n  - {name: SRV, type: rdp, host: 127.0.0.1, user: pedro}\n', { MULTTERM_FREERDP: exe, FAKE_RDP_LOG: logFile, ...env });
  const lines = async () => (existsSync(logFile) ? (await readFile(logFile, 'utf8')).split(/\r?\n/) : []);
  await ctx.page.locator('#tree li.session', { hasText: 'SRV' }).dblclick();
  await ctx.page.locator('#rdp-auth-dialog [name=rdpPassword]').fill('s3nha');
  await ctx.page.locator('#rdp-auth-dialog button[type=submit]').click();
  await expect.poll(async () => (await lines()).some((l) => l.startsWith('hwnd ')), { timeout: 15_000 }).toBe(true);
  return lines;
}

const sizes = (lines: string[]) => lines.filter((l) => l.startsWith('args ')).map((l) => l.match(/\/size:(\d+x\d+)/)![1]);

async function growWindow() {
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const b = w.getBounds();
    w.setBounds({ ...b, width: b.width + 240, height: b.height + 140 });
  });
}

test('servidor antigo (sem ajuste de resolução): reconecta no tamanho novo sem pedir senha', async () => {
  const lines = await connect({});
  const [first] = sizes(await lines());
  await growWindow();
  // Espera o servidor "não ter" o canal (alguns segundos) e a aba parar de mudar.
  await expect.poll(async () => sizes(await lines()).length, { timeout: 20_000 }).toBe(2);
  const [, second] = sizes(await lines());
  const [w1, h1] = first.split('x').map(Number);
  const [w2, h2] = second.split('x').map(Number);
  expect(w2).toBeGreaterThan(w1 + 100);
  expect(h2).toBeGreaterThan(h1 + 50);
  // Mesma senha, sem nova pergunta.
  expect((await lines()).filter((l) => l === 'senha s3nha')).toHaveLength(2);
  await expect(ctx.page.locator('#rdp-auth-dialog')).toBeHidden();
});

test('servidor moderno (canal Display Control): ajusta a resolução sem reconectar', async () => {
  const lines = await connect({ FAKE_RDP_DISP: '1' });
  await growWindow();
  await expect.poll(lines, { timeout: 10_000 }).toContain('exitsizemove');
  await ctx.page.waitForTimeout(7000);
  expect(sizes(await lines())).toHaveLength(1);
});

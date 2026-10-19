import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

/*
 * RDP em todos os monitores: abre o cliente do Windows em tela cheia com "use multimon" (o
 * Windows remoto enxerga cada monitor). O mstsc é trocado por um programa que só termina
 * (MULTTERM_MSTSC); o teste confere o arquivo .rdp gravado. A aba usa o cliente RDP falso.
 */

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const NOOP = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');

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

async function start(name: string) {
  const logFile = join(dir, `log-${Date.now()}.txt`);
  ctx = await launchApp(`version: 1\nsessions:\n  - {name: ${name}, type: rdp, host: 127.0.0.1, user: pedro}\n`, { MULTTERM_FREERDP: exe, FAKE_RDP_LOG: logFile, MULTTERM_MSTSC: NOOP });
  const rdpFile = join(ctx.dir, 'userdata', 'multterm-rdp', `${name}.rdp`);
  const rdp = async () => (existsSync(rdpFile) ? readFile(rdpFile, 'utf8') : '');
  return { rdp, session: ctx.page.locator('#tree li.session', { hasText: name }) };
}

test('aba RDP: "Abrir em todos os monitores" fecha a aba e abre o cliente do Windows em tela cheia', async () => {
  const { rdp, session } = await start('MM_ABA');
  const page = ctx.page;
  await session.dblclick();
  await page.locator('#rdp-auth-dialog [name=rdpPassword]').fill('s3nha');
  await page.locator('#rdp-auth-dialog button[type=submit]').click();
  const tab = page.locator('#tabs .tab', { hasText: 'MM_ABA' });
  await expect(tab).toBeVisible();

  await tab.click({ button: 'right' });
  await expect(page.locator('.tab-menu button', { hasText: 'Enviar Ctrl+Alt+Del' })).toBeVisible();
  await page.locator('.tab-menu button', { hasText: 'Abrir em todos os monitores' }).click();
  await expect(tab).toHaveCount(0);
  await expect.poll(rdp, { timeout: 10_000 }).toContain('use multimon:i:1');
  expect(await rdp()).toContain('screen mode id:i:2');
  expect(await rdp()).toContain('full address:s:127.0.0.1:3389');
});

test('opção da sessão: o duplo clique abre em todos os monitores, sem aba', async () => {
  const { rdp, session } = await start('MM_OPCAO');
  const page = ctx.page;
  await session.click();
  await page.locator('#form [name=multimon]').check();
  await page.click('#form button[type=submit]');
  await expect.poll(() => readFile(ctx.sessionsFile, 'utf8')).toContain('multimon: true');

  await session.dblclick();
  await expect.poll(rdp, { timeout: 10_000 }).toContain('use multimon:i:1');
  await expect(page.locator('#rdp-auth-dialog')).toBeHidden();
  await expect(page.locator('#tabs .tab', { hasText: 'MM_OPCAO' })).toHaveCount(0);

  // Janela externa continua abrindo sem tela cheia.
  await rm(join(ctx.dir, 'userdata', 'multterm-rdp', 'MM_OPCAO.rdp'));
  await session.click({ button: 'right' });
  await page.locator('#tree-menu [data-action="external"]').click();
  await expect.poll(rdp, { timeout: 10_000 }).toContain('full address');
  expect(await rdp()).not.toContain('multimon');
});

test('menu da sessão RDP: "Abrir em todos os monitores"', async () => {
  const { rdp, session } = await start('MM_MENU');
  await session.click({ button: 'right' });
  await ctx.page.locator('#tree-menu [data-action="multimon"]').click();
  await expect.poll(rdp, { timeout: 10_000 }).toContain('use multimon:i:1');
});

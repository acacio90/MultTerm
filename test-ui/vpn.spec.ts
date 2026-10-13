import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp | undefined;
let root: string;

/** Programas falsos (ipsecc.exe vazio) e uma pasta de sites própria do teste. */
async function fakeShrew(sites: Record<string, string>) {
  const pf = join(root, 'pf');
  await mkdir(join(pf, 'ShrewSoft', 'VPN Client'), { recursive: true });
  await writeFile(join(pf, 'ShrewSoft', 'VPN Client', 'ipsecc.exe'), '');
  const dir = join(root, 'sites');
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(sites)) await writeFile(join(dir, name), text);
  return { MULTTERM_PROGRAM_FILES: pf, MULTTERM_SHREW_SITES: dir };
}

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'multterm-vpn-'));
});

test.afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
  await rm(root, { recursive: true, force: true });
});

async function openVpn(yaml: string, env: Record<string, string>) {
  ctx = await launchApp(yaml, env);
  await ctx.page.click('#btn-tools');
  await ctx.page.click('#tools-menu [data-tool="vpn"]');
  return ctx.page.locator('.panel:not([hidden])').last();
}

const MATRIZ = 's:network-host:vpn.example.org\ns:auth-method:mutual-psk-xauth\ns:client-saved-username:ana\n';
const FILIAL = 's:network-host:10.9.9.9\nn:network-ike-port:4500\ns:auth-method:mutual-psk\n';

test('sem o Shrew, orienta a instalação', async () => {
  const panel = await openVpn('version: 1\nsessions: []\n', { MULTTERM_PROGRAM_FILES: root, MULTTERM_SHREW_SITES: root });
  await expect(panel).toContainText('instale o Shrew Soft VPN Client');
  await expect(panel.locator('button', { hasText: 'Verificar de novo' })).toBeVisible();
  await expect(ctx!.page.locator('#vpn-indicator')).toBeHidden();
});

test('lista os sites e mostra usuário/senha só para XAuth', async () => {
  const panel = await openVpn('version: 1\nsessions: []\n', await fakeShrew({ Matriz: MATRIZ, Filial: FILIAL }));
  const site = panel.locator('[name=site]');
  await expect(site.locator('option')).toHaveText(['Filial — 10.9.9.9:4500', 'Matriz — vpn.example.org']);
  await expect(panel.locator('[name=user]')).toBeHidden(); // Filial: só chave compartilhada
  await site.selectOption('Matriz');
  await expect(panel.locator('[name=user]')).toHaveValue('ana');
  await expect(panel.locator('[name=password]')).toBeVisible();
  await expect(panel).toContainText('a senha não é gravada');
});

test('sem sites, oferece importar um .vpn', async () => {
  const panel = await openVpn('version: 1\nsessions: []\n', await fakeShrew({}));
  await expect(panel).toContainText('Nenhum site configurado');
  await expect(panel.locator('button', { hasText: 'Importar site (.vpn)…' })).toBeVisible();
});

test('falha ao abrir o cliente aparece no painel', async () => {
  test.skip(process.platform !== 'win32', 'controle da janela do Shrew só no Windows');
  const panel = await openVpn('version: 1\nsessions: []\n', await fakeShrew({ Matriz: MATRIZ }));
  await panel.locator('[name=password]').fill('segredo');
  await panel.locator('button[type=submit]').click();
  // O ipsecc.exe falso (vazio) não é um executável válido.
  await expect(panel.locator('.tool-status')).toContainText('não foi possível abrir o cliente do Shrew', { timeout: 30_000 });
  await expect(panel.locator('button[type=submit]')).toBeEnabled();
  await expect(ctx!.page.locator('#vpn-indicator')).toBeHidden();
});

test('sessão com VPN: campo no formulário e abertura pede a VPN', async () => {
  const yaml = 'version: 1\nsessions:\n  - {name: srv, host: 10.0.0.5, vpn: Matriz}\n';
  ctx = await launchApp(yaml, await fakeShrew({ Matriz: MATRIZ }));
  const { page } = ctx;
  const session = page.locator('#tree li.session', { hasText: 'srv' });
  await session.click();
  await expect(page.locator('#form [name=vpn]')).toHaveValue('Matriz');
  await expect(page.locator('#vpn-sites option')).toHaveCount(1);
  await session.dblclick();
  const panel = page.locator('.panel:not([hidden])').last();
  await expect(panel).toContainText('A sessão "srv" usa a VPN "Matriz"');
  await expect(panel.locator('[name=site]')).toHaveValue('Matriz');
  await expect(page.locator('#tabs .tab.active')).toHaveText(/VPN/);

  // Trocar o campo grava no YAML.
  await page.locator('#tab-editor').click();
  await session.click();
  await page.locator('#form [name=vpn]').fill('');
  await page.locator('#form button[type=submit]').click();
  await expect.poll(async () => readFile(ctx!.sessionsFile, 'utf8')).not.toContain('vpn:');
});

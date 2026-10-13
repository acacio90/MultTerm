import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { launchApp, type LaunchedApp } from './fixture.ts';

const SESSIONS = `version: 1
sessions:
  - name: web-01
    folder: Servidores/Produção
    type: ssh
    host: web-01.example.org
  - name: web-02
    folder: Servidores/Produção/Web
    type: ssh
    host: web-02.example.org
  - name: ad-01
    folder: Servidores/Infraestrutura
    type: rdp
    host: 10.0.0.9
`;

let ctx: LaunchedApp;
let page: Page;

test.beforeEach(async () => {
  ctx = await launchApp(SESSIONS);
  page = ctx.page;
  await expect(page.locator('#status-count')).toHaveText('3 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx?.close();
});

const folder = (name: string) => page.locator('#tree li.folder', { has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) });
const menuItem = (action: string) => page.locator(`#tree-menu [data-action="${action}"]`);
const yaml = () => readFile(ctx.sessionsFile, 'utf8');

async function nameDialog(value: string) {
  await expect(page.locator('#name-dialog')).toBeVisible();
  await page.fill('#name-dialog [name=folderName]', value);
  await page.click('#name-dialog button[type=submit]');
}

test('nova subpasta aparece vazia e é gravada ao salvar uma sessão dentro dela', async () => {
  await folder('Servidores').click({ button: 'right' });
  await expect(page.locator('#tree-menu button')).toHaveText(['Nova subpasta…', 'Nova sessão aqui', 'Renomear…', 'Excluir pasta']);
  await menuItem('subfolder').click();
  await nameDialog('Banco');
  await expect(folder('Banco')).toHaveClass(/pending/);
  await expect(page.locator('#messages')).toContainText('Pasta "Servidores/Banco" criada');
  expect(await yaml()).not.toContain('Servidores/Banco');

  await folder('Banco').click({ button: 'right' });
  await menuItem('session').click();
  await expect(page.locator('#form [name=folder]')).toHaveValue('Servidores/Banco');
  await page.fill('#form [name=name]', 'db-01');
  await page.fill('#form [name=host]', 'db-01.example.org');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages')).toHaveText('Sessão salva.');
  await expect(folder('Banco')).not.toHaveClass(/pending/);
  expect(await yaml()).toContain('folder: Servidores/Banco');
});

test('renomear move as sessões da pasta e das subpastas', async () => {
  await folder('Produção').click({ button: 'right' });
  await menuItem('rename').click();
  await expect(page.locator('#name-dialog [name=folderName]')).toHaveValue('Produção');
  await nameDialog('Prod');
  await expect(page.locator('#messages')).toContainText('Pasta renomeada para "Servidores/Prod" (2 sessão(ões) movida(s))');
  const file = await yaml();
  expect(file).toContain('folder: Servidores/Prod\n');
  expect(file).toContain('folder: Servidores/Prod/Web');
  expect(file).not.toContain('Produção');
  await expect(folder('Prod')).toHaveCount(1);
});

test('renomear para uma pasta que já existe é recusado', async () => {
  await folder('Produção').click({ button: 'right' });
  await menuItem('rename').click();
  await nameDialog('Infraestrutura');
  await expect(page.locator('#messages .error')).toContainText('Já existe a pasta "Servidores/Infraestrutura"');
  expect(await yaml()).toContain('Servidores/Produção');
});

test('excluir só remove pasta vazia', async () => {
  await folder('Infraestrutura').click({ button: 'right' });
  await menuItem('delete').click();
  await expect(page.locator('#messages .error')).toContainText('tem 1 sessão(ões)');
  await expect(folder('Infraestrutura')).toHaveCount(1);

  await folder('Infraestrutura').click({ button: 'right' });
  await menuItem('subfolder').click();
  await nameDialog('Vazia');
  await folder('Vazia').click({ button: 'right' });
  await menuItem('delete').click();
  await expect(page.locator('#messages')).toContainText('Pasta "Servidores/Infraestrutura/Vazia" excluída');
  await expect(folder('Vazia')).toHaveCount(0);
});

test('botão direito na área vazia cria pasta na raiz; nome com barra é recusado', async () => {
  await page.locator('#tree').click({ button: 'right', position: { x: 60, y: 300 } });
  await expect(page.locator('#tree-menu button')).toHaveText(['Nova pasta…', 'Nova sessão na raiz']);
  await menuItem('subfolder').click();
  await page.fill('#name-dialog [name=folderName]', 'A/B');
  await page.click('#name-dialog button[type=submit]');
  await expect(page.locator('#name-error')).toContainText('não pode ter /');
  await nameDialog('Laboratório');
  await expect(folder('Laboratório')).toHaveClass(/pending/);
  await page.keyboard.press('Escape');
});

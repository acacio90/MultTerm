import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:net';
import { launchApp, type LaunchedApp } from './fixture.ts';

const SESSIONS = `version: 1
sessions:
  - name: local
    folder: Teste
    type: ssh
    host: 127.0.0.1
`;

let ctx: LaunchedApp;
let page: Page;
let server: Server;
let openPort: number;

test.beforeEach(async () => {
  // Porta aberta de verdade nesta máquina, para os scanners e a lista de portas locais.
  server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  openPort = (server.address() as { port: number }).port;
  ctx = await launchApp(SESSIONS);
  page = ctx.page;
  await expect(page.locator('#status-count')).toHaveText('1 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx?.close();
  await new Promise((r) => server.close(r));
});

async function openTool(name: string) {
  await page.click('#btn-tools');
  await page.click(`#tools-menu [data-tool="${name}"]`);
}

const activePanel = () => page.locator('.panel:not([hidden])').last();

test('menu Ferramentas abre e fecha', async () => {
  await page.click('#btn-tools');
  await expect(page.locator('#tools-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tools-menu')).toBeHidden();
});

test('ping roda numa aba de terminal e pode ser executado de novo com R', async () => {
  await page.locator('#tree li.session', { hasText: 'local' }).click();
  await openTool('ping');
  await expect(page.locator('#diag-dialog [name=host]')).toHaveValue('127.0.0.1'); // vem da sessão selecionada
  await page.fill('#diag-dialog [name=count]', '2');
  await page.click('#diag-dialog button[type=submit]');

  const tab = page.locator('#tabs .tab', { hasText: 'ping 127.0.0.1' });
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(tab).toHaveClass(/active/);
  await expect(rows).toContainText('127.0.0.1', { timeout: 20_000 });
  await expect(rows).toContainText('Pressione R para executar de novo', { timeout: 20_000 });
  await expect(tab).toHaveClass(/ended/);
});

test('ping recusa host que viraria opção do comando', async () => {
  await openTool('ping');
  await page.fill('#diag-dialog [name=host]', '-t');
  await page.click('#diag-dialog button[type=submit]');
  await expect(page.locator('.term-panel:not([hidden]) .xterm-rows')).toContainText('host inválido');
});

test('scanner de portas encontra a porta aberta e a fechada', async () => {
  await openTool('portscan');
  const panel = activePanel();
  await panel.locator('[name=host]').fill('127.0.0.1');
  await panel.locator('[name=ports]').fill(`${openPort},1`);
  await panel.locator('label.check input').uncheck(); // mostrar todas
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('Concluído: 1 aberta(s), 1 fechada(s)');
  await expect(panel.locator('table.results tbody tr')).toHaveText([/^1.*fechada$/, new RegExp(`^${openPort}.*aberta$`)]);
});

test('scanner de rede acha o host e cria sessão a partir do resultado', async () => {
  await openTool('netscan');
  const panel = activePanel();
  await panel.locator('[name=range]').fill('127.0.0.1');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('Concluído: 1 host(s) ativo(s)');
  await panel.locator('table.results tbody tr').first().locator('button', { hasText: '+ sessão' }).first().click();
  await expect(page.locator('#panel-editor')).toBeVisible();
  await expect(page.locator('#form [name=host]')).toHaveValue('127.0.0.1');
});

test('consulta DNS valida a entrada e mostra erros em português', async () => {
  await openTool('dns');
  const panel = activePanel();
  await panel.locator('[name=name]').fill('-x');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('nome ou IP inválido');
  await panel.locator('[name=name]').fill('example.org');
  await panel.locator('[name=server]').fill('dns.example.org');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('servidor DNS deve ser um IP');
});

test('portas locais lista a porta em escuta com o processo', async () => {
  await openTool('localports');
  const panel = activePanel();
  await expect(panel.locator('.tool-status')).toContainText('entradas', { timeout: 30_000 });
  await panel.locator('input[type=search]').fill(String(openPort));
  await expect(panel.locator('table.results tbody tr').first()).toContainText(`127.0.0.1:${openPort}`);
  await expect(panel.locator('table.results tbody tr').first()).toContainText('escutando');
});

test('fechar a aba de ferramenta volta para a aba Sessão', async () => {
  await openTool('dns');
  await expect(page.locator('#tabs .tab', { hasText: 'Consulta DNS' })).toHaveClass(/active/);
  await page.locator('#tabs .tab', { hasText: 'Consulta DNS' }).locator('.close').click();
  await expect(page.locator('#panel-editor')).toBeVisible();
});

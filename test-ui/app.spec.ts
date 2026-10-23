import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clickMenu, launchApp, type LaunchedApp } from './fixture.ts';

// Sessões de teste: "recusada" aponta para uma porta fechada (o ssh termina na hora).
const SESSIONS = `version: 1
sessions:
  - name: recusada
    folder: Teste
    type: ssh
    host: 127.0.0.1
    port: 1
  - name: web-01
    folder: Servidores/Produção
    type: ssh
    host: web-01.example.org
    user: deploy
  - name: ad-01
    folder: Servidores/Infraestrutura
    type: rdp
    host: 10.0.0.9
`;

let ctx: LaunchedApp;
let app: ElectronApplication;
let page: Page;
let dir: string;
let sessionsFile: string;

test.beforeEach(async () => {
  ctx = await launchApp(SESSIONS);
  ({ app, page, dir, sessionsFile } = ctx);
  await expect(page.locator('#status-count')).toHaveText('3 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx?.close();
});

const session = (name: string) => page.locator('#tree li.session', { hasText: name });

test('árvore mostra pastas aninhadas e a busca filtra', async () => {
  await expect(page.locator('#tree li.folder .label')).toHaveText(['Servidores', 'Infraestrutura', 'Produção', 'Teste']);
  await page.fill('#search', 'web');
  await expect(page.locator('#tree li.session .label')).toHaveText(['web-01']);
  await expect(page.locator('#status-count')).toHaveText('1 de 3 sessões');

  await page.fill('#search', '');
  await page.locator('#tree li.folder', { hasText: 'Servidores' }).click(); // recolhe
  await expect(session('web-01')).toHaveCount(0);
  await expect(session('recusada')).toHaveCount(1);
});

test('cria, edita e exclui uma sessão, gravando no YAML', async () => {
  await page.click('#btn-new');
  await page.fill('#form [name=name]', 'db-01');
  await page.fill('#form [name=folder]', 'Servidores\\Banco');
  await page.fill('#form [name=host]', 'db-01.example.org');
  await page.fill('#form [name=user]', 'postgres');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages')).toHaveText('Sessão salva.');
  await expect(session('db-01')).toHaveClass(/selected/);
  expect(await readFile(sessionsFile, 'utf8')).toContain('folder: Servidores/Banco');

  await page.fill('#form [name=port]', '2222');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages')).toHaveText('Sessão salva.');
  expect(await readFile(sessionsFile, 'utf8')).toContain('port: 2222');

  await page.click('#btn-delete');
  await page.click('#confirm-ok');
  await expect(page.locator('#messages')).toHaveText('Sessão "db-01" excluída.');
  await expect(session('db-01')).toHaveCount(0);
  expect(await readFile(sessionsFile, 'utf8')).not.toContain('db-01');
});

test('recusa host que viraria opção do ssh', async () => {
  await session('web-01').click();
  await page.fill('#form [name=host]', '-oProxyCommand=calc');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages .error')).toContainText('"host" inválido');
  expect(await readFile(sessionsFile, 'utf8')).not.toContain('ProxyCommand');
});

test('duplo clique abre aba de terminal; sessão encerrada reconecta com R e a aba fecha', async () => {
  await session('recusada').dblclick();
  const tab = page.locator('#tabs .tab', { hasText: 'recusada' });
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(tab).toHaveClass(/active/);
  await expect(rows).toContainText('Connection refused');
  await expect(rows).toContainText('Pressione R para reconectar');
  await expect(tab).toHaveClass(/ended/);

  await page.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.press('r');
  await expect(tab).not.toHaveClass(/ended/); // reconectando
  await expect(tab).toHaveClass(/ended/); // recusada de novo
  await expect(rows).toContainText('Connection refused');

  await page.click('#tab-editor');
  await expect(page.locator('#panel-editor')).toBeVisible();
  await tab.locator('.close').click();
  await expect(page.locator('#tabs .tab')).toHaveCount(1);
});

test('F1 abre a ajuda com versão, agente SSH e arquivo de sessões', async () => {
  await page.keyboard.press('F1');
  const help = page.locator('#help');
  await expect(help).toBeVisible();
  await expect(page.locator('#help-title')).toHaveText(/^MultTerm \d+\.\d+\.\d+$/);
  await expect(page.locator('#help-sessions')).toHaveText(sessionsFile);
  await expect(page.locator('#help-agent')).toHaveText(/chave|indisponível/);
  await expect(page.locator('#update-text')).toHaveText('Atualizações só funcionam no app instalado.');
  await page.click('#help-close');
  await expect(help).toBeHidden();
});

test('importa inventário pelo botão (diálogo substituído no teste)', async () => {
  const inventory = join(dir, 'hosts.ini');
  await writeFile(inventory, '[web]\nweb[01:02].example.org\n\n[win]\nad02 type=rdp\n');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, inventory);

  await clickMenu(app, 'import-sessions');
  await expect(page.locator('#messages')).toContainText('3 sessões importadas do inventário');
  await expect(page.locator('#status-count')).toHaveText('6 sessões · sem limite');
  await expect(session('web02.example.org')).toHaveCount(1);
  await expect(session('ad02')).toContainText('rdp');
});

test('chave privada pelo explorador: caminho na pasta do usuário vira ~/', async () => {
  await app.evaluate(({ app: electronApp, dialog }) => {
    const key = `${electronApp.getPath('home')}/.ssh/minha-chave`;
    const g = globalThis as { keyDialog?: unknown };
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      g.keyDialog = args.at(-1);
      return { canceled: false, filePaths: [key] };
    }) as typeof dialog.showOpenDialog;
  });
  await page.click('#btn-new');
  await page.click('#pick-key');
  await expect(page.locator('#form [name=identityFile]')).toHaveValue('~/.ssh/minha-chave');
  const opts = await app.evaluate(() => (globalThis as { keyDialog?: { title: string; properties: string[] } }).keyDialog);
  expect(opts?.title).toBe('Chave privada');
  expect(opts?.properties).toContain('showHiddenFiles');
});

test('chave SSH padrão pelo menu: gravada no arquivo e mostrada no campo da sessão', async () => {
  await clickMenu(app, 'default-key');
  await expect(page.locator('#key-dialog')).toBeVisible();
  await page.fill('#key-form [name=defaultKey]', '~/.ssh/geral');
  await page.click('#key-form button[type=submit]');
  await expect(page.locator('#key-dialog')).toBeHidden();
  await expect(page.locator('#messages')).toHaveText('Chave SSH padrão: ~/.ssh/geral');
  expect(await readFile(sessionsFile, 'utf8')).toMatch(/defaults:\r?\n  identityFile: ~\/\.ssh\/geral\r?\n/);
  await page.click('#btn-new');
  await expect(page.locator('#form [name=identityFile]')).toHaveAttribute('placeholder', 'vazio = chave padrão (~/.ssh/geral)');

  // Salvar uma sessão mantém a chave padrão no arquivo.
  await page.fill('#form [name=name]', 'nova');
  await page.fill('#form [name=host]', 'nova.example.org');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages')).toHaveText('Sessão salva.');
  expect(await readFile(sessionsFile, 'utf8')).toContain('identityFile: ~/.ssh/geral');

  // Vazio remove a chave padrão.
  await clickMenu(app, 'default-key');
  await expect(page.locator('#key-form [name=defaultKey]')).toHaveValue('~/.ssh/geral');
  await page.fill('#key-form [name=defaultKey]', '');
  await page.click('#key-form button[type=submit]');
  await expect(page.locator('#messages')).toContainText('Sem chave SSH padrão');
  expect(await readFile(sessionsFile, 'utf8')).not.toMatch(/^defaults:/m);
});

import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixture.ts';

// Porta 1 em 127.0.0.1: o ssh falha na hora, mas cada sessão abre a sua aba.
const SESSIONS = `version: 1
sessions:
  - {name: alfa, folder: Lab, host: 127.0.0.1, port: 1}
  - {name: beta, folder: Lab, host: 127.0.0.1, port: 1}
  - {name: gama, folder: Lab, host: 127.0.0.1, port: 1}
  - {name: delta, host: 127.0.0.1, port: 1}
`;

let ctx: LaunchedApp;
let page: Page;

test.beforeEach(async () => {
  ctx = await launchApp(SESSIONS);
  page = ctx.page;
});

test.afterEach(async () => {
  await ctx?.close();
});

const session = (name: string) => page.locator('#tree li.session', { has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) });
const tab = (name: string) => page.locator('#tabs .tab', { hasText: new RegExp(`^${name}`) });
const menuItem = (action: string) => page.locator(`#tree-menu [data-action="${action}"]`);

test('Ctrl/Shift+clique seleciona várias sessões e o botão direito abre todas', async () => {
  await session('alfa').click();
  await session('gama').click({ modifiers: ['Shift'] }); // alfa..gama
  await session('delta').click({ modifiers: ['Control'] }); // + delta
  await session('beta').click({ modifiers: ['Control'] }); // - beta
  for (const n of ['alfa', 'gama', 'delta']) await expect(session(n)).toHaveClass(/selected/);
  await expect(session('beta')).not.toHaveClass(/selected/);
  await expect(page.locator('#status-count')).toContainText('3 selecionadas');

  await session('gama').click({ button: 'right' });
  await expect(menuItem('connect-selected')).toHaveText('Conectar as 3 selecionadas');
  await menuItem('connect-selected').click();
  for (const n of ['alfa', 'gama', 'delta']) await expect(tab(n)).toHaveCount(1);
  await expect(tab('beta')).toHaveCount(0);

  // Botão direito fora da seleção: menu normal de uma sessão, e a seleção múltipla é desfeita
  // (fica só a sessão em edição).
  await session('beta').click({ button: 'right' });
  await expect(menuItem('connect')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tree li.session.selected')).toHaveCount(1);
  await expect(session('alfa')).toHaveClass(/selected/);

  // Escape limpa a seleção múltipla; clique simples volta a editar uma sessão só.
  await session('alfa').click({ modifiers: ['Control'] });
  await session('beta').click({ modifiers: ['Control'] });
  await expect(page.locator('#tree li.session.selected')).toHaveCount(1); // alfa saiu, beta entrou
  await page.keyboard.press('Escape');
  await expect(page.locator('#status-count')).not.toContainText('selecionadas');
  await session('beta').click();
  await expect(page.locator('#tree li.session.selected')).toHaveCount(1);
});

test('botão direito na pasta conecta todas as sessões dela', async () => {
  await page.locator('#tree li.folder', { hasText: 'Lab' }).click({ button: 'right' });
  await expect(menuItem('connect-all')).toHaveText('Conectar todas (3)');
  await menuItem('connect-all').click();
  for (const n of ['alfa', 'beta', 'gama']) await expect(tab(n)).toHaveCount(1);
  await expect(tab('delta')).toHaveCount(0);
});

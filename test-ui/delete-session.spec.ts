import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { launchApp, type LaunchedApp } from './fixture.ts';

const SESSIONS = `version: 1
sessions:
  - {name: alfa, folder: Lab, host: 10.0.0.1}
  - {name: beta, folder: Lab, host: 10.0.0.2}
  - {name: gama, folder: Lab, type: rdp, host: 10.0.0.3}
  - {name: delta, host: 10.0.0.4}
`;

let ctx: LaunchedApp;
let page: Page;

test.beforeEach(async () => {
  ctx = await launchApp(SESSIONS);
  page = ctx.page;
  await expect(page.locator('#status-count')).toHaveText('4 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx.close();
});

const session = (name: string) => page.locator('#tree li.session', { has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) });
const menuItem = (action: string) => page.locator(`#tree-menu [data-action="${action}"]`);
const dialog = () => page.locator('#confirm-dialog');
const yaml = () => readFile(ctx.sessionsFile, 'utf8');

test('excluir pelo botão direito: confirmação clara, cancelar não exclui', async () => {
  await session('delta').click({ button: 'right' });
  await expect(menuItem('delete')).toHaveText('Excluir…');
  await menuItem('delete').click();
  await expect(dialog()).toBeVisible();
  await expect(dialog().locator('#confirm-title')).toHaveText('Excluir sessão');
  await expect(dialog().locator('li')).toHaveText(['delta — SSH 10.0.0.4']);
  // O foco começa em Cancelar: Enter não exclui.
  await expect(page.locator('#confirm-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog()).toBeHidden();
  expect(await yaml()).toContain('name: delta');

  await session('delta').click({ button: 'right' });
  await menuItem('delete').click();
  await page.click('#confirm-ok');
  await expect(page.locator('#messages')).toHaveText('Sessão "delta" excluída.');
  await expect(session('delta')).toHaveCount(0);
  expect(await yaml()).not.toContain('delta');
});

test('excluir várias selecionadas de uma vez', async () => {
  await session('alfa').click();
  await session('gama').click({ modifiers: ['Shift'] });
  await session('gama').click({ button: 'right' });
  await expect(menuItem('delete-selected')).toHaveText('Excluir as 3 selecionadas…');
  await menuItem('delete-selected').click();
  await expect(dialog().locator('#confirm-title')).toHaveText('Excluir 3 sessões');
  await expect(dialog().locator('li')).toHaveText(['alfa — Lab · SSH 10.0.0.1', 'beta — Lab · SSH 10.0.0.2', 'gama — Lab · RDP 10.0.0.3']);
  await page.click('#confirm-ok');
  await expect(page.locator('#messages')).toHaveText('3 sessões excluídas.');
  await expect(page.locator('#status-count')).toHaveText('1 sessões · sem limite');
  const text = await yaml();
  for (const n of ['alfa', 'beta', 'gama']) expect(text).not.toContain(`name: ${n}`);
  expect(text).toContain('name: delta');
});

test('sessão com aba aberta: avisa que a aba continua', async () => {
  // Porta 1 no localhost: o ssh falha na hora, mas a aba fica aberta.
  await page.locator('#form').waitFor({ state: 'attached' });
  await session('delta').dblclick();
  await expect(page.locator('#tabs .tab', { hasText: 'delta' })).toHaveCount(1);
  await session('delta').click({ button: 'right' });
  await menuItem('delete').click();
  await expect(dialog()).toContainText('as abas continuam abertas');
  await page.click('#confirm-ok');
  await expect(page.locator('#tabs .tab', { hasText: 'delta' })).toHaveCount(1);
});

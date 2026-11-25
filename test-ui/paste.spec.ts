import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, LOCAL, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;

test.beforeEach(async () => {
  ctx = await launchApp('version: 1\nsessions: []\n');
});

test.afterEach(async () => {
  await ctx?.close();
});

test('botão direito cola uma vez só, mesmo num programa que usa o mouse (Claude Code)', async () => {
  const { app, page } = ctx;
  await app.evaluate(({ clipboard }) => clipboard.writeText('colado-123'));
  await page.click('#btn-tools');
  await page.click(`#tools-menu [data-tool="${LOCAL.tool}"]`);
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(rows).toContainText(LOCAL.prompt, { timeout: 20_000 });

  const script = join(import.meta.dirname, 'fixtures', 'mouse-echo.cjs');
  await page.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type(LOCAL.run(process.execPath, script));
  await expect(rows).toContainText('PRONTO', { timeout: 20_000 });

  await page.locator('.term-panel:not([hidden]) .xterm-screen').click({ button: 'right' });
  await expect(rows).toContainText('RECEBIDO "colado-123"');
  // Nada além da colagem: nem a segunda cópia nem o clique direito como evento de mouse.
  await page.waitForTimeout(500);
  await expect(rows.locator('div', { hasText: 'RECEBIDO' })).toHaveCount(1);
});

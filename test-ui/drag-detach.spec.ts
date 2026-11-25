import { expect, test, type Page } from '@playwright/test';
import { launchApp, LOCAL, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;
let page: Page;

test.beforeEach(async () => {
  ctx = await launchApp('version: 1\nsessions: []\n');
  page = ctx.page;
  await expect(page.locator('#status-count')).toHaveText('0 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx.close();
});

const tab = (p: Page, title: string) => p.locator('#tabs .tab', { hasText: title });

test('arrastar uma aba de terminal para fora da barra a destaca em janela própria', async () => {
  await page.click('#btn-tools');
  await page.click('#tools-menu [data-tool="dns"]');
  await page.click('#btn-tools');
  await page.click(`#tools-menu [data-tool="${LOCAL.tool}"]`);
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(rows).toContainText(LOCAL.prompt, { timeout: 20_000 });
  await page.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type(LOCAL.setMark);

  const area = page.locator('.term-panel:not([hidden])');
  const box = (await area.boundingBox())!;

  // Solta logo abaixo da barra (dentro da margem): não destaca.
  await tab(page, LOCAL.title).dragTo(area, { targetPosition: { x: box.width / 2, y: 12 } });
  await page.waitForTimeout(800);
  expect(ctx.app.windows()).toHaveLength(1);
  // Nem o título da aba foi digitado no terminal (o campo de texto do terminal não aceita a aba).
  await expect(rows).not.toContainText(LOCAL.typedTitle);

  // Aba que não é de terminal: soltar longe da barra não faz nada.
  await tab(page, 'Consulta DNS').dragTo(page.locator('.terminals'), { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForTimeout(800);
  expect(ctx.app.windows()).toHaveLength(1);
  await expect(tab(page, 'Consulta DNS')).toHaveCount(1);

  // Terminal solto no meio da área: vai para uma janela nova, com a mesma sessão.
  await tab(page, LOCAL.title).click();
  const opened = ctx.app.waitForEvent('window');
  await tab(page, LOCAL.title).dragTo(area, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  const detached = await opened;
  await expect(tab(detached, LOCAL.title)).toBeVisible();
  await expect(tab(page, LOCAL.title)).toHaveCount(0);
  await detached.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await detached.keyboard.type(LOCAL.showMark);
  await expect(detached.locator('.term-panel:not([hidden]) .xterm-rows')).toContainText(LOCAL.markOut, { timeout: 20_000 });
});

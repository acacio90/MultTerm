import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixture.ts';

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
  await page.click('#tools-menu [data-tool="local-powershell"]');
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(rows).toContainText('PS ', { timeout: 20_000 });
  await page.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type('$marca = 6*7\r');

  const area = page.locator('.term-panel:not([hidden])');
  const box = (await area.boundingBox())!;

  // Solta logo abaixo da barra (dentro da margem): não destaca.
  await tab(page, 'PowerShell').dragTo(area, { targetPosition: { x: box.width / 2, y: 12 } });
  await page.waitForTimeout(800);
  expect(ctx.app.windows()).toHaveLength(1);
  // Nem o título da aba foi digitado no terminal (o campo de texto do terminal não aceita a aba).
  await expect(rows).not.toContainText(/PS .*>\s*PowerShell/);

  // Aba que não é de terminal: soltar longe da barra não faz nada.
  await tab(page, 'Consulta DNS').dragTo(page.locator('.terminals'), { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForTimeout(800);
  expect(ctx.app.windows()).toHaveLength(1);
  await expect(tab(page, 'Consulta DNS')).toHaveCount(1);

  // Terminal solto no meio da área: vai para uma janela nova, com a mesma sessão.
  await tab(page, 'PowerShell').click();
  const opened = ctx.app.waitForEvent('window');
  await tab(page, 'PowerShell').dragTo(area, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  const detached = await opened;
  await expect(tab(detached, 'PowerShell')).toBeVisible();
  await expect(tab(page, 'PowerShell')).toHaveCount(0);
  await detached.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await detached.keyboard.type('Write-Output $marca\r');
  await expect(detached.locator('.term-panel:not([hidden]) .xterm-rows')).toContainText(/Write-Output \$marca\s*42/, { timeout: 20_000 });
});

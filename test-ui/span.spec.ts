import { expect, test } from '@playwright/test';
import { clickMenu, launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;

test.beforeEach(async () => {
  ctx = await launchApp('version: 1\nsessions: []\n');
  await expect(ctx.page.locator('#status-count')).toHaveText('0 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx.close();
});

const bounds = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
const allScreens = () => ctx.app.evaluate(({ screen }) => {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const x = Math.min(...areas.map((a) => a.x));
  const y = Math.min(...areas.map((a) => a.y));
  return { x, y, width: Math.max(...areas.map((a) => a.x + a.width)) - x, height: Math.max(...areas.map((a) => a.y + a.height)) - y };
});

test('expandir para todas as telas e voltar ao tamanho anterior (botão e menu)', async () => {
  const page = ctx.page;
  const button = page.locator('#btn-span');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  const original = await bounds();

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('title', 'Voltar ao tamanho anterior');
  await expect.poll(bounds).toEqual(await allScreens());

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(bounds).toEqual(original);

  // Pelo menu Exibir também.
  await clickMenu(ctx.app, 'span-displays');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await clickMenu(ctx.app, 'span-displays');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(bounds).toEqual(original);
});

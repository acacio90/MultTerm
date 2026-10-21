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

const tab = (title: string) => page.locator('#tabs .tab', { hasText: title });
const layoutButton = (name: string) => page.locator(`#layout-picker [data-layout="${name}"]`);

async function openTool(name: string) {
  await page.click('#btn-tools');
  await page.click(`#tools-menu [data-tool="${name}"]`);
}

async function box(title: string) {
  const b = await page.locator('.terminals > .panel:not([hidden])').filter({ has: page.locator(`text=${title}`) }).first().boundingBox();
  if (!b) throw new Error(`painel ${title} sem área`);
  return b;
}

test('layout da área de abas: uma, lado a lado e empilhadas', async () => {
  await expect(layoutButton('single')).toHaveAttribute('aria-pressed', 'true');
  await openTool('dns');
  await openTool('wol');
  const visible = page.locator('.terminals > .panel:not([hidden])');
  await expect(visible).toHaveCount(1);

  // Lado a lado: a aba ativa (Wake-on-LAN) e a mais recente que não está à vista (DNS).
  await layoutButton('cols').click();
  await expect(layoutButton('cols')).toHaveAttribute('aria-pressed', 'true');
  await expect(visible).toHaveCount(2);
  const [wolCols, dnsCols] = [await box('Wake-on-LAN'), await box('Consulta DNS')];
  expect(dnsCols.x).toBeGreaterThan(wolCols.x + wolCols.width - 5);
  expect(Math.abs(dnsCols.y - wolCols.y)).toBeLessThan(2);
  await expect(tab('Wake-on-LAN')).toHaveClass(/active/);
  await expect(tab('Consulta DNS')).toHaveClass(/in-pane/);

  // Empilhadas.
  await layoutButton('rows').click();
  const [wolRows, dnsRows] = [await box('Wake-on-LAN'), await box('Consulta DNS')];
  expect(dnsRows.y).toBeGreaterThan(wolRows.y + wolRows.height - 5);
  expect(Math.abs(dnsRows.x - wolRows.x)).toBeLessThan(2);

  // Clicar dentro da outra metade passa o foco para ela.
  await page.locator('.terminals > .panel:not([hidden])').filter({ has: page.locator('text=Consulta DNS') }).first().click({ position: { x: 20, y: 20 } });
  await expect(tab('Consulta DNS')).toHaveClass(/active/);
  await expect(tab('Wake-on-LAN')).toHaveClass(/in-pane/);

  // Uma aba nova entra na metade em foco (não há metade vazia) (no lugar do DNS, que sai de vista).
  await openTool('localports');
  await expect(visible).toHaveCount(2);
  await expect(tab('Portas locais')).toHaveClass(/active/);
  await expect(tab('Consulta DNS')).not.toHaveClass(/active|in-pane/);

  // Fechar a aba de uma metade: a metade passa a mostrar a aba que estava fora de vista.
  await tab('Portas locais').locator('.close').click();
  await expect(visible).toHaveCount(2);
  await expect(tab('Consulta DNS')).toHaveClass(/active/);

  // Fechar tudo deixa as metades vazias com a dica; o layout fica lembrado.
  await tab('Consulta DNS').locator('.close').click();
  await tab('Wake-on-LAN').locator('.close').click();
  expect(await page.evaluate(() => localStorage.getItem('tabLayout'))).toBe('rows');
  await openTool('dns');
  await expect(page.locator('.pane-empty')).toHaveText('Arraste uma aba para cá ou clique numa aba.');

  // De volta a uma aba só.
  await layoutButton('single').click();
  await expect(visible).toHaveCount(1);
  await expect(page.locator('.pane-empty')).toHaveCount(0);
});

test('tela dividida: a aba só muda de metade de propósito', async () => {
  await openTool('dns');
  await openTool('wol');
  await openTool('localports');
  await layoutButton('cols').click();
  const visible = page.locator('.terminals > .panel:not([hidden])');
  const menu = page.locator('.tab-menu');
  await expect(tab('Portas locais')).toHaveClass(/active/);
  await expect(tab('Wake-on-LAN')).toHaveClass(/in-pane/);

  // Clicar numa aba fora de vista não troca nada: pergunta em qual metade mostrar.
  await tab('Consulta DNS').click();
  await expect(menu.locator('button')).toHaveText([
    'Mostrar na metade esquerda (no lugar de Portas locais)',
    'Mostrar na metade direita (no lugar de Wake-on-LAN)',
  ]);
  await expect(tab('Portas locais')).toHaveClass(/active/);
  await expect(tab('Consulta DNS')).not.toHaveClass(/active|in-pane/);
  await menu.locator('button', { hasText: 'metade direita' }).click();
  await expect(menu).toHaveCount(0);
  await expect(visible).toHaveCount(2);
  await expect(tab('Consulta DNS')).toHaveClass(/active/);
  await expect(tab('Wake-on-LAN')).not.toHaveClass(/active|in-pane/);
  expect((await box('Consulta DNS')).x).toBeGreaterThan((await box('Portas locais')).x);

  // Clicar numa aba que já está numa metade só passa o foco, sem menu.
  await tab('Portas locais').click();
  await expect(menu).toHaveCount(0);
  await expect(tab('Portas locais')).toHaveClass(/active/);

  // Menu de contexto: mandar para a outra metade troca as duas de lugar.
  await tab('Portas locais').click({ button: 'right' });
  await menu.locator('button', { hasText: 'metade direita' }).click();
  expect((await box('Portas locais')).x).toBeGreaterThan((await box('Consulta DNS')).x);

  // Arrastar a aba para uma metade a mostra lá.
  await tab('Wake-on-LAN').dragTo(visible.filter({ has: page.locator('text=Consulta DNS') }).first());
  await expect(tab('Wake-on-LAN')).toHaveClass(/active/);
  await expect(tab('Consulta DNS')).not.toHaveClass(/active|in-pane/);
  expect((await box('Portas locais')).x).toBeGreaterThan((await box('Wake-on-LAN')).x);
});

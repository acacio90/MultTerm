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

const titles = () => page.locator('#tabs .tab[data-tab-id] .title');
const tab = (title: string) => page.locator('#tabs .tab', { hasText: title });

async function openTool(name: string) {
  await page.click('#btn-tools');
  await page.click(`#tools-menu [data-tool="${name}"]`);
}

test('mudar a ordem das abas: arrastar, menu de contexto e teclado', async () => {
  await openTool('dns');
  await openTool('wol');
  await openTool('localports');
  await expect(titles()).toHaveText(['Consulta DNS', 'Wake-on-LAN', 'Portas locais']);

  // Arrastar "Portas locais" para antes do DNS.
  const dns = await tab('Consulta DNS').boundingBox();
  await tab('Portas locais').dragTo(tab('Consulta DNS'), { targetPosition: { x: 4, y: dns!.height / 2 } });
  await expect(titles()).toHaveText(['Portas locais', 'Consulta DNS', 'Wake-on-LAN']);
  await expect(page.locator('#tabs .drop-before, #tabs .drop-after')).toHaveCount(0);
  // A aba "Sessão" continua no início.
  await expect(page.locator('#tabs > .tab').first()).toHaveText('Sessão');

  // Menu de contexto: mover para o início / para a direita; extremos desabilitados.
  await tab('Wake-on-LAN').click({ button: 'right' });
  const menu = page.locator('.tab-menu');
  await expect(menu.locator('button', { hasText: 'Mover para a direita' })).toBeDisabled();
  await expect(menu.locator('button', { hasText: 'Abrir em janela separada' })).toHaveCount(0); // só terminais
  await menu.locator('button', { hasText: 'Mover para o início' }).click();
  await expect(titles()).toHaveText(['Wake-on-LAN', 'Portas locais', 'Consulta DNS']);
  await tab('Wake-on-LAN').click({ button: 'right' });
  await page.locator('.tab-menu button', { hasText: 'Mover para a direita' }).click();
  await expect(titles()).toHaveText(['Portas locais', 'Wake-on-LAN', 'Consulta DNS']);

  // Fechar a aba ativa segue a ordem visível (vai para a última aba da barra).
  await tab('Portas locais').click();
  await tab('Portas locais').locator('.close').click();
  await expect(tab('Consulta DNS')).toHaveClass(/active/);
});

test('Ctrl+Shift+PageUp/PageDown move a aba do terminal sem chegar ao shell', async () => {
  await openTool('dns');
  await page.click('#btn-tools');
  await page.click('#tools-menu [data-tool="local-powershell"]');
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(rows).toContainText('PS ', { timeout: 20_000 });
  await expect(titles()).toHaveText(['Consulta DNS', 'PowerShell']);

  await page.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+PageUp');
  await expect(titles()).toHaveText(['PowerShell', 'Consulta DNS']);
  await page.keyboard.press('Control+Shift+PageDown');
  await expect(titles()).toHaveText(['Consulta DNS', 'PowerShell']);

  // O terminal segue funcionando e não recebeu as teclas (nenhum "~" ou sequência estranha).
  await page.keyboard.type('Write-Output (6*7)\r');
  await expect(rows).toContainText(/\(6\*7\)\s*42/, { timeout: 20_000 });
  await expect(rows).not.toContainText('~');
});

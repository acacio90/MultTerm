import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;

test.beforeEach(async () => {
  ctx = await launchApp('version: 1\nsessions:\n  - {name: local, host: 127.0.0.1}\n');
});

test.afterEach(async () => {
  await ctx.close();
});

test('destaca uma aba de terminal em janela própria e devolve, sem reiniciar o processo', async () => {
  const main = ctx.page;
  // Ping contínuo (só termina com Ctrl+C: prova que o processo é o mesmo do começo ao fim).
  await main.locator('#tree li.session', { hasText: 'local' }).click();
  await main.click('#btn-tools');
  await main.click('#tools-menu [data-tool="ping"]');
  await main.click('#diag-dialog button[type=submit]');
  const tabIn = (p: typeof main) => p.locator('#tabs .tab', { hasText: 'ping 127.0.0.1' });
  const rows = (p: typeof main) => p.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(rows(main)).toContainText('127.0.0.1', { timeout: 20_000 });

  // Compartilhada com o agente (somente leitura): o compartilhamento acompanha a aba.
  await main.click('#btn-agent');
  const agentPanel = main.locator('.panel:not([hidden])').last();
  await agentPanel.locator('[name=port]').fill('47977');
  await agentPanel.locator('button', { hasText: 'Trocar porta' }).click();
  await agentPanel.locator('button', { hasText: 'Ligar o agente' }).click();
  await agentPanel.locator('select[name^=share-]').selectOption('read');
  await expect(tabIn(main)).toHaveClass(/agent-shared/);

  // Destacar.
  const opened = ctx.app.waitForEvent('window');
  await tabIn(main).click({ button: 'right' });
  await main.locator('.tab-menu button', { hasText: 'Abrir em janela separada' }).click();
  const detached = await opened;
  await expect(tabIn(detached)).toBeVisible();
  await expect(tabIn(main)).toHaveCount(0);
  await expect(detached.locator('.sidebar')).toBeHidden();
  await expect(detached).toHaveTitle(/ping 127\.0\.0\.1 — MultTerm/);
  // A saída anterior foi redesenhada e a nova continua chegando.
  await expect(rows(detached)).toContainText('127.0.0.1');
  const before = (await rows(detached).textContent())?.length ?? 0;
  await expect.poll(async () => (await rows(detached).textContent())?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(tabIn(detached)).toHaveClass(/agent-shared/);

  // O agente continua vendo a aba (agora em outra janela).
  const conn = JSON.parse(await readFile(join(ctx.dir, 'userdata', 'agent-connection.json'), 'utf8'));
  const res = await fetch(`http://127.0.0.1:${conn.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_terminals', arguments: {} } }),
  });
  const list = JSON.parse((await res.json()).result.content[0].text);
  expect(list).toMatchObject([{ title: 'ping 127.0.0.1', permission: 'read', running: true }]);

  // Devolver: a janela destacada fecha e a aba volta para a principal.
  const closed = detached.waitForEvent('close');
  await tabIn(detached).click({ button: 'right' });
  await detached.locator('.tab-menu button', { hasText: 'Devolver à janela principal' }).click();
  await closed;
  await expect(tabIn(main)).toBeVisible();
  await expect(tabIn(main)).toHaveClass(/agent-shared/);
  await expect(rows(main)).toContainText('127.0.0.1');

  // Ctrl+C encerra o mesmo ping que começou na janela principal.
  await main.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await main.keyboard.press('Control+C');
  await expect(tabIn(main)).toHaveClass(/ended/, { timeout: 15_000 });
});

test('fechar a janela destacada devolve a aba à principal; fechar a aba encerra', async () => {
  const main = ctx.page;
  const tabIn = (p: typeof main, title: string) => p.locator('#tabs .tab', { hasText: title });
  const rows = (p: typeof main) => p.locator('.term-panel:not([hidden]) .xterm-rows');
  await main.click('#btn-tools');
  await main.click('#tools-menu [data-tool="local-powershell"]');
  await expect(rows(main)).toContainText('PS ', { timeout: 20_000 });
  await main.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await main.keyboard.type('$marca = 6*7\r');

  // Destaca e fecha a janela destacada pelo X (evento "close" da janela).
  let opened = ctx.app.waitForEvent('window');
  await tabIn(main, 'PowerShell').click({ button: 'right' });
  await main.locator('.tab-menu button', { hasText: 'Abrir em janela separada' }).click();
  let detached = await opened;
  await expect(tabIn(detached, 'PowerShell')).toBeVisible();
  const closed = detached.waitForEvent('close');
  await ctx.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('PowerShell'))?.close();
  });
  await closed;

  // A aba voltou para a principal com a mesma sessão (a variável continua lá).
  await expect(tabIn(main, 'PowerShell')).toBeVisible();
  await main.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await main.keyboard.type('Write-Output $marca\r');
  await expect(rows(main)).toContainText(/Write-Output \$marca\s*42/, { timeout: 20_000 });
  expect(ctx.app.windows()).toHaveLength(1);

  // Fechar a aba na janela destacada encerra a sessão e fecha a janela vazia.
  opened = ctx.app.waitForEvent('window');
  await tabIn(main, 'PowerShell').click({ button: 'right' });
  await main.locator('.tab-menu button', { hasText: 'Abrir em janela separada' }).click();
  detached = await opened;
  const closed2 = detached.waitForEvent('close');
  await tabIn(detached, 'PowerShell').locator('.close').click();
  await closed2;
  await expect(tabIn(main, 'PowerShell')).toHaveCount(0);
  expect(ctx.app.windows()).toHaveLength(1);
});

test('fechar a janela principal encerra o app, inclusive as janelas destacadas', async () => {
  const main = ctx.page;
  await main.click('#btn-tools');
  await main.click('#tools-menu [data-tool="local-powershell"]');
  await expect(main.locator('.term-panel:not([hidden]) .xterm-rows')).toContainText('PS ', { timeout: 20_000 });
  const opened = ctx.app.waitForEvent('window');
  await main.locator('#tabs .tab', { hasText: 'PowerShell' }).click({ button: 'right' });
  await main.locator('.tab-menu button', { hasText: 'Abrir em janela separada' }).click();
  const detached = await opened;
  await expect(detached.locator('#tabs .tab', { hasText: 'PowerShell' })).toBeVisible();
  expect(ctx.app.windows()).toHaveLength(2);
  const exited = ctx.app.waitForEvent('close');
  // A principal pela URL, não pelo título: enquanto carrega, a destacada também se chama "MultTerm".
  await ctx.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('detached=1'))?.close();
  });
  await exited;
});

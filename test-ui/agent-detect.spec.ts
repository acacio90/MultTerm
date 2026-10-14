import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;
let searchDir: string;

test.beforeEach(async () => {
  // PATH da busca só com esta pasta (vazia no começo): nada da máquina interfere.
  searchDir = await mkdtemp(join(tmpdir(), 'multterm-agents-'));
  ctx = await launchApp('version: 1\nsessions: []\n', { MULTTERM_AGENT_SEARCH_PATH: searchDir });
  await expect(ctx.page.locator('#status-count')).toHaveText('0 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx.close();
  await rm(searchDir, { recursive: true, force: true });
});

test('lista só os agentes instalados; sem nenhum, explica e bloqueia o botão', async () => {
  const page = ctx.page;
  await page.click('#btn-agent');
  const panel = page.locator('.panel:not([hidden])').last();
  const option = panel.locator('select[name=agent] option');
  await expect(option).toHaveText('Claude Code (não instalado)');
  await expect(option).toHaveAttribute('disabled', ''); // toBeDisabled não vale para <option>
  await expect(panel.locator('button', { hasText: 'Abrir o agente' })).toBeDisabled();
  await expect(panel).toContainText('Nenhum agente compatível foi encontrado nesta máquina');

  // "Instala" um agente falso e procura de novo: aparece e pode ser aberto.
  await writeFile(join(searchDir, 'claude.cmd'), '@echo AGENTE-FALSO %*\r\n');
  await panel.locator('button', { hasText: 'Procurar de novo' }).click();
  await expect(option).toHaveText('Claude Code');
  await expect(option).not.toHaveAttribute('disabled');
  await expect(panel).not.toContainText('Nenhum agente compatível');
  await panel.locator('[name=port]').fill('47981');
  await panel.locator('button', { hasText: 'Trocar porta' }).click();
  await panel.locator('button', { hasText: 'Abrir o agente' }).click();
  // Abre pelo caminho encontrado, com o arquivo de configuração MCP.
  await expect(page.locator('.term-panel:not([hidden]) .xterm-rows')).toContainText('AGENTE-FALSO --mcp-config', { timeout: 20_000 });
});

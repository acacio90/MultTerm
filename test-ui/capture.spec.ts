import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

const HAS_WIRESHARK = existsSync('C:/Program Files/Wireshark/dumpcap.exe');
let ctx: LaunchedApp | undefined;
let captures: string;

test.beforeEach(async () => {
  captures = await mkdtemp(join(tmpdir(), 'multterm-capturas-'));
});

test.afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
  await rm(captures, { recursive: true, force: true });
});

async function openCapture(extraEnv: Record<string, string> = {}) {
  ctx = await launchApp('version: 1\nsessions: []\n', { MULTTERM_CAPTURES_DIR: captures, ...extraEnv });
  await ctx.page.click('#btn-tools');
  await ctx.page.click('#tools-menu [data-tool="capture"]');
  return ctx.page.locator('.panel:not([hidden])').last();
}

test('sem Wireshark, orienta a instalação', async () => {
  // Procurar o Wireshark numa pasta vazia simula uma máquina sem ele.
  const empty = await mkdtemp(join(tmpdir(), 'multterm-pf-'));
  try {
    const panel = await openCapture({ MULTTERM_PROGRAM_FILES: empty });
    await expect(panel).toContainText('instale o Wireshark');
    await expect(panel.locator('button', { hasText: 'Verificar de novo' })).toBeVisible();
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('captura no loopback com filtro, conta ao vivo e grava ao parar', async () => {
  test.skip(!HAS_WIRESHARK, 'Wireshark/Npcap não instalados nesta máquina');
  const panel = await openCapture();
  await panel.locator('[name=iface]').selectOption({ label: 'Adapter for loopback traffic capture' });
  await panel.locator('[name=filter]').fill('tcp port 9');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('Capturando…');
  await new Promise((r) => setTimeout(r, 1500));
  // Conexões recusadas na porta 9 geram SYN/RST no loopback.
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => connect({ port: 9, host: '127.0.0.1' }).once('error', () => r()).once('connect', () => r()));
  }
  await expect(panel.locator('.tool-status')).toContainText(/Capturando… [1-9]\d* pacote/);
  await panel.locator('button', { hasText: 'Parar' }).click();
  await expect(panel.locator('.tool-status')).toContainText(/[1-9]\d* pacote\(s\) em \d\d:\d\d salvos em /);
  await expect(panel.locator('button', { hasText: 'Abrir no Wireshark' })).toBeVisible();
  const files = await readdir(captures);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^multterm-captura-\d{8}-\d{6}\.pcapng$/);
});

test('filtro inválido mostra erro traduzido', async () => {
  test.skip(!HAS_WIRESHARK, 'Wireshark/Npcap não instalados nesta máquina');
  const panel = await openCapture();
  await panel.locator('[name=iface]').selectOption({ label: 'Adapter for loopback traffic capture' });
  await panel.locator('[name=filter]').fill('port and lixo');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('filtro de captura inválido');
});

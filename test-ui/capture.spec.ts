import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

test('sem Wireshark nem pktmon, orienta a instalação', async () => {
  // Procurar numa pasta vazia simula uma máquina sem Wireshark e sem pktmon.
  const empty = await mkdtemp(join(tmpdir(), 'multterm-pf-'));
  try {
    const panel = await openCapture({ MULTTERM_PROGRAM_FILES: empty, MULTTERM_SYSTEM_ROOT: empty });
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

/** Pasta do Windows falsa só com o PktMon.exe (vazio: o teste não chega a executá-lo). */
async function fakeSystemRoot() {
  const root = await mkdtemp(join(tmpdir(), 'multterm-win-'));
  await mkdir(join(root, 'System32'));
  await writeFile(join(root, 'System32', 'PktMon.exe'), '');
  return root;
}

test('sem Wireshark, usa o pktmon com filtros simples', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'multterm-pf-'));
  const root = await fakeSystemRoot();
  try {
    const panel = await openCapture({ MULTTERM_PROGRAM_FILES: empty, MULTTERM_SYSTEM_ROOT: root });
    await expect(panel.locator('.tool-status')).toContainText('usando o pktmon do Windows');
    await expect(panel.locator('[name=backend]')).toBeHidden(); // um só motor: sem seletor
    await expect(panel.locator('[name=ip]')).toBeVisible();
    await expect(panel.locator('[name=protocol]')).toBeVisible();
    await expect(panel.locator('[name=filter]')).toBeHidden();
    await expect(panel).toContainText('exige administrador');
    // A validação acontece antes de pedir a elevação.
    await panel.locator('[name=ip]').fill('10.0.0.999');
    await panel.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toContainText('IP inválido no filtro');
    await expect(panel.locator('button[type=submit]')).toBeEnabled();
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('com Wireshark e pktmon, o seletor troca os campos', async () => {
  test.skip(!HAS_WIRESHARK, 'Wireshark/Npcap não instalados nesta máquina');
  const root = await fakeSystemRoot();
  try {
    const panel = await openCapture({ MULTTERM_SYSTEM_ROOT: root });
    const backend = panel.locator('[name=backend]');
    await expect(backend).toHaveValue('dumpcap');
    await expect(panel.locator('[name=filter]')).toBeVisible();
    await expect(panel.locator('[name=ip]')).toBeHidden();
    await backend.selectOption('pktmon');
    await expect(panel.locator('[name=filter]')).toBeHidden();
    await expect(panel.locator('[name=iface]')).toBeHidden();
    await expect(panel.locator('[name=port]')).toBeVisible();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

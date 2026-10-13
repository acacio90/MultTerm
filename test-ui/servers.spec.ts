import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp | undefined;
let root: string;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'multterm-srv-ui-'));
});

test.afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
  await rm(root, { recursive: true, force: true });
});

async function openServers() {
  ctx = await launchApp('version: 1\nsessions: []\n', { MULTTERM_SERVERS_FILE: join(root, 'servers.json') });
  await ctx.page.click('#btn-tools');
  await ctx.page.click('#tools-menu [data-tool="servers"]');
  return ctx.page.locator('.panel:not([hidden])').last();
}

test('HTTP: inicia pelo painel, serve a pasta, registra e para', async () => {
  await writeFile(join(root, 'firmware.bin'), 'conteúdo do firmware');
  const port = await freePort();
  const panel = await openServers();
  await expect(panel.locator('.server-row')).toHaveCount(3);
  await panel.locator('.server-row[data-kind=http] .server-name').click();
  const detail = panel.locator('.server-detail');
  await expect(detail.locator('h3')).toHaveText('Servidor HTTP');
  await detail.locator('[name=root]').fill(root);
  await detail.locator('[name=port]').fill(String(port));
  await panel.locator('.server-row[data-kind=http] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.server-row[data-kind=http] .server-state')).toContainText(`rodando na porta ${port}`);
  await expect(panel.locator('.server-row[data-kind=http] .server-state')).toContainText('para em');

  const r = await fetch(`http://127.0.0.1:${port}/firmware.bin`);
  expect(await r.text()).toBe('conteúdo do firmware');
  await expect(detail.locator('.server-log')).toContainText('GET /firmware.bin → 200');

  await panel.locator('.server-row[data-kind=http] button', { hasText: 'Parar' }).click();
  await expect(panel.locator('.server-row[data-kind=http] .server-state')).toHaveText('parado');
  await expect(detail.locator('.server-log')).toContainText('HTTP parado');
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  // A configuração fica lembrada.
  const saved = JSON.parse(await readFile(join(root, 'servers.json'), 'utf8'));
  expect(saved.http.port).toBe(port);
  expect(saved.http.root).toBe(root);
});

test('porta em uso mostra erro claro', async () => {
  const busy = createServer().listen(0);
  await new Promise((r) => busy.once('listening', r));
  const port = (busy.address() as { port: number }).port;
  try {
    const panel = await openServers();
    await panel.locator('.server-row[data-kind=http] .server-name').click();
    await panel.locator('.server-detail [name=root]').fill(root);
    await panel.locator('.server-detail [name=port]').fill(String(port));
    await panel.locator('.server-row[data-kind=http] button', { hasText: 'Iniciar' }).click();
    await expect(panel.locator('.tool-status')).toHaveText(`HTTP: a porta ${port} já está em uso por outro programa`);
    await expect(panel.locator('.server-row[data-kind=http] .server-state')).toHaveText('parado');
  } finally {
    busy.close();
  }
});

test('TFTP: recebe um arquivo pelo curl e para sozinho no tempo limite', async () => {
  test.skip(!existsSync('C:/Windows/System32/curl.exe'), 'sem curl');
  const port = await freePort();
  const panel = await openServers();
  const detail = panel.locator('.server-detail');
  await expect(detail.locator('h3')).toHaveText('Servidor TFTP');
  await detail.locator('[name=root]').fill(root);
  await detail.locator('[name=port]').fill(String(port));
  await detail.locator('[name=notify]').uncheck();
  await detail.locator('[name=stopAfter]').fill('3');
  await panel.locator('.server-row[data-kind=tftp] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.server-row[data-kind=tftp] .server-state')).toContainText(`rodando na porta ${port}`);

  const local = join(root, 'local-config.txt');
  await writeFile(local, 'hostname switch-01\n');
  await new Promise<void>((resolve, reject) => execFile('C:/Windows/System32/curl.exe', ['-s', '-S', '-T', local, `tftp://127.0.0.1:${port}/backup.cfg`], (e) => (e ? reject(e) : resolve())));
  expect(await readFile(join(root, 'backup.cfg'), 'utf8')).toBe('hostname switch-01\n');
  await expect(detail.locator('.server-log')).toContainText('enviou "backup.cfg"');

  await expect(panel.locator('.server-row[data-kind=tftp] .server-state')).toHaveText('parado', { timeout: 10_000 });
  await expect(detail.locator('.server-log')).toContainText('tempo limite de 3 s');
});

test('FTP: senha guardada cifrada, login pelo curl e anônimo recusado', async () => {
  test.skip(!existsSync('C:/Windows/System32/curl.exe'), 'sem curl');
  await writeFile(join(root, 'config.txt'), 'interface eth0');
  const port = await freePort();
  const panel = await openServers();
  await expect(panel.locator('.server-row')).toHaveCount(3);
  await panel.locator('.server-row[data-kind=ftp] .server-name').click();
  const detail = panel.locator('.server-detail');
  await detail.locator('[name=root]').fill(root);
  await detail.locator('[name=port]').fill(String(port));
  await detail.locator('[name=user]').fill('tecnico');
  await detail.locator('[name=password]').fill('senha-forte');
  await panel.locator('.server-row[data-kind=ftp] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.server-row[data-kind=ftp] .server-state')).toContainText(`rodando na porta ${port}`);

  const get = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => execFile('C:/Windows/System32/curl.exe', ['-s', ...args], (e, out) => resolve({ code: e ? 1 : 0, out })));
  expect((await get(['-u', 'tecnico:senha-forte', `ftp://127.0.0.1:${port}/config.txt`])).out).toBe('interface eth0');
  expect((await get([`ftp://127.0.0.1:${port}/config.txt`])).code).not.toBe(0); // anônimo desligado
  await expect(detail.locator('.server-log')).toContainText('login de tecnico');

  // A senha não fica em texto puro no arquivo nem volta para a tela.
  const saved = await readFile(join(root, 'servers.json'), 'utf8');
  expect(saved).not.toContain('senha-forte');
  expect(JSON.parse(saved).ftp.passwordSealed).toBeTruthy();
  await panel.locator('.server-row[data-kind=ftp] button', { hasText: 'Parar' }).click();
  await panel.locator('.server-row[data-kind=http] .server-name').click();
  await panel.locator('.server-row[data-kind=ftp] .server-name').click();
  await expect(detail.locator('[name=password]')).toHaveValue('');
  await expect(detail.locator('[name=password]')).toHaveAttribute('placeholder', 'em branco mantém');
  // Em branco reinicia com a senha guardada.
  await panel.locator('.server-row[data-kind=ftp] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.server-row[data-kind=ftp] .server-state')).toContainText('rodando');
  expect((await get(['-u', 'tecnico:senha-forte', `ftp://127.0.0.1:${port}/config.txt`])).out).toBe('interface eth0');
});

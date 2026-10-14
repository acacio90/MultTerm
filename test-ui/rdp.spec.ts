import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

// Cliente RDP baixado por "npm run fetch:freerdp" (o CI baixa antes dos testes de interface).
const FREERDP = join(import.meta.dirname, '..', 'vendor', 'freerdp', 'wfreerdp.exe');

let ctx: LaunchedApp;
let server: Server;
let port: number;

test.beforeEach(async () => {
  // "Servidor" que aceita e derruba a conexão: o cliente RDP falha logo e encerra.
  server = createServer((sock) => sock.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

test.afterEach(async () => {
  await ctx?.close();
  server.close();
});

const session = (name: string) => ctx.page.locator('#tree li.session', { has: ctx.page.locator('.label', { hasText: new RegExp(`^${name}$`) }) });

test('RDP abre numa aba; falha de conexão mostra o motivo e reconectar', async () => {
  test.skip(!existsSync(FREERDP), 'cliente RDP não baixado (npm run fetch:freerdp)');
  ctx = await launchApp(`version: 1\nsessions:\n  - {name: AD WIN, type: rdp, host: 127.0.0.1, port: ${port}, user: 'EMPRESA\\ana'}\n`);
  await session('AD WIN').dblclick();
  const tab = ctx.page.locator('#tabs .tab', { hasText: 'AD WIN' });
  await expect(tab).toHaveClass(/active/);
  const status = ctx.page.locator('.rdp-panel:not([hidden]) .rdp-status');
  await expect(status).toContainText('Sessão RDP encerrada', { timeout: 30_000 });
  await expect(tab).toHaveClass(/ended/);
  // Código do FreeRDP traduzido; o registro do cliente fica nos detalhes técnicos.
  await expect(status.locator('.rdp-error')).toContainText('não foi possível conectar');
  await expect(status.locator('details pre')).toContainText('ERRCONNECT_CONNECT_TRANSPORT_FAILED');

  // Reconectar tenta de novo (e falha de novo, sem travar a aba).
  await status.locator('button', { hasText: 'Reconectar' }).click();
  await expect(tab).not.toHaveClass(/ended/);
  await expect(status).toContainText('Sessão RDP encerrada', { timeout: 30_000 });
});

test('menu da sessão RDP mantém a opção do cliente do Windows; sem o cliente embutido, não há aba', async () => {
  ctx = await launchApp(`version: 1\nsessions:\n  - {name: AD WIN, type: rdp, host: 127.0.0.1, port: ${port}}\n`, { MULTTERM_FREERDP: join(import.meta.dirname, 'nao-existe.exe') });
  await session('AD WIN').click({ button: 'right' });
  await expect(ctx.page.locator('#tree-menu [data-action="external"]')).toHaveText('Janela externa (cliente do Windows)');
  await ctx.page.keyboard.press('Escape');
  expect(await ctx.page.evaluate(() => (window as unknown as { multterm: { rdpAvailable: () => Promise<boolean> } }).multterm.rdpAvailable())).toBe(false);
});

test('servidor só com TLS antigo: oferece permitir TLS antigo só nesta sessão', async () => {
  test.skip(!existsSync(FREERDP), 'cliente RDP não baixado (npm run fetch:freerdp)');
  // Servidor que escolhe NLA na negociação e recusa o handshake TLS (como um Windows antigo, só TLS 1.0).
  const old = createServer((sock) => {
    let stage = 0;
    sock.on('data', () => {
      if (stage++ === 0) sock.write(Buffer.from([0x03, 0, 0, 0x13, 0x0e, 0xd0, 0, 0, 0x12, 0x34, 0, 0x02, 0x00, 0x08, 0x00, 0x02, 0, 0, 0]));
      else sock.end(Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46]));
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
  const oldPort = (old.address() as { port: number }).port;
  try {
    ctx = await launchApp(`version: 1\nsessions:\n  - {name: AD WIN, type: rdp, host: 127.0.0.1, port: ${oldPort}}\n  - {name: OUTRO, type: rdp, host: 127.0.0.1, port: ${oldPort}}\n`);
    await session('AD WIN').dblclick();
    const status = ctx.page.locator('.rdp-panel:not([hidden]) .rdp-status');
    await expect(status.locator('.rdp-error')).toContainText('falha na conexão segura (TLS)', { timeout: 30_000 });
    await expect(status.locator('.rdp-error')).toContainText('só aceitam TLS 1.0');
    await status.locator('button', { hasText: 'Permitir TLS antigo nesta sessão e reconectar' }).click();

    // Gravado só na sessão AD WIN; a nova tentativa já usa a opção (e não oferece de novo).
    await expect(status.locator('.rdp-error')).toContainText('falha na conexão segura (TLS)', { timeout: 30_000 });
    await expect(status.locator('button', { hasText: 'Permitir TLS antigo' })).toHaveCount(0);
    const yaml = await readFile(ctx.sessionsFile, 'utf8');
    expect(yaml).toMatch(/name: AD WIN[\s\S]*?legacyTls: true/);
    expect(yaml.match(/legacyTls: true/g)).toHaveLength(1);

    // O formulário mostra a opção marcada (só em sessões RDP).
    await session('AD WIN').click();
    await expect(ctx.page.locator('#form [name=legacyTls]')).toBeChecked();
    await session('OUTRO').click();
    await expect(ctx.page.locator('#form [name=legacyTls]')).not.toBeChecked();
  } finally {
    old.close();
  }
});

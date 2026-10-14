import { expect, test, type Page } from '@playwright/test';
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { magicPacket } from '../src/network/wol.ts';
import { launchApp, type LaunchedApp } from './fixture.ts';

const SESSIONS = `version: 1
sessions:
  - name: pc-lab
    folder: Lab
    type: rdp
    host: 10.0.0.50
    mac: 00:1a:2b:3c:4d:5e
  - name: srv
    folder: Lab
    type: ssh
    host: 10.0.0.60
`;

let ctx: LaunchedApp;
let page: Page;

test.beforeEach(async () => {
  ctx = await launchApp(SESSIONS);
  page = ctx.page;
  await expect(page.locator('#status-count')).toHaveText('2 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx?.close();
});

const session = (name: string) => page.locator('#tree li.session', { hasText: name });
const menuLabels = () => page.locator('#tree-menu button').allTextContents();

test('menu da sessão: Wake-on-LAN só com MAC; atalhos usam o host da sessão', async () => {
  await session('srv').click({ button: 'right' });
  expect(await menuLabels()).toEqual(['Conectar', 'Janela externa', 'Ping…', 'Traceroute…', 'Scanner de portas', 'Consulta SNMP', 'Editar', 'Excluir…']);
  await page.click('#tree-menu [data-action="ping"]');
  await expect(page.locator('#diag-dialog [name=host]')).toHaveValue('10.0.0.60');
  await page.click('#diag-cancel');

  await session('pc-lab').click({ button: 'right' });
  expect(await menuLabels()).toContain('Ligar (Wake-on-LAN)');
  await page.click('#tree-menu [data-action="portscan"]');
  await expect(page.locator('.panel:not([hidden]) [name=host]').last()).toHaveValue('10.0.0.50');
});

test('Ligar (Wake-on-LAN) pelo menu envia o pacote', async () => {
  await session('pc-lab').click({ button: 'right' });
  await page.click('#tree-menu [data-action="wol"]');
  await expect(page.locator('#messages')).toContainText('Pacote Wake-on-LAN enviado para pc-lab (00:1a:2b:3c:4d:5e, 255.255.255.255:9)');
});

test('campo MAC no formulário é validado e gravado normalizado', async () => {
  await session('srv').click();
  await page.fill('#form [name=mac]', 'xx');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages .error')).toContainText('"mac" inválido');
  await page.fill('#form [name=mac]', 'AA-BB-CC-DD-EE-01');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages')).toHaveText('Sessão salva.');
  expect(await readFile(ctx.sessionsFile, 'utf8')).toContain('mac: aa:bb:cc:dd:ee:01');
});

test('ferramenta Wake-on-LAN entrega o pacote mágico', async () => {
  const rx = createSocket('udp4');
  await new Promise<void>((r) => rx.bind(0, '127.0.0.1', r));
  const received = new Promise<Buffer>((r) => rx.once('message', (msg) => r(msg)));
  try {
    await page.click('#btn-tools');
    await page.click('#tools-menu [data-tool="wol"]');
    const panel = page.locator('.panel:not([hidden])').last();
    await panel.locator('[name=session]').selectOption({ label: 'Lab/pc-lab (00:1a:2b:3c:4d:5e)' });
    await expect(panel.locator('[name=mac]')).toHaveValue('00:1a:2b:3c:4d:5e');
    await panel.locator('[name=address]').fill('127.0.0.1');
    await panel.locator('[name=port]').fill(String(rx.address().port));
    await panel.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toContainText('Pacote mágico enviado para 00:1a:2b:3c:4d:5e');
    expect((await received).equals(magicPacket('00:1a:2b:3c:4d:5e'))).toBe(true);
  } finally {
    rx.close();
  }
});

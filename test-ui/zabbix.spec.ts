import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clickMenu, launchApp, type LaunchedApp } from './fixture.ts';
import { startFakeZabbix, type FakeZabbix } from '../test/zabbix-fake.ts';

const LINUX = { groupid: '2', name: 'Linux servers' };
const WIN = { groupid: '11', name: 'Clientes/ACME' };
const agent = (ip: string) => [{ type: '1', main: '1', useip: '1', ip, dns: '' }];

let ctx: LaunchedApp;
let zabbix: FakeZabbix;

test.beforeEach(async () => {
  zabbix = await startFakeZabbix({
    version: '7.0.5',
    token: 'token-123',
    groups: [LINUX, WIN],
    hosts: [
      { hostid: '101', host: 'web01', interfaces: agent('10.0.0.1'), groups: [LINUX] },
      { hostid: '102', host: 'ad01', interfaces: agent('10.0.0.2'), inventory: { os: 'Windows Server 2022' }, groups: [WIN] },
      { hostid: '103', host: 'db01', interfaces: agent('10.0.0.3'), groups: [LINUX, WIN] },
    ],
  });
  ctx = await launchApp('version: 1\nsessions: []\n');
});

test.afterEach(async () => {
  await ctx?.close();
  await zabbix?.close();
});

test('importa hosts do Zabbix: conecta com token, escolhe o grupo e monta a árvore', async () => {
  const { app, page, sessionsFile } = ctx;
  const dialog = page.locator('#zabbix-dialog');
  await clickMenu(app, 'import-zabbix');
  await expect(dialog).toBeVisible();

  // Token errado: erro no próprio diálogo.
  await dialog.locator('input[name="url"]').fill(zabbix.url);
  await dialog.locator('input[name="token"]').fill('errado');
  await page.locator('#zabbix-connect').click();
  await expect(page.locator('#zabbix-error')).toContainText('Not authorised');

  await dialog.locator('input[name="token"]').fill('token-123');
  await page.locator('#zabbix-connect').click();
  await expect(page.locator('#zabbix-version')).toContainText('Zabbix 7.0.5: 2 grupo(s)');
  await expect(page.locator('#zabbix-groups label')).toHaveText(['Linux servers (2)', 'Clientes/ACME (2)']);
  await expect(page.locator('#zabbix-import')).toBeDisabled();

  await page.locator('#zabbix-groups label', { hasText: 'Clientes/ACME' }).locator('input').check();
  await page.locator('#zabbix-import').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#messages')).toContainText('2 sessões importadas do Zabbix (2 hosts), 0 já existiam.');
  await expect(page.locator('#status-count')).toHaveText('2 sessões · sem limite');

  const saved = await readFile(sessionsFile, 'utf8');
  expect(saved).toContain('folder: Zabbix/Clientes/ACME');
  expect(saved).toMatch(/name: ad01\n\s+folder: Zabbix\/Clientes\/ACME\n\s+type: rdp/);
  expect(saved).toContain('zabbixHostId: "103"');

  // O token fica cifrado: não aparece em texto puro no zabbix.json.
  const config = await readFile(join(ctx.dir, 'userdata', 'zabbix.json'), 'utf8');
  expect(config).not.toContain('token-123');

  // Reabrir lembra a conexão: token em branco usa o guardado e o grupo escolhido vem marcado.
  await clickMenu(app, 'import-zabbix');
  await expect(dialog.locator('input[name="token"]')).toHaveAttribute('placeholder', /guardado/);
  await page.locator('#zabbix-connect').click();
  await expect(page.locator('#zabbix-groups label', { hasText: 'Clientes/ACME' }).locator('input')).toBeChecked();
  await page.locator('#zabbix-import').click();
  await expect(page.locator('#messages')).toContainText('0 sessões importadas do Zabbix (2 hosts), 2 já existiam.');
});

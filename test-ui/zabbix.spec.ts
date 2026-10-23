import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clickMenu, launchApp, type LaunchedApp } from './fixture.ts';
import { startFakeZabbix, type FakeZabbix, type FakeZabbixOptions } from '../test/zabbix-fake.ts';

const LINUX = { groupid: '2', name: 'Linux servers' };
const ACME = { groupid: '11', name: 'Clientes/ACME' };
const agent = (ip: string) => [{ type: '1', main: '1', useip: '1', ip, dns: '' }];

let ctx: LaunchedApp;
let zabbix: FakeZabbix;
let options: FakeZabbixOptions;

test.beforeEach(async () => {
  options = {
    version: '7.0.5',
    token: 'token-123',
    groups: [LINUX, ACME],
    hosts: [
      { hostid: '101', host: 'web01', interfaces: agent('10.0.0.1'), groups: [LINUX] },
      { hostid: '102', host: 'ad01', interfaces: agent('10.0.0.2'), inventory: { os: 'Windows Server 2022' }, groups: [ACME] },
      { hostid: '103', host: 'db01', interfaces: agent('10.0.0.3'), groups: [LINUX, ACME] },
    ],
  };
  zabbix = await startFakeZabbix(options);
  ctx = await launchApp('version: 1\nsessions:\n  - { name: roteador, folder: Rede, host: 10.0.0.254 }\n');
});

test.afterEach(async () => {
  await ctx?.close();
  await zabbix?.close();
});

test('sincroniza com o Zabbix: prévia, grava, mantém o editado e remove o que sumiu', async () => {
  const { app, page, sessionsFile } = ctx;
  const dialog = page.locator('#zabbix-dialog');
  const confirm = page.locator('#confirm-dialog');
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

  // Primeira sincronização: prévia com 2 novas, nada gravado antes de confirmar.
  await page.locator('#zabbix-groups label', { hasText: 'Clientes/ACME' }).locator('input').check();
  await page.locator('#zabbix-import').click();
  await expect(dialog).toBeHidden();
  await expect(confirm).toContainText('2 hosts no Zabbix: 2 sessão(ões) nova(s), 0 atualizada(s) e 0 removida(s).');
  expect(await readFile(sessionsFile, 'utf8')).not.toContain('zabbixHostId');
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#messages')).toContainText('Zabbix sincronizado: 2 nova(s), 0 atualizada(s), 0 removida(s).');
  await expect(page.locator('#status-count')).toHaveText('3 sessões · sem limite');

  let saved = await readFile(sessionsFile, 'utf8');
  expect(saved).toMatch(/name: ad01\n\s+folder: Zabbix\/Clientes\/ACME\n\s+type: rdp/);
  expect(saved).toContain('zabbixHostId: "103"');
  // O token fica cifrado: não aparece em texto puro no zabbix.json.
  expect(await readFile(join(ctx.dir, 'userdata', 'zabbix.json'), 'utf8')).not.toContain('token-123');

  // Edição à mão (usuário) e mudanças no Zabbix: db01 muda de IP, ad01 sai do grupo.
  await writeFile(sessionsFile, saved.replace('host: 10.0.0.3', 'host: 10.0.0.3\n    user: pedro'));
  await clickMenu(app, 'reload');
  options.hosts[2].interfaces = agent('10.0.0.33');
  options.hosts[1].groups = [LINUX];

  // Sincronizar pelo menu usa a conexão e os grupos guardados.
  await clickMenu(app, 'zabbix-sync');
  await expect(confirm).toContainText('0 sessão(ões) nova(s), 1 atualizada(s) e 1 removida(s).');
  await expect(confirm).toContainText('remover: Zabbix/Clientes/ACME/ad01');
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#messages')).toContainText('Zabbix sincronizado: 0 nova(s), 1 atualizada(s), 1 removida(s).');

  saved = await readFile(sessionsFile, 'utf8');
  expect(saved).not.toContain('ad01');
  expect(saved).toMatch(/host: 10\.0\.0\.33\n\s+user: pedro/);
  expect(saved).toContain('name: roteador'); // sessão criada à mão nunca é tocada

  // Cancelar a prévia não grava nada.
  options.hosts.pop();
  await clickMenu(app, 'zabbix-sync');
  await expect(confirm).toContainText('1 removida(s)');
  await page.locator('#confirm-cancel').click();
  expect(await readFile(sessionsFile, 'utf8')).toBe(saved);

  // Sem mudanças: não pergunta.
  options.hosts.push({ hostid: '103', host: 'db01', interfaces: agent('10.0.0.33'), groups: [LINUX, ACME] });
  await clickMenu(app, 'zabbix-sync');
  await expect(page.locator('#messages')).toContainText('Zabbix sincronizado: nada mudou.');
});

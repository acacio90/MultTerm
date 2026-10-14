import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clickMenu, launchApp, type LaunchedApp } from './fixture.ts';

// Máquina de origem: duas sessões, um site de VPN, um servidor configurado (com senha cifrada).
const SESSIONS = 'version: 1\nsessions:\n  - {name: web-01, folder: Prod, host: 10.0.0.1}\n  - {name: ad-01, type: rdp, host: 10.0.0.9}\n';
const SITE = 's:network-host:vpn.example.org\ns:auth-method:mutual-psk\nb:auth-mutual-psk:c2VncmVkbw==\n';
const SERVERS = { ftp: { port: 2121, user: 'equipe', passwordSealed: 'AAAA', anonymous: true }, _cert: { passphrase: 'BBBB' } };

let root: string;
const apps: LaunchedApp[] = [];

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'multterm-backup-'));
});

test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await rm(root, { recursive: true, force: true });
});

async function machine(name: string, sessions: string, site?: string, servers?: unknown) {
  const sites = join(root, name, 'sites');
  await mkdir(sites, { recursive: true });
  if (site) await writeFile(join(sites, 'Matriz'), site);
  const serversFile = join(root, name, 'servers.json');
  if (servers) await writeFile(serversFile, JSON.stringify(servers));
  const ctx = await launchApp(sessions, { MULTTERM_VPN_SITES: sites, MULTTERM_SERVERS_FILE: serversFile });
  apps.push(ctx);
  return { ctx, sites, serversFile };
}

test('backup completo: exporta numa máquina e restaura em outra', async () => {
  const origin = await machine('origem', SESSIONS, SITE, SERVERS);
  const out = join(root, 'MultTerm-backup.multterm');
  await origin.ctx.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
  }, out);
  await clickMenu(origin.ctx.app, 'export-backup');
  await expect(origin.ctx.page.locator('#messages')).toContainText('2 sessão(ões), 1 site(s) de VPN e 1 servidor(es)');

  const backup = JSON.parse(await readFile(out, 'utf8'));
  expect(backup).toMatchObject({ format: 'multterm-backup', version: 1, agent: { agent: 'claude' } });
  expect(backup.sessions.map((s: { name: string }) => s.name).sort()).toEqual(['ad-01', 'web-01']);
  expect(backup.vpnSites).toEqual([{ name: 'Matriz', content: SITE }]);
  // Sem senhas cifradas nem a senha do certificado.
  expect(backup.servers).toEqual({ ftp: { port: 2121, user: 'equipe', anonymous: true } });

  // Máquina nova: já tem uma sessão com o mesmo nome (fica) e nenhum site.
  const target = await machine('destino', 'version: 1\nsessions:\n  - {name: web-01, folder: Prod, host: 10.0.0.77}\n');
  const page = target.ctx.page;
  await target.ctx.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, out);
  page.once('dialog', (d) => void d.accept());
  await clickMenu(target.ctx.app, 'import-backup');
  await expect(page.locator('#messages')).toContainText('1 sessão(ões) nova(s) (1 já existiam), 1 site(s) de VPN novo(s) (0 já existiam) e 1 servidor(es)');
  await expect(page.locator('#status-count')).toHaveText('2 sessões · sem limite');
  expect(await readFile(join(target.sites, 'Matriz'), 'utf8')).toBe(SITE);
  expect(JSON.parse(await readFile(target.serversFile, 'utf8'))).toEqual({ ftp: { port: 2121, user: 'equipe', anonymous: true } });
  // A sessão existente não foi trocada pela do backup.
  expect(await readFile(target.ctx.sessionsFile, 'utf8')).toContain('10.0.0.77');

  // Importar de novo: nada novo.
  page.once('dialog', (d) => void d.accept());
  await clickMenu(target.ctx.app, 'import-backup');
  await expect(page.locator('#messages')).toContainText('0 sessão(ões) nova(s) (2 já existiam), 0 site(s) de VPN novo(s) (1 já existiam)');
});

test('arquivo que não é backup é recusado sem mudar nada', async () => {
  const target = await machine('destino', SESSIONS);
  const bad = join(root, 'outro.multterm');
  await writeFile(bad, JSON.stringify({ format: 'outra-coisa' }));
  await target.ctx.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, bad);
  target.ctx.page.once('dialog', (d) => void d.accept());
  await clickMenu(target.ctx.app, 'import-backup');
  await expect(target.ctx.page.locator('#messages .error')).toContainText('não é um backup do MultTerm');
  await expect(target.ctx.page.locator('#status-count')).toHaveText('2 sessões · sem limite');
});

test('exporta todos os sites de VPN numa pasta', async () => {
  const origin = await machine('origem', SESSIONS, SITE);
  const dest = join(root, 'saida');
  await mkdir(dest);
  await origin.ctx.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, dest);
  await clickMenu(origin.ctx.app, 'export-vpn');
  await expect(origin.ctx.page.locator('#messages')).toContainText(`1 site(s) de VPN exportado(s) para ${dest}`);
  expect(await readdir(dest)).toEqual(['Matriz.vpn']);
  expect(await readFile(join(dest, 'Matriz.vpn'), 'utf8')).toBe(SITE);
});

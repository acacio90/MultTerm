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
  await expect(panel.locator('.server-row')).toHaveCount(8);
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
  await expect(panel.locator('.server-row')).toHaveCount(8);
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

test('agendador: valida as tarefas, roda sem porta e inicia junto com o app', async () => {
  let panel = await openServers();
  await panel.locator('.server-row[data-kind=cron] .server-name').click();
  const detail = () => panel.locator('.server-detail');
  await detail().locator('[name=jobs]').fill('60 * * * * echo x');
  await panel.locator('.server-row[data-kind=cron] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.tool-status')).toContainText('linha 1: fora do intervalo');
  await detail().locator('[name=jobs]').fill('# backup\n*/5 * * * * echo ok');
  await detail().locator('[name=startWithApp]').check();
  await panel.locator('.server-row[data-kind=cron] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.server-row[data-kind=cron] .server-state')).toHaveText('rodando');
  await expect(detail().locator('.server-log')).toContainText('agendador iniciado com 1 tarefa(s)');
  await expect(detail().locator('.server-log')).toContainText('próxima:');

  // Reabrir o app: o agendador sobe sozinho com a configuração guardada.
  const env = { MULTTERM_SERVERS_FILE: join(root, 'servers.json') };
  await ctx!.close();
  ctx = await launchApp('version: 1\nsessions: []\n', env);
  await ctx.page.click('#btn-tools');
  await ctx.page.click('#tools-menu [data-tool="servers"]');
  panel = ctx.page.locator('.panel:not([hidden])').last();
  await expect(panel.locator('.server-row[data-kind=cron] .server-state')).toHaveText('rodando');
});

test('todos os servidores abrem as configurações (inclusive os com caixa de seleção)', async () => {
  const panel = await openServers();
  for (const [kind, title] of [['tftp', 'TFTP'], ['ftp', 'FTP'], ['http', 'HTTP'], ['ssh', 'SSH/SFTP'], ['telnet', 'Telnet'], ['cron', 'Agendador (cron)'], ['iperf', 'Iperf']]) {
    await panel.locator(`.server-row[data-kind=${kind}] .server-name`).click();
    await expect(panel.locator('.server-detail h3')).toHaveText(`Servidor ${title}`);
  }
  await panel.locator('.server-row[data-kind=telnet] .server-name').click();
  await expect(panel.locator('.server-detail [name=shell]')).toHaveValue('powershell');
  await expect(panel.locator('.server-detail')).toContainText('não é cifrado');
});

test('escutar só em 127.0.0.1 (ou numa placa específica); aviso de firewall fora do localhost', async () => {
  const port = await freePort();
  const panel = await openServers();
  await panel.locator('.server-row[data-kind=http] .server-name').click();
  const detail = panel.locator('.server-detail');
  const host = detail.locator('select[name=host]');
  await expect(host.locator('option').first()).toHaveText('Todas as interfaces');
  await expect(host.locator('option').nth(1)).toHaveText('Só esta máquina (127.0.0.1)');
  await host.selectOption('127.0.0.1');
  await detail.locator('[name=root]').fill(root);
  await detail.locator('[name=port]').fill(String(port));
  await panel.locator('.server-row[data-kind=http] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.server-row[data-kind=http] .server-state')).toContainText(`rodando na porta ${port}`);
  await expect(detail.locator('.server-log')).toContainText(`escutando em 127.0.0.1, porta ${port}`);
  await expect(detail.locator('.server-log')).not.toContainText('Firewall');
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  const saved = JSON.parse(await readFile(join(root, 'servers.json'), 'utf8'));
  expect(saved.http.host).toBe('127.0.0.1');
  await panel.locator('.server-row[data-kind=http] button', { hasText: 'Parar' }).click();

  // Todas as interfaces: avisa do firewall.
  await host.selectOption('');
  await panel.locator('.server-row[data-kind=http] button', { hasText: 'Iniciar' }).click();
  await expect(detail.locator('.server-log')).toContainText(`escutando em todas as interfaces, porta ${port}`);
  await expect(detail.locator('.server-log')).toContainText('Firewall do Windows');
  await panel.locator('.server-row[data-kind=http] button', { hasText: 'Parar' }).click();
});

test('NFS: inicia pelo painel (somente leitura), sem portmapper, e para', async () => {
  const port = await freePort();
  const panel = await openServers();
  await panel.locator('.server-row[data-kind=nfs] .server-name').click();
  const detail = panel.locator('.server-detail');
  await expect(detail.locator('h3')).toHaveText('Servidor NFS (experimental)');
  await detail.locator('[name=root]').fill(root);
  await detail.locator('[name=port]').fill(String(port));
  await detail.locator('select[name=host]').selectOption('127.0.0.1');
  await detail.locator('[name=portmap]').uncheck();
  await detail.locator('[name=allow]').fill('127.0.0.1, 10.0.0.0/8');
  await panel.locator('.server-row[data-kind=nfs] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.server-row[data-kind=nfs] .server-state')).toContainText(`rodando na porta ${port}`);
  await expect(detail.locator('.server-log')).toContainText(`NFS somente leitura de ${root} na porta ${port} (sem portmapper)`);
  await expect(detail.locator('.server-log')).toContainText('clientes permitidos: 127.0.0.1, 10.0.0.0/8');
  await panel.locator('.server-row[data-kind=nfs] button', { hasText: 'Parar' }).click();
  await expect(panel.locator('.server-row[data-kind=nfs] .server-state')).toHaveText('parado');

  // Lista inválida de clientes: erro claro, nada inicia.
  await detail.locator('[name=allow]').fill('meu-pc');
  await panel.locator('.server-row[data-kind=nfs] button', { hasText: 'Iniciar' }).click();
  await expect(panel.locator('.tool-status, .server-error, .status').filter({ hasText: 'cliente permitido inválido' }).first()).toBeVisible();
});

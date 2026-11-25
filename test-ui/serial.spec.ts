import { expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, WIN, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;

test.afterEach(async () => {
  await ctx?.close();
});

const session = (name: string) => ctx.page.locator('#tree li.session', { hasText: name });
const rows = () => ctx.page.locator('.term-panel:not([hidden]) .xterm-rows');

test('formulário: o tipo Serial troca host e porta pela linha e pela configuração serial', async () => {
  ctx = await launchApp('version: 1\nsessions: []\n');
  const { page } = ctx;
  await page.click('#btn-new');
  await expect(page.locator('#form [name=baudRate]')).toBeHidden();
  await page.selectOption('#form [name=type]', 'serial');
  await expect(page.locator('#host-label')).toHaveText('Linha serial');
  await expect(page.locator('#form [name=port]')).toBeHidden();
  await expect(page.locator('#form [name=user]')).toBeHidden();
  await expect(page.locator('#form [name=vpn]')).toBeHidden();
  await expect(page.locator('#form [name=baudRate]')).toBeVisible();
  await expect(page.locator('#serial-ports')).not.toBeEmpty();

  await page.fill('#form [name=name]', 'sw-core');
  await page.fill('#form [name=folder]', 'Rede');
  await page.fill('#form [name=host]', WIN ? 'com4' : '/dev/ttyUSB0');
  await page.fill('#form [name=baudRate]', '115200');
  await page.selectOption('#form [name=parity]', 'even');
  await page.selectOption('#form [name=flowControl]', 'rtscts');
  await page.click('#form button[type=submit]');
  await expect(page.locator('#messages')).toHaveText('Sessão salva.');

  const yaml = await readFile(ctx.sessionsFile, 'utf8');
  expect(yaml).toContain(`type: serial\n    host: ${WIN ? 'COM4' : '/dev/ttyUSB0'}\n    baudRate: 115200\n    parity: even\n    flowControl: rtscts\n`);
  expect(yaml).not.toContain('dataBits');
  await expect(session('sw-core')).toHaveAttribute('title', `${WIN ? 'COM4' : '/dev/ttyUSB0'} 115200 8E1 RTS/CTS`);

  // Ferramentas de rede e janela externa não aparecem para a sessão serial.
  await session('sw-core').click({ button: 'right' });
  const menu = page.locator('#tree-menu');
  await expect(menu.locator('[data-action=connect]')).toBeVisible();
  await expect(menu.locator('[data-action=ping]')).toHaveCount(0);
  await expect(menu.locator('[data-action=external]')).toHaveCount(0);
});

test('porta inexistente: a aba explica o erro', async () => {
  const line = WIN ? 'COM199' : '/dev/ttyMULTTERM9';
  ctx = await launchApp(`version: 1\nsessions:\n  - {name: console, type: serial, host: ${line}}\n`);
  await session('console').dblclick();
  await expect(rows()).toContainText(`a porta ${line} não existe`, { timeout: 10_000 });
});

// Linux com socat: um par de pseudo-terminais faz o papel do cabo e do equipamento.
const hasSocat = !WIN && spawnSync('which', ['socat']).status === 0;

test('socat: a aba conversa com o "equipamento" do outro lado da linha', async () => {
  test.skip(!hasSocat, 'precisa do socat (Linux)');
  ctx = await launchApp('version: 1\nsessions: []\n');
  const a = join(ctx.dir, 'ttyA');
  const b = join(ctx.dir, 'ttyB');
  const socat: ChildProcess = spawn('socat', [`pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`], { stdio: 'ignore' });
  try {
    await expect.poll(async () => readlink(a).then(() => true, () => false)).toBe(true);
    await expect.poll(async () => readlink(b).then(() => true, () => false)).toBe(true);
    const [lineA, lineB] = [await readlink(a), await readlink(b)];
    await ctx.page.click('#btn-new');
    await ctx.page.selectOption('#form [name=type]', 'serial');
    await ctx.page.fill('#form [name=name]', 'roteador');
    await ctx.page.fill('#form [name=host]', lineA);
    await ctx.page.click('#form button[type=submit]');
    await expect(ctx.page.locator('#messages')).toHaveText('Sessão salva.');

    // O "equipamento": responde ao que chega com um prompt.
    const device = spawn('sh', ['-c', `stty -F ${lineB} raw -echo 9600; head -c 4 < ${lineB} > ${join(ctx.dir, 'recebido')}; printf 'Router> configuração\\r\\n' > ${lineB}`]);
    const answered = new Promise((r) => device.on('exit', r));
    await session('roteador').dblclick();
    await ctx.page.waitForTimeout(500);
    await ctx.page.keyboard.type('show');
    await answered;
    await expect(rows()).toContainText('Router> configuração');
    expect(await readFile(join(ctx.dir, 'recebido'), 'utf8')).toBe('show');

    // Pseudo-terminal não tem sinal de break: a aba mostra o motivo, sem fechar.
    await ctx.page.locator('#tabs .tab', { hasText: 'roteador' }).click({ button: 'right' });
    await ctx.page.locator('.tab-menu button', { hasText: 'Enviar Break' }).click();
    await expect(rows()).toContainText('não aceitou o break');
    await expect(ctx.page.locator('#tabs .tab', { hasText: 'roteador' })).not.toHaveClass(/ended/);

    // O cabo some: a aba avisa e fica encerrada.
    socat.kill();
    await expect(rows()).toContainText('porta serial fechada', { timeout: 10_000 });
  } finally {
    socat.kill();
  }
});

import { expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;
let page: Page;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test.beforeEach(async () => {
  // O "agente" dos testes só mostra o arquivo de configuração que recebeu no lugar de {mcp}.
  ctx = await launchApp('version: 1\nsessions:\n  - {name: local, host: 127.0.0.1}\n', { MULTTERM_AGENT_COMMAND: 'Get-Content {mcp}' });
  page = ctx.page;
});

test.afterEach(async () => {
  await ctx.close();
});

async function connection() {
  return JSON.parse(await readFile(join(ctx.dir, 'userdata', 'agent-connection.json'), 'utf8')) as { port: number; token: string };
}

async function mcp(method: string, params: Record<string, unknown> = {}) {
  const c = await connection();
  const res = await fetch(`http://127.0.0.1:${c.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp('tools/call', { name, arguments: args });
  return { text: r.result.content[0].text as string, error: !!r.result.isError };
};

test('agente MCP: compartilha uma aba, lê, respeita o modo, pede aprovação e controla', async () => {
  // Ping contínuo numa aba de terminal.
  await page.locator('#tree li.session', { hasText: 'local' }).click();
  await page.click('#btn-tools');
  await page.click('#tools-menu [data-tool="ping"]');
  await page.click('#diag-dialog button[type=submit]');
  const pingTab = page.locator('#tabs .tab', { hasText: 'ping 127.0.0.1' });
  await expect(page.locator('.term-panel:not([hidden]) .xterm-rows')).toContainText('127.0.0.1', { timeout: 20_000 });

  // Painel do agente: porta livre, liga, compartilha a aba só para leitura.
  await page.click('#btn-agent');
  const panel = page.locator('.panel:not([hidden])').last();
  await panel.locator('[name=port]').fill(String(await freePort()));
  await panel.locator('button', { hasText: 'Trocar porta' }).click();
  await panel.locator('button', { hasText: 'Ligar o agente' }).click();
  await expect(panel.locator('.agent-state')).toContainText('ligado em http://127.0.0.1:');
  await expect(page.locator('#agent-badge')).toBeVisible();
  await expect(panel.locator('.agent-config').first()).toContainText('ELECTRON_RUN_AS_NODE');

  // Nada compartilhado ainda.
  expect((await tool('list_terminals')).text).toMatch(/Nenhum terminal compartilhado/);
  const share = panel.locator('select[name^=share-]');
  await share.selectOption('read');
  await expect(pingTab).toHaveClass(/agent-shared/);
  const list = JSON.parse((await tool('list_terminals')).text);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ title: 'ping 127.0.0.1', permission: 'read', running: true });
  const id = list[0].id;
  expect((await tool('read_terminal', { id, lines: 5 })).text).toMatch(/127\.0\.0\.1/);
  const denied = await tool('send_keys', { id, keys: ['ctrl+c'] });
  expect(denied).toEqual({ text: expect.stringMatching(/só para leitura/), error: true });

  // Aprovar cada envio: a janela de aprovação é simulada (recusa e depois permite).
  await share.selectOption('approve');
  await ctx.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[]; answers: number[] };
    g.asked = [];
    g.answers = [2, 0]; // Recusar, depois Permitir
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message: string; detail: string };
      g.asked.push(`${opts.message} | ${opts.detail}`);
      return { response: g.answers.shift() ?? 2, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  expect(await tool('send_keys', { id, keys: ['ctrl+c'] })).toEqual({ text: 'o usuário recusou este envio', error: true });
  expect((await tool('send_keys', { id, keys: ['ctrl+c'] })).text).toBe('enviado');
  const asked = await ctx.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked);
  expect(asked[0]).toMatch(/O agente quer apertar na aba "ping 127\.0\.0\.1".*Ctrl\+C/s);
  // Ctrl+C encerra o ping contínuo: a aba termina e o agente vê o fim.
  await expect(pingTab).toHaveClass(/ended/, { timeout: 15_000 });
  await expect.poll(async () => JSON.parse((await tool('list_terminals')).text)[0].running).toBe(false);

  // Registro de atividade e ponte stdio (o próprio Electron em modo Node).
  await expect(panel.locator('.server-log')).toContainText('recusado pelo usuário em "ping 127.0.0.1"');
  await expect(panel.locator('.server-log')).toContainText('enviou para "ping 127.0.0.1": Ctrl+C');
  const stdio = JSON.parse(await panel.locator('.agent-config').first().textContent() ?? '{}').mcpServers.multterm;
  const electronExe = createRequire(import.meta.url)('electron') as string;
  expect(stdio.command.toLowerCase()).toBe(electronExe.toLowerCase());
  const out = await new Promise<string>((resolve) => {
    const p = spawn(stdio.command, stdio.args, { env: { ...process.env, ...stdio.env } });
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.on('close', () => resolve(text));
    p.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_terminals', arguments: {} } })}\n`);
  });
  expect(JSON.parse(out).result.content[0].text).toContain('ping 127.0.0.1');

  // Parar de compartilhar tudo e desligar.
  await panel.locator('button', { hasText: 'Parar de compartilhar tudo' }).click();
  await expect(pingTab).not.toHaveClass(/agent-shared/);
  const port = (await connection()).port;
  await panel.locator('button', { hasText: 'Desligar o agente' }).click();
  await expect(panel.locator('.agent-state')).toHaveText('desligado');
  await expect(fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })).rejects.toThrow();
});

test('agente: sem abas abertas explica o que fazer e lembra que estava ligado', async () => {
  await page.click('#btn-agent');
  const panel = page.locator('.panel:not([hidden])').last();
  await expect(panel).toContainText('Nenhuma aba de terminal aberta');
  await expect(panel).toContainText('nada é compartilhado por padrão');
  await panel.locator('[name=port]').fill(String(await freePort()));
  await panel.locator('button', { hasText: 'Trocar porta' }).click();
  await panel.locator('button', { hasText: 'Ligar o agente' }).click();
  await expect(page.locator('#agent-badge')).toBeVisible();
  const prefs = JSON.parse(await readFile(join(ctx.dir, 'userdata', 'agent.json'), 'utf8'));
  expect(prefs.enabled).toBe(true);
  expect(JSON.stringify(prefs)).not.toContain((await connection()).token); // token só cifrado
});

test('terminal local e abrir o agente numa aba com a configuração MCP', async () => {
  // PowerShell local.
  await page.click('#btn-tools');
  await page.click('#tools-menu [data-tool="local-powershell"]');
  const ps = page.locator('#tabs .tab', { hasText: 'PowerShell' });
  await expect(ps).toHaveClass(/active/);
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(rows).toContainText('PS ', { timeout: 20_000 });
  await page.locator('.term-panel:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type('Write-Output (6*7)\r');
  await expect(rows).toContainText(/\(6\*7\)\s*42/, { timeout: 20_000 });

  // Agente escolhido na lista (o comando de teste vem de MULTTERM_AGENT_COMMAND).
  await page.click('#btn-agent');
  const panel = page.locator('.panel:not([hidden])').last();
  await panel.locator('[name=port]').fill(String(await freePort()));
  await panel.locator('button', { hasText: 'Trocar porta' }).click();
  // Com a versão, se o agente estiver instalado nesta máquina.
  await expect(panel.locator('select[name=agent] option')).toHaveText([/^Claude Code/]);
  await panel.locator('select[name=agent]').selectOption('claude');
  await panel.locator('button', { hasText: 'Abrir o agente' }).click();
  const agentTab = page.locator('#tabs .tab', { hasText: /^Agente/ }).filter({ hasNot: page.locator('.nada') }).last();
  await expect(agentTab).toHaveClass(/active/);
  await expect(rows).toContainText('"mcpServers"', { timeout: 20_000 });
  await expect(rows).toContainText('stdio-main.js');
  await expect(page.locator('#agent-badge')).toBeVisible(); // ligou o servidor sozinho
  const cfg = JSON.parse(await readFile(join(ctx.dir, 'userdata', 'agent-mcp.json'), 'utf8'));
  expect(cfg.mcpServers.multterm.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  const prefs = JSON.parse(await readFile(join(ctx.dir, 'userdata', 'agent.json'), 'utf8'));
  expect(prefs.agent).toBe('claude');
});

test('agente MCP: define o modo de todas as abas de uma vez', async () => {
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-tools');
    await page.click('#tools-menu [data-tool="local-powershell"]');
  }
  const tabs = page.locator('#tabs .tab', { hasText: 'PowerShell' });
  await expect(tabs).toHaveCount(2);

  await page.click('#btn-agent');
  const panel = page.locator('.panel:not([hidden])').last();
  await panel.locator('[name=port]').fill(String(await freePort()));
  await panel.locator('button', { hasText: 'Trocar porta' }).click();
  await panel.locator('button', { hasText: 'Ligar o agente' }).click();

  await panel.locator('select[name=shareAll]').selectOption('read');
  await expect(tabs.nth(0)).toHaveClass(/agent-shared/);
  await expect(tabs.nth(1)).toHaveClass(/agent-shared/);
  for (const sel of await panel.locator('select[name^=share-]').all()) await expect(sel).toHaveValue('read');
  expect(JSON.parse((await tool('list_terminals')).text)).toHaveLength(2);

  // Controle livre pede confirmação; recusar não muda nada.
  page.once('dialog', (d) => void d.dismiss());
  await panel.locator('select[name=shareAll]').selectOption('auto');
  await expect(panel.locator('select[name=shareAll]')).toHaveValue('');
  for (const sel of await panel.locator('select[name^=share-]').all()) await expect(sel).toHaveValue('read');
  page.once('dialog', (d) => void d.accept());
  await panel.locator('select[name=shareAll]').selectOption('auto');
  for (const sel of await panel.locator('select[name^=share-]').all()) await expect(sel).toHaveValue('auto');

  await panel.locator('select[name=shareAll]').selectOption('off');
  await expect(tabs.nth(0)).not.toHaveClass(/agent-shared/);
  await expect(tabs.nth(1)).not.toHaveClass(/agent-shared/);
});

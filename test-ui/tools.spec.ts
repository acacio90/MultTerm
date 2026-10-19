import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:net';
import { startAgent, V3_USER } from '../test/snmp-agent.ts';
import { launchApp, type LaunchedApp } from './fixture.ts';

const SESSIONS = `version: 1
sessions:
  - name: local
    folder: Teste
    type: ssh
    host: 127.0.0.1
`;

let ctx: LaunchedApp;
let page: Page;
let server: Server;
let openPort: number;

test.beforeEach(async () => {
  // Porta aberta de verdade nesta máquina, para os scanners e a lista de portas locais.
  server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  openPort = (server.address() as { port: number }).port;
  ctx = await launchApp(SESSIONS);
  page = ctx.page;
  await expect(page.locator('#status-count')).toHaveText('1 sessões · sem limite');
});

test.afterEach(async () => {
  await ctx?.close();
  await new Promise((r) => server.close(r));
});

async function openTool(name: string) {
  await page.click('#btn-tools');
  await page.click(`#tools-menu [data-tool="${name}"]`);
  // Só segue com o painel da ferramenta aberto e visível (os localizadores abaixo dependem dele).
  // Ping e traceroute abrem numa aba de terminal.
  if (!['ping', 'traceroute'].includes(name)) await expect(page.locator('.tool-panel:not([hidden])')).toHaveCount(1);
}

const activePanel = () => page.locator('.tool-panel:not([hidden])');

test('menu Ferramentas abre e fecha', async () => {
  await page.click('#btn-tools');
  await expect(page.locator('#tools-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tools-menu')).toBeHidden();
});

test('ping roda numa aba de terminal e pode ser executado de novo com R', async () => {
  await page.locator('#tree li.session', { hasText: 'local' }).click();
  await openTool('ping');
  await expect(page.locator('#diag-dialog [name=host]')).toHaveValue('127.0.0.1'); // vem da sessão selecionada
  await page.fill('#diag-dialog [name=count]', '2');
  await page.click('#diag-dialog button[type=submit]');

  const tab = page.locator('#tabs .tab', { hasText: 'ping 127.0.0.1' });
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(tab).toHaveClass(/active/);
  await expect(rows).toContainText('127.0.0.1', { timeout: 20_000 });
  await expect(rows).toContainText('Pressione R para executar de novo', { timeout: 20_000 });
  await expect(tab).toHaveClass(/ended/);
});

test('ping recusa host que viraria opção do comando', async () => {
  await openTool('ping');
  await page.fill('#diag-dialog [name=host]', '-t');
  await page.click('#diag-dialog button[type=submit]');
  await expect(page.locator('.term-panel:not([hidden]) .xterm-rows')).toContainText('host inválido');
});

test('scanner de portas encontra a porta aberta e a fechada', async () => {
  await openTool('portscan');
  const panel = activePanel();
  await panel.locator('[name=host]').fill('127.0.0.1');
  await panel.locator('[name=ports]').fill(`${openPort},1`);
  // Máquina carregada (suíte inteira): até o localhost pode passar do timeout padrão.
  await panel.locator('[name=timeout]').fill('8000');
  await panel.locator('label.check input').uncheck(); // mostrar todas
  // Os valores precisam estar no formulário antes de enviar (sem isso, vale a predefinição "comuns").
  await expect(panel.locator('[name=ports]')).toHaveValue(`${openPort},1`);
  await expect(panel.locator('[name=host]')).toHaveValue('127.0.0.1');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('Concluído: 1 aberta(s), 1 fechada(s)');
  await expect(panel.locator('table.results tbody tr')).toHaveText([/^1.*fechada$/, new RegExp(`^${openPort}.*aberta$`)]);
});

test('scanner de rede acha o host e cria sessão a partir do resultado', async () => {
  await openTool('netscan');
  const panel = activePanel();
  await panel.locator('[name=range]').fill('127.0.0.1');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('Concluído: 1 host(s) ativo(s)');
  await panel.locator('table.results tbody tr').first().locator('button', { hasText: '+ sessão' }).first().click();
  await expect(page.locator('#panel-editor')).toBeVisible();
  await expect(page.locator('#form [name=host]')).toHaveValue('127.0.0.1');
});

test('consulta DNS valida a entrada e mostra erros em português', async () => {
  await openTool('dns');
  const panel = activePanel();
  await panel.locator('[name=name]').fill('-x');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('nome ou IP inválido');
  await panel.locator('[name=name]').fill('example.org');
  await panel.locator('[name=server]').fill('dns.example.org');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toContainText('servidor DNS deve ser um IP');
});

test('portas locais lista a porta em escuta com o processo', async () => {
  await openTool('localports');
  const panel = activePanel();
  await expect(panel.locator('.tool-status')).toContainText('entradas', { timeout: 30_000 });
  await panel.locator('input[type=search]').fill(String(openPort));
  await expect(panel.locator('table.results tbody tr').first()).toContainText(`127.0.0.1:${openPort}`);
  await expect(panel.locator('table.results tbody tr').first()).toContainText('escutando');
});

test('fechar a aba de ferramenta volta para a aba Sessão', async () => {
  await openTool('dns');
  await expect(page.locator('#tabs .tab', { hasText: 'Consulta DNS' })).toHaveClass(/active/);
  await page.locator('#tabs .tab', { hasText: 'Consulta DNS' }).locator('.close').click();
  await expect(page.locator('#panel-editor')).toBeVisible();
});

test.describe('consulta SNMP contra um agente local', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>;
  test.beforeEach(async () => {
    agent = await startAgent();
  });
  test.afterEach(async () => {
    await agent.close();
  });

  async function openSnmp() {
    await openTool('snmp');
    const panel = activePanel();
    await panel.locator('[name=host]').fill('127.0.0.1');
    await panel.locator('[name=port]').fill(String(agent.port));
    await panel.locator('[name=timeout]').fill('1500');
    return panel;
  }

  test('v2c walk lista a subárvore com nomes e valores formatados', async () => {
    const panel = await openSnmp();
    await panel.locator('[name=operation]').selectOption('walk');
    await panel.locator('[name=oids]').fill('system');
    await panel.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toHaveText('Concluído: 5 resultado(s).');
    const rows = panel.locator('table.results tbody tr');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(2)).toContainText('sysUpTime.0');
    await expect(rows.nth(2)).toContainText('3d 03:00:00');
  });

  test('campos mudam com versão e nível; v3 authPriv faz get', async () => {
    const panel = await openSnmp();
    const visible = (name: string) => panel.locator(`[name=${name}]`).isVisible();
    expect(await visible('community')).toBe(true);
    expect(await visible('user')).toBe(false);

    await panel.locator('[name=version]').selectOption('3');
    expect(await visible('community')).toBe(false);
    await panel.locator('[name=level]').selectOption('authNoPriv');
    expect(await visible('authKey')).toBe(true);
    expect(await visible('privKey')).toBe(false);
    await panel.locator('[name=level]').selectOption('authPriv');

    await panel.locator('[name=user]').fill(V3_USER.name);
    await panel.locator('[name=authProtocol]').selectOption('sha');
    await panel.locator('[name=authKey]').fill(V3_USER.authKey);
    await panel.locator('[name=privProtocol]').selectOption('aes');
    await panel.locator('[name=privKey]').fill(V3_USER.privKey);
    await panel.locator('[name=oids]').fill('sysName');
    await panel.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toHaveText('Concluído: 1 resultado(s).');
    await expect(panel.locator('table.results tbody tr').first()).toContainText('agente-teste');

    await panel.locator('[name=authKey]').fill('senha-errada-9');
    await panel.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toContainText('confira host, porta, usuário, senhas e protocolos do SNMPv3');
  });

  test('v1 não oferece getbulk', async () => {
    const panel = await openSnmp();
    await panel.locator('[name=operation]').selectOption('getbulk');
    await panel.locator('[name=version]').selectOption('1');
    await expect(panel.locator('[name=operation]')).toHaveValue('getnext');
    // toBeDisabled() do Playwright não considera <option>; verifica a propriedade.
    await expect(panel.locator('[name=operation] option[value=getbulk]')).toHaveJSProperty('disabled', true);
  });
});

test('scanner de rede busca o nome por SNMP quando não há DNS reverso', async () => {
  // 127.0.0.2 também é loopback e não tem DNS reverso; o agente responde só nele.
  const agent = await startAgent('127.0.0.2');
  try {
    await openTool('netscan');
    const panel = activePanel();
    await expect(panel.locator('[name=snmpPort]')).toBeHidden();
    await panel.locator('[name=range]').fill('127.0.0.2');
    await panel.locator('[name=version]').selectOption('2c');
    await panel.locator('[name=snmpPort]').fill(String(agent.port));
    await panel.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toContainText('Concluído: 1 host(s) ativo(s)');
    const row = panel.locator('table.results tbody tr').first();
    await expect(row).toContainText('agente-teste');
    await expect(row).toContainText('SNMP');
    await row.locator('button', { hasText: '+ sessão' }).first().click();
    await expect(page.locator('#form [name=name]')).toHaveValue('agente-teste');
  } finally {
    await agent.close();
  }
});

test('voltar para a aba Sessão com uma ferramenta aberta usa a altura toda', async () => {
  await openTool('dns');
  await page.click('#tab-editor');
  await expect(page.locator('#terminals')).toBeHidden();
  const editor = await page.locator('#panel-editor').boundingBox();
  const workspace = await page.locator('.workspace').boundingBox();
  const tabs = await page.locator('#tabs').boundingBox();
  expect(editor!.height).toBeGreaterThan(workspace!.height - tabs!.height - 4);
});

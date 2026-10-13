import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp | undefined;
let root: string;

/** Pasta de sites própria do teste. */
async function withSites(sites: Record<string, string>) {
  const dir = join(root, 'sites');
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(sites)) await writeFile(join(dir, name), text);
  return { MULTTERM_VPN_SITES: dir };
}

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'multterm-vpn-'));
});

test.afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
  await rm(root, { recursive: true, force: true });
});

async function openVpn(yaml: string, env: Record<string, string>) {
  ctx = await launchApp(yaml, env);
  await ctx.page.click('#btn-tools');
  await ctx.page.click('#tools-menu [data-tool="vpn"]');
  return ctx.page.locator('.panel:not([hidden])').last();
}

const MATRIZ = 's:network-host:vpn.example.org\ns:auth-method:mutual-psk-xauth\ns:client-saved-username:ana\n';
const FILIAL = 's:network-host:10.9.9.9\nn:network-ike-port:4500\ns:auth-method:mutual-psk\n';

test('menu e painel da VPN, sem cliente externo', async () => {
  const panel = await openVpn('version: 1\nsessions: []\n', await withSites({ Matriz: MATRIZ }));
  await expect(ctx!.page.locator('#tools-menu [data-tool="vpn"]')).toHaveText('VPN');
  await expect(panel.locator('[name=site] option')).toHaveText(['Matriz — vpn.example.org']);
  await expect(panel).toContainText('O MultTerm conecta sozinho');
  await expect(panel).not.toContainText(/Shrew/i);
  await expect(panel.locator('[name=engine]')).toHaveCount(0);
  await expect(ctx!.page.locator('#vpn-indicator')).toBeHidden();
  // Site sem PSK: o motor recusa antes de pedir administrador.
  await panel.locator('[name=password]').fill('x');
  await panel.locator('button[type=submit]').click();
  await expect(panel.locator('.tool-status')).toHaveText('o site não tem chave compartilhada (PSK)');
  await expect(panel.locator('button[type=submit]')).toBeEnabled();
});

test('lista os sites e mostra usuário/senha só para XAuth', async () => {
  const panel = await openVpn('version: 1\nsessions: []\n', await withSites({ Matriz: MATRIZ, Filial: FILIAL }));
  const site = panel.locator('[name=site]');
  await expect(site.locator('option')).toHaveText(['Filial — 10.9.9.9:4500', 'Matriz — vpn.example.org']);
  await expect(panel.locator('[name=user]')).toBeHidden(); // Filial: só chave compartilhada
  await site.selectOption('Matriz');
  await expect(panel.locator('[name=user]')).toHaveValue('ana');
  await expect(panel.locator('[name=password]')).toBeVisible();
  await expect(panel).toContainText('A senha não é gravada');
});

test('sem sites, oferece criar ou importar um .vpn', async () => {
  const panel = await openVpn('version: 1\nsessions: []\n', await withSites({}));
  await expect(panel).toContainText('Nenhum site de VPN configurado');
  await expect(panel.locator('button', { hasText: 'Novo site' })).toBeVisible();
  await expect(panel.locator('button', { hasText: 'Importar site (.vpn)…' })).toBeVisible();
});

test('sessão com VPN: campo no formulário e abertura pede a VPN', async () => {
  const yaml = 'version: 1\nsessions:\n  - {name: srv, host: 10.0.0.5, vpn: Matriz}\n';
  ctx = await launchApp(yaml, await withSites({ Matriz: MATRIZ }));
  const { page } = ctx;
  const session = page.locator('#tree li.session', { hasText: 'srv' });
  await session.click();
  await expect(page.locator('#form [name=vpn]')).toHaveValue('Matriz');
  await expect(page.locator('#vpn-sites option')).toHaveCount(1);
  await session.dblclick();
  const panel = page.locator('.panel:not([hidden])').last();
  await expect(panel).toContainText('A sessão "srv" usa a VPN "Matriz"');
  await expect(panel.locator('[name=site]')).toHaveValue('Matriz');
  await expect(page.locator('#tabs .tab.active')).toHaveText(/VPN/);

  // Trocar o campo grava no YAML.
  await page.locator('#tab-editor').click();
  await session.click();
  await page.locator('#form [name=vpn]').fill('');
  await page.locator('#form button[type=submit]').click();
  await expect.poll(async () => readFile(ctx!.sessionsFile, 'utf8')).not.toContain('vpn:');
});

test.describe('editor de sites', () => {
  test('cria um site sem arquivo .vpn, com PSK e redes', async () => {
    const env = await withSites({});
    const panel = await openVpn('version: 1\nsessions: []\n', env);
    await panel.locator('button', { hasText: 'Novo site' }).click();
    const editor = panel.locator('form.site-editor');
    await expect(editor.locator('h3')).toHaveText('Novo site');
    // Só as autenticações que o motor suporta.
    await expect(editor.locator('[name="auth-method"] option')).toHaveCount(2);
    await editor.locator('[name=site-name]').fill('Matriz');
    await editor.locator('[name="network-host"]').fill('vpn.example.org');
    // Sem PSK num site novo: pede antes de gravar.
    await editor.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toHaveText('Informe a chave compartilhada (PSK).');
    await editor.locator('[name="auth-mutual-psk"]').fill('segredo');
    await editor.locator('[name="client-saved-username"]').fill('ana');
    // Redes manuais aparecem ao desligar a obtenção automática.
    await expect(editor.locator('[name="policy-list-include"]')).toBeHidden();
    await editor.locator('[name="policy-list-auto"]').uncheck();
    await editor.locator('[name="policy-list-include"]').fill('10.0.0.0/8, 192.168.10.0/24');
    await editor.locator('summary').click();
    await editor.locator('[name="phase1-dhgroup"]').selectOption('15');
    await editor.locator('button[type=submit]').click();

    await expect(panel.locator('.tool-status')).toHaveText('Site "Matriz" salvo.');
    await expect(panel.locator('[name=site] option')).toHaveText(['Matriz — vpn.example.org']);
    await expect(panel.locator('[name=user]')).toHaveValue('ana');
    const text = await readFile(join(env.MULTTERM_VPN_SITES, 'Matriz'), 'utf8');
    expect(text).toContain(`b:auth-mutual-psk:${Buffer.from('segredo').toString('base64')}`);
    expect(text).toContain('s:policy-list-include:10.0.0.0 / 255.0.0.0,192.168.10.0 / 255.255.255.0');
    expect(text).toContain('n:phase1-dhgroup:15');
    expect(text).toContain('s:phase1-hash:sha2-256');
  });

  test('edita sem mostrar a PSK, renomeia, exporta e exclui', async () => {
    const original = `${MATRIZ}b:auth-mutual-psk:c2VncmVkbw==\ns:auth-server-cert:ca.pem\n`;
    const env = await withSites({ Matriz: original });
    const panel = await openVpn('version: 1\nsessions: []\n', env);
    await panel.locator('button', { hasText: 'Editar' }).click();
    const editor = panel.locator('form.site-editor');
    await expect(editor.locator('[name="network-host"]')).toHaveValue('vpn.example.org');
    await expect(editor.locator('[name="auth-mutual-psk"]')).toHaveValue('');
    await expect(editor.locator('[name="auth-mutual-psk"]')).toHaveAttribute('placeholder', 'em branco mantém');
    await editor.locator('[name=site-name]').fill('Matriz Nova');
    await editor.locator('[name="network-host"]').fill('nova.example.org');
    await editor.locator('button[type=submit]').click();
    await expect(panel.locator('.tool-status')).toHaveText('Site "Matriz Nova" salvo.');
    const text = await readFile(join(env.MULTTERM_VPN_SITES, 'Matriz Nova'), 'utf8');
    expect(text).toContain('b:auth-mutual-psk:c2VncmVkbw=='); // PSK mantida
    expect(text).toContain('s:auth-server-cert:ca.pem'); // chave fora do editor mantida
    expect(text).toContain('s:network-host:nova.example.org');

    const out = join(root, 'exportado.vpn');
    await ctx!.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
    }, out);
    await panel.locator('button', { hasText: 'Exportar…' }).click();
    await expect(panel.locator('.tool-status')).toHaveText(`Site exportado para ${out}`);
    expect(await readFile(out, 'utf8')).toBe(text);

    ctx!.page.once('dialog', (d) => d.accept());
    await panel.locator('button', { hasText: 'Excluir' }).click();
    await expect(panel.locator('.tool-status')).toHaveText('Site "Matriz Nova" excluído.');
    await expect(panel).toContainText('Nenhum site de VPN configurado');
  });

  test('cancelar o editor volta ao painel sem gravar', async () => {
    const env = await withSites({ Matriz: MATRIZ });
    const panel = await openVpn('version: 1\nsessions: []\n', env);
    await panel.locator('button', { hasText: 'Editar' }).click();
    await panel.locator('form.site-editor [name="network-host"]').fill('outro');
    await panel.locator('button', { hasText: 'Cancelar' }).click();
    await expect(panel.locator('[name=site] option')).toHaveText(['Matriz — vpn.example.org']);
    expect(await readFile(join(env.MULTTERM_VPN_SITES, 'Matriz'), 'utf8')).toBe(MATRIZ);
  });
});

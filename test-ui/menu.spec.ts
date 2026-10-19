import { expect, test } from '@playwright/test';
import { clickMenu, launchApp, type LaunchedApp } from './fixture.ts';

let ctx: LaunchedApp;

test.beforeEach(async () => {
  ctx = await launchApp('version: 1\nsessions:\n  - {name: web-01, folder: Prod, host: 127.0.0.1, port: 1}\n');
});

test.afterEach(async () => {
  await ctx.close();
});

test('menu do topo em português, sem atalhos que roubem teclas do terminal', async () => {
  const menu = await ctx.app.evaluate(({ Menu }) => {
    const walk = (items: Electron.MenuItem[]): { label: string; accel?: string; registered: boolean; sub?: unknown }[] =>
      items.filter((i) => i.type !== 'separator').map((i) => ({
        label: i.label,
        accel: i.accelerator ?? undefined,
        registered: i.registerAccelerator !== false,
        sub: i.submenu ? walk(i.submenu.items) : undefined,
      }));
    return walk(Menu.getApplicationMenu()!.items);
  });
  expect(menu.map((m) => m.label)).toEqual(['&Arquivo', '&Sessão', '&Ferramentas', '&Exibir', 'Aj&uda']);
  // Nada de "Recarregar a página" (derrubaria as sessões) nem atalhos registrados fora zoom/tela cheia.
  const all: { label: string; accel?: string; registered: boolean }[] = [];
  const flat = (items: { label: string; accel?: string; registered: boolean; sub?: unknown }[]) => {
    for (const i of items) {
      all.push(i);
      if (i.sub) flat(i.sub as typeof items);
    }
  };
  flat(menu);
  expect(all.some((i) => /(recarregar a página|reload)$/i.test(i.label))).toBe(false);
  const registered = all.filter((i) => i.accel && i.registered).map((i) => i.accel);
  for (const a of registered) expect(a).toMatch(/^(CommandOrControl\+(Plus|-|0|=)|F11|Control\+(Plus|-|0)|Ctrl\+(Plus|-|0)|.*Shift.*)$/i);

  // Barra enxuta: Nova sessão e Ferramentas; VPN, Agente e Ajuda à direita.
  await expect(ctx.page.locator('.toolbar > button, .toolbar > .menu-wrap > button')).toHaveText(
    ['+ Nova sessão', 'Ferramentas ▾', 'VPN', /^Agente/, /^Ajuda/],
  );
});

test('comandos do menu agem na janela principal', async () => {
  const page = ctx.page;
  await expect(page.locator('#status-count')).toHaveText('1 sessões · sem limite');
  // Sessão → Conectar sem nada selecionado: avisa.
  await clickMenu(ctx.app, 'connect');
  await expect(page.locator('#messages')).toContainText('Selecione uma sessão na árvore primeiro');

  // Com a sessão selecionada: Editar abre o formulário dela.
  await page.locator('#tree li.session', { hasText: 'web-01' }).click();
  await clickMenu(ctx.app, 'new-session');
  await expect(page.locator('#form-title')).toHaveText('Nova sessão');
  await page.locator('#tree li.session', { hasText: 'web-01' }).click();
  await clickMenu(ctx.app, 'edit');
  await expect(page.locator('#form-title')).toHaveText('web-01');

  // Ferramentas: o ping abre o diálogo com o host da sessão; a VPN abre a aba dela.
  await clickMenu(ctx.app, 'ping');
  await expect(page.locator('#diag-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await clickMenu(ctx.app, 'vpn');
  await expect(page.locator('#tabs .tab', { hasText: 'VPN' })).toHaveCount(1);

  // Exibir → barra lateral.
  await clickMenu(ctx.app, 'toggle-sidebar');
  await expect(page.locator('.sidebar')).toBeHidden();
  await clickMenu(ctx.app, 'toggle-sidebar');
  await expect(page.locator('.sidebar')).toBeVisible();

  // Arquivo → Nova pasta abre o diálogo de nome.
  await clickMenu(ctx.app, 'new-folder');
  await expect(page.locator('#name-dialog')).toBeVisible();
});

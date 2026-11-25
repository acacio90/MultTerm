import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WIN = process.platform === 'win32';

/**
 * Terminal local dos testes: PowerShell no Windows; no Linux, o sh (prompt previsível, sem o tema
 * do shell do usuário: o launchApp fixa SHELL=/bin/sh).
 */
export const LOCAL = WIN
  ? {
    tool: 'local-powershell', title: 'PowerShell', prompt: 'PS ',
    calc: 'Write-Output (6*7)\r', calcOut: /\(6\*7\)\s*42/,
    setMark: '$marca = 6*7\r', showMark: 'Write-Output $marca\r', markOut: /Write-Output \$marca\s*42/,
    typedTitle: /PS .*>\s*PowerShell/,
    run: (exe: string, script: string) => `& "${exe}" "${script}"\r`,
  }
  : {
    tool: 'local-shell', title: 'Terminal', prompt: '$ ',
    calc: 'echo $((6*7))\r', calcOut: /\$\(\(6\*7\)\)\s*42/,
    setMark: 'marca=$((6*7))\r', showMark: 'echo "$marca"\r', markOut: /echo "\$marca"\s*42/,
    typedTitle: /\$ Terminal/,
    run: (exe: string, script: string) => `"${exe}" "${script}"\r`,
  };

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  dir: string;
  sessionsFile: string;
  close(): Promise<void>;
}

/**
 * Abre o app real com um arquivo de sessões e uma pasta de dados próprios do teste:
 * nada (pastas recolhidas, config, caches) vaza entre testes nem para o perfil do usuário.
 */
export async function launchApp(sessionsYaml: string, extraEnv: Record<string, string> = {}): Promise<LaunchedApp> {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-ui-'));
  const sessionsFile = join(dir, 'sessions.yaml');
  await writeFile(sessionsFile, sessionsYaml);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({
    // Linux sem chaveiro (Xvfb, CI): o safeStorage cifra com a chave fixa do Chromium.
    args: WIN ? ['.'] : ['.', '--password-store=basic'],
    env: { ...env, ...(WIN ? {} : { SHELL: '/bin/sh' }), MULTTERM_SESSIONS: sessionsFile, MULTTERM_USER_DATA: join(dir, 'userdata'), MULTTERM_UPDATE_URL: '', MULTTERM_TEST_PLAINTEXT_SECRETS: '1', ...extraEnv },
  });
  const page = await app.firstWindow();
  expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(join(dir, 'userdata'));
  return {
    app,
    page,
    dir,
    sessionsFile,
    async close() {
      await closeApp(app);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const CLOSE_MS = 30_000;

/**
 * Fecha o app; se ele não sair em 30 s, avisa no log e mata a árvore de processos, para um
 * travamento no encerramento aparecer como aviso em vez de derrubar o job pelo tempo de
 * encerramento do worker (#117).
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  const closing = app.close();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), CLOSE_MS)));
  const result = await Promise.race([closing.then(() => 'ok' as const), late]);
  clearTimeout(timer);
  if (result === 'ok') return;
  const pid = app.process().pid;
  console.warn(`::warning::o MultTerm não fechou em ${CLOSE_MS / 1000} s (pid ${pid}); matando a árvore de processos`);
  if (pid) {
    if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else app.process().kill('SIGKILL');
  }
  await Promise.race([closing.catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
}

/** Clica num item do menu do topo pelo id (o mesmo caminho do clique do usuário). */
export async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  const found = await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    item?.click();
    return !!item;
  }, id);
  expect(found, `item de menu "${id}"`).toBe(true);
}

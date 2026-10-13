import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    args: ['.'],
    env: { ...env, MULTTERM_SESSIONS: sessionsFile, MULTTERM_USER_DATA: join(dir, 'userdata'), MULTTERM_UPDATE_URL: '', ...extraEnv },
  });
  const page = await app.firstWindow();
  expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(join(dir, 'userdata'));
  return {
    app,
    page,
    dir,
    sessionsFile,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

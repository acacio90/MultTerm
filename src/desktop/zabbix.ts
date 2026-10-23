import { app, ipcMain, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planZabbixSync, zabbixToSessions } from '../sessions/import-zabbix.ts';
import { normalizeFolder, sessionKey, type Session } from '../sessions/model.ts';
import { apiUrl, ZabbixClient, ZabbixError, type ZabbixAuth } from '../zabbix/client.ts';

/*
 * Arquivo → Importar → Hosts do Zabbix: conecta na API, lista os grupos e sincroniza as sessões
 * com os hosts dos grupos escolhidos. Endereço, grupos e pasta ficam lembrados em zabbix.json; o
 * token e a senha ficam cifrados pelo Windows (safeStorage) e nunca voltam para a interface.
 */

type AuthType = 'token' | 'password';

interface Config {
  url?: string;
  authType?: AuthType;
  user?: string;
  tokenSealed?: string;
  passwordSealed?: string;
  insecure?: boolean;
  rootFolder?: string;
  groupIds?: string[];
}

const DEFAULT_ROOT = 'Zabbix';
const configFile = () => join(app.getPath('userData'), 'zabbix.json');

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configFile(), 'utf8')) as Config;
  } catch {
    return {};
  }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(configFile(), JSON.stringify(config, null, 2));
}

const seal = (text: string) => {
  if (!safeStorage.isEncryptionAvailable()) throw new ZabbixError('o Windows não liberou a cifra para guardar a credencial');
  return safeStorage.encryptString(text).toString('base64');
};
const unseal = (b64: string | undefined) => {
  if (!b64) return '';
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return '';
  }
};

function authOf(config: Config): ZabbixAuth {
  if (config.authType === 'password') {
    const password = unseal(config.passwordSealed);
    if (!config.user || !password) throw new ZabbixError('informe usuário e senha do Zabbix');
    return { user: config.user, password };
  }
  const token = unseal(config.tokenSealed);
  if (!token) throw new ZabbixError('informe o API token do Zabbix');
  return { token };
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Acesso ao arquivo de sessões; "save" devolve o novo estado para a interface. */
export interface SessionsAccess {
  load(): Promise<Session[]>;
  save(sessions: Session[]): Promise<Record<string, unknown>>;
}

export function registerZabbixIpc(sessions: SessionsAccess): void {
  ipcMain.handle('zabbix:config', async () => {
    const c = await loadConfig();
    return {
      url: c.url ?? '',
      authType: c.authType ?? 'token',
      user: c.user ?? '',
      insecure: c.insecure === true,
      rootFolder: c.rootFolder ?? DEFAULT_ROOT,
      groupIds: c.groupIds ?? [],
      hasToken: !!c.tokenSealed,
      hasPassword: !!c.passwordSealed,
    };
  });

  // Conecta (token/senha em branco = o guardado), lembra a conexão e devolve os grupos.
  ipcMain.handle('zabbix:connect', async (_e, raw: Record<string, unknown>) => {
    const config = await loadConfig();
    const url = apiUrl(text(raw?.url)).href;
    const authType: AuthType = raw?.authType === 'password' ? 'password' : 'token';
    const next: Config = { ...config, url, authType, insecure: raw?.insecure === true };
    if (authType === 'password') {
      next.user = text(raw?.user);
      if (typeof raw?.password === 'string' && raw.password) next.passwordSealed = seal(raw.password);
    } else if (text(raw?.token)) {
      next.tokenSealed = seal(text(raw?.token));
    }
    const client = await ZabbixClient.connect({ url, auth: authOf(next), insecure: next.insecure });
    try {
      const groups = await client.groups();
      await saveConfig(next);
      return { version: client.version, groups };
    } finally {
      await client.close();
    }
  });

  /*
   * Sincroniza com os grupos e a pasta informados (ou os guardados, no "Sincronizar com o Zabbix"
   * do menu). Sem "apply" só devolve a prévia; com "apply" grava e lembra a escolha.
   */
  ipcMain.handle('zabbix:sync', async (_e, raw: Record<string, unknown>) => {
    const config = await loadConfig();
    if (!config.url) throw new ZabbixError('configure a conexão em Arquivo → Importar → Hosts do Zabbix');
    const groupIds = Array.isArray(raw?.groupIds)
      ? raw.groupIds.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id))
      : config.groupIds ?? [];
    if (!groupIds.length) throw new ZabbixError('escolha ao menos um grupo');
    const rootFolder = typeof raw?.rootFolder === 'string' ? normalizeFolder(raw.rootFolder) : config.rootFolder ?? DEFAULT_ROOT;
    const client = await ZabbixClient.connect({ url: config.url, auth: authOf(config), insecure: config.insecure });
    let hosts;
    try {
      hosts = await client.hosts(groupIds);
    } finally {
      await client.close();
    }
    const { sessions: incoming, warnings } = zabbixToSessions(hosts, groupIds, rootFolder);
    const plan = planZabbixSync(await sessions.load(), incoming);
    const summary = {
      hosts: hosts.length,
      added: plan.added.length,
      updated: plan.updated.length,
      removed: plan.removed.map(sessionKey),
      warnings: [
        ...warnings,
        ...plan.conflicts.map((s) => `${sessionKey(s)}: já existe uma sessão com esse nome criada à mão; mantida`),
      ],
    };
    if (raw?.apply !== true) return summary;
    await saveConfig({ ...config, groupIds, rootFolder });
    return { ...(await sessions.save(plan.sessions)), ...summary };
  });
}

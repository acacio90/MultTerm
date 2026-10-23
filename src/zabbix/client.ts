import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ZabbixGroup, ZabbixHost } from '../sessions/import-zabbix.ts';

/*
 * Cliente da API JSON-RPC do Zabbix (6.0 em diante). A versão do servidor decide os parâmetros:
 * - 6.4+: credencial no cabeçalho "Authorization: Bearer"; antes, no campo "auth" do pedido.
 * - 6.2+: hostgroup.get com "with_hosts" e host.get com "selectHostGroups"; antes, "real_hosts" e "selectGroups".
 */

export type ZabbixAuth = { token: string } | { user: string; password: string };

export interface ZabbixConnection {
  url: string;
  auth: ZabbixAuth;
  /** Aceita certificado autoassinado ou de outra autoridade (HTTPS). */
  insecure?: boolean;
  timeoutMs?: number;
}

export interface ZabbixGroupInfo extends ZabbixGroup {
  hosts: number;
}

export class ZabbixError extends Error {
  override name = 'ZabbixError';
}

const MAX_RESPONSE = 64 * 1024 * 1024;

/** Aceita "https://zabbix", ".../zabbix/" ou o endereço completo do api_jsonrpc.php. */
export function apiUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new ZabbixError(`endereço inválido: ${text}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ZabbixError('o endereço deve começar com http:// ou https://');
  if (!url.pathname.endsWith('/api_jsonrpc.php')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/api_jsonrpc.php`;
  url.search = '';
  url.hash = '';
  return url;
}

/** "7.0.5" → [7, 0]. */
export function parseVersion(version: string): [number, number] {
  const [major, minor] = version.split('.').map(Number);
  return [major || 0, minor || 0];
}

function atLeast(version: string, major: number, minor: number): boolean {
  const [a, b] = parseVersion(version);
  return a > major || (a === major && b >= minor);
}

function post(conn: ZabbixConnection, body: unknown, bearer?: string): Promise<unknown> {
  const url = apiUrl(conn.url);
  const data = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = { 'Content-Type': 'application/json-rpc', 'Content-Length': data.length };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, timeout: conn.timeoutMs ?? 30_000, rejectUnauthorized: !conn.insecure }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) req.destroy(new ZabbixError('resposta grande demais'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new ZabbixError(`o servidor respondeu HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new ZabbixError('a resposta não é da API do Zabbix (confira o endereço)'));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ZabbixError('o servidor não respondeu a tempo')));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof ZabbixError) return reject(err);
      const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(err.code ?? '');
      reject(new ZabbixError(tls ? `certificado não confiável (${err.code}); marque "aceitar certificado" se o servidor for seu` : err.message));
    });
    req.end(data);
  });
}

let nextId = 1;

async function call<T>(conn: ZabbixConnection, method: string, params: unknown, credential?: { value: string; bearer: boolean }): Promise<T> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method, params, id: nextId++ };
  if (credential && !credential.bearer) body.auth = credential.value;
  const res = await post(conn, body, credential?.bearer ? credential.value : undefined) as { result?: T; error?: { message?: string; data?: string } };
  if (res?.error) throw new ZabbixError([res.error.message, res.error.data].filter(Boolean).join(' '));
  if (!res || !('result' in res)) throw new ZabbixError('a resposta não é da API do Zabbix (confira o endereço)');
  return res.result as T;
}

export class ZabbixClient {
  readonly version: string;
  private readonly conn: ZabbixConnection;
  private readonly credential: { value: string; bearer: boolean };
  private readonly loggedIn: boolean;

  private constructor(conn: ZabbixConnection, version: string, credential: { value: string; bearer: boolean }, loggedIn: boolean) {
    this.conn = conn;
    this.version = version;
    this.credential = credential;
    this.loggedIn = loggedIn;
  }

  /** Descobre a versão e autentica (token ou usuário/senha). */
  static async connect(conn: ZabbixConnection): Promise<ZabbixClient> {
    const version = await call<string>(conn, 'apiinfo.version', []);
    if (!atLeast(version, 6, 0)) throw new ZabbixError(`Zabbix ${version} não é suportado (precisa ser 6.0 ou mais novo)`);
    const bearer = atLeast(version, 6, 4);
    if ('token' in conn.auth) {
      const client = new ZabbixClient(conn, version, { value: conn.auth.token, bearer }, false);
      await client.groups(); // confere o token já na conexão
      return client;
    }
    const session = await call<string>(conn, 'user.login', { username: conn.auth.user, password: conn.auth.password });
    return new ZabbixClient(conn, version, { value: session, bearer }, true);
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    return call<T>(this.conn, method, params, this.credential);
  }

  /** Grupos com hosts, em ordem alfabética, com a quantidade de hosts de cada um. */
  async groups(): Promise<ZabbixGroupInfo[]> {
    const filter = atLeast(this.version, 6, 2) ? 'with_hosts' : 'real_hosts';
    const groups = await this.call<(ZabbixGroup & { hosts?: string })[]>('hostgroup.get', {
      output: ['groupid', 'name'],
      selectHosts: 'count',
      [filter]: true,
      sortfield: 'name',
    });
    return groups.map((g) => ({ groupid: g.groupid, name: g.name, hosts: Number(g.hosts ?? 0) }));
  }

  /** Hosts dos grupos, com interfaces, inventário, tags, grupos e templates. */
  hosts(groupIds: string[]): Promise<ZabbixHost[]> {
    if (!groupIds.length) return Promise.resolve([]);
    const selectGroups = atLeast(this.version, 6, 2) ? 'selectHostGroups' : 'selectGroups';
    return this.call<ZabbixHost[]>('host.get', {
      output: ['hostid', 'host', 'name'],
      groupids: groupIds,
      selectInterfaces: ['type', 'main', 'useip', 'ip', 'dns'],
      selectInventory: ['os', 'macaddress_a'],
      selectTags: ['tag', 'value'],
      [selectGroups]: ['groupid', 'name'],
      selectParentTemplates: ['name'],
    });
  }

  /** Encerra a sessão aberta por usuário/senha (token não precisa). */
  async close(): Promise<void> {
    if (!this.loggedIn) return;
    await this.call('user.logout', []).catch(() => undefined);
  }
}

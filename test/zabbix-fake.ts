import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ZabbixHost } from '../src/sessions/import-zabbix.ts';

/*
 * Servidor JSON-RPC que imita a API do Zabbix nas versões 6.0 e 6.4+: credencial no campo
 * "auth" (até 6.2) ou no cabeçalho Bearer (6.4+), real_hosts/with_hosts e selectGroups/selectHostGroups.
 */

export interface FakeZabbixOptions {
  version: string;
  token?: string;
  user?: string;
  password?: string;
  groups: { groupid: string; name: string }[];
  /** Hosts com "groups" (o servidor devolve no campo certo para a versão). */
  hosts: (Omit<ZabbixHost, 'hostgroups' | 'groups'> & { groups: { groupid: string; name: string }[] })[];
}

export interface FakeCall {
  method: string;
  params: Record<string, unknown>;
  credential?: string;
}

export interface FakeZabbix {
  url: string;
  calls: FakeCall[];
  close(): Promise<void>;
}

const SESSION = 'sessao-de-teste';

function atLeast(version: string, minor: number): boolean {
  const [a, b] = version.split('.').map(Number);
  return a > 6 || (a === 6 && b >= minor);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startFakeZabbix(opts: FakeZabbixOptions): Promise<FakeZabbix> {
  const calls: FakeCall[] = [];
  const bearerAuth = atLeast(opts.version, 4);
  const newGroups = atLeast(opts.version, 2);

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/zabbix/api_jsonrpc.php') {
      res.writeHead(404).end('not found');
      return;
    }
    const rpc = await body(req);
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const header = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const credential = bearerAuth ? header : (rpc.auth as string | undefined);
    calls.push({ method: String(rpc.method), params, credential });

    const reply = (result: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', result, id: rpc.id }));
    const fail = (message: string, data: string) => res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message, data }, id: rpc.id }));

    if (rpc.method === 'apiinfo.version') return reply(opts.version);
    if (rpc.method === 'user.login') {
      return params.username === opts.user && params.password === opts.password
        ? reply(SESSION)
        : fail('Invalid params.', 'Incorrect user name or password or account is temporarily blocked.');
    }
    if (!credential || (credential !== opts.token && credential !== SESSION)) return fail('Invalid params.', 'Not authorised.');
    if (rpc.method === 'user.logout') return reply(true);
    if (rpc.method === 'hostgroup.get') {
      return reply(opts.groups.map((g) => ({
        ...g,
        hosts: String(opts.hosts.filter((h) => h.groups.some((hg) => hg.groupid === g.groupid)).length),
      })));
    }
    if (rpc.method === 'host.get') {
      const ids = new Set(params.groupids as string[]);
      const key = newGroups ? 'hostgroups' : 'groups';
      return reply(opts.hosts
        .filter((h) => h.groups.some((g) => ids.has(g.groupid)))
        .map(({ groups, ...h }) => ({ ...h, [key]: groups })));
    }
    return fail('Method not found.', `Incorrect API "${String(rpc.method)}".`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/zabbix`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { McpServer } from './mcp.ts';

/*
 * Transporte MCP "Streamable HTTP" (POST com JSON-RPC, resposta em JSON) só em 127.0.0.1.
 * Exige o token (Authorization: Bearer) e recusa pedidos de navegador (cabeçalho Origin) e
 * nomes de host estranhos (proteção contra DNS rebinding).
 */

export interface AgentHttp {
  port: number;
  close(): Promise<void>;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function body(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error('corpo grande demais'), { status: 413 });
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

export async function startAgentHttp(mcp: McpServer, opts: { port: number; token: string; onRequest?: (ok: boolean, why?: string) => void }): Promise<AgentHttp> {
  let actualPort = opts.port;
  const server: Server = createServer((req, res) => {
    const deny = (status: number, msg: string) => {
      opts.onRequest?.(false, msg);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: msg } }));
    };
    const host = String(req.headers.host ?? '');
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${actualPort}$`).test(host)) return deny(403, 'host não permitido');
    if (req.headers.origin) return deny(403, 'pedidos de navegador não são aceitos');
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !same(auth.slice(7), opts.token)) return deny(401, 'token inválido');
    if ((req.url ?? '').split('?')[0] !== '/mcp') return deny(404, 'use o endereço /mcp');
    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== 'POST') return deny(405, 'método não permitido');
    void (async () => {
      let msg: unknown;
      try {
        msg = JSON.parse(await body(req));
      } catch (err) {
        const e = err as { status?: number };
        res.writeHead(e.status ?? 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }));
        return;
      }
      opts.onRequest?.(true);
      const out = await mcp.handle(msg);
      if (out === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  actualPort = (server.address() as { port: number }).port;
  return {
    port: actualPort,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

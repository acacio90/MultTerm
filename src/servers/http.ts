import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { checkHost, checkPort, checkRoot, resolveInRoot, type LogFn, type RunningServer } from './common.ts';

/*
 * Servidor HTTP de arquivos: serve uma pasta (só leitura), com index.html, listagem opcional,
 * HEAD e Range (retomar download). Nunca sai da pasta raiz.
 */

export interface HttpConfig {
  root: string;
  port?: number;
  listing?: boolean;
  host?: string;
}

export function validateHttp(raw: Record<string, unknown>): HttpConfig {
  return { root: checkRoot(raw.root), port: checkPort(raw.port, 8080), host: checkHost(raw.host), listing: raw.listing !== false };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.iso': 'application/x-iso9660-image', '.cfg': 'text/plain; charset=utf-8', '.conf': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function size(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** Faixa pedida em "Range: bytes=a-b" (uma só); undefined = arquivo inteiro, null = inválida. */
export function parseRange(header: string | undefined, total: number): { start: number; end: number } | undefined | null {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  return start <= end && start < total ? { start, end } : null;
}

export async function startHttp(cfg: HttpConfig, log: LogFn): Promise<RunningServer> {
  const send = (res: ServerResponse, code: number, text: string) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const client = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'método não permitido');
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return send(res, 400, 'endereço inválido');
    }
    const path = await resolveInRoot(cfg.root, urlPath);
    if (!path) {
      log(`${client} ${req.method} ${urlPath} → 404`);
      return send(res, 404, 'não encontrado');
    }
    let st = await stat(path);
    let file = path;
    if (st.isDirectory()) {
      if (!urlPath.endsWith('/')) {
        res.writeHead(301, { Location: `${encodeURI(urlPath)}/` });
        return res.end();
      }
      const index = join(path, 'index.html');
      const ist = await stat(index).catch(() => undefined);
      if (ist?.isFile()) {
        file = index;
        st = ist;
      } else if (cfg.listing) {
        const entries = await readdir(path, { withFileTypes: true });
        const rows = await Promise.all(entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map(async (e) => {
            const s = e.isDirectory() ? undefined : await stat(join(path, e.name)).catch(() => undefined);
            const name = e.isDirectory() ? `${e.name}/` : e.name;
            return `<tr><td><a href="${esc(encodeURIComponent(e.name))}${e.isDirectory() ? '/' : ''}">${esc(name)}</a></td><td>${s ? size(s.size) : ''}</td></tr>`;
          }));
        const html = `<!doctype html><meta charset="utf-8"><title>${esc(urlPath)}</title><h1>${esc(urlPath)}</h1><table>${urlPath !== '/' ? '<tr><td><a href="../">../</a></td><td></td></tr>' : ''}${rows.join('')}</table>`;
        log(`${client} ${req.method} ${urlPath} → listagem`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(req.method === 'HEAD' ? undefined : html);
      } else {
        log(`${client} ${req.method} ${urlPath} → 403 (listagem desativada)`);
        return send(res, 403, 'listagem desativada');
      }
    }
    if (!st.isFile()) return send(res, 404, 'não encontrado');
    const range = parseRange(req.headers.range, st.size);
    if (range === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Last-Modified': st.mtime.toUTCString(),
    };
    const { start, end } = range ?? { start: 0, end: st.size - 1 };
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(range ? 206 : 200, headers);
    log(`${client} ${req.method} ${urlPath} → ${range ? 206 : 200} (${headers['Content-Length']} bytes)`);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      log(`erro: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'erro interno');
      else res.destroy();
    });
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 8080, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  log(`HTTP escutando na porta ${port}, raiz ${cfg.root}`);
  return {
    port,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      log('HTTP parado');
    },
  };
}

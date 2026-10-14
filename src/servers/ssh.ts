import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import pty from 'node-pty';
import ssh2 from 'ssh2';
import { checkHost, checkPort, checkRoot, resolveInRoot, type LogFn, type RunningServer } from './common.ts';

/*
 * Servidor SSH/SFTP: login com usuário e senha do painel, shell do Windows pelo ConPTY, execução
 * de comandos (ssh host comando) e SFTP restrito à pasta raiz. Chave de host ed25519 gerada na
 * primeira vez e reutilizada (a impressão digital vai para o log).
 */

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;
const OPEN = utils.sftp.OPEN_MODE;

export interface SshConfig {
  root: string;
  port?: number;
  host?: string;
  user: string;
  password: string;
  shell?: 'powershell' | 'cmd';
  /** Chave de host (OpenSSH, privada). */
  hostKey: string;
}

export function validateSsh(raw: Record<string, unknown>): Omit<SshConfig, 'hostKey'> {
  const user = String(raw.user ?? '').trim();
  const password = String(raw.password ?? '');
  // eslint-disable-next-line no-control-regex
  if (!user || /[\s\x00-\x1f]/.test(user)) throw new Error('informe o usuário');
  if (password.length < 6) throw new Error('defina uma senha (mínimo 6 caracteres)');
  return { root: checkRoot(raw.root), port: checkPort(raw.port, 22), host: checkHost(raw.host), user, password, shell: raw.shell === 'cmd' ? 'cmd' : 'powershell' };
}

/** Lê a chave de host em `path` ou gera uma ed25519 nova. */
export async function ensureHostKey(path: string): Promise<{ key: string; fingerprint: string; created: boolean }> {
  let key = await readFile(path, 'utf8').catch(() => '');
  let created = false;
  if (!key) {
    key = utils.generateKeyPairSync('ed25519').private;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, key, { mode: 0o600 });
    created = true;
  }
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw new Error(`chave de host inválida: ${parsed.message}`);
  const pub = (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH();
  return { key, fingerprint: `SHA256:${createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')}`, created };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Atributos de arquivo no formato do SFTP. */
function attrs(st: { mode: number; size: number; atime: Date; mtime: Date }) {
  return { mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atime.getTime() / 1000), mtime: Math.floor(st.mtime.getTime() / 1000) };
}

function longname(name: string, st: { isDirectory(): boolean; size: number; mtime: Date }) {
  const d = st.mtime;
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${st.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--'} 1 user user ${String(st.size).padStart(10)} ${m} ${String(d.getDate()).padStart(2)} ${d.getFullYear()} ${name}`;
}

export async function startSsh(cfg: SshConfig, log: LogFn): Promise<RunningServer> {
  const clients = new Set<{ end(): void }>();
  const realRoot = await realpath(cfg.root);
  const toVirtual = (p: string) => `/${relative(realRoot, p).split(sep).join('/')}`.replace(/\/$/, '') || '/';

  const server = new Server({ hostKeys: [cfg.hostKey], banner: undefined }, (client, info) => {
    const addr = String(info.ip ?? '').replace(/^::ffff:/, '');
    clients.add(client);
    let who = '';
    client.on('error', () => {});
    client.on('close', () => {
      clients.delete(client);
      if (who) log(`${addr}: ${who} desconectou`);
    });
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && same(ctx.username, cfg.user) && same(ctx.password, cfg.password)) {
        who = ctx.username;
        log(`${addr}: login de ${who}`);
        ctx.accept();
        return;
      }
      if (ctx.method === 'password') log(`${addr}: senha errada para "${ctx.username}"`);
      ctx.reject(['password']);
    });

    client.on('session', (acceptSession) => {
      const session = acceptSession();
      let size = { cols: 80, rows: 24 };
      let term: pty.IPty | undefined;
      session.on('pty', (accept, _r, info2) => {
        size = { cols: info2.cols || 80, rows: info2.rows || 24 };
        accept?.();
      });
      session.on('window-change', (accept, _r, info2) => {
        size = { cols: info2.cols, rows: info2.rows };
        term?.resize(size.cols, size.rows);
        accept?.();
      });
      session.on('env', (accept) => accept?.());
      session.on('shell', (accept) => {
        const stream = accept();
        const file = cfg.shell === 'cmd' ? 'cmd.exe' : 'powershell.exe';
        term = pty.spawn(file, cfg.shell === 'cmd' ? [] : ['-NoLogo'], {
          name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: homedir(), env: process.env as Record<string, string>,
        });
        log(`${addr}: shell aberto`);
        term.onData((d) => stream.write(d));
        term.onExit(({ exitCode }) => {
          stream.exit(exitCode ?? 0);
          stream.end();
        });
        stream.on('data', (d: Buffer) => term?.write(d.toString('utf8')));
        stream.on('close', () => {
          try {
            term?.kill();
          } catch { /* já saiu */ }
        });
      });
      session.on('exec', (accept, _r, info2) => {
        const stream = accept();
        log(`${addr}: comando "${info2.command.slice(0, 80)}"`);
        const child = spawn(cfg.shell === 'cmd' ? 'cmd.exe' : 'powershell.exe',
          cfg.shell === 'cmd' ? ['/d', '/s', '/c', info2.command] : ['-NoLogo', '-NoProfile', '-Command', info2.command],
          { cwd: homedir(), windowsHide: true });
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream.stderr, { end: false });
        stream.pipe(child.stdin);
        child.on('close', (code) => {
          stream.exit(code ?? 0);
          stream.end();
        });
        child.on('error', (err) => {
          stream.stderr.write(`${err.message}\n`);
          stream.exit(127);
          stream.end();
        });
      });
      session.on('sftp', (accept) => {
        log(`${addr}: SFTP aberto`);
        sftpSession(accept(), addr);
      });
    });
  });

  function sftpSession(sftp: import('ssh2').SFTPWrapper, addr: string) {
    const handles = new Map<number, { fh?: FileHandle; dir?: string; listed?: boolean; path: string; write: boolean; bytes: number }>();
    let next = 1;
    const newHandle = (h: typeof handles extends Map<number, infer V> ? V : never) => {
      const id = next++;
      handles.set(id, h);
      const b = Buffer.alloc(4);
      b.writeUInt32BE(id, 0);
      return b;
    };
    const getHandle = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
    const resolve = (p: string, mustExist = true) => resolveInRoot(cfg.root, p, mustExist);
    const fail = (id: number, err: unknown) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      sftp.status(id, code === 'ENOENT' ? STATUS.NO_SUCH_FILE : code === 'EACCES' || code === 'EPERM' ? STATUS.PERMISSION_DENIED : STATUS.FAILURE);
    };
    const wrap = (id: number, fn: () => Promise<void>) => { fn().catch((err) => fail(id, err)); };

    sftp.on('REALPATH', (id, path) => wrap(id, async () => {
      const p = await resolve(path);
      const v = p ? toVirtual(p) : path.startsWith('/') ? path : `/${path}`;
      sftp.name(id, [{ filename: v === '' ? '/' : v, longname: v, attrs: {} as never }]);
    }));
    const statFn = (id: number, path: string) => wrap(id, async () => {
      const p = await resolve(path);
      if (!p) return sftp.status(id, STATUS.NO_SUCH_FILE);
      sftp.attrs(id, attrs(await stat(p)));
    });
    sftp.on('STAT', statFn);
    sftp.on('LSTAT', statFn);
    sftp.on('FSTAT', (id, handle) => wrap(id, async () => {
      const h = getHandle(handle);
      if (!h) return sftp.status(id, STATUS.FAILURE);
      sftp.attrs(id, attrs(await stat(h.path)));
    }));
    sftp.on('OPENDIR', (id, path) => wrap(id, async () => {
      const p = await resolve(path);
      if (!p || !(await stat(p)).isDirectory()) return sftp.status(id, STATUS.NO_SUCH_FILE);
      sftp.handle(id, newHandle({ dir: p, path: p, write: false, bytes: 0 }));
    }));
    sftp.on('READDIR', (id, handle) => wrap(id, async () => {
      const h = getHandle(handle);
      if (!h?.dir) return sftp.status(id, STATUS.FAILURE);
      if (h.listed) return sftp.status(id, STATUS.EOF);
      h.listed = true;
      const names = await readdir(h.dir);
      const list = [];
      for (const n of names) {
        const st = await stat(join(h.dir, n)).catch(() => undefined);
        if (st) list.push({ filename: n, longname: longname(n, st), attrs: attrs(st) });
      }
      sftp.name(id, list);
    }));
    sftp.on('OPEN', (id, path, flags) => wrap(id, async () => {
      const write = (flags & (OPEN.WRITE | OPEN.APPEND | OPEN.CREAT | OPEN.TRUNC)) !== 0;
      const p = await resolve(path, !write);
      if (!p) return sftp.status(id, write ? STATUS.PERMISSION_DENIED : STATUS.NO_SUCH_FILE);
      let mode = write ? fsc.O_WRONLY : fsc.O_RDONLY;
      if (flags & OPEN.READ && write) mode = fsc.O_RDWR;
      if (flags & OPEN.CREAT) mode |= fsc.O_CREAT;
      if (flags & OPEN.TRUNC) mode |= fsc.O_TRUNC;
      if (flags & OPEN.EXCL) mode |= fsc.O_EXCL;
      if (flags & OPEN.APPEND) mode |= fsc.O_APPEND;
      const fh = await open(p, mode);
      sftp.handle(id, newHandle({ fh, path: p, write, bytes: 0 }));
    }));
    sftp.on('READ', (id, handle, offset, length) => wrap(id, async () => {
      const h = getHandle(handle);
      if (!h?.fh) return sftp.status(id, STATUS.FAILURE);
      const buf = Buffer.alloc(Math.min(length, 256 * 1024));
      const { bytesRead } = await h.fh.read(buf, 0, buf.length, offset);
      if (!bytesRead) return sftp.status(id, STATUS.EOF);
      h.bytes += bytesRead;
      sftp.data(id, buf.subarray(0, bytesRead));
    }));
    sftp.on('WRITE', (id, handle, offset, data) => wrap(id, async () => {
      const h = getHandle(handle);
      if (!h?.fh) return sftp.status(id, STATUS.FAILURE);
      await h.fh.write(data, 0, data.length, offset);
      h.bytes += data.length;
      sftp.status(id, STATUS.OK);
    }));
    sftp.on('CLOSE', (id, handle) => wrap(id, async () => {
      const h = getHandle(handle);
      if (!h) return sftp.status(id, STATUS.FAILURE);
      handles.delete(handle.readUInt32BE(0));
      if (h.fh) {
        await h.fh.close();
        if (h.bytes) log(`${addr}: SFTP ${h.write ? 'enviou' : 'baixou'} ${toVirtual(h.path)} (${h.bytes} bytes)`);
      }
      sftp.status(id, STATUS.OK);
    }));
    sftp.on('SETSTAT', (id) => sftp.status(id, STATUS.OK));
    sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS.OK));
    sftp.on('REMOVE', (id, path) => wrap(id, async () => {
      const p = await resolve(path);
      if (!p) return sftp.status(id, STATUS.NO_SUCH_FILE);
      await rm(p);
      log(`${addr}: SFTP apagou ${toVirtual(p)}`);
      sftp.status(id, STATUS.OK);
    }));
    sftp.on('RMDIR', (id, path) => wrap(id, async () => {
      const p = await resolve(path);
      if (!p || p === realRoot) return sftp.status(id, STATUS.NO_SUCH_FILE);
      await rmdir(p);
      sftp.status(id, STATUS.OK);
    }));
    sftp.on('MKDIR', (id, path) => wrap(id, async () => {
      const p = await resolve(path, false);
      if (!p) return sftp.status(id, STATUS.PERMISSION_DENIED);
      await mkdir(p);
      sftp.status(id, STATUS.OK);
    }));
    sftp.on('RENAME', (id, from, to) => wrap(id, async () => {
      const a = await resolve(from);
      const b = await resolve(to, false);
      if (!a || !b) return sftp.status(id, STATUS.NO_SUCH_FILE);
      await rename(a, b);
      sftp.status(id, STATUS.OK);
    }));
    // O cliente encerra mandando EOF: fecha o canal (senão o sftp fica esperando).
    sftp.on('end', () => sftp.end());
    sftp.on('close', () => {
      for (const h of handles.values()) void h.fh?.close();
      handles.clear();
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 22, cfg.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  log(`SSH/SFTP escutando na porta ${port}, usuário ${cfg.user}, SFTP na raiz ${cfg.root}`);
  return {
    port,
    stop: async () => {
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
      log('SSH/SFTP parado');
    },
  };
}

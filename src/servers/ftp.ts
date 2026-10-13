import { timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { relative, sep } from 'node:path';
import { createSecureContext, createServer as createTlsServer, TLSSocket, type SecureContextOptions } from 'node:tls';
import { checkPort, checkRoot, resolveInRoot, type LogFn, type RunningServer } from './common.ts';

/*
 * Servidor FTP (RFC 959 + 2389 FEAT, 3659 SIZE/MDTM/MLSD/REST, 2428 EPSV/EPRT) para trocar arquivos
 * com equipamentos. Usuário e senha (ou anônimo só leitura), modo passivo e ativo, UTF-8 e FTPS
 * implícito opcional. Nunca sai da pasta raiz.
 */

export interface FtpConfig {
  root: string;
  port?: number;
  user: string;
  password: string;
  anonymous?: boolean;
  /** FTPS implícito (TLS desde a conexão), com certificado/chave em PEM. */
  tls?: SecureContextOptions;
  host?: string;
  /** Endereço anunciado no PASV (padrão: o da conexão de controle). */
  publicAddress?: string;
  passivePorts?: [number, number];
  /** Pergunta antes de aceitar cada conexão (true = aceitar). */
  confirm?: (client: string) => Promise<boolean>;
}

export function validateFtp(raw: Record<string, unknown>): Omit<FtpConfig, 'tls' | 'confirm'> {
  const user = String(raw.user ?? '').trim();
  const password = String(raw.password ?? '');
  const anonymous = raw.anonymous === true;
  if (!anonymous && (!user || !password)) throw new Error('informe usuário e senha (ou permita o acesso anônimo)');
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f]/.test(user)) throw new Error('usuário inválido');
  return { root: checkRoot(raw.root), port: checkPort(raw.port, 21), user, password, anonymous };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function listLine(name: string, st: { isDirectory(): boolean; size: number; mtime: Date }): string {
  const d = st.mtime;
  const recent = Date.now() - d.getTime() < 180 * 86400_000;
  const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ` ${d.getFullYear()}`}`;
  return `${st.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ftp ftp ${String(st.size).padStart(12)} ${when} ${name}`;
}
const mlsxTime = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
function mlsxFacts(name: string, st: { isDirectory(): boolean; size: number; mtime: Date }) {
  return `type=${st.isDirectory() ? 'dir' : 'file'};size=${st.size};modify=${mlsxTime(st.mtime)}; ${name}`;
}

export async function startFtp(cfg: FtpConfig, log: LogFn): Promise<RunningServer> {
  const sockets = new Set<Socket>();
  const passiveServers = new Set<Server>();

  const onConnection = (ctrl: Socket) => {
    sockets.add(ctrl);
    ctrl.on('close', () => sockets.delete(ctrl));
    void session(ctrl).catch((err: Error) => {
      log(`erro: ${err.message}`);
      ctrl.destroy();
    });
  };
  const server = cfg.tls ? createTlsServer(cfg.tls, onConnection) : createServer(onConnection);

  async function session(ctrl: Socket) {
    const client = String(ctrl.remoteAddress ?? '').replace(/^::ffff:/, '');
    const reply = (code: number, text: string) => {
      if (!ctrl.destroyed) ctrl.write(`${code} ${text}\r\n`);
    };
    if (cfg.confirm && !(await cfg.confirm(client))) {
      log(`${client}: conexão recusada`);
      reply(421, 'Conexão recusada.');
      ctrl.end();
      return;
    }
    log(`${client}: conectou`);
    let user = '';
    let authed = false;
    let readOnly = false;
    let cwd = '/';
    let restOffset = 0;
    let renameFrom: string | undefined;
    let pasv: Server | undefined;
    let pasvSocket: Promise<Socket> | undefined;
    let active: { host: string; port: number } | undefined;
    reply(220, 'Servidor FTP do MultTerm');

    const abs = (p: string) => {
      const joined = p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`;
      const parts: string[] = [];
      for (const seg of joined.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      return `/${parts.join('/')}`;
    };
    const real = (p: string, mustExist = true) => resolveInRoot(cfg.root, abs(p), mustExist);
    const virtual = async (path: string) => {
      const rel = relative(await realpath(cfg.root), path);
      return `/${rel.split(sep).join('/')}`.replace(/\/$/, '') || '/';
    };

    const closePassive = () => {
      if (pasv) {
        passiveServers.delete(pasv);
        pasv.close();
      }
      pasv = undefined;
      pasvSocket = undefined;
    };

    const openPassive = async (): Promise<number> => {
      closePassive();
      const srv = cfg.tls ? createTlsServer(cfg.tls) : createServer();
      const tryListen = (port: number) => new Promise<boolean>((resolve) => {
        srv.once('error', () => resolve(false));
        srv.listen(port, cfg.host, () => resolve(true));
      });
      let ok = false;
      if (cfg.passivePorts) {
        for (let p = cfg.passivePorts[0]; p <= cfg.passivePorts[1] && !ok; p++) ok = await tryListen(p);
      } else ok = await tryListen(0);
      if (!ok) throw new Error('sem porta passiva livre');
      pasv = srv;
      passiveServers.add(srv);
      pasvSocket = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('o cliente não abriu a conexão de dados')), 20_000);
        srv.once(cfg.tls ? 'secureConnection' : 'connection', (s: Socket) => {
          clearTimeout(t);
          if (String(s.remoteAddress).replace(/^::ffff:/, '') !== client) {
            s.destroy(); // conexão de dados de outro endereço: recusa (proteção contra roubo de dados)
            reject(new Error('conexão de dados de outro endereço'));
            return;
          }
          resolve(s);
        });
      });
      return (srv.address() as { port: number }).port;
    };

    const dataSocket = async (): Promise<Socket> => {
      if (pasvSocket) {
        const s = await pasvSocket;
        closePassive();
        return s;
      }
      if (active) {
        const { host, port } = active;
        active = undefined;
        return new Promise((resolve, reject) => {
          const raw = connect(port, host);
          raw.once('error', reject);
          raw.once('connect', () => {
            if (!cfg.tls) return resolve(raw);
            // FTPS no modo ativo: o servidor abre a conexão, mas continua sendo o lado servidor do TLS.
            const s = new TLSSocket(raw, { isServer: true, secureContext: createSecureContext(cfg.tls) });
            s.once('secure', () => resolve(s));
            s.once('error', reject);
          });
        });
      }
      throw new Error('use PASV ou PORT antes');
    };

    const withData = async (fn: (s: Socket) => Promise<void>) => {
      let s: Socket;
      try {
        reply(150, 'Abrindo conexão de dados.');
        s = await dataSocket();
      } catch (err) {
        reply(425, `Sem conexão de dados: ${(err as Error).message}`);
        return;
      }
      try {
        await fn(s);
        reply(226, 'Transferência concluída.');
      } catch (err) {
        s.destroy();
        reply(451, `Falha: ${(err as Error).message}`);
      }
    };

    const listing = async (arg: string, kind: 'LIST' | 'NLST' | 'MLSD') => {
      const target = await real(arg.replace(/^-\w+\s*/, '') || '.');
      if (!target) return reply(550, 'Pasta não encontrada.');
      const st = await stat(target);
      const entries = st.isDirectory()
        ? await Promise.all((await readdir(target)).map(async (n) => ({ n, st: await stat(`${target}${sep}${n}`).catch(() => undefined) })))
        : [{ n: target.split(sep).pop()!, st }];
      const lines = entries.filter((e) => e.st).map((e) => (kind === 'NLST' ? e.n : kind === 'MLSD' ? mlsxFacts(e.n, e.st!) : listLine(e.n, e.st!)));
      await withData((s) => new Promise((resolve, reject) => {
        s.on('error', reject);
        s.end(lines.length ? `${lines.join('\r\n')}\r\n` : '', () => resolve());
      }));
    };

    const needWrite = () => {
      if (readOnly) {
        reply(550, 'Acesso anônimo é só leitura.');
        return false;
      }
      return true;
    };

    let buffer = '';
    ctrl.setEncoding('utf8');
    ctrl.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        queue = queue.then(() => command(line)).catch((err: Error) => reply(451, `Erro: ${err.message}`));
      }
      if (buffer.length > 8192) ctrl.destroy();
    });
    let queue = Promise.resolve();
    ctrl.on('close', () => {
      closePassive();
      log(`${client}: desconectou`);
    });

    async function command(line: string) {
      const sp = line.indexOf(' ');
      const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp < 0 ? '' : line.slice(sp + 1);
      if (!authed && !['USER', 'PASS', 'QUIT', 'FEAT', 'SYST', 'OPTS', 'NOOP', 'AUTH', 'PBSZ', 'PROT'].includes(cmd)) {
        return reply(530, 'Faça login primeiro.');
      }
      switch (cmd) {
        case 'USER':
          user = arg;
          authed = false;
          return reply(331, 'Informe a senha.');
        case 'PASS': {
          const anon = cfg.anonymous && (user === 'anonymous' || user === 'ftp');
          if (anon || (!!cfg.user && same(user, cfg.user) && same(arg, cfg.password))) {
            authed = true;
            readOnly = !!anon;
            log(`${client}: login ${anon ? 'anônimo (só leitura)' : `de ${user}`}`);
            return reply(230, 'Login feito.');
          }
          log(`${client}: senha errada para "${user}"`);
          await new Promise((r) => setTimeout(r, 1000)); // atrasa tentativas
          return reply(530, 'Usuário ou senha incorretos.');
        }
        case 'SYST': return reply(215, 'UNIX Type: L8');
        case 'FEAT':
          ctrl.write('211-Recursos:\r\n UTF8\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n MLSD\r\n MLST type*;size*;modify*;\r\n EPSV\r\n EPRT\r\n PASV\r\n211 Fim\r\n');
          return;
        case 'OPTS': return reply(/^utf8 on$/i.test(arg) ? 200 : 501, /^utf8 on$/i.test(arg) ? 'UTF-8 ligado.' : 'Opção desconhecida.');
        case 'PBSZ': return reply(200, 'PBSZ=0');
        case 'PROT': return reply(arg.toUpperCase() === 'P' && cfg.tls ? 200 : 536, 'Proteção ajustada.');
        case 'NOOP': return reply(200, 'OK');
        case 'TYPE': return reply(200, 'Tipo ajustado.');
        case 'MODE': return reply(arg.toUpperCase() === 'S' ? 200 : 504, 'Modo.');
        case 'STRU': return reply(arg.toUpperCase() === 'F' ? 200 : 504, 'Estrutura.');
        case 'PWD':
        case 'XPWD': return reply(257, `"${cwd.replace(/"/g, '""')}" é a pasta atual.`);
        case 'CWD':
        case 'XCWD':
        case 'CDUP': {
          const target = cmd === 'CDUP' ? '..' : arg;
          const p = await real(target);
          if (!p || !(await stat(p)).isDirectory()) return reply(550, 'Pasta não encontrada.');
          cwd = await virtual(p);
          return reply(250, `Pasta atual: ${cwd}`);
        }
        case 'PASV': {
          const port = await openPassive();
          const ip = (cfg.publicAddress ?? String(ctrl.localAddress).replace(/^::ffff:/, '')).replace(/^::1$/, '127.0.0.1');
          return reply(227, `Entrando em modo passivo (${ip.split('.').join(',')},${port >> 8},${port & 255}).`);
        }
        case 'EPSV': return reply(229, `Entrando em modo passivo estendido (|||${await openPassive()}|).`);
        case 'PORT': {
          const n = arg.split(',').map(Number);
          if (n.length !== 6 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return reply(501, 'PORT inválido.');
          const host = n.slice(0, 4).join('.');
          if (host !== client) return reply(504, 'Só aceito conexões de dados para o seu próprio endereço.');
          closePassive();
          active = { host, port: n[4] * 256 + n[5] };
          return reply(200, 'PORT ok.');
        }
        case 'EPRT': {
          const m = /^(.)(\d)\1([^|]+)\1(\d+)\1$/.exec(arg);
          if (!m || m[3].replace(/^::ffff:/, '') !== client) return reply(504, 'EPRT inválido.');
          closePassive();
          active = { host: m[3], port: Number(m[4]) };
          return reply(200, 'EPRT ok.');
        }
        case 'LIST': return listing(arg, 'LIST');
        case 'NLST': return listing(arg, 'NLST');
        case 'MLSD': return listing(arg, 'MLSD');
        case 'MLST': {
          const p = await real(arg || '.');
          if (!p) return reply(550, 'Não encontrado.');
          ctrl.write(`250-Fatos\r\n ${mlsxFacts(arg || cwd, await stat(p))}\r\n250 Fim\r\n`);
          return;
        }
        case 'SIZE': {
          const p = await real(arg);
          const st = p && (await stat(p));
          return st && st.isFile() ? reply(213, String(st.size)) : reply(550, 'Arquivo não encontrado.');
        }
        case 'MDTM': {
          const p = await real(arg);
          return p ? reply(213, mlsxTime((await stat(p)).mtime)) : reply(550, 'Arquivo não encontrado.');
        }
        case 'REST': {
          const n = Number(arg);
          if (!Number.isInteger(n) || n < 0) return reply(501, 'Posição inválida.');
          restOffset = n;
          return reply(350, `Recomeça em ${n}.`);
        }
        case 'RETR': {
          const p = await real(arg);
          if (!p || !(await stat(p)).isFile()) return reply(550, 'Arquivo não encontrado.');
          const start = restOffset;
          restOffset = 0;
          const t0 = Date.now();
          let bytes = 0;
          await withData((s) => new Promise((resolve, reject) => {
            const rs = createReadStream(p, { start });
            rs.on('data', (c) => { bytes += c.length; });
            rs.on('error', reject);
            s.on('error', reject);
            rs.pipe(s);
            s.on('finish', () => resolve());
          }));
          log(`${client}: baixou ${abs(arg)} (${bytes} bytes, ${Date.now() - t0} ms)`);
          return;
        }
        case 'STOR':
        case 'APPE': {
          if (!needWrite()) return;
          const p = await real(arg, false);
          if (!p) return reply(553, 'Nome de arquivo não permitido.');
          const start = cmd === 'APPE' ? -1 : restOffset;
          restOffset = 0;
          const t0 = Date.now();
          let bytes = 0;
          await withData((s) => new Promise((resolve, reject) => {
            const ws = createWriteStream(p, start === -1 ? { flags: 'a' } : start > 0 ? { flags: 'r+', start } : {});
            s.on('data', (c: Buffer) => { bytes += c.length; });
            ws.on('error', reject);
            s.on('error', reject);
            s.pipe(ws);
            ws.on('finish', () => resolve());
          }));
          log(`${client}: enviou ${abs(arg)} (${bytes} bytes, ${Date.now() - t0} ms)`);
          return;
        }
        case 'DELE': {
          if (!needWrite()) return;
          const p = await real(arg);
          if (!p) return reply(550, 'Arquivo não encontrado.');
          await rm(p);
          log(`${client}: apagou ${abs(arg)}`);
          return reply(250, 'Apagado.');
        }
        case 'MKD':
        case 'XMKD': {
          if (!needWrite()) return;
          const p = await real(arg, false);
          if (!p) return reply(550, 'Nome não permitido.');
          await mkdir(p);
          return reply(257, `"${abs(arg)}" criada.`);
        }
        case 'RMD':
        case 'XRMD': {
          if (!needWrite()) return;
          const p = await real(arg);
          if (!p || p === (await real('/'))) return reply(550, 'Pasta não encontrada.');
          await rmdir(p);
          return reply(250, 'Pasta removida.');
        }
        case 'RNFR': {
          if (!needWrite()) return;
          renameFrom = await real(arg);
          return renameFrom ? reply(350, 'Informe o novo nome.') : reply(550, 'Não encontrado.');
        }
        case 'RNTO': {
          if (!needWrite()) return;
          const to = await real(arg, false);
          if (!renameFrom || !to) return reply(503, 'Use RNFR antes.');
          await rename(renameFrom, to);
          renameFrom = undefined;
          return reply(250, 'Renomeado.');
        }
        case 'ABOR': return reply(226, 'Nada a abortar.');
        case 'QUIT':
          reply(221, 'Até logo.');
          ctrl.end();
          return;
        default: return reply(502, 'Comando não implementado.');
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 21, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  log(`FTP${cfg.tls ? 'S implícito' : ''} escutando na porta ${port}, raiz ${cfg.root}${cfg.anonymous ? ' (anônimo só leitura)' : ''}`);
  return {
    port,
    stop: async () => {
      for (const s of sockets) s.destroy();
      for (const p of passiveServers) p.close();
      await new Promise<void>((r) => server.close(() => r()));
      log('FTP parado');
    },
  };
}

import { timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import pty from 'node-pty';
import { checkHost, checkPort, type LogFn, type RunningServer } from './common.ts';

/*
 * Servidor Telnet (RFC 854/857/858/1073) para equipamentos que só falam Telnet: pede a senha (sem
 * eco) e abre um shell do Windows pelo ConPTY. O Telnet não é cifrado: senha obrigatória.
 */

export const Tn = { IAC: 255, DONT: 254, DO: 253, WONT: 252, WILL: 251, SB: 250, SE: 240, ECHO: 1, SGA: 3, NAWS: 31 } as const;

export interface TelnetConfig {
  port?: number;
  host?: string;
  password: string;
  shell?: 'powershell' | 'cmd';
  confirm?: (client: string) => Promise<boolean>;
  /** Pasta inicial do shell (padrão: a do usuário). */
  cwd?: string;
}

export function validateTelnet(raw: Record<string, unknown>): Omit<TelnetConfig, 'confirm'> {
  const password = String(raw.password ?? '');
  if (password.length < 4) throw new Error('defina uma senha (mínimo 4 caracteres): o Telnet não é cifrado');
  const shell = raw.shell === 'cmd' ? 'cmd' : 'powershell';
  return { port: checkPort(raw.port, 23), host: checkHost(raw.host), password, shell };
}

/**
 * Separa os comandos Telnet (IAC ...) dos dados. Devolve os dados limpos, os pedidos de tamanho de
 * janela (NAWS) e o que ficou pela metade para o próximo pedaço.
 */
export function parseTelnet(buf: Buffer): { data: Buffer; sizes: { cols: number; rows: number }[]; rest: Buffer } {
  const out: number[] = [];
  const sizes: { cols: number; rows: number }[] = [];
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    if (c !== Tn.IAC) {
      // CR NUL e CR LF viram CR (fim de linha do Telnet).
      if (c === 0x0d && (buf[i + 1] === 0x00 || buf[i + 1] === 0x0a)) {
        out.push(0x0d);
        i += 2;
        continue;
      }
      if (c === 0x0d && i + 1 === buf.length) return { data: Buffer.from(out), sizes, rest: buf.subarray(i) };
      out.push(c);
      i++;
      continue;
    }
    if (i + 1 >= buf.length) break;
    const cmd = buf[i + 1];
    if (cmd === Tn.IAC) {
      out.push(Tn.IAC);
      i += 2;
    } else if (cmd >= Tn.WILL && cmd <= Tn.DONT) {
      if (i + 2 >= buf.length) break;
      i += 3;
    } else if (cmd === Tn.SB) {
      const end = buf.indexOf(Buffer.from([Tn.IAC, Tn.SE]), i + 2);
      if (end < 0) break;
      const sub = buf.subarray(i + 2, end);
      if (sub[0] === Tn.NAWS && sub.length >= 5) sizes.push({ cols: sub.readUInt16BE(1), rows: sub.readUInt16BE(3) });
      i = end + 2;
    } else i += 2;
  }
  return { data: Buffer.from(out), sizes, rest: buf.subarray(i) };
}

/** Dados para o cliente: 0xFF vira IAC IAC. */
export const escapeIac = (b: Buffer) => (b.includes(Tn.IAC) ? Buffer.from([...b].flatMap((c) => (c === Tn.IAC ? [Tn.IAC, Tn.IAC] : [c]))) : b);

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function startTelnet(cfg: TelnetConfig, log: LogFn): Promise<RunningServer> {
  const sessions = new Set<{ sock: Socket; kill: () => void }>();
  const server = createServer((sock) => {
    void session(sock).catch((err: Error) => {
      log(`erro: ${err.message}`);
      sock.destroy();
    });
  });

  async function session(sock: Socket) {
    const client = String(sock.remoteAddress ?? '').replace(/^::ffff:/, '');
    sock.on('error', () => {});
    if (cfg.confirm && !(await cfg.confirm(client))) {
      log(`${client}: conexão recusada`);
      sock.end('Conexão recusada.\r\n');
      return;
    }
    log(`${client}: conectou`);
    // Servidor faz o eco e suprime o go-ahead; pede o tamanho da janela.
    sock.write(Buffer.from([Tn.IAC, Tn.WILL, Tn.ECHO, Tn.IAC, Tn.WILL, Tn.SGA, Tn.IAC, Tn.DO, Tn.NAWS]));
    sock.write('MultTerm - servidor Telnet\r\nSenha: ');
    let size = { cols: 80, rows: 24 };
    let pending: Buffer = Buffer.alloc(0);
    let line = '';
    let tries = 0;
    let term: pty.IPty | undefined;
    // kill() sempre: mesmo com o shell já encerrado, é ele que libera o ConPTY (senão o processo
    // não termina). Num shell que já saiu, o node-pty só reclama no stderr ("AttachConsole failed").
    const kill = () => {
      try {
        term?.kill();
      } catch { /* já liberado */ }
      term = undefined;
    };
    const entry = { sock, kill };
    sessions.add(entry);
    sock.on('close', () => {
      sessions.delete(entry);
      kill();
      log(`${client}: desconectou`);
    });

    sock.on('data', (chunk: Buffer) => {
      const parsed = parseTelnet(Buffer.concat([pending, chunk]));
      pending = Buffer.from(parsed.rest);
      for (const s of parsed.sizes) {
        if (s.cols > 0 && s.rows > 0) {
          size = s;
          term?.resize(s.cols, s.rows);
        }
      }
      if (term) {
        if (parsed.data.length) term.write(parsed.data.toString('utf8'));
        return;
      }
      // Login: lê a senha sem eco.
      for (const c of parsed.data.toString('utf8')) {
        if (c === '\r' || c === '\n') {
          if (!line && c === '\n') continue;
          const ok = same(line, cfg.password);
          line = '';
          sock.write('\r\n');
          if (ok) {
            log(`${client}: login feito`);
            openShell();
            return;
          }
          log(`${client}: senha errada`);
          if (++tries >= 3) {
            sock.end('Senha incorreta.\r\n');
            return;
          }
          setTimeout(() => sock.write('Senha incorreta.\r\nSenha: '), 1000);
        } else if (c === '\b' || c === '\x7f') line = line.slice(0, -1);
        else if (line.length < 256) line += c;
      }
    });

    function openShell() {
      const file = cfg.shell === 'cmd' ? 'cmd.exe' : 'powershell.exe';
      term = pty.spawn(file, cfg.shell === 'cmd' ? [] : ['-NoLogo'], {
        name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: cfg.cwd ?? homedir(), env: process.env as Record<string, string>,
      });
      term.onData((d) => {
        if (!sock.destroyed) sock.write(escapeIac(Buffer.from(d, 'utf8')));
      });
      term.onExit(() => {
        log(`${client}: shell encerrado`);
        sock.end();
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 23, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  log(`Telnet escutando na porta ${port} (shell: ${cfg.shell === 'cmd' ? 'cmd' : 'PowerShell'}); o Telnet não é cifrado`);
  return {
    port,
    stop: async () => {
      for (const s of sessions) {
        s.kill();
        s.sock.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
      log('Telnet parado');
    },
  };
}

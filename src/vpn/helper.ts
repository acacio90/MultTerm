import { lookup } from 'node:dns/promises';
import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tunnel } from './tunnel.ts';
import { WintunTun } from './wintun.ts';
import { WindowsNetConfig } from './netconfig.ts';
import type { NativeVpnOptions } from './site-config.ts';

/*
 * Processo auxiliar da VPN, executado como administrador (uma confirmação do UAC por conexão):
 * conecta no named pipe do app, confere o token, recebe a configuração (com a PSK e a senha, que
 * nunca passam pela linha de comando), sobe o túnel e informa o andamento em linhas JSON.
 * Se o app fechar o pipe, derruba o túnel e sai. Registro em %TEMP%\multterm-vpn.log.
 */

export const HELPER_FLAG = '--multterm-vpn-helper';
export const PIPE_RE = /^\\\\\.\\pipe\\multterm-vpn-[0-9a-f]{32}$/;
export const TOKEN_RE = /^[0-9a-f]{64}$/;
export const ADAPTER_NAME = 'MultTerm VPN';

export interface HelperStart {
  cmd: 'start';
  options: Omit<NativeVpnOptions, 'ike'> & { ike: Omit<NativeVpnOptions['ike'], 'psk'> & { psk: string } };
}

/** Síncrono: o registro precisa sobreviver a uma queda abrupta do processo. */
function note(text: string) {
  try {
    appendFileSync(join(tmpdir(), 'multterm-vpn.log'), `${new Date().toISOString()} ${text}\n`);
  } catch { /* sem registro */ }
}

export async function runVpnHelper(argv: string[], dllPath: string, exit: (code: number) => void): Promise<void> {
  const i = argv.indexOf(HELPER_FLAG);
  const pipe = argv[i + 1] ?? '';
  const token = argv[i + 2] ?? '';
  if (!PIPE_RE.test(pipe) || !TOKEN_RE.test(token)) return exit(2);
  note(`auxiliar iniciado (pid ${process.pid})`);

  const sock = connect(pipe);
  const send = (o: object) => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(o)}\n`);
  };
  let tunnel: Tunnel | undefined;
  let finishing = false;
  const finish = async (code = 0, why = '') => {
    if (finishing) return;
    finishing = true;
    note(`encerrando (código ${code}${why ? `: ${why}` : ''})`);
    await tunnel?.stop().catch(() => {});
    send({ ev: 'stopped' });
    // O Wintun fecha a sessão em segundo plano (ver WintunTun.close).
    setTimeout(() => {
      sock.end();
      exit(code);
    }, 900);
  };
  // Falha inesperada: avisa o app (que mostra a mensagem) e registra.
  const crash = (err: unknown) => {
    note(`falha: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    send({ ev: 'error', message: `falha no processo da VPN: ${err instanceof Error ? err.message : String(err)}` });
    void finish(1, 'falha inesperada');
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  process.on('exit', (c) => note(`saiu (código ${c})`));
  sock.on('error', (err) => void finish(1, `canal: ${err.message}`));
  sock.on('close', () => void finish(0, 'canal fechado'));
  sock.on('connect', () => send({ ev: 'hello', token, pid: process.pid }));

  let buffer = '';
  sock.on('data', (d) => {
    buffer += d.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg: { cmd?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.cmd === 'stop') void finish(0, 'pedido do app');
      else if (msg.cmd === 'start' && !tunnel) void start(msg as HelperStart);
    }
  });

  async function start(req: HelperStart) {
    try {
      const o = req.options;
      const host = /^\d+\.\d+\.\d+\.\d+$/.test(o.ike.host) ? o.ike.host : (await lookup(o.ike.host, { family: 4 })).address;
      tunnel = new Tunnel({
        ...o,
        ike: { ...o.ike, host, psk: Buffer.from(o.ike.psk, 'base64') },
        createTun: () => new WintunTun(dllPath, ADAPTER_NAME, note),
        net: new WindowsNetConfig(host),
      });
      tunnel.on('log', (msg: string) => {
        note(msg);
        send({ ev: 'log', msg });
      });
      tunnel.on('banner', (text: string) => send({ ev: 'banner', text }));
      tunnel.on('down', (reason: string) => {
        send({ ev: 'down', reason });
        void finish(0, `túnel caiu: ${reason}`);
      });
      const setup = await tunnel.start();
      send({ ev: 'up', setup });
      const t = setInterval(() => send({ ev: 'stats', stats: tunnel?.stats }), 2000);
      t.unref();
    } catch (err) {
      note(`erro ao conectar: ${(err as Error).stack ?? err}`);
      send({ ev: 'error', message: (err as Error).message });
      void finish(1, 'erro ao conectar');
    }
  }
}

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { quoteWindowsArg } from '../sessions/launch.ts';
import { HELPER_FLAG, type HelperStart } from '../vpn/helper.ts';
import type { NativeVpnOptions } from '../vpn/site-config.ts';
import type { NetSetup, TunnelStats } from '../vpn/tunnel.ts';
import type { VpnStatus } from '../vpn/sites.ts';

/*
 * VPN pelo motor do próprio MultTerm. O túnel roda num processo auxiliar elevado (o próprio
 * executável com HELPER_FLAG); o app fala com ele por um named pipe com nome e token aleatórios.
 */

export const wintunDllPath = () => join(
  app.isPackaged ? join(process.resourcesPath, 'wintun') : join(app.getAppPath(), 'vendor', 'wintun'),
  process.arch === 'arm64' ? 'arm64' : 'amd64',
  'wintun.dll',
);

/** Abre o auxiliar como administrador (UAC). Resolve quando o processo foi iniciado. */
function elevate(args: string[]): Promise<void> {
  const quoted = args.map(quoteWindowsArg).join(' ');
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const command = `Start-Process -FilePath ${ps(process.execPath)} -ArgumentList ${ps(quoted)} -Verb RunAs -WindowStyle Hidden`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (err, _o, stderr) => {
      if (!err) return resolve();
      const text = String(stderr || err.message);
      reject(new Error(/cancel/i.test(text) ? 'a permissão de administrador foi recusada (UAC)' : `não foi possível iniciar a VPN: ${text.trim()}`));
    });
  });
}

export class NativeVpnConnection extends EventEmitter {
  status: VpnStatus;
  setup?: NetSetup;
  stats?: TunnelStats;
  private readonly site: string;
  private readonly options: NativeVpnOptions;
  private server?: Server;
  private sock?: Socket;
  private closing = false;
  private done?: Promise<void>;

  constructor(site: string, options: NativeVpnOptions) {
    super();
    this.site = site;
    this.options = options;
    this.status = { site, state: 'off', log: '' };
  }

  private set(patch: Partial<VpnStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  private log(line: string) {
    this.set({ log: `${this.status.log}${line}\n` });
  }

  connect(timeoutMs = 120_000): Promise<void> {
    const pipe = `\\\\.\\pipe\\multterm-vpn-${randomBytes(16).toString('hex')}`;
    const token = randomBytes(32).toString('hex');
    this.set({ state: 'connecting', error: undefined, log: '' });
    this.log('pedindo permissão de administrador para criar o adaptador da VPN…');

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.set({ state: 'off', error: err.message });
          reject(err);
          void this.disconnect();
        } else resolve();
      };
      const timer = setTimeout(() => settle(new Error('tempo esgotado ao conectar a VPN')), timeoutMs);
      let authed = false;
      const server = createServer((sock) => {
        if (this.sock) return sock.destroy(); // só uma conexão
        this.sock = sock;
        server.close(); // ninguém mais conecta
        let buffer = '';
        this.done = new Promise((r) => sock.on('close', () => {
          if (this.status.state !== 'off') this.set({ state: 'off', ...(this.closing ? {} : { error: this.status.error ?? 'o processo da VPN terminou' }) });
          settle(new Error(this.status.error ?? 'o processo da VPN terminou'));
          r();
        }));
        sock.on('error', () => {});
        sock.on('data', (d) => {
          buffer += d.toString('utf8');
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (!authed) {
              const got = Buffer.from(String(ev.token ?? ''));
              const want = Buffer.from(token);
              if (ev.ev !== 'hello' || got.length !== want.length || !timingSafeEqual(got, want)) {
                sock.destroy();
                settle(new Error('o processo da VPN não se identificou'));
                return;
              }
              authed = true;
              this.log('adaptador autorizado; conectando ao gateway…');
              const start: HelperStart = { cmd: 'start', options: { ...this.options, ike: { ...this.options.ike, psk: this.options.ike.psk.toString('base64') } } };
              sock.write(`${JSON.stringify(start)}\n`);
              continue;
            }
            this.event(ev, settle);
          }
        });
      });
      this.server = server;
      server.on('error', (err) => settle(new Error(`falha no canal com o processo da VPN: ${err.message}`)));
      server.listen(pipe, () => {
        const args = [...(app.isPackaged ? [] : [app.getAppPath()]), HELPER_FLAG, pipe, token];
        elevate(args).catch((err: Error) => settle(err));
      });
    });
  }

  private event(ev: Record<string, unknown>, settle: (err?: Error) => void) {
    switch (ev.ev) {
      case 'log':
        this.log(String(ev.msg));
        break;
      case 'banner':
        this.log(`aviso do gateway: ${String(ev.text)}`);
        break;
      case 'up':
        this.setup = ev.setup as NetSetup;
        this.set({ state: 'connected', since: Date.now() });
        settle();
        break;
      case 'stats':
        this.stats = ev.stats as TunnelStats;
        this.emit('stats', this.stats);
        break;
      case 'error':
        this.set({ state: 'off', error: String(ev.message) });
        settle(new Error(String(ev.message)));
        break;
      case 'down':
        this.set({ state: 'off', error: String(ev.reason) });
        settle(new Error(String(ev.reason)));
        break;
    }
  }

  async disconnect(): Promise<void> {
    if (this.closing) return this.done;
    this.closing = true;
    this.server?.close();
    if (this.status.state !== 'off') this.set({ state: 'disconnecting' });
    if (this.sock && !this.sock.destroyed) {
      this.sock.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
      const sock = this.sock;
      const force = setTimeout(() => sock.destroy(), 15_000);
      await this.done;
      clearTimeout(force);
    }
    if (this.status.state !== 'off') this.set({ state: 'off' });
  }
}

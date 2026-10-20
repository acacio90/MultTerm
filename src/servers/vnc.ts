import { randomBytes } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { checkHost, checkPort, type LogFn, type RunningServer } from './common.ts';
import { vncAuthResponse } from './des.ts';
import { clientAllowed, parseCidr } from './nfs.ts';

/*
 * Servidor VNC (RFB 3.3/3.7/3.8, RFC 6143) para compartilhar a tela local: autenticação VNC
 * (senha obrigatória), "somente visualização" opcional e envio só dos blocos que mudaram.
 * A captura da tela e a injeção de mouse/teclado vêm de fora (o app usa o Electron e o Win32),
 * para o protocolo ser testável sem tela.
 */

/** Quadro capturado: BGRA, 4 bytes por pixel, linha a linha. */
export interface Frame {
  width: number;
  height: number;
  data: Buffer;
}

export interface VncInput {
  pointer(x: number, y: number, buttons: number): void;
  key(keysym: number, down: boolean): void;
}

export interface VncDeps {
  capture(): Promise<Frame>;
  input?: VncInput;
  /** Perguntar ao usuário antes de aceitar (depois da senha certa). */
  confirm?(client: string): Promise<boolean>;
  notify?(text: string): void;
}

export interface VncConfig {
  port?: number;
  host?: string;
  password: string;
  viewOnly: boolean;
  allow: string[];
  /** Quadros por segundo da captura (enquanto há cliente pedindo). */
  fps?: number;
  name?: string;
}

export function validateVnc(raw: Record<string, unknown>): VncConfig {
  const password = typeof raw.password === 'string' ? raw.password : '';
  if (!password) throw new Error('defina a senha do VNC (até 8 caracteres)');
  if (password.length > 8) throw new Error('a senha do VNC tem no máximo 8 caracteres (limite do protocolo)');
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(password)) throw new Error('a senha do VNC aceita só letras, números e símbolos comuns');
  const allow = typeof raw.allow === 'string' ? raw.allow.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean) : [];
  for (const a of allow) if (!parseCidr(a)) throw new Error(`cliente permitido inválido: ${a} (use IPv4 ou faixa como 10.0.0.0/24)`);
  const fps = raw.fps === undefined || raw.fps === '' ? 5 : Number(raw.fps);
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error('quadros por segundo entre 1 e 30');
  return {
    port: checkPort(raw.port, 5900),
    host: checkHost(raw.host),
    password,
    viewOnly: raw.viewOnly !== false,
    allow,
    fps,
  };
}

// ---------- formato de pixel ----------

export interface PixelFormat {
  bpp: number;
  depth: number;
  bigEndian: boolean;
  trueColor: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

/** Formato do servidor: 32 bits, little-endian, R<<16 G<<8 B — os bytes saem como BGRX (o da captura). */
export const SERVER_FORMAT: PixelFormat = {
  bpp: 32, depth: 24, bigEndian: false, trueColor: true,
  redMax: 255, greenMax: 255, blueMax: 255, redShift: 16, greenShift: 8, blueShift: 0,
};

export function encodePixelFormat(pf: PixelFormat): Buffer {
  const b = Buffer.alloc(16);
  b[0] = pf.bpp;
  b[1] = pf.depth;
  b[2] = pf.bigEndian ? 1 : 0;
  b[3] = pf.trueColor ? 1 : 0;
  b.writeUInt16BE(pf.redMax, 4);
  b.writeUInt16BE(pf.greenMax, 6);
  b.writeUInt16BE(pf.blueMax, 8);
  b[10] = pf.redShift;
  b[11] = pf.greenShift;
  b[12] = pf.blueShift;
  return b;
}

export function decodePixelFormat(b: Buffer): PixelFormat {
  return {
    bpp: b[0], depth: b[1], bigEndian: b[2] !== 0, trueColor: b[3] !== 0,
    redMax: b.readUInt16BE(4), greenMax: b.readUInt16BE(6), blueMax: b.readUInt16BE(8),
    redShift: b[10], greenShift: b[11], blueShift: b[12],
  };
}

const sameFormat = (a: PixelFormat, b: PixelFormat) => encodePixelFormat(a).equals(encodePixelFormat(b));

/** Pixels BGRA de um retângulo → bytes no formato do cliente. */
export function encodePixels(frame: Frame, x: number, y: number, w: number, h: number, pf: PixelFormat): Buffer {
  const bytes = pf.bpp / 8;
  const out = Buffer.alloc(w * h * bytes);
  const direct = sameFormat(pf, SERVER_FORMAT);
  let o = 0;
  for (let row = y; row < y + h; row++) {
    const start = (row * frame.width + x) * 4;
    if (direct) {
      frame.data.copy(out, o, start, start + w * 4);
      o += w * 4;
      continue;
    }
    for (let i = 0; i < w; i++) {
      const p = start + i * 4;
      const b = frame.data[p];
      const g = frame.data[p + 1];
      const r = frame.data[p + 2];
      const v = ((Math.round((r * pf.redMax) / 255) << pf.redShift)
        | (Math.round((g * pf.greenMax) / 255) << pf.greenShift)
        | (Math.round((b * pf.blueMax) / 255) << pf.blueShift)) >>> 0;
      if (bytes === 4) {
        if (pf.bigEndian) out.writeUInt32BE(v, o);
        else out.writeUInt32LE(v, o);
      } else if (bytes === 2) {
        if (pf.bigEndian) out.writeUInt16BE(v & 0xffff, o);
        else out.writeUInt16LE(v & 0xffff, o);
      } else {
        out[o] = v & 0xff;
      }
      o += bytes;
    }
  }
  return out;
}

// ---------- blocos que mudaram ----------

const TILE = 64;

/** Retângulos (blocos de 64×64) da região que diferem entre o quadro novo e o último enviado. */
export function changedTiles(prev: Frame | undefined, next: Frame, rx: number, ry: number, rw: number, rh: number): [number, number, number, number][] {
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(next.width, rx + rw);
  const y1 = Math.min(next.height, ry + rh);
  const rects: [number, number, number, number][] = [];
  const full = !prev || prev.width !== next.width || prev.height !== next.height;
  for (let ty = y0; ty < y1; ty += TILE) {
    for (let tx = x0; tx < x1; tx += TILE) {
      const w = Math.min(TILE, x1 - tx);
      const h = Math.min(TILE, y1 - ty);
      let changed = full;
      for (let row = ty; !changed && row < ty + h; row++) {
        const s = (row * next.width + tx) * 4;
        if (next.data.compare(prev!.data, s, s + w * 4, s, s + w * 4) !== 0) changed = true;
      }
      if (changed) rects.push([tx, ty, w, h]);
    }
  }
  return rects;
}

// ---------- servidor ----------

const ENC_RAW = 0;
const ENC_DESKTOP_SIZE = -223;

interface Client {
  sock: Socket;
  addr: string;
  pf: PixelFormat;
  desktopSize: boolean;
  /** Último quadro enviado (para mandar só o que mudou). */
  sent?: Frame;
  pending?: { incremental: boolean; x: number; y: number; w: number; h: number };
  buttons: number;
}

export async function startVnc(cfg: VncConfig, deps: VncDeps, log: LogFn): Promise<RunningServer> {
  const clients = new Set<Client>();
  const sockets = new Set<Socket>();
  let current: Frame = await deps.capture();
  let timer: NodeJS.Timeout | undefined;
  let capturing = false;

  /** Responde os pedidos pendentes com o quadro atual (inteiro ou só o que mudou). */
  function serve(c: Client) {
    const req = c.pending;
    if (!req || c.sock.destroyed) return;
    const frame = current;
    const resized = !c.sent || c.sent.width !== frame.width || c.sent.height !== frame.height;
    const rects: [number, number, number, number][] = req.incremental && !resized
      ? changedTiles(c.sent, frame, req.x, req.y, req.w, req.h)
      : [[Math.max(0, req.x), Math.max(0, req.y),
        Math.max(0, Math.min(frame.width, req.x + req.w) - Math.max(0, req.x)),
        Math.max(0, Math.min(frame.height, req.y + req.h) - Math.max(0, req.y))]];
    const sizeRect = resized && c.sent && c.desktopSize;
    if (req.incremental && !rects.length && !sizeRect) return; // nada mudou: o pedido espera o próximo quadro
    c.pending = undefined;
    const parts: Buffer[] = [];
    const head = Buffer.alloc(4);
    head[0] = 0;
    head.writeUInt16BE(rects.length + (sizeRect ? 1 : 0), 2);
    parts.push(head);
    if (sizeRect) {
      const r = Buffer.alloc(12);
      r.writeUInt16BE(frame.width, 4);
      r.writeUInt16BE(frame.height, 6);
      r.writeInt32BE(ENC_DESKTOP_SIZE, 8);
      parts.push(r);
    }
    for (const [x, y, w, h] of rects) {
      const r = Buffer.alloc(12);
      r.writeUInt16BE(x, 0);
      r.writeUInt16BE(y, 2);
      r.writeUInt16BE(w, 4);
      r.writeUInt16BE(h, 6);
      r.writeInt32BE(ENC_RAW, 8);
      parts.push(r, encodePixels(frame, x, y, w, h, c.pf));
    }
    c.sock.write(Buffer.concat(parts));
    c.sent = frame;
  }

  /** Captura no ritmo configurado enquanto algum cliente espera atualização. */
  function schedule() {
    if (timer || ![...clients].some((c) => c.pending)) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (capturing) return;
      capturing = true;
      try {
        current = await deps.capture();
      } catch (err) {
        log(`falha ao capturar a tela: ${(err as Error).message}`);
      } finally {
        capturing = false;
      }
      for (const c of clients) serve(c);
      schedule();
    }, 1000 / (cfg.fps ?? 5));
  }

  function handle(sock: Socket) {
    const addr = (sock.remoteAddress ?? '').replace(/^::ffff:/, '');
    sockets.add(sock);
    sock.setNoDelay(true);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    if (!clientAllowed(addr, cfg.allow)) {
      log(`conexão recusada de ${addr} (fora dos clientes permitidos)`);
      sock.destroy();
      return;
    }

    let buf = Buffer.alloc(0);
    let stage: 'version' | 'security' | 'auth' | 'init' | 'messages' = 'version';
    let minor = 8;
    let challenge = Buffer.alloc(0);
    let client: Client | undefined;
    let busy = false;
    sock.write('RFB 003.008\n');

    const fail = (reason: string) => {
      const r = Buffer.from(reason);
      const out = Buffer.alloc(8);
      out.writeUInt32BE(1, 0);
      out.writeUInt32BE(r.length, 4);
      sock.end(minor >= 8 ? Buffer.concat([out, r]) : out.subarray(0, 4));
    };

    const step = async () => {
      if (busy) return;
      busy = true;
      try {
        for (;;) {
          if (stage === 'version') {
            if (buf.length < 12) return;
            const v = buf.subarray(0, 12).toString('latin1');
            buf = buf.subarray(12);
            const m = /^RFB 003\.(\d{3})\n$/.exec(v);
            if (!m) {
              sock.destroy();
              return;
            }
            minor = Number(m[1]) >= 8 ? 8 : Number(m[1]) === 7 ? 7 : 3;
            challenge = randomBytes(16);
            if (minor === 3) {
              const t = Buffer.alloc(4);
              t.writeUInt32BE(2);
              sock.write(Buffer.concat([t, challenge]));
              stage = 'auth';
            } else {
              sock.write(Buffer.from([1, 2])); // um tipo: VNC Authentication
              stage = 'security';
            }
          } else if (stage === 'security') {
            if (buf.length < 1) return;
            const type = buf[0];
            buf = buf.subarray(1);
            if (type !== 2) {
              fail('tipo de segurança não suportado (use a autenticação VNC)');
              return;
            }
            sock.write(challenge);
            stage = 'auth';
          } else if (stage === 'auth') {
            if (buf.length < 16) return;
            const response = buf.subarray(0, 16);
            buf = buf.subarray(16);
            if (!response.equals(vncAuthResponse(cfg.password, challenge))) {
              log(`senha errada de ${addr}`);
              // Atraso contra tentativa e erro.
              await new Promise((r) => setTimeout(r, 1000));
              fail('senha incorreta');
              return;
            }
            if (deps.confirm && !(await deps.confirm(addr))) {
              log(`conexão de ${addr} recusada pelo usuário`);
              fail('conexão recusada no computador compartilhado');
              return;
            }
            sock.write(Buffer.from([0, 0, 0, 0]));
            stage = 'init';
          } else if (stage === 'init') {
            if (buf.length < 1) return;
            buf = buf.subarray(1); // shared-flag
            const name = Buffer.from(cfg.name ?? 'MultTerm');
            const head = Buffer.alloc(4);
            head.writeUInt16BE(current.width, 0);
            head.writeUInt16BE(current.height, 2);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(name.length);
            sock.write(Buffer.concat([head, encodePixelFormat(SERVER_FORMAT), len, name]));
            client = { sock, addr, pf: SERVER_FORMAT, desktopSize: false, buttons: 0 };
            clients.add(client);
            sock.on('close', () => {
              clients.delete(client!);
              log(`${addr} desconectou`);
            });
            log(`${addr} conectado (${cfg.viewOnly ? 'somente visualização' : 'com controle de mouse e teclado'})`);
            deps.notify?.(`VNC: ${addr} está vendo a sua tela`);
            stage = 'messages';
          } else {
            if (buf.length < 1) return;
            const type = buf[0];
            const c = client!;
            if (type === 0) { // SetPixelFormat
              if (buf.length < 20) return;
              const pf = decodePixelFormat(buf.subarray(4, 20));
              buf = buf.subarray(20);
              if (!pf.trueColor || ![8, 16, 32].includes(pf.bpp)) {
                log(`${addr}: formato de cor não suportado (paleta); use cores reais no visualizador`);
                sock.destroy();
                return;
              }
              c.pf = pf;
              c.sent = undefined; // o próximo envio vai inteiro, no formato novo
            } else if (type === 2) { // SetEncodings
              if (buf.length < 4) return;
              const n = buf.readUInt16BE(2);
              if (buf.length < 4 + n * 4) return;
              const encs = Array.from({ length: n }, (_, i) => buf.readInt32BE(4 + i * 4));
              buf = buf.subarray(4 + n * 4);
              c.desktopSize = encs.includes(ENC_DESKTOP_SIZE);
            } else if (type === 3) { // FramebufferUpdateRequest
              if (buf.length < 10) return;
              c.pending = {
                incremental: buf[1] !== 0,
                x: buf.readUInt16BE(2), y: buf.readUInt16BE(4), w: buf.readUInt16BE(6), h: buf.readUInt16BE(8),
              };
              buf = buf.subarray(10);
              serve(c);
              schedule();
            } else if (type === 4) { // KeyEvent
              if (buf.length < 8) return;
              const down = buf[1] !== 0;
              const key = buf.readUInt32BE(4);
              buf = buf.subarray(8);
              if (!cfg.viewOnly) deps.input?.key(key, down);
            } else if (type === 5) { // PointerEvent
              if (buf.length < 6) return;
              const buttons = buf[1];
              const x = buf.readUInt16BE(2);
              const y = buf.readUInt16BE(4);
              buf = buf.subarray(6);
              if (!cfg.viewOnly) deps.input?.pointer(x, y, buttons);
            } else if (type === 6) { // ClientCutText (ignorado)
              if (buf.length < 8) return;
              const len = buf.readUInt32BE(4);
              if (len > 1024 * 1024) {
                sock.destroy();
                return;
              }
              if (buf.length < 8 + len) return;
              buf = buf.subarray(8 + len);
            } else {
              log(`${addr}: mensagem desconhecida (${type}); desconectando`);
              sock.destroy();
              return;
            }
          }
        }
      } finally {
        busy = false;
      }
    };

    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 2 * 1024 * 1024) {
        sock.destroy();
        return;
      }
      void step().then(() => {
        // Dados que chegaram durante uma espera (senha, confirmação) são processados agora.
        if (buf.length && !sock.destroyed) void step();
      });
    });
  }

  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 5900, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  log(`VNC na porta ${port}: tela ${current.width}×${current.height}, ${cfg.viewOnly ? 'somente visualização' : 'com controle de mouse e teclado'}`);
  return {
    port,
    async stop() {
      clearTimeout(timer);
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      log('VNC parado');
    },
  };
}

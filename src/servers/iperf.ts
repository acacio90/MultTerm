import { createServer, type Socket } from 'node:net';
import { checkPort, type LogFn, type RunningServer } from './common.ts';

/*
 * Servidor de teste de banda compatível com o cliente iperf3 (protocolo do iperf3: conexão de
 * controle com estados de 1 byte e parâmetros/resultados em JSON com tamanho de 4 bytes).
 * Testes TCP: envio do cliente, reverso (-R) e vários fluxos (-P). Um teste por vez.
 */

export const IperfState = {
  TestStart: 1, TestRunning: 2, TestEnd: 4, ParamExchange: 9, CreateStreams: 10, ServerTerminate: 11,
  ClientTerminate: 12, ExchangeResults: 13, DisplayResults: 14, IperfStart: 15, IperfDone: 16,
  AccessDenied: -1, ServerError: -2,
} as const;

const COOKIE = 37;

export interface IperfConfig {
  port?: number;
  host?: string;
}

export function validateIperf(raw: Record<string, unknown>): IperfConfig {
  return { port: checkPort(raw.port, 5201) };
}

/** Lê exatamente n bytes de um socket (fila interna por socket). */
class Reader {
  private chunks: Buffer[] = [];
  private size = 0;
  private waiting?: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void };
  private ended?: Error;

  private readonly sock: Socket;
  private readonly onData = (d: Buffer) => {
    this.chunks.push(d);
    this.size += d.length;
    this.flush();
  };

  constructor(sock: Socket) {
    this.sock = sock;
    sock.on('data', this.onData);
    const end = () => {
      this.ended = new Error('conexão encerrada');
      this.waiting?.reject(this.ended);
      this.waiting = undefined;
    };
    sock.on('end', end);
    sock.on('close', end);
    sock.on('error', end);
  }

  /** Para de guardar dados (fluxo de dados); devolve o que já tinha chegado. */
  detach(): number {
    this.sock.off('data', this.onData);
    const left = this.size;
    this.chunks = [];
    this.size = 0;
    return left;
  }

  private flush() {
    if (!this.waiting || this.size < this.waiting.n) return;
    const all = Buffer.concat(this.chunks);
    const out = all.subarray(0, this.waiting.n);
    this.chunks = [all.subarray(this.waiting.n)];
    this.size = all.length - this.waiting.n;
    const w = this.waiting;
    this.waiting = undefined;
    w.resolve(out);
  }

  read(n: number): Promise<Buffer> {
    if (this.ended && this.size < n) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject };
      this.flush();
    });
  }
}

interface Stream {
  id: number;
  sock: Socket;
  bytes: number;
}

export async function startIperf(cfg: IperfConfig, log: LogFn): Promise<RunningServer> {
  const sockets = new Set<Socket>();
  let busy: { cookie: string; streams: Stream[]; wanted: number; ready?: () => void } | undefined;

  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    const reader = new Reader(sock);
    void reader.read(COOKIE).then((cookieBuf) => {
      const cookie = cookieBuf.toString('latin1');
      // Fluxo de dados de um teste em andamento?
      if (busy && cookie === busy.cookie && busy.streams.length < busy.wanted) {
        const id = busy.streams.length === 0 ? 1 : busy.streams.length + 2; // ids do iperf3: 1, 3, 4, 5…
        // Daqui em diante só conta bytes (sem guardar): o Reader para de acumular.
        const stream: Stream = { id, sock, bytes: reader.detach() };
        sock.on('data', (d: Buffer) => { stream.bytes += d.length; });
        busy.streams.push(stream);
        if (busy.streams.length === busy.wanted) busy.ready?.();
        return;
      }
      if (busy) {
        sock.end(Buffer.from([IperfState.AccessDenied & 0xff]));
        log(`${addr(sock)}: recusado (já há um teste em andamento)`);
        return;
      }
      sock.setNoDelay(true); // só no controle: nos fluxos de dados piora a vazão no Windows
      void control(sock, reader, cookie).catch((err: Error) => {
        log(`${addr(sock)}: teste interrompido: ${err.message}`);
        sock.destroy();
      }).finally(() => {
        for (const s of busy?.streams ?? []) s.sock.destroy();
        busy = undefined;
      });
    }, () => sock.destroy());
  });

  const addr = (s: Socket) => String(s.remoteAddress ?? '').replace(/^::ffff:/, '');
  const state = (sock: Socket, st: number) => sock.write(Buffer.from([st & 0xff]));
  const sendJson = (sock: Socket, obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    sock.write(Buffer.concat([len, body]));
  };
  const readJson = async (reader: Reader) => {
    const n = (await reader.read(4)).readUInt32BE(0);
    if (n > 1 << 20) throw new Error('JSON grande demais');
    return JSON.parse((await reader.read(n)).toString('utf8'));
  };

  async function control(sock: Socket, reader: Reader, cookie: string) {
    const client = addr(sock);
    state(sock, IperfState.ParamExchange);
    const params = await readJson(reader);
    if (params.udp || params.sctp || params.bidirectional) {
      state(sock, IperfState.ServerError);
      const err = Buffer.alloc(8);
      err.writeInt32BE(13, 0); // IEUNIMP: "opção ainda não implementada" no cliente
      sock.end(err);
      log(`${client}: modo não suportado (${params.udp ? 'UDP' : params.sctp ? 'SCTP' : 'bidirecional'}); use TCP, com ou sem -R`);
      return;
    }
    const wanted = Math.max(1, Math.min(Number(params.parallel) || 1, 128));
    const reverse = !!params.reverse;
    const blockLen = Math.max(1024, Math.min(Number(params.len) || 131072, 1 << 20));
    busy = { cookie, streams: [], wanted };
    const allReady = new Promise<void>((resolve, reject) => {
      busy!.ready = resolve;
      setTimeout(() => reject(new Error('o cliente não abriu os fluxos de dados')), 15_000);
    });
    state(sock, IperfState.CreateStreams);
    await allReady;
    const streams = busy.streams;
    log(`${client}: teste TCP ${reverse ? 'reverso (servidor envia)' : '(cliente envia)'}, ${wanted} fluxo(s)`);

    const started = process.hrtime.bigint();
    state(sock, IperfState.TestStart);
    state(sock, IperfState.TestRunning);
    let sending = reverse;
    if (reverse) {
      const block = Buffer.alloc(blockLen, 0x5a);
      for (const s of streams) {
        const pump = () => {
          while (sending && !s.sock.destroyed) {
            s.bytes += block.length;
            if (!s.sock.write(block)) {
              s.sock.once('drain', pump);
              return;
            }
          }
        };
        s.sock.on('error', () => {});
        pump();
      }
    }

    // Espera o fim do teste (o cliente controla a duração).
    for (;;) {
      const st = (await reader.read(1)).readInt8(0);
      if (st === IperfState.TestEnd) break;
      if (st === IperfState.ClientTerminate) throw new Error('o cliente encerrou o teste');
    }
    sending = false;
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    state(sock, IperfState.ExchangeResults);
    const theirs = await readJson(reader);
    sendJson(sock, {
      cpu_util_total: 0, cpu_util_user: 0, cpu_util_system: 0,
      sender_has_retransmits: reverse ? -1 : 0,
      congestion_used: 'cubic',
      streams: streams.map((s) => ({ id: s.id, bytes: s.bytes, retransmits: -1, jitter: 0, errors: 0, omitted_errors: 0, packets: 0, omitted_packets: 0, start_time: 0, end_time: secs })),
    });
    state(sock, IperfState.DisplayResults);
    // O cliente responde IPERF_DONE; não é obrigatório esperar.
    await Promise.race([reader.read(1).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
    const total = reverse
      ? streams.reduce((n, s) => n + s.bytes, 0)
      : (theirs?.streams ?? []).reduce((n: number, s: { bytes?: number }) => n + (Number(s.bytes) || 0), 0) || streams.reduce((n, s) => n + s.bytes, 0);
    const mbps = (total * 8) / secs / 1e6;
    log(`${client}: ${(total / 1048576).toFixed(1)} MB em ${secs.toFixed(1)} s = ${mbps >= 1000 ? `${(mbps / 1000).toFixed(2)} Gbit/s` : `${mbps.toFixed(1)} Mbit/s`}`);
    for (const s of streams) s.sock.destroy();
    sock.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 5201, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  log(`Iperf (iperf3) escutando na porta ${port}`);
  return {
    port,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      log('Iperf parado');
    },
  };
}

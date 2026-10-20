import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server, type Socket } from 'node:net';

/*
 * ONC RPC (RFC 5531) com XDR (RFC 4506), o suficiente para o servidor NFS: chamadas por UDP e por
 * TCP (com "record marking"), autenticação AUTH_NONE/AUTH_UNIX aceita sem verificar (o servidor é
 * somente leitura) e respostas aceitas ou de erro de programa/versão/procedimento.
 */

// ---------- XDR ----------

export class XdrReader {
  private off = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  get remaining() {
    return this.buf.length - this.off;
  }
  private need(n: number) {
    if (this.off + n > this.buf.length) throw new GarbageArgs();
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.off);
    this.off += 8;
    return v;
  }
  bool(): boolean {
    return this.u32() !== 0;
  }
  opaque(max = 1 << 20): Buffer {
    const len = this.u32();
    if (len > max) throw new GarbageArgs();
    return this.fixed(len);
  }
  fixed(len: number): Buffer {
    this.need(len);
    const v = this.buf.subarray(this.off, this.off + len);
    this.off += len + ((4 - (len % 4)) % 4);
    return v;
  }
  string(max = 4096): string {
    return this.opaque(max).toString('utf8');
  }
}

export class XdrWriter {
  private parts: Buffer[] = [];
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.parts.push(b);
    return this;
  }
  u64(v: bigint | number) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(v));
    this.parts.push(b);
    return this;
  }
  bool(v: boolean) {
    return this.u32(v ? 1 : 0);
  }
  fixed(data: Buffer) {
    this.parts.push(data);
    const pad = (4 - (data.length % 4)) % 4;
    if (pad) this.parts.push(Buffer.alloc(pad));
    return this;
  }
  opaque(data: Buffer) {
    this.u32(data.length);
    return this.fixed(data);
  }
  string(s: string) {
    return this.opaque(Buffer.from(s, 'utf8'));
  }
  raw(data: Buffer) {
    this.parts.push(data);
    return this;
  }
  get length() {
    return this.parts.reduce((n, p) => n + p.length, 0);
  }
  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

// ---------- RPC ----------

/** Argumentos malformados: vira GARBAGE_ARGS na resposta. */
export class GarbageArgs extends Error {}

export interface RpcCall {
  xid: number;
  prog: number;
  vers: number;
  proc: number;
  args: XdrReader;
  /** Endereço do cliente (para a lista de clientes permitidos e o log). */
  client: string;
  transport: 'udp' | 'tcp';
}

/** Um programa RPC: versões aceitas e o tratamento dos procedimentos (devolve o corpo do resultado). */
export interface RpcProgram {
  prog: number;
  versions: [number, number];
  handle(call: RpcCall): Promise<Buffer | 'proc-unavail'> | Buffer | 'proc-unavail';
}

const MSG_REPLY = 1;
const MSG_ACCEPTED = 0;
const MSG_DENIED = 1;
const SUCCESS = 0;
const PROG_UNAVAIL = 1;
const PROG_MISMATCH = 2;
const PROC_UNAVAIL = 3;
const GARBAGE_ARGS = 4;
const SYSTEM_ERR = 5;
const RPC_MISMATCH = 0;

function acceptedReply(xid: number, stat: number, body?: Buffer) {
  const w = new XdrWriter().u32(xid).u32(MSG_REPLY).u32(MSG_ACCEPTED).u32(0).u32(0).u32(stat); // verf AUTH_NONE
  if (body) w.raw(body);
  return w.toBuffer();
}

/** Interpreta uma chamada RPC e devolve a resposta (ou undefined se não for uma chamada). */
export async function dispatch(msg: Buffer, programs: RpcProgram[], client: string, transport: 'udp' | 'tcp'): Promise<Buffer | undefined> {
  let xid = 0;
  try {
    const r = new XdrReader(msg);
    xid = r.u32();
    if (r.u32() !== 0) return undefined; // não é CALL
    if (r.u32() !== 2) {
      return new XdrWriter().u32(xid).u32(MSG_REPLY).u32(MSG_DENIED).u32(RPC_MISMATCH).u32(2).u32(2).toBuffer();
    }
    const prog = r.u32();
    const vers = r.u32();
    const proc = r.u32();
    r.u32(); r.opaque(400); // credencial (aceita sem verificar)
    r.u32(); r.opaque(400); // verificador
    const p = programs.find((x) => x.prog === prog);
    if (!p) return acceptedReply(xid, PROG_UNAVAIL);
    if (vers < p.versions[0] || vers > p.versions[1]) {
      return acceptedReply(xid, PROG_MISMATCH, new XdrWriter().u32(p.versions[0]).u32(p.versions[1]).toBuffer());
    }
    const result = await p.handle({ xid, prog, vers, proc, args: r, client, transport });
    if (result === 'proc-unavail') return acceptedReply(xid, PROC_UNAVAIL);
    return acceptedReply(xid, SUCCESS, result);
  } catch (err) {
    return acceptedReply(xid, err instanceof GarbageArgs ? GARBAGE_ARGS : SYSTEM_ERR);
  }
}

export interface RpcListener {
  udpPort: number;
  tcpPort: number;
  close(): Promise<void>;
}

/** Atende os programas por UDP e TCP na mesma porta (0 = qualquer livre, igual nas duas). */
export async function listenRpc(port: number, host: string | undefined, programs: RpcProgram[]): Promise<RpcListener> {
  // Porta automática: a livre em TCP pode estar proibida em UDP (o Windows reserva faixas por
  // protocolo, "netsh int ipv4 show excludedportrange protocol=udp"); tenta outra.
  for (let attempt = 1; ; attempt++) {
    try {
      return await listenPair(port, host, programs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const udpRefused = (err as { udp?: boolean }).udp && (code === 'EACCES' || code === 'EADDRINUSE');
      if (port !== 0 || !udpRefused || attempt >= 20) throw err;
    }
  }
}

async function listenPair(port: number, host: string | undefined, programs: RpcProgram[]): Promise<RpcListener> {
  const tcp: Server = createServer((sock) => serveTcp(sock, programs));
  const sockets = new Set<Socket>();
  tcp.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen(port, host, () => {
      tcp.off('error', reject);
      resolve();
    });
  });
  const tcpPort = (tcp.address() as { port: number }).port;
  const udp: UdpSocket = createSocket(host && host.includes(':') ? 'udp6' : 'udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(tcpPort, host, () => {
        udp.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await new Promise<void>((r) => tcp.close(() => r()));
    throw Object.assign(err as Error, { udp: true });
  }
  udp.on('message', (msg, rinfo) => {
    void dispatch(msg, programs, rinfo.address, 'udp').then((reply) => {
      if (reply) udp.send(reply, rinfo.port, rinfo.address);
    });
  });
  udp.on('error', () => {});
  return {
    udpPort: tcpPort,
    tcpPort,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => tcp.close(() => r()));
      await new Promise<void>((r) => udp.close(() => r()));
    },
  };
}

/** TCP: cada mensagem vem em fragmentos com cabeçalho de 4 bytes (bit alto = último fragmento). */
function serveTcp(sock: Socket, programs: RpcProgram[]) {
  let pending = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let queue = Promise.resolve();
  const client = (sock.remoteAddress ?? '').replace(/^::ffff:/, '');
  sock.on('error', () => {});
  sock.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const header = pending.readUInt32BE(0);
      const len = header & 0x7fffffff;
      if (len > 4 * 1024 * 1024) {
        sock.destroy();
        return;
      }
      if (pending.length < 4 + len) break;
      fragments.push(pending.subarray(4, 4 + len));
      pending = pending.subarray(4 + len);
      if (header & 0x80000000) {
        const msg = Buffer.concat(fragments);
        fragments = [];
        // Respostas na ordem das chamadas.
        queue = queue.then(async () => {
          const reply = await dispatch(msg, programs, client, 'tcp');
          if (!reply || sock.destroyed) return;
          const head = Buffer.alloc(4);
          head.writeUInt32BE((0x80000000 | reply.length) >>> 0);
          sock.write(Buffer.concat([head, reply]));
        });
      }
    }
  });
}

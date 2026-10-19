import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { checkHost, checkPort, checkRoot, resolveInRoot, type LogFn, type RunningServer } from './common.ts';

/*
 * Servidor TFTP (RFC 1350) com negociação de opções (RFC 2347 blksize/RFC 2348, timeout e
 * tsize/RFC 2349). Cada transferência usa uma porta própria (TID), com retransmissão, volta do
 * número de bloco depois de 65535 e modo netascii. Nunca sai da pasta raiz.
 */

const Op = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 } as const;
const Err = { NotDefined: 0, NotFound: 1, Access: 2, DiskFull: 3, Illegal: 4, UnknownTid: 5, Exists: 6, Option: 8 } as const;

export interface TftpConfig {
  root: string;
  port?: number;
  /** Maior bloco aceito na negociação (8 a 65464). */
  maxBlockSize?: number;
  allowUpload?: boolean;
  allowOverwrite?: boolean;
  /** Avisa ao concluir cada transferência. */
  onTransfer?: (t: { dir: 'download' | 'upload'; file: string; bytes: number; client: string; ms: number }) => void;
  /** Endereço de escuta (padrão: todas as interfaces). */
  host?: string;
  retries?: number;
  timeoutMs?: number;
}

export function validateTftp(raw: Record<string, unknown>): Omit<TftpConfig, 'onTransfer'> {
  const max = raw.maxBlockSize === undefined || raw.maxBlockSize === '' ? 8192 : Number(raw.maxBlockSize);
  if (!Number.isInteger(max) || max < 8 || max > 65464) throw new Error('tamanho de bloco deve estar entre 8 e 65464');
  return {
    root: checkRoot(raw.root),
    port: checkPort(raw.port, 69),
    host: checkHost(raw.host),
    maxBlockSize: max,
    allowUpload: raw.allowUpload !== false,
    allowOverwrite: raw.allowOverwrite !== false,
  };
}

const packet = (op: number, ...parts: Buffer[]) => {
  const h = Buffer.alloc(2);
  h.writeUInt16BE(op, 0);
  return Buffer.concat([h, ...parts]);
};
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
};
const errorPacket = (code: number, msg: string) => packet(Op.ERROR, u16(code), Buffer.from(`${msg}\0`, 'ascii'));

/** Pedido RRQ/WRQ: arquivo, modo e opções (chaves em minúsculas). */
export function parseRequest(msg: Buffer): { file: string; mode: string; options: Map<string, string> } | undefined {
  const parts = msg.subarray(2).toString('latin1').split('\0');
  if (parts.length < 3 || !parts[0]) return undefined;
  const options = new Map<string, string>();
  for (let i = 2; i + 1 < parts.length; i += 2) if (parts[i]) options.set(parts[i].toLowerCase(), parts[i + 1]);
  return { file: parts[0], mode: parts[1].toLowerCase(), options };
}

/** netascii: LF → CR LF e CR → CR NUL (leitura); o inverso na escrita. */
export function toNetascii(b: Buffer): Buffer {
  const out: number[] = [];
  for (const c of b) {
    if (c === 0x0a) out.push(0x0d, 0x0a);
    else if (c === 0x0d) out.push(0x0d, 0x00);
    else out.push(c);
  }
  return Buffer.from(out);
}

export function fromNetascii(b: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0d && b[i + 1] === 0x0a) {
      out.push(0x0a);
      i++;
    } else if (b[i] === 0x0d && b[i + 1] === 0x00) {
      out.push(0x0d);
      i++;
    } else out.push(b[i]);
  }
  return Buffer.from(out);
}

export async function startTftp(cfg: TftpConfig, log: LogFn): Promise<RunningServer> {
  const main = createSocket('udp4');
  const transfers = new Set<Socket>();
  const retries = cfg.retries ?? 5;
  await new Promise<void>((resolve, reject) => {
    main.once('error', reject);
    main.bind(cfg.port ?? 69, cfg.host, () => {
      main.off('error', reject);
      resolve();
    });
  });
  const port = main.address().port;
  log(`TFTP escutando na porta ${port}, raiz ${cfg.root}`);

  main.on('message', (msg, rinfo) => {
    const op = msg.length >= 2 ? msg.readUInt16BE(0) : 0;
    if (op !== Op.RRQ && op !== Op.WRQ) return;
    void transfer(op, msg, rinfo).catch((err: Error) => log(`erro: ${err.message}`));
  });

  async function transfer(op: number, msg: Buffer, peer: RemoteInfo) {
    const req = parseRequest(msg);
    const sock = createSocket('udp4');
    transfers.add(sock);
    await new Promise<void>((r) => sock.bind(0, cfg.host, () => r()));
    const client = `${peer.address}:${peer.port}`;
    // O envio do dgram é assíncrono: o socket só fecha depois do último pacote sair (senão o
    // ERROR ou o ACK final se perdem e o cliente fica esperando).
    let pending = 0;
    let closing = false;
    const close = () => {
      transfers.delete(sock);
      try {
        sock.close();
      } catch { /* já fechado */ }
    };
    const send = (b: Buffer) => {
      pending++;
      sock.send(b, peer.port, peer.address, () => {
        if (--pending === 0 && closing) close();
      });
    };
    const done = () => {
      closing = true;
      if (pending === 0) close();
    };
    if (!req || (req.mode !== 'octet' && req.mode !== 'netascii')) {
      send(errorPacket(Err.Illegal, 'pedido inválido (modos: octet, netascii)'));
      return done();
    }
    const write = op === Op.WRQ;
    const path = await resolveInRoot(cfg.root, req.file, !write);
    if (!path) {
      log(`${client} ${write ? 'enviar' : 'baixar'} "${req.file}": fora da raiz ou inexistente`);
      send(errorPacket(write ? Err.Access : Err.NotFound, write ? 'acesso negado' : 'arquivo não encontrado'));
      return done();
    }

    // Opções (RFC 2347): só respondemos às que entendemos.
    const accepted = new Map<string, string>();
    let blksize = 512;
    let timeoutMs = cfg.timeoutMs ?? 3000;
    const bs = Number(req.options.get('blksize'));
    if (Number.isInteger(bs) && bs >= 8) {
      blksize = Math.min(bs, cfg.maxBlockSize ?? 8192, 65464);
      accepted.set('blksize', String(blksize));
    }
    const to = Number(req.options.get('timeout'));
    if (Number.isInteger(to) && to >= 1 && to <= 255) {
      timeoutMs = to * 1000;
      accepted.set('timeout', String(to));
    }

    /** Envia e espera o ACK `block` (ou DATA, na escrita), retransmitindo. */
    const exchange = (out: Buffer, accept: (m: Buffer) => boolean): Promise<Buffer> => new Promise((resolve, reject) => {
      let tries = 0;
      const timer = setInterval(() => {
        if (++tries > retries) {
          cleanup();
          reject(new Error('tempo esgotado'));
          return;
        }
        send(out);
      }, timeoutMs);
      const onMsg = (m: Buffer, r: RemoteInfo) => {
        if (r.address !== peer.address || r.port !== peer.port) {
          sock.send(errorPacket(Err.UnknownTid, 'TID desconhecido'), r.port, r.address);
          return;
        }
        if (m.length >= 2 && m.readUInt16BE(0) === Op.ERROR) {
          cleanup();
          reject(new Error(`o cliente cancelou: ${m.subarray(4).toString('latin1').replace(/\0.*$/, '')}`));
          return;
        }
        if (accept(m)) {
          cleanup();
          resolve(m);
        }
      };
      const cleanup = () => {
        clearInterval(timer);
        sock.off('message', onMsg);
      };
      sock.on('message', onMsg);
      send(out);
    });
    const isAck = (n: number) => (m: Buffer) => m.length >= 4 && m.readUInt16BE(0) === Op.ACK && m.readUInt16BE(2) === (n & 0xffff);
    const oack = () => packet(Op.OACK, ...[...accepted].flatMap(([k, v]) => [Buffer.from(`${k}\0${v}\0`, 'ascii')]));
    const started = Date.now();

    if (!write) {
      let fh: FileHandle | undefined;
      try {
        fh = await open(path, 'r');
        // Confere o arquivo já aberto: entre conferir pelo caminho e abrir, ele poderia ser trocado.
        const st = await fh.stat();
        if (!st.isFile()) throw Object.assign(new Error('não é um arquivo'), { code: 'EISDIR' });
        if (req.options.has('tsize') && req.mode === 'octet') accepted.set('tsize', String(st.size));
        let data: Buffer | undefined;
        if (req.mode === 'netascii') data = toNetascii(await fh.readFile());
        if (accepted.size) await exchange(oack(), isAck(0));
        let block = 1;
        let offset = 0;
        let sent = 0;
        for (;;) {
          let chunk: Buffer;
          if (data) chunk = data.subarray(offset, offset + blksize);
          else {
            chunk = Buffer.alloc(blksize);
            const { bytesRead } = await fh.read(chunk, 0, blksize, offset);
            chunk = chunk.subarray(0, bytesRead);
          }
          await exchange(packet(Op.DATA, u16(block), chunk), isAck(block));
          offset += chunk.length;
          sent += chunk.length;
          if (chunk.length < blksize) break;
          block = (block + 1) & 0xffff; // volta para 0 depois de 65535
        }
        log(`${client} baixou "${req.file}" (${sent} bytes, ${Date.now() - started} ms)`);
        cfg.onTransfer?.({ dir: 'download', file: req.file, bytes: sent, client, ms: Date.now() - started });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const code = e.code === 'ENOENT' ? Err.NotFound : e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EISDIR' ? Err.Access : Err.NotDefined;
        if (!/tempo esgotado|cancelou/.test(e.message)) send(errorPacket(code, e.message));
        log(`${client} baixar "${req.file}": ${e.message}`);
      } finally {
        await fh?.close();
        done();
      }
      return;
    }

    // Escrita (WRQ): grava num temporário e só troca ao final.
    if (cfg.allowUpload === false) {
      send(errorPacket(Err.Access, 'envio desativado neste servidor'));
      log(`${client} enviar "${req.file}": envio desativado`);
      return done();
    }
    const exists = await stat(path).then(() => true, () => false);
    if (exists && cfg.allowOverwrite === false) {
      send(errorPacket(Err.Exists, 'o arquivo já existe'));
      log(`${client} enviar "${req.file}": já existe`);
      return done();
    }
    if (req.options.has('tsize')) accepted.set('tsize', req.options.get('tsize')!);
    const tmp = `${path}.multterm-upload`;
    let fh: FileHandle | undefined;
    try {
      fh = await open(tmp, 'w');
      const parts: Buffer[] = [];
      let expected = 1;
      let received = 0;
      const isData = (m: Buffer) => m.length >= 4 && m.readUInt16BE(0) === Op.DATA && m.readUInt16BE(2) === (expected & 0xffff);
      let reply = accepted.size ? oack() : packet(Op.ACK, u16(0));
      for (;;) {
        const m = await exchange(reply, isData);
        const chunk = m.subarray(4);
        if (req.mode === 'netascii') parts.push(chunk);
        else await fh.write(chunk);
        received += chunk.length;
        reply = packet(Op.ACK, u16(expected));
        if (chunk.length < blksize) {
          send(reply);
          break;
        }
        expected = (expected + 1) & 0xffff;
      }
      if (parts.length) await fh.write(fromNetascii(Buffer.concat(parts)));
      await fh.close();
      fh = undefined;
      await rename(tmp, path);
      log(`${client} enviou "${req.file}" (${received} bytes, ${Date.now() - started} ms)`);
      cfg.onTransfer?.({ dir: 'upload', file: req.file, bytes: received, client, ms: Date.now() - started });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (!/tempo esgotado|cancelou/.test(e.message)) send(errorPacket(e.code === 'ENOSPC' ? Err.DiskFull : Err.NotDefined, e.message));
      log(`${client} enviar "${req.file}": ${e.message}`);
      await fh?.close().catch(() => {});
      await rm(tmp, { force: true });
    } finally {
      done();
    }
  }

  return {
    port,
    stop: async () => {
      for (const s of transfers) {
        try {
          s.close();
        } catch { /* já fechado */ }
      }
      await new Promise<void>((r) => main.close(() => r()));
      log('TFTP parado');
    },
  };
}

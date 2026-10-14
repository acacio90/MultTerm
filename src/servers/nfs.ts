import { randomBytes } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { relative, sep } from 'node:path';
import { checkHost, checkPort, checkRoot, resolveInRoot, type LogFn, type RunningServer } from './common.ts';
import { GarbageArgs, listenRpc, XdrWriter, type RpcCall, type RpcListener, type RpcProgram } from './rpc.ts';

/*
 * Servidor NFSv3 somente leitura de uma pasta (RFC 1813), para equipamentos que fazem boot ou
 * atualização por NFS. Três programas ONC RPC: portmapper v2 (porta 111, para o cliente achar os
 * outros), MOUNT v1/v3 e NFS v3 — os dois últimos na mesma porta (2049), por UDP e TCP.
 * Nada é gravado: as operações de escrita respondem NFS3ERR_ROFS. Nenhum nome sai da raiz.
 */

export interface NfsConfig {
  root: string;
  port?: number;
  host?: string;
  /** Portmapper na porta 111 (a maioria dos clientes precisa dele para achar o MOUNT e o NFS). */
  portmap?: boolean;
  portmapPort?: number;
  /** Clientes permitidos: IPv4 ou faixas CIDR; vazio = qualquer um. */
  allow?: string[];
}

export function validateNfs(raw: Record<string, unknown>): NfsConfig {
  const allow = typeof raw.allow === 'string'
    ? raw.allow.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  for (const a of allow) if (!parseCidr(a)) throw new Error(`cliente permitido inválido: ${a} (use IPv4 ou faixa como 10.0.0.0/24)`);
  return {
    root: checkRoot(raw.root),
    port: checkPort(raw.port, 2049),
    host: checkHost(raw.host),
    portmap: raw.portmap !== false,
    portmapPort: checkPort(raw.portmapPort, 111),
    allow,
  };
}

// ---------- clientes permitidos ----------

function ipToInt(ip: string) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

/** "10.0.0.0/24" ou "10.0.0.5" → rede e máscara; undefined se inválido. */
export function parseCidr(text: string): { net: number; mask: number } | undefined {
  const [ip, bits = '32'] = text.split('/');
  const n = Number(bits);
  if (!isIPv4(ip) || !/^\d+$/.test(bits) || n < 0 || n > 32) return undefined;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return { net: (ipToInt(ip) & mask) >>> 0, mask };
}

export function clientAllowed(ip: string, allow: string[]): boolean {
  if (!allow.length) return true;
  const v4 = ip.replace(/^::ffff:/, '');
  if (!isIPv4(v4)) return false;
  const n = ipToInt(v4);
  return allow.some((a) => {
    const c = parseCidr(a);
    return !!c && ((n & c.mask) >>> 0) === c.net;
  });
}

// ---------- constantes ----------

const PORTMAP = 100000;
const MOUNT = 100005;
const NFS = 100003;
const IPPROTO_TCP = 6;
const IPPROTO_UDP = 17;

const NFS3_OK = 0;
const NFS3ERR_NOENT = 2;
const NFS3ERR_IO = 5;
const NFS3ERR_ACCES = 13;
const NFS3ERR_NOTDIR = 20;
const NFS3ERR_ISDIR = 21;
const NFS3ERR_INVAL = 22;
const NFS3ERR_ROFS = 30;
const NFS3ERR_NAMETOOLONG = 63;
const NFS3ERR_STALE = 70;
const NFS3ERR_BADHANDLE = 10001;
const NFS3ERR_BAD_COOKIE = 10003;

const MNT3_OK = 0;
const MNT3ERR_NOENT = 2;
const MNT3ERR_ACCES = 13;
const MNT3ERR_NOTDIR = 20;

const NF3REG = 1;
const NF3DIR = 2;

/** Erro NFS com o código do protocolo. */
class NfsError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`NFS ${status}`);
    this.status = status;
  }
}

// ---------- servidor ----------

export async function startNfs(cfg: NfsConfig, log: LogFn): Promise<RunningServer> {
  const root = cfg.root;
  const allow = cfg.allow ?? [];
  // Identificadores de arquivo: 8 bytes desta execução + 8 bytes do caminho registrado. Depois de
  // reiniciar o servidor, um identificador antigo vira NFS3ERR_STALE (o cliente monta de novo).
  const boot = randomBytes(8);
  const ids = new Map<string, bigint>(); // caminho relativo ("" = raiz) → id
  const paths = new Map<bigint, string>();
  let nextId = 1n;
  const handleOf = (rel: string) => {
    let id = ids.get(rel);
    if (id === undefined) {
      id = nextId++;
      ids.set(rel, id);
      paths.set(id, rel);
    }
    const fh = Buffer.alloc(16);
    boot.copy(fh, 0);
    fh.writeBigUInt64BE(id, 8);
    return fh;
  };
  handleOf('');
  const fsid = BigInt(`0x${boot.subarray(0, 4).toString('hex')}`);
  const readers = new Set<string>(); // "cliente arquivo" já registrados no log

  /** Identificador → caminho real (sempre dentro da raiz). */
  async function resolveHandle(fh: Buffer): Promise<{ rel: string; real: string }> {
    if (fh.length !== 16) throw new NfsError(NFS3ERR_BADHANDLE);
    if (!fh.subarray(0, 8).equals(boot)) throw new NfsError(NFS3ERR_STALE);
    const rel = paths.get(fh.readBigUInt64BE(8));
    if (rel === undefined) throw new NfsError(NFS3ERR_STALE);
    const real = await resolveInRoot(root, rel);
    if (!real) throw new NfsError(NFS3ERR_STALE);
    return { rel, real };
  }

  const relOf = async (real: string) => {
    const r = relative(await resolveInRoot(root, '') ?? root, real);
    return r.split(sep).join('/');
  };

  type Stats = Awaited<ReturnType<typeof statOf>>;
  const statOf = (real: string) => stat(real, { bigint: true });

  function fattr(w: XdrWriter, st: Stats) {
    const dir = st.isDirectory();
    w.u32(dir ? NF3DIR : NF3REG)
      .u32(dir ? 0o555 : 0o444)
      .u32(dir ? 2 : 1)
      .u32(0).u32(0) // uid, gid
      .u64(dir ? 4096n : st.size)
      .u64(dir ? 4096n : st.size)
      .u32(0).u32(0) // rdev
      .u64(fsid)
      .u64(st.ino || 1n);
    for (const t of [st.atimeNs, st.mtimeNs, st.ctimeNs]) {
      w.u32(Number(t / 1_000_000_000n) >>> 0).u32(Number(t % 1_000_000_000n));
    }
  }

  async function postOpAttr(w: XdrWriter, real: string | undefined) {
    const st = real ? await statOf(real).catch(() => undefined) : undefined;
    w.bool(!!st);
    if (st) fattr(w, st);
  }

  const wccNone = (w: XdrWriter) => w.bool(false).bool(false);

  function checkName(name: string) {
    if (name.length > 255) throw new NfsError(NFS3ERR_NAMETOOLONG);
    // eslint-disable-next-line no-control-regex
    if (!name || /[\\/\x00-\x1f]/.test(name)) throw new NfsError(NFS3ERR_INVAL);
  }

  async function lookup(dir: { rel: string; real: string }, name: string): Promise<{ rel: string; real: string }> {
    checkName(name);
    const st = await statOf(dir.real);
    if (!st.isDirectory()) throw new NfsError(NFS3ERR_NOTDIR);
    if (name === '.') return dir;
    if (name === '..') {
      const parentRel = dir.rel.includes('/') ? dir.rel.slice(0, dir.rel.lastIndexOf('/')) : '';
      const real = await resolveInRoot(root, parentRel);
      if (!real) throw new NfsError(NFS3ERR_NOENT);
      return { rel: parentRel, real };
    }
    const real = await resolveInRoot(root, dir.rel ? `${dir.rel}/${name}` : name);
    if (!real) throw new NfsError(NFS3ERR_NOENT);
    return { rel: await relOf(real), real };
  }

  /** Entradas do diretório em ordem estável (com "." e ".."), para paginar pelo cookie. */
  async function listDir(dir: { rel: string; real: string }) {
    const names = (await readdir(dir.real)).sort((a, b) => a.localeCompare(b));
    return ['.', '..', ...names];
  }

  const nfs: RpcProgram = {
    prog: NFS,
    versions: [3, 3],
    async handle(call) {
      const a = call.args;
      const w = new XdrWriter();
      const denied = !clientAllowed(call.client, allow);
      try {
        switch (call.proc) {
          case 0: // NULL
            return w.toBuffer();
          case 1: { // GETATTR
            const f = await resolveHandle(a.opaque(64));
            if (denied) throw new NfsError(NFS3ERR_ACCES);
            const st = await statOf(f.real);
            w.u32(NFS3_OK);
            fattr(w, st);
            return w.toBuffer();
          }
          case 3: { // LOOKUP
            const dir = await resolveHandle(a.opaque(64));
            const name = a.string(1024);
            if (denied) throw new NfsError(NFS3ERR_ACCES);
            try {
              const obj = await lookup(dir, name);
              w.u32(NFS3_OK).opaque(handleOf(obj.rel));
              await postOpAttr(w, obj.real);
              await postOpAttr(w, dir.real);
            } catch (err) {
              if (!(err instanceof NfsError)) throw err;
              w.u32(err.status);
              await postOpAttr(w, dir.real);
            }
            return w.toBuffer();
          }
          case 4: { // ACCESS
            const f = await resolveHandle(a.opaque(64));
            const asked = a.u32();
            if (denied) throw new NfsError(NFS3ERR_ACCES);
            const st = await statOf(f.real);
            // Leitura, busca e execução; nada de escrita.
            const granted = (st.isDirectory() ? 0x01 | 0x02 | 0x20 : 0x01 | 0x20) & asked;
            w.u32(NFS3_OK);
            await postOpAttr(w, f.real);
            w.u32(granted);
            return w.toBuffer();
          }
          case 5: { // READLINK: links aparecem como o destino (dentro da raiz), nunca como link
            const f = await resolveHandle(a.opaque(64));
            w.u32(NFS3ERR_INVAL);
            await postOpAttr(w, f.real);
            return w.toBuffer();
          }
          case 6: { // READ
            const f = await resolveHandle(a.opaque(64));
            const offset = a.u64();
            const count = Math.min(a.u32(), 65536);
            if (denied) throw new NfsError(NFS3ERR_ACCES);
            const st = await statOf(f.real);
            if (st.isDirectory()) throw new NfsError(NFS3ERR_ISDIR);
            const fd = await open(f.real, 'r');
            let n = 0;
            const buf = Buffer.alloc(count);
            try {
              if (offset < st.size) n = (await fd.read(buf, 0, count, Number(offset))).bytesRead;
            } finally {
              await fd.close();
            }
            if (offset === 0n) {
              const key = `${call.client} ${f.rel}`;
              if (!readers.has(key)) {
                readers.add(key);
                log(`${call.client} lendo /${f.rel} (${st.size} bytes)`);
              }
            }
            w.u32(NFS3_OK).bool(true);
            fattr(w, st);
            w.u32(n).bool(offset + BigInt(n) >= st.size).opaque(buf.subarray(0, n));
            return w.toBuffer();
          }
          case 16: // READDIR
          case 17: { // READDIRPLUS
            const plus = call.proc === 17;
            const dir = await resolveHandle(a.opaque(64));
            const cookie = Number(a.u64());
            a.fixed(8); // cookieverf
            const dircount = a.u32();
            const maxcount = plus ? a.u32() : dircount;
            if (denied) throw new NfsError(NFS3ERR_ACCES);
            const st = await statOf(dir.real);
            if (!st.isDirectory()) throw new NfsError(NFS3ERR_NOTDIR);
            const entries = await listDir(dir);
            if (cookie > entries.length) throw new NfsError(NFS3ERR_BAD_COOKIE);
            const head = new XdrWriter().u32(NFS3_OK).bool(true);
            fattr(head, st);
            head.fixed(Buffer.alloc(8)); // cookieverf
            const body = new XdrWriter();
            const limit = Math.max(512, Math.min(maxcount, 65536)) - head.length - 16;
            let i = cookie;
            for (; i < entries.length; i++) {
              const name = entries[i];
              const obj = await lookup(dir, name).catch(() => undefined);
              if (!obj) continue;
              const e = new XdrWriter().bool(true);
              const est = await statOf(obj.real).catch(() => undefined);
              e.u64(est?.ino || BigInt(i + 1)).string(name).u64(i + 1);
              if (plus) {
                e.bool(!!est);
                if (est) fattr(e, est);
                e.bool(true).opaque(handleOf(obj.rel));
              }
              if (body.length + e.length > limit && i > cookie) break;
              body.raw(e.toBuffer());
            }
            body.bool(false).bool(i >= entries.length); // fim da lista, eof
            return Buffer.concat([head.toBuffer(), body.toBuffer()]);
          }
          case 18: { // FSSTAT
            const f = await resolveHandle(a.opaque(64));
            w.u32(NFS3_OK);
            await postOpAttr(w, f.real);
            w.u64(1n << 40n).u64(0n).u64(0n).u64(1_000_000n).u64(0n).u64(0n).u32(0);
            return w.toBuffer();
          }
          case 19: { // FSINFO
            const f = await resolveHandle(a.opaque(64));
            w.u32(NFS3_OK);
            await postOpAttr(w, f.real);
            w.u32(65536).u32(65536).u32(4096) // rtmax, rtpref, rtmult
              .u32(65536).u32(65536).u32(4096) // wtmax, wtpref, wtmult
              .u32(65536) // dtpref
              .u64(1n << 62n) // maxfilesize
              .u32(0).u32(1_000_000) // time_delta
              .u32(0x08); // FSF3_HOMOGENEOUS
            return w.toBuffer();
          }
          case 20: { // PATHCONF
            const f = await resolveHandle(a.opaque(64));
            w.u32(NFS3_OK);
            await postOpAttr(w, f.real);
            w.u32(1).u32(255).bool(true).bool(true).bool(true).bool(true); // case_insensitive (Windows)
            return w.toBuffer();
          }
          // Escrita: somente leitura. O erro de cada procedimento leva os dados "antes/depois"
          // (wcc_data) do objeto ou da pasta — aqui sempre ausentes.
          case 2: case 7: case 21: // SETATTR, WRITE, COMMIT
          case 8: case 9: case 10: case 11: case 12: case 13: // CREATE, MKDIR, SYMLINK, MKNOD, REMOVE, RMDIR
            w.u32(NFS3ERR_ROFS);
            wccNone(w);
            return w.toBuffer();
          case 14: // RENAME: wcc das duas pastas
            w.u32(NFS3ERR_ROFS);
            wccNone(w);
            wccNone(w);
            return w.toBuffer();
          case 15: // LINK: atributos do arquivo + wcc da pasta
            w.u32(NFS3ERR_ROFS).bool(false);
            wccNone(w);
            return w.toBuffer();
          default:
            return 'proc-unavail';
        }
      } catch (err) {
        if (err instanceof GarbageArgs) throw err;
        const status = err instanceof NfsError ? err.status
          : (err as NodeJS.ErrnoException).code === 'ENOENT' ? NFS3ERR_NOENT
            : (err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EPERM' ? NFS3ERR_ACCES
              : NFS3ERR_IO;
        // Resposta de erro genérica: status + post_op_attr ausente (serve para GETATTR, ACCESS, READ,
        // READDIR*, FSSTAT, FSINFO e PATHCONF — todos têm o post_op_attr logo após o status).
        const e = new XdrWriter().u32(status);
        if (call.proc !== 1) e.bool(false);
        return e.toBuffer();
      }
    },
  };

  const mount: RpcProgram = {
    prog: MOUNT,
    versions: [1, 3],
    async handle(call) {
      const a = call.args;
      switch (call.proc) {
        case 0: // NULL
          return Buffer.alloc(0);
        case 1: { // MNT
          const path = a.string(1024);
          const w = new XdrWriter();
          const fail = (status: number) => new XdrWriter().u32(status).toBuffer();
          if (!clientAllowed(call.client, allow)) {
            log(`montagem recusada para ${call.client} (fora dos clientes permitidos)`);
            return fail(MNT3ERR_ACCES);
          }
          // Exporta a raiz como "/"; caminhos abaixo dela montam a subpasta.
          const real = await resolveInRoot(root, path.replace(/^\/+/, ''));
          if (!real) return fail(MNT3ERR_NOENT);
          const st = await statOf(real).catch(() => undefined);
          if (!st?.isDirectory()) return fail(MNT3ERR_NOTDIR);
          const fh = handleOf(await relOf(real));
          log(`${call.client} montou ${path || '/'}`);
          if (call.vers === 3) return w.u32(MNT3_OK).opaque(fh).u32(2).u32(1).u32(0).toBuffer(); // AUTH_UNIX, AUTH_NONE
          // MOUNT v1/v2: identificador fixo de 32 bytes.
          const fixed = Buffer.alloc(32);
          fh.copy(fixed);
          return w.u32(0).fixed(fixed).toBuffer();
        }
        case 2: // DUMP
          return new XdrWriter().bool(false).toBuffer();
        case 3: // UMNT
          a.string(1024);
          return Buffer.alloc(0);
        case 4: // UMNTALL
          return Buffer.alloc(0);
        case 5: // EXPORT: "/" para todos (ou os grupos permitidos)
          {
            const w = new XdrWriter().bool(true).string('/');
            for (const g of allow) w.bool(true).string(g);
            return w.bool(false).bool(false).toBuffer();
          }
        default:
          return 'proc-unavail';
      }
    },
  };

  let nfsListener: RpcListener | undefined;
  let portmapListener: RpcListener | undefined;
  nfsListener = await listenRpc(cfg.port ?? 2049, cfg.host, [nfs, mount]);
  const port = nfsListener.tcpPort;

  const portmap: RpcProgram = {
    prog: PORTMAP,
    versions: [2, 2], // clientes que pedem rpcbind v3/v4 recebem PROG_MISMATCH e voltam para a v2
    handle(call: RpcCall) {
      const a = call.args;
      switch (call.proc) {
        case 0:
          return Buffer.alloc(0);
        case 3: { // GETPORT
          const prog = a.u32();
          const vers = a.u32();
          const prot = a.u32();
          a.u32();
          const known = (prog === NFS && vers === 3) || (prog === MOUNT && vers >= 1 && vers <= 3) || (prog === PORTMAP && vers === 2);
          const ok = known && (prot === IPPROTO_TCP || prot === IPPROTO_UDP);
          return new XdrWriter().u32(ok ? (prog === PORTMAP ? portmapListener?.tcpPort ?? 0 : port) : 0).toBuffer();
        }
        case 4: { // DUMP
          const w = new XdrWriter();
          const maps: [number, number][] = [[NFS, 3], [MOUNT, 1], [MOUNT, 2], [MOUNT, 3]];
          for (const [prog, vers] of maps) {
            for (const prot of [IPPROTO_TCP, IPPROTO_UDP]) w.bool(true).u32(prog).u32(vers).u32(prot).u32(port);
          }
          return w.bool(false).toBuffer();
        }
        default:
          return 'proc-unavail';
      }
    },
  };
  if (cfg.portmap !== false) {
    try {
      portmapListener = await listenRpc(cfg.portmapPort ?? 111, cfg.host, [portmap]);
    } catch (err) {
      await nfsListener.close();
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EADDRINUSE') {
        throw Object.assign(new Error(`a porta ${cfg.portmapPort ?? 111} (portmapper) já está em uso — outro servidor NFS ou "rpcbind" rodando?`), { code: 'PORTMAP' });
      }
      throw err;
    }
  }
  log(`NFS somente leitura de ${root} na porta ${port}${portmapListener ? `, portmapper na ${portmapListener.tcpPort}` : ' (sem portmapper)'}`);
  if (allow.length) log(`clientes permitidos: ${allow.join(', ')}`);
  return {
    port,
    async stop() {
      await portmapListener?.close();
      await nfsListener?.close();
      nfsListener = undefined;
      portmapListener = undefined;
      log('NFS parado');
    },
  };
}

/** Números dos programas RPC (os clientes de teste usam). */
export const NFS_PROGRAMS = { PORTMAP, MOUNT, NFS };

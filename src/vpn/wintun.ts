import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

/*
 * Adaptador de rede virtual pelo Wintun (wintun.dll, assinada pela WireGuard LLC, usada só pela
 * API pública de wintun.h). Criar o adaptador exige administrador. O laço de leitura espera o
 * evento do Wintun numa thread do koffi (chamada assíncrona), sem travar o Node.
 */

/** Interface de pacotes IP (o Wintun ou, nos testes, uma implementação em memória). */
export interface Tun {
  /** Índice da interface no Windows (para IP/rotas), quando houver. */
  readonly luid?: bigint;
  onPacket?: (ip: Buffer) => void;
  write(ip: Buffer): void;
  close(): void;
}

const ERROR_NO_MORE_ITEMS = 259;
const WAIT_TIMEOUT = 258;

type Fn = ((...args: unknown[]) => unknown) & { async: (...args: unknown[]) => void };

interface WintunApi {
  CreateAdapter: Fn;
  CloseAdapter: Fn;
  GetAdapterLUID: Fn;
  StartSession: Fn;
  EndSession: Fn;
  GetReadWaitEvent: Fn;
  ReceivePacket: Fn;
  ReleaseReceivePacket: Fn;
  AllocateSendPacket: Fn;
  SendPacket: Fn;
  WaitForSingleObject: Fn;
  /** Cópia de memória (o Electron proíbe ArrayBuffer sobre memória externa: koffi.view derruba o processo). */
  Copy: Fn;
  GetLastError: Fn;
  koffi: {
    view(ref: unknown, len: number): ArrayBuffer;
    alloc(type: unknown, len: number): unknown;
    decode(ref: unknown, type: string): unknown;
    free(v: unknown): void;
  };
}

let api: WintunApi | undefined;

function load(dllPath: string): WintunApi {
  if (api) return api;
  const require = createRequire(import.meta.url);
  const koffi = require('koffi');
  const lib = koffi.load(dllPath);
  const k32 = koffi.load('kernel32.dll');
  const GUID = koffi.struct('WINTUN_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
  const f = (sig: string) => lib.func(sig) as Fn;
  api = {
    CreateAdapter: lib.func('__stdcall', 'WintunCreateAdapter', 'void *', ['str16', 'str16', koffi.pointer(GUID)]) as Fn,
    CloseAdapter: f('void __stdcall WintunCloseAdapter(void *adapter)'),
    GetAdapterLUID: f('void __stdcall WintunGetAdapterLUID(void *adapter, _Out_ uint64_t *luid)'),
    StartSession: f('void * __stdcall WintunStartSession(void *adapter, uint32_t capacity)'),
    EndSession: f('void __stdcall WintunEndSession(void *session)'),
    GetReadWaitEvent: f('void * __stdcall WintunGetReadWaitEvent(void *session)'),
    ReceivePacket: f('void * __stdcall WintunReceivePacket(void *session, _Out_ uint32_t *size)'),
    ReleaseReceivePacket: f('void __stdcall WintunReleaseReceivePacket(void *session, void *packet)'),
    AllocateSendPacket: f('void * __stdcall WintunAllocateSendPacket(void *session, uint32_t size)'),
    SendPacket: f('void __stdcall WintunSendPacket(void *session, void *packet)'),
    WaitForSingleObject: k32.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)') as Fn,
    Copy: k32.func('void __stdcall RtlMoveMemory(void *dst, void *src, uintptr_t len)') as Fn,
    GetLastError: k32.func('uint32_t __stdcall GetLastError()') as Fn,
    koffi,
  };
  return api;
}

export class WintunTun implements Tun {
  readonly luid: bigint;
  onPacket?: (ip: Buffer) => void;
  private readonly w: WintunApi;
  private adapter: unknown;
  private session: unknown;
  private event: unknown;
  private closed = false;

  private readonly trace: (m: string) => void;

  constructor(dllPath: string, name: string, trace: (m: string) => void = () => {}) {
    this.trace = trace;
    this.w = load(dllPath);
    const g = randomBytes(16);
    const guid = { d1: g.readUInt32LE(0), d2: g.readUInt16LE(4), d3: g.readUInt16LE(6), d4: [...g.subarray(8)] };
    this.adapter = this.w.CreateAdapter(name, 'MultTerm', guid);
    if (!this.adapter) throw new Error(`não foi possível criar o adaptador de rede (erro ${this.w.GetLastError()}; o MultTerm precisa de administrador)`);
    const luid = [0n];
    this.w.GetAdapterLUID(this.adapter, luid);
    this.luid = BigInt(luid[0]);
    trace(`wintun: adaptador criado, LUID ${this.luid}`);
    this.session = this.w.StartSession(this.adapter, 0x400000);
    if (!this.session) {
      this.w.CloseAdapter(this.adapter);
      throw new Error(`não foi possível iniciar o adaptador (erro ${this.w.GetLastError()})`);
    }
    trace("wintun: sessão iniciada");
    this.event = this.w.GetReadWaitEvent(this.session);
    trace("wintun: evento de leitura obtido");
    this.readLoop();
  }

  private drain(): boolean {
    let got = false;
    for (;;) {
      const size = [0];
      const ptr = this.w.ReceivePacket(this.session, size);
      if (!ptr) {
        const err = this.w.GetLastError();
        if (err !== ERROR_NO_MORE_ITEMS && !this.closed) this.closed = true;
        return got;
      }
      got = true;
      const packet = Buffer.alloc(size[0]); // cópia: o anel é reaproveitado
      this.w.Copy(packet, ptr, size[0]);
      this.w.ReleaseReceivePacket(this.session, ptr);
      try {
        this.onPacket?.(packet);
      } catch { /* pacote ruim não derruba o laço */ }
    }
  }

  private loops = 0;

  private readLoop() {
    if (this.loops++ < 3) this.trace(`wintun: laço de leitura ${this.loops}`);
    if (this.closed) return;
    if (this.drain()) {
      setImmediate(() => this.readLoop());
      return;
    }
    // Espera o evento numa thread do koffi (até 500 ms, para notar o fechamento).
    this.w.WaitForSingleObject.async(this.event, 500, (err: unknown, res: number) => {
      if (this.closed) return;
      if (err) {
        this.closed = true;
        return;
      }
      if (res === WAIT_TIMEOUT) this.readLoop();
      else setImmediate(() => this.readLoop());
    });
  }

  write(ip: Buffer) {
    if (this.closed) return;
    const ptr = this.w.AllocateSendPacket(this.session, ip.length);
    if (!ptr) return; // anel cheio: descarta (o TCP retransmite)
    this.w.Copy(ptr, ip, ip.length);
    this.w.SendPacket(this.session, ptr);
  }

  close() {
    if (this.closed && !this.session) return;
    this.closed = true;
    // Espera a leitura assíncrona em andamento terminar (timeout de 500 ms) antes de liberar.
    setTimeout(() => {
      if (this.session) this.w.EndSession(this.session);
      if (this.adapter) this.w.CloseAdapter(this.adapter);
      this.session = this.adapter = undefined;
    }, 600);
  }
}

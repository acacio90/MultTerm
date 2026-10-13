import { spawn } from 'node:child_process';
import { join } from 'node:path';

/*
 * Captura de pacotes com o dumpcap do Wireshark (driver Npcap). Com o Npcap no modo padrão
 * (sem "restringir a administradores"), captura sem elevar o app. Para parar, o processo é
 * encerrado: o pcapng gravado até ali continua válido (verificado com capinfos).
 */

export interface CaptureTools {
  dumpcap?: string;
  wireshark?: string;
}

/** Procura o dumpcap e o Wireshark nas pastas de instalação padrão. */
export function findCaptureTools(env: { programFiles?: string[]; fileExists: (p: string) => boolean }): CaptureTools {
  const dirs = (env.programFiles ?? []).filter(Boolean).map((d) => join(d, 'Wireshark'));
  const pick = (exe: string) => dirs.map((d) => join(d, exe)).find((p) => env.fileExists(p));
  return { dumpcap: pick('dumpcap.exe'), wireshark: pick('Wireshark.exe') };
}

export interface CaptureInterface {
  index: string;
  device: string;
  name: string;
}

/** Saída de "dumpcap -D": "11. \Device\NPF_Loopback (Adapter for loopback traffic capture)". */
export function parseInterfaces(stdout: string): CaptureInterface[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => /^(\d+)\.\s+(\S+)(?:\s+\((.*)\))?\s*$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(([, index, device, name]) => ({ index, device, name: name || device }));
}

export interface CaptureRequest {
  iface: string;
  filter: string;
  maxPackets?: number;
  maxSeconds?: number;
}

const optionalInt = (v: unknown, max: number, label: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${label} deve estar entre 1 e ${max}`);
  return n;
};

export function validateCapture(raw: unknown): CaptureRequest {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const iface = String(o.iface ?? '').trim();
  if (!/^(\d+|\\Device\\NPF_[\w{}-]+)$/.test(iface)) throw new Error('escolha uma interface de captura');
  const filter = String(o.filter ?? '').trim();
  if (filter.length > 1000 || /[\x00-\x1f]/.test(filter) || filter.startsWith('-')) {
    throw new Error('filtro de captura inválido');
  }
  return {
    iface,
    filter,
    maxPackets: optionalInt(o.maxPackets, 10_000_000, 'limite de pacotes'),
    maxSeconds: optionalInt(o.maxSeconds, 86_400, 'limite de tempo (s)'),
  };
}

/** Argumentos do dumpcap. O filtro vai como um único argumento (sintaxe BPF/libpcap). */
export function captureArgs(req: CaptureRequest, file: string): string[] {
  return [
    '-i', req.iface,
    ...(req.filter ? ['-f', req.filter] : []),
    ...(req.maxPackets ? ['-c', String(req.maxPackets)] : []),
    ...(req.maxSeconds ? ['-a', `duration:${req.maxSeconds}`] : []),
    '-w', file,
  ];
}

/** Última contagem informada pelo dumpcap ("Packets: 12" durante, "Packets captured: 12" no fim). */
export function parsePacketCount(text: string): number | undefined {
  const all = [...text.matchAll(/Packets(?: captured)?: (\d+)/g)];
  return all.length ? Number(all.at(-1)![1]) : undefined;
}

/** Traduz os erros mais comuns do dumpcap. */
export function captureErrorMessage(stderr: string): string {
  const text = stderr.replace(/\r/g, '');
  if (/permission|access is denied|acesso negado/i.test(text)) {
    return 'sem permissão para capturar: o Npcap está restrito a administradores (reinstale o Npcap sem essa opção ou rode como administrador)';
  }
  if (/invalid capture filter|can't parse filter/i.test(text)) {
    return 'filtro de captura inválido (sintaxe BPF, ex.: host 10.0.0.5 and port 22)';
  }
  if (/no interface|no such device|could not be initiated on capture device|interface.*not found/i.test(text)) {
    return 'não foi possível abrir a interface de captura (ela existe e o Npcap está ativo?)';
  }
  const last = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^Please check/i.test(l)).at(-1);
  return last ? `o dumpcap falhou: ${last.replace(/^dumpcap:\s*/, '')}` : 'o dumpcap falhou';
}

/** Nome do arquivo: multterm-captura-20261013-153045.pcapng */
export function captureFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `multterm-captura-${stamp}.pcapng`;
}

export interface CaptureResult {
  file: string;
  packets: number;
}

/** Captura até o limite, até falhar ou até o sinal ser abortado (Parar). */
export function runCapture(
  dumpcap: string,
  req: CaptureRequest,
  file: string,
  opts: { signal?: AbortSignal; onPackets?: (n: number) => void } = {},
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(dumpcap, captureArgs(req, file), { windowsHide: true });
    let stderr = '';
    let packets = 0;
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
      const n = parsePacketCount(chunk);
      if (n !== undefined && n !== packets) {
        packets = n;
        opts.onPackets?.(n);
      }
    });
    child.once('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`não foi possível executar o dumpcap: ${err.message}`));
    });
    child.once('exit', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      packets = parsePacketCount(stderr) ?? packets;
      if (opts.signal?.aborted || code === 0) resolve({ file, packets });
      else reject(new Error(captureErrorMessage(stderr)));
    });
  });
}

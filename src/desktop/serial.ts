import { autoDetect, type BindingInterface } from '@serialport/bindings-cpp';
import { access, constants } from 'node:fs/promises';
import { SerialPortStream } from '@serialport/stream';
import { serialSettings, type Session } from '../sessions/model.ts';
import type { TerminalProcess } from './terminals.ts';

/**
 * Sessão serial numa aba (como o tipo "Serial" do PuTTY): a porta vira um processo de terminal.
 * O texto que chega é UTF-8 (equipamentos que só mandam ASCII ficam iguais); não há tamanho de
 * tela a repassar, então o redimensionamento da aba não faz nada.
 */

/** Tempo do sinal de break: o Cisco pede de 250 a 500 ms; o PuTTY usa o padrão do sistema (~250 ms). */
export const BREAK_MS = 300;

let binding: BindingInterface | undefined;
/** Binding nativo do sistema; os testes trocam pelo simulado. */
export function serialBinding(): BindingInterface {
  binding ??= autoDetect();
  return binding;
}
export function setSerialBinding(b: BindingInterface | undefined): void {
  binding = b;
}

export interface SerialPortInfo {
  path: string;
  /** Fabricante/descrição para o usuário reconhecer o cabo (ex.: "FTDI", "Prolific"). */
  label: string;
}

/** Portas seriais do sistema, em ordem natural (COM2 antes de COM10). */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports = await serialBinding().list();
  return ports
    .map((p) => ({ path: p.path, label: [p.manufacturer, p.serialNumber && `nº ${p.serialNumber}`].filter(Boolean).join(' · ') }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** Opções de abertura do serialport para a sessão. */
export function serialOpenOptions(s: Session) {
  const c = serialSettings(s);
  return {
    path: s.host,
    baudRate: c.baudRate,
    dataBits: c.dataBits,
    stopBits: c.stopBits,
    parity: c.parity,
    rtscts: c.flowControl === 'rtscts',
    xon: c.flowControl === 'xonxoff',
    xoff: c.flowControl === 'xonxoff',
  };
}

/** O que o sistema de arquivos diz da linha (Linux): o texto do erro nativo vem no idioma do sistema. */
export type SerialProbe = 'missing' | 'denied' | undefined;

export async function probeSerialLine(line: string, platform: NodeJS.Platform = process.platform): Promise<SerialProbe> {
  if (platform === 'win32') return undefined;
  try {
    await access(line, constants.R_OK | constants.W_OK);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'denied' : undefined;
  }
}

/** Erro de abertura em linguagem de gente, com o que fazer nos casos comuns. */
export function serialErrorMessage(line: string, err: unknown, platform: NodeJS.Platform = process.platform, probe?: SerialProbe): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '');
  if (probe === 'denied' || /EACCES|Permission denied/i.test(text)) {
    return platform === 'linux'
      ? `sem permissão para abrir ${line}: adicione seu usuário ao grupo dialout (sudo usermod -aG dialout $USER) e entre de novo na sessão do sistema`
      : `sem permissão para abrir ${line}`;
  }
  if (/Access denied|EBUSY|Resource busy|Cannot lock port|is locked/i.test(text)) {
    return `${line} está em uso por outro programa (outro terminal, PuTTY, IDE do Arduino…): feche-o e tente de novo`;
  }
  if (probe === 'missing' || /ENOENT|No such file|File not found|cannot find the file/i.test(text)) {
    return `a porta ${line} não existe: confira se o cabo está conectado e o nome da porta (veja a lista no formulário da sessão)`;
  }
  if (/baud/i.test(text)) return `${line}: a porta não aceita essa velocidade (${text})`;
  return `não foi possível abrir ${line}: ${text}`;
}

/** Abre a porta da sessão; rejeita com a mensagem de serialErrorMessage. */
export async function openSerial(s: Session): Promise<TerminalProcess> {
  const port = new SerialPortStream({ binding: serialBinding(), autoOpen: false, ...serialOpenOptions(s) });
  await new Promise<void>((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  }).catch(async (err: unknown) => {
    throw new Error(serialErrorMessage(s.host, err, process.platform, await probeSerialLine(s.host)));
  });

  const dataCbs: ((data: string) => void)[] = [];
  const exitCbs: ((e: { exitCode: number }) => void)[] = [];
  const decoder = new TextDecoder('utf-8');
  const emit = (text: string) => {
    if (text) for (const cb of dataCbs) cb(text);
  };
  let closedByUser = false;
  let lastError: (Error & { disconnected?: boolean }) | undefined;

  port.on('data', (chunk: Buffer) => emit(decoder.decode(chunk, { stream: true })));
  port.on('error', (err: Error) => {
    lastError = err;
  });
  port.on('close', (err?: Error & { disconnected?: boolean }) => {
    emit(decoder.decode());
    const problem = err ?? lastError;
    if (!closedByUser) {
      emit(problem?.disconnected || !problem
        ? `\r\n\x1b[33m[a porta ${s.host} foi desconectada]\x1b[0m\r\n`
        : `\r\n\x1b[31m[${s.host}: ${problem.message}]\x1b[0m\r\n`);
    }
    for (const cb of exitCbs) cb({ exitCode: closedByUser ? 0 : 1 });
  });

  const set = (opts: { brk: boolean }) =>
    new Promise<void>((resolve, reject) => port.set(opts, (err) => (err ? reject(err) : resolve())));

  return {
    write: (data) => {
      if (port.isOpen) port.write(Buffer.from(data, 'utf8'));
    },
    resize: () => {},
    kill: () => {
      closedByUser = true;
      if (port.isOpen) port.close();
    },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    sendBreak: async () => {
      try {
        await set({ brk: true });
        await new Promise((r) => setTimeout(r, BREAK_MS));
        await set({ brk: false });
      } catch (err) {
        // Portas virtuais (pty, alguns adaptadores) não têm o sinal de break.
        throw new Error(`${s.host} não aceitou o break: ${(err as Error).message.replace(/^Error: /, '')}`);
      }
    },
  };
}

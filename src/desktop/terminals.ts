import type { WebContents } from 'electron';
import pty from 'node-pty';
import { OutputBuffer } from '../agent/text.ts';
import { ptyHelpersDone, ptyHelpersRunning, trackPtyHelpers } from './pty-helpers.ts';

trackPtyHelpers();

/**
 * Terminais embutidos: um pseudo-terminal por aba, ligado à janela que o abriu.
 * O id é escolhido pela aba e registrado por ela antes da abertura, para que
 * nenhuma saída (nem o fim de um ssh que termina na hora) chegue antes da aba saber dele.
 * Uma aba pode mudar de janela (destacar/devolver): dono e id são trocados sem reiniciar o processo.
 */
/**
 * O que roda atrás da aba: um pseudo-terminal (ssh, shell local) ou outra fonte de texto, como a
 * porta serial. O pty do node-pty já tem esse formato.
 */
export interface TerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  /** Sinal de break da linha serial (só a porta serial tem). */
  sendBreak?(): Promise<void>;
}

interface Terminal {
  proc: TerminalProcess;
  owner: WebContents;
  id: number;
  /** Resolve quando o processo termina (o encerramento do app espera por ele). */
  exited: Promise<void>;
}

/** Terminais encerrados pela aba ou pela janela que ainda não terminaram. */
const ending = new Set<Promise<void>>();

function kill(t: Terminal): void {
  ending.add(t.exited);
  void t.exited.then(() => ending.delete(t.exited));
  t.proc.kill();
}

/**
 * Saída recente de cada terminal (por janela + id da aba): o agente MCP lê dela e a janela que
 * recebe uma aba destacada redesenha a tela com ela. Sobrevive à reconexão (mesmo id).
 */
const outputs = new Map<string, OutputBuffer>();
const dataListeners = new Set<(key: string) => void>();
const moveListeners = new Set<(from: string, to: string, owner: WebContents, id: number) => void>();

const terminals = new Map<string, Terminal>();

const keyOf = (owner: WebContents, id: number) => `${owner.id}:${id}`;

/**
 * Ajuste da saída antes de ir para a aba e para o agente (ex.: acentos escapados pelo ssh). Pode
 * guardar o fim de um pedaço para juntar com o próximo; o que ficou guardado sai no `flush`.
 */
export interface OutputFilter {
  push(chunk: string): string;
  flush(): string;
  readonly pending: boolean;
}

// O que o filtro guardou sai se nada mais vier logo (ex.: uma "\" digitada no shell remoto).
const FILTER_WAIT_MS = 20;

function validId(id: unknown): id is number {
  return Number.isInteger(id) && (id as number) > 0;
}

function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  }
  return env;
}

export function openTerminal(
  owner: WebContents,
  id: unknown,
  file: string,
  args: string[],
  size: { cols: number; rows: number; cwd: string },
  filter?: OutputFilter,
): void {
  checkFree(owner, id);
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: size.cwd,
    env: ptyEnv(),
  });
  attachTerminal(owner, id, proc, filter);
}

/** Recusa um id inválido ou de uma aba que já tem processo. */
export function checkFree(owner: WebContents, id: unknown): asserts id is number {
  if (!validId(id)) throw new Error('id de terminal inválido');
  if (terminals.has(keyOf(owner, id))) throw new Error(`terminal ${id} já está aberto`);
}

/** Liga um processo já aberto à aba `id` da janela `owner`. */
export function attachTerminal(owner: WebContents, id: unknown, proc: TerminalProcess, filter?: OutputFilter): void {
  checkFree(owner, id);
  const key = keyOf(owner, id);
  let markExited!: () => void;
  const entry: Terminal = { proc, owner, id, exited: new Promise<void>((r) => (markExited = r)) };
  terminals.set(key, entry);
  if (!outputs.has(key)) outputs.set(key, new OutputBuffer());
  // Dono e id lidos na hora: a aba pode ter mudado de janela.
  const deliver = (data: string) => {
    if (!data) return;
    const k = keyOf(entry.owner, entry.id);
    outputs.get(k)?.push(data);
    for (const l of dataListeners) l(k);
    if (!entry.owner.isDestroyed()) entry.owner.send('term:data', entry.id, data);
  };
  let held: NodeJS.Timeout | undefined;
  proc.onData((raw) => {
    if (!filter) return deliver(raw);
    clearTimeout(held);
    deliver(filter.push(raw));
    if (filter.pending) held = setTimeout(() => deliver(filter.flush()), FILTER_WAIT_MS);
  });
  proc.onExit(({ exitCode }) => {
    clearTimeout(held);
    if (filter) deliver(filter.flush());
    const k = keyOf(entry.owner, entry.id);
    if (terminals.get(k) === entry) terminals.delete(k);
    if (!entry.owner.isDestroyed()) entry.owner.send('term:exit', entry.id, exitCode);
    markExited();
  });
}

function get(owner: WebContents, id: unknown): Terminal | undefined {
  return validId(id) ? terminals.get(keyOf(owner, id)) : undefined;
}

export function writeTerminal(owner: WebContents, id: unknown, data: unknown): void {
  if (typeof data === 'string') get(owner, id)?.proc.write(data);
}

export function resizeTerminal(owner: WebContents, id: unknown, cols: unknown, rows: unknown): void {
  const t = get(owner, id);
  if (t && validId(cols) && validId(rows)) t.proc.resize(cols, rows);
}

/** Envia o sinal de break pela linha serial da aba; falha se a aba não for serial. */
export async function breakTerminal(owner: WebContents, id: unknown): Promise<void> {
  const t = get(owner, id);
  if (!t) throw new Error('a sessão desta aba não está aberta');
  if (!t.proc.sendBreak) throw new Error('só a sessão serial envia break');
  await t.proc.sendBreak();
}

export function closeTerminal(owner: WebContents, id: unknown): void {
  if (validId(id)) outputs.delete(keyOf(owner, id));
  const t = get(owner, id);
  if (!t) return;
  terminals.delete(keyOf(owner, id as number));
  kill(t);
}

/**
 * Passa a aba (processo em execução ou só a saída de uma sessão encerrada) para outra janela.
 * Devolve a saída guardada, para a janela nova redesenhar a tela, e se o processo segue vivo.
 */
export function moveTerminal(from: WebContents, fromId: number, to: WebContents, toId: number): { output: string; running: boolean } {
  const fromKey = keyOf(from, fromId);
  const toKey = keyOf(to, toId);
  if (terminals.has(toKey) || outputs.has(toKey)) throw new Error('a janela de destino já usa esse id de aba');
  const t = terminals.get(fromKey);
  const out = outputs.get(fromKey);
  if (!t && !out) throw new Error('a aba não existe mais');
  if (t) {
    terminals.delete(fromKey);
    t.owner = to;
    t.id = toId;
    terminals.set(toKey, t);
  }
  if (out) {
    outputs.delete(fromKey);
    outputs.set(toKey, out);
  }
  for (const l of moveListeners) l(fromKey, toKey, to, toId);
  return { output: out?.since(0) ?? '', running: !!t };
}

export function onTerminalMoved(cb: (from: string, to: string, owner: WebContents, id: number) => void) {
  moveListeners.add(cb);
}

// ---------- acesso para o agente MCP ----------

export const terminalKey = keyOf;
export const terminalOutput = (key: string) => outputs.get(key);
export const terminalRunning = (key: string) => terminals.has(key);
export function writeTerminalByKey(key: string, data: string) {
  terminals.get(key)?.proc.write(data);
}

/** Espera a saída do terminal ficar parada por `quietMs`; false se o tempo esgotar antes. */
export function waitTerminalQuiet(key: string, quietMs: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let quiet: NodeJS.Timeout;
    const finish = (ok: boolean) => {
      clearTimeout(quiet);
      clearTimeout(limit);
      dataListeners.delete(onData);
      resolve(ok);
    };
    const arm = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(true), quietMs);
    };
    const onData = (k: string) => {
      if (k === key) arm();
    };
    const limit = setTimeout(() => finish(false), timeoutMs);
    dataListeners.add(onData);
    arm();
  });
}

export function closeTerminalsOf(owner: WebContents): void {
  for (const key of outputs.keys()) if (key.startsWith(`${owner.id}:`)) outputs.delete(key);
  for (const [key, t] of terminals) {
    if (t.owner === owner) {
      terminals.delete(key);
      kill(t);
    }
  }
}

/** Há terminais abertos, encerrando ou auxiliares do node-pty em andamento. */
export function terminalsBusy(): boolean {
  return terminals.size > 0 || ending.size > 0 || ptyHelpersRunning() > 0;
}

/**
 * Encerra todos os terminais e espera os processos (e os auxiliares do node-pty no Windows)
 * terminarem, até `timeoutMs`. O app chama antes de sair: o fim acontece com o app ainda de pé.
 */
export async function shutdownTerminals(timeoutMs: number): Promise<boolean> {
  for (const [key, t] of terminals) {
    terminals.delete(key);
    kill(t);
  }
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)));
  // Os auxiliares nascem no kill (o do Windows espera o terminal ficar pronto): espera os
  // terminais primeiro e só então os auxiliares que eles abriram.
  const done = Promise.all([...ending]).then(() => ptyHelpersDone()).then(() => true as const);
  try {
    return await Promise.race([done, limit]);
  } finally {
    clearTimeout(timer);
  }
}

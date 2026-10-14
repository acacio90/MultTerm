import type { WebContents } from 'electron';
import pty from 'node-pty';
import { OutputBuffer } from '../agent/text.ts';

/**
 * Terminais embutidos: um pseudo-terminal por aba, ligado à janela que o abriu.
 * O id é escolhido pela aba e registrado por ela antes da abertura, para que
 * nenhuma saída (nem o fim de um ssh que termina na hora) chegue antes da aba saber dele.
 * Uma aba pode mudar de janela (destacar/devolver): dono e id são trocados sem reiniciar o processo.
 */
interface Terminal {
  proc: pty.IPty;
  owner: WebContents;
  id: number;
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
): void {
  if (!validId(id)) throw new Error('id de terminal inválido');
  const key = keyOf(owner, id);
  if (terminals.has(key)) throw new Error(`terminal ${id} já está aberto`);
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: size.cwd,
    env: ptyEnv(),
  });
  const entry: Terminal = { proc, owner, id };
  terminals.set(key, entry);
  if (!outputs.has(key)) outputs.set(key, new OutputBuffer());
  // Dono e id lidos na hora: a aba pode ter mudado de janela.
  proc.onData((data) => {
    const k = keyOf(entry.owner, entry.id);
    outputs.get(k)?.push(data);
    for (const l of dataListeners) l(k);
    if (!entry.owner.isDestroyed()) entry.owner.send('term:data', entry.id, data);
  });
  proc.onExit(({ exitCode }) => {
    const k = keyOf(entry.owner, entry.id);
    if (terminals.get(k) === entry) terminals.delete(k);
    if (!entry.owner.isDestroyed()) entry.owner.send('term:exit', entry.id, exitCode);
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

export function closeTerminal(owner: WebContents, id: unknown): void {
  if (validId(id)) outputs.delete(keyOf(owner, id));
  const t = get(owner, id);
  if (!t) return;
  terminals.delete(keyOf(owner, id as number));
  t.proc.kill();
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
      t.proc.kill();
    }
  }
}

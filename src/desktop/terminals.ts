import type { WebContents } from 'electron';
import pty from 'node-pty';

/**
 * Terminais embutidos: um pseudo-terminal por aba, ligado à janela que o abriu.
 * O id é escolhido pela aba e registrado por ela antes da abertura, para que
 * nenhuma saída (nem o fim de um ssh que termina na hora) chegue antes da aba saber dele.
 */
interface Terminal {
  proc: pty.IPty;
  owner: WebContents;
}

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
  const entry = { proc, owner };
  terminals.set(key, entry);
  proc.onData((data) => {
    if (!owner.isDestroyed()) owner.send('term:data', id, data);
  });
  proc.onExit(({ exitCode }) => {
    if (terminals.get(key) === entry) terminals.delete(key);
    if (!owner.isDestroyed()) owner.send('term:exit', id, exitCode);
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
  const t = get(owner, id);
  if (!t) return;
  terminals.delete(keyOf(owner, id as number));
  t.proc.kill();
}

export function closeTerminalsOf(owner: WebContents): void {
  for (const [key, t] of terminals) {
    if (t.owner === owner) {
      terminals.delete(key);
      t.proc.kill();
    }
  }
}

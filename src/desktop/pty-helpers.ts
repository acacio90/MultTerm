import childProcess, { type ChildProcess, type ForkOptions } from 'node:child_process';

/**
 * Processos auxiliares que o node-pty abre no Windows ao encerrar um terminal.
 *
 * No Windows, o kill() de um pty do ConPTY faz um fork() do `conpty_console_list_agent` para
 * listar os processos do console (o pai espera até 5 s pela resposta e depois o mata). Se o app
 * encerra logo depois (fechar a janela fecha os terminais e sai), o auxiliar fica órfão. Como o
 * fork herda a saída padrão do Electron, quem espera essa saída fechar (o Playwright no CI, #117)
 * fica preso até ele terminar.
 *
 * Por isso, só para esse auxiliar: sem herdar a saída padrão, e registrado para o encerramento
 * do app esperar por ele (encerra sozinho ou pelo limite de 5 s do node-pty).
 */
const AGENT = /conpty_console_list_agent(\.js)?$/;
const helpers = new Set<ChildProcess>();

let installed = false;

/** Troca o child_process.fork (o node-pty o lê na hora da chamada) por um que trata o auxiliar. */
export function trackPtyHelpers(platform: NodeJS.Platform = process.platform, cp: { fork: typeof childProcess.fork } = childProcess): void {
  if (platform !== 'win32' || installed) return;
  installed = true;
  const fork = cp.fork;
  cp.fork = function (this: unknown, modulePath: string | URL, args?: readonly string[] | ForkOptions, options?: ForkOptions) {
    if (!AGENT.test(String(modulePath))) return fork.call(this, modulePath, args as readonly string[], options);
    const argv = Array.isArray(args) ? args : [];
    const opts = (Array.isArray(args) ? options : args) ?? {};
    const child = fork.call(this, modulePath, argv, { ...opts, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    helpers.add(child);
    child.once('exit', () => helpers.delete(child));
    child.once('error', () => helpers.delete(child));
    return child;
  } as typeof childProcess.fork;
}

/** Espera os auxiliares em andamento terminarem. */
export function ptyHelpersDone(): Promise<void> {
  return Promise.all([...helpers].map((c) => new Promise<void>((r) => {
    if (c.exitCode !== null || c.signalCode !== null) return r();
    c.once('exit', () => r());
  }))).then(() => {});
}

export const ptyHelpersRunning = () => helpers.size;

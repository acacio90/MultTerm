import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { ptyHelpersDone, ptyHelpersRunning, trackPtyHelpers } from '../src/desktop/pty-helpers.ts';

/** child_process falso: guarda as chamadas do fork e devolve processos que terminam quando mandados. */
function fakeChildProcess() {
  const calls: { path: string; args: unknown; opts: Record<string, unknown> | undefined }[] = [];
  const children: (EventEmitter & { exitCode: number | null; signalCode: null })[] = [];
  const cp = {
    fork: ((path: string, args?: unknown, opts?: Record<string, unknown>) => {
      calls.push({ path, args, opts });
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
      children.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as typeof import('node:child_process').fork,
  };
  return { cp, calls, children };
}

test('trackPtyHelpers: o auxiliar do node-pty não herda a saída e o encerramento espera por ele', async () => {
  const { cp, calls, children } = fakeChildProcess();
  trackPtyHelpers('linux', cp);
  assert.equal(cp.fork.name, 'fork', 'fora do Windows o fork fica como está');

  trackPtyHelpers('win32', cp);
  cp.fork('C:\\app\\node_modules\\node-pty\\lib\\conpty_console_list_agent', ['1234']);
  cp.fork('C:\\outro\\script.js', ['x'], { silent: true });
  assert.deepEqual(calls[0].args, ['1234']);
  assert.deepEqual(calls[0].opts?.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.deepEqual(calls[1].opts, { silent: true }, 'outros forks ficam iguais');
  assert.equal(ptyHelpersRunning(), 1);

  let done = false;
  const waiting = ptyHelpersDone().then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  children[0].exitCode = 0;
  children[0].emit('exit', 0, null);
  await waiting;
  assert.equal(ptyHelpersRunning(), 0);
});

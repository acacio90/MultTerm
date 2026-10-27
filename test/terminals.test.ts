import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebContents } from 'electron';
import {
  closeTerminalsOf, moveTerminal, onTerminalMoved, openTerminal, terminalKey, terminalOutput, terminalRunning, writeTerminal,
} from '../src/desktop/terminals.ts';
import { sshTextStream } from '../src/sessions/ssh-text.ts';

/** Janela falsa: só o que terminals.ts usa. */
function fakeWindow(id: number) {
  const sent: { channel: string; args: unknown[] }[] = [];
  const wc = { id, isDestroyed: () => false, send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }) };
  return { wc: wc as unknown as WebContents, sent };
}

const dataOf = (sent: { channel: string; args: unknown[] }[], id: number) =>
  sent.filter((m) => m.channel === 'term:data' && m.args[0] === id).map((m) => m.args[1]).join('');

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('moveTerminal passa o processo para outra janela sem reiniciá-lo', async (t) => {
  const a = fakeWindow(901);
  const b = fakeWindow(902);
  t.after(() => {
    closeTerminalsOf(a.wc);
    closeTerminalsOf(b.wc);
  });
  const moves: string[] = [];
  onTerminalMoved((from, to) => moves.push(`${from}>${to}`));

  openTerminal(a.wc, 3, 'cmd.exe', ['/q', '/k', 'echo antes'], { cols: 80, rows: 24, cwd: process.cwd() });
  await until(() => dataOf(a.sent, 3).includes('antes'));

  const moved = moveTerminal(a.wc, 3, b.wc, 7);
  assert.equal(moved.running, true);
  assert.match(moved.output, /antes/);
  assert.deepEqual(moves, ['901:3>902:7']);
  assert.equal(terminalRunning(terminalKey(a.wc, 3)), false);
  assert.equal(terminalRunning(terminalKey(b.wc, 7)), true);
  assert.equal(terminalOutput(terminalKey(a.wc, 3)), undefined);

  // A janela nova escreve no mesmo processo e recebe a saída com o próprio id.
  writeTerminal(b.wc, 7, 'echo depois\r');
  await until(() => dataOf(b.sent, 7).includes('depois'));
  assert.doesNotMatch(dataOf(a.sent, 3), /depois/);
  writeTerminal(a.wc, 3, 'echo nada\r'); // a janela antiga não alcança mais o processo

  // Destino ocupado ou origem inexistente: recusado.
  assert.throws(() => moveTerminal(b.wc, 7, b.wc, 7), /destino/);
  assert.throws(() => moveTerminal(a.wc, 3, b.wc, 8), /não existe/);

  // Fechar a janela antiga não mata o processo que mudou de dono.
  closeTerminalsOf(a.wc);
  assert.equal(terminalRunning(terminalKey(b.wc, 7)), true);
});

test('filtro ajusta a saída antes da aba e do agente (acentos escapados pelo ssh)', async (t) => {
  const w = fakeWindow(903);
  t.after(() => closeTerminalsOf(w.wc));
  openTerminal(w.wc, 1, 'cmd.exe', ['/q', '/k', 'echo n\\343o'], { cols: 80, rows: 24, cwd: process.cwd() }, sshTextStream());
  await until(() => dataOf(w.sent, 1).includes('não'));
  assert.doesNotMatch(dataOf(w.sent, 1), /\\343/);
  // Saída bruta guardada para o agente: o tail() aplica \r e cursor de forma simplificada, e o
  // redesenho do ConPTY (no CI) apaga o texto nele.
  const saved = terminalOutput(terminalKey(w.wc, 1))!.since(0);
  assert.match(saved, /não/);
  assert.doesNotMatch(saved, /\\343/);
});

test('o que o filtro guarda sai sozinho se nada mais vier', async (t) => {
  const w = fakeWindow(904);
  t.after(() => closeTerminalsOf(w.wc));
  // Guarda tudo: a saída só chega pelo flush do prazo.
  let held = '';
  const filter = {
    push(chunk: string) {
      held += chunk;
      return '';
    },
    flush() {
      const text = held;
      held = '';
      return text;
    },
    get pending() {
      return held !== '';
    },
  };
  openTerminal(w.wc, 1, 'cmd.exe', ['/q', '/k', 'echo guardado'], { cols: 80, rows: 24, cwd: process.cwd() }, filter);
  await until(() => dataOf(w.sent, 1).includes('guardado'));
});

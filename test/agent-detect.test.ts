import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { chooseAgent, knownAgentPaths, parseVersion, parseWhere, pickExecutable } from '../src/desktop/agent-detect.ts';

test('where.exe: um caminho por linha; .exe antes de .cmd; script sem extensão fica de fora', () => {
  const found = parseWhere('C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\nC:\\bin\\claude.exe\r\n\r\n');
  assert.deepEqual(found, ['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\bin\\claude.exe']);
  assert.equal(pickExecutable(found), 'C:\\bin\\claude.exe');
  assert.equal(pickExecutable(['C:\\npm\\claude', 'C:\\npm\\claude.cmd']), 'C:\\npm\\claude.cmd');
  assert.equal(pickExecutable(['C:\\npm\\claude']), undefined);
  assert.deepEqual(parseWhere(''), []);
});

test('caminhos de instalação conhecidos e versão', () => {
  assert.deepEqual(knownAgentPaths('claude', { userProfile: 'C:\\Users\\ana', appData: 'C:\\Users\\ana\\AppData\\Roaming' }), [
    join('C:\\Users\\ana', '.local', 'bin', 'claude.exe'),
    join('C:\\Users\\ana\\AppData\\Roaming', 'npm', 'claude.cmd'),
  ]);
  assert.deepEqual(knownAgentPaths('claude', {}), []);
  assert.equal(parseVersion('2.1.4 (Claude Code)\n'), '2.1.4');
  assert.equal(parseVersion('\n  v10.3\n'), '10.3');
  assert.equal(parseVersion(''), undefined);
});

test('escolha do agente: o gravado se instalado; senão o primeiro instalado (com aviso)', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(chooseAgent('b', order, undefined), { agent: 'b', fallback: false }); // ainda procurando
  assert.deepEqual(chooseAgent('b', order, { a: { installed: true }, b: { installed: true } }), { agent: 'b', fallback: false });
  assert.deepEqual(chooseAgent('b', order, { a: { installed: false }, b: { installed: false }, c: { installed: true } }), { agent: 'c', fallback: true });
  // Nenhum instalado: fica o gravado (a interface mostra que não há agente).
  assert.deepEqual(chooseAgent('b', order, { a: { installed: false }, b: { installed: false }, c: { installed: false } }), { agent: 'b', fallback: false });
});

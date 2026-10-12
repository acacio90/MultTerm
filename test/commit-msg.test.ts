import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HEADER, validateCommitMessage } from '../scripts/commit-msg.ts';

test('aceita títulos no padrão, com escopo, breaking change e corpo', () => {
  for (const msg of [
    'feat: versão inicial',
    'fix(terminal): reconecta após encerrar',
    'refactor(sessions)!: muda o formato do arquivo',
    'docs: atualiza o README\n\nExplica a instalação.\n',
    'chore(deps): atualiza o electron\n# comentário do git ignorado\n',
  ]) {
    assert.deepEqual(validateCommitMessage(msg), [], msg);
  }
});

test('aceita mensagens geradas pelo git', () => {
  assert.deepEqual(validateCommitMessage("Merge branch 'main'"), []);
  assert.deepEqual(validateCommitMessage('Revert "feat: x"'), []);
  assert.deepEqual(validateCommitMessage('fixup! feat: x'), []);
});

test('recusa tipo inválido, falta de descrição, título longo e corpo colado', () => {
  assert.match(validateCommitMessage('Adiciona tela de ajuda')[0], /tipo\(escopo opcional\)/);
  assert.match(validateCommitMessage('feature: x')[0], /tipo/);
  assert.match(validateCommitMessage('feat:x')[0], /tipo/);
  assert.match(validateCommitMessage('feat(Terminal): x')[0], /tipo/);
  assert.match(validateCommitMessage(`feat: ${'x'.repeat(MAX_HEADER)}`)[0], /máximo/);
  assert.match(validateCommitMessage('feat: x\ncorpo sem linha em branco')[0], /linha em branco/);
  assert.deepEqual(validateCommitMessage('\n# só comentário\n'), ['mensagem vazia']);
});

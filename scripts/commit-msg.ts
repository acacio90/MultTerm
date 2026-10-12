// Valida mensagens de commit no padrão Conventional Commits (https://www.conventionalcommits.org).
// Uso como hook do git: node scripts/commit-msg.ts <arquivo-da-mensagem>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
export const MAX_HEADER = 100;

const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9._/-]+\\))?(!)?: \\S.*$`);
// Mensagens geradas pelo próprio git.
const GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/** Devolve a lista de problemas da mensagem (vazia = válida). */
export function validateCommitMessage(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('#'));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const header = lines[0] ?? '';
  if (!header.trim()) return ['mensagem vazia'];
  if (GENERATED.test(header)) return [];

  const problems: string[] = [];
  if (!HEADER.test(header)) {
    problems.push(`o título deve ser "tipo(escopo opcional): descrição" com tipo em: ${TYPES.join(', ')}`);
  }
  if (header.length > MAX_HEADER) problems.push(`o título tem ${header.length} caracteres (máximo ${MAX_HEADER})`);
  if (lines.length > 1 && lines[1].trim()) problems.push('deixe uma linha em branco entre o título e o corpo');
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('uso: node scripts/commit-msg.ts <arquivo-da-mensagem>');
    process.exit(2);
  }
  const problems = validateCommitMessage(readFileSync(file, 'utf8'));
  if (problems.length) {
    console.error('Mensagem de commit fora do padrão Conventional Commits:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nExemplos:\n  feat(terminal): reconecta com a tecla R\n  fix: corrige leitura de chave .ppk\n  docs: atualiza o README');
    process.exit(1);
  }
}

// Instala o hook commit-msg (Conventional Commits). Roda no "npm install" (script prepare).
// Não mexe em outros hooks já existentes; fora de um repositório git, não faz nada.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const hooks = join('.git', 'hooks');
if (existsSync('.git')) {
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\nexec node scripts/commit-msg.ts "$1"\n', { mode: 0o755 });
  console.log('hook commit-msg instalado (Conventional Commits)');
}

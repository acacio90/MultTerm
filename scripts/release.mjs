// Publica a versão do package.json numa release (rascunho) do GitHub.
// Uso: npm run release   (requer a tag vX.Y.Z já enviada e o gh autenticado, ou GH_TOKEN)
//
// O rascunho é criado antes do build: se a release ainda não existe, o electron-builder envia os
// arquivos em paralelo e cria dois rascunhos para a mesma tag (aconteceu nas versões 0.1.0 e 0.2.0).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { owner, repo } = pkg.build.publish[0];
const R = `${owner}/${repo}`;
const tag = `v${pkg.version}`;
const dryRun = process.argv.includes('--dry-run');

const gh = (...args) => execFileSync('gh', [...args, '-R', R], { encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

// 1. A tag precisa existir no GitHub (o fluxo é: merge na main → tag → release).
try {
  execFileSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], { stdio: 'ignore' });
} catch {
  fail(`a tag ${tag} não existe no GitHub; crie e envie a tag antes (veja o README)`);
}

// 2. Rascunhos/publicadas com essa tag.
const releases = JSON.parse(execFileSync('gh', ['api', `repos/${R}/releases`, '--paginate'], { encoding: 'utf8' }))
  .filter((r) => r.tag_name === tag);
if (releases.some((r) => !r.draft)) fail(`a release ${tag} já foi publicada; suba a versão no package.json`);
if (releases.length > 1) fail(`há ${releases.length} rascunhos para ${tag}; apague os extras antes`);

if (releases.length === 0) {
  console.log(`release: criando o rascunho ${tag}`);
  if (!dryRun) gh('release', 'create', tag, '--draft', '--verify-tag', '--title', `${pkg.productName} ${pkg.version}`, '--notes', '');
} else {
  console.log(`release: usando o rascunho existente ${tag}`);
}
if (dryRun) {
  console.log('release: --dry-run, nada foi gerado nem enviado');
  process.exit(0);
}

// 3. Build e envio dos arquivos para o rascunho.
const token = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
const build = spawnSync(process.execPath, [cli, '--win', 'nsis', '--x64', '--publish', 'always'], {
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token },
});
if (build.status !== 0) fail('o electron-builder falhou');

// 4. Conferência final: um único rascunho, com instalador, blockmap e latest.yml.
const drafts = JSON.parse(execFileSync('gh', ['api', `repos/${R}/releases`, '--paginate'], { encoding: 'utf8' }))
  .filter((r) => r.tag_name === tag);
const assets = drafts.flatMap((r) => r.assets.map((a) => a.name)).sort();
console.log(`release: ${drafts.length} rascunho(s) para ${tag}: ${assets.join(', ')}`);
if (drafts.length !== 1 || assets.length !== 3) fail('confira os rascunhos no GitHub antes de publicar');
console.log(`release: pronto — revise as notas e publique em https://github.com/${R}/releases`);

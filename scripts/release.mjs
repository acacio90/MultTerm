// Publica a versão do package.json numa release (rascunho) do GitHub.
// Uso: npm run release   (requer a tag vX.Y.Z já enviada e o gh autenticado, ou GH_TOKEN)
// Gera os pacotes do sistema em que roda: rode no Windows e no Linux antes de publicar.
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

// 3. Build e envio dos arquivos da plataforma atual para o rascunho. Cada sistema gera os pacotes
// dele (o NSIS precisa do Windows; o AppImage e o .deb, do Linux): rode o release nos dois antes
// de publicar. O electron-builder substitui um arquivo que já estiver no rascunho.
const { productName: name, version } = pkg;
const PLATFORMS = {
  win32: {
    label: 'Windows',
    args: ['--win', 'nsis', '--x64'],
    assets: [`${name}-setup-${version}.exe`, `${name}-setup-${version}.exe.blockmap`, 'latest.yml'],
  },
  linux: {
    label: 'Linux',
    args: ['--linux', 'AppImage', 'deb', '--x64'],
    assets: [`${name}-${version}-x86_64.AppImage`, `${name}-${version}-amd64.deb`, 'latest-linux.yml'],
  },
};
const here = PLATFORMS[process.platform];
if (!here) fail(`a plataforma ${process.platform} não gera pacotes (só Windows e Linux)`);

// O cliente RDP embutido (wfreerdp.exe) só vai no instalador do Windows.
if (process.platform === 'win32') execFileSync(process.execPath, ['scripts/fetch-freerdp.mjs'], { stdio: 'inherit' });

const token = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
console.log(`release: gerando os pacotes do ${here.label}`);
const build = spawnSync(process.execPath, [cli, ...here.args, '--publish', 'always'], {
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token },
});
if (build.status !== 0) fail('o electron-builder falhou');

// 4. Conferência final: um único rascunho, com os arquivos das duas plataformas e nada além deles.
const drafts = JSON.parse(execFileSync('gh', ['api', `repos/${R}/releases`, '--paginate'], { encoding: 'utf8' }))
  .filter((r) => r.tag_name === tag);
const assets = drafts.flatMap((r) => r.assets.map((a) => a.name)).sort();
console.log(`release: ${drafts.length} rascunho(s) para ${tag}: ${assets.join(', ')}`);
if (drafts.length !== 1) fail('há mais de um rascunho; confira no GitHub antes de publicar');

const expected = Object.values(PLATFORMS).flatMap((p) => p.assets);
const extra = assets.filter((a) => !expected.includes(a));
if (extra.length) fail(`arquivos inesperados no rascunho: ${extra.join(', ')}`);
const missingHere = here.assets.filter((a) => !assets.includes(a));
if (missingHere.length) fail(`faltam arquivos do ${here.label}: ${missingHere.join(', ')}`);

const pending = Object.values(PLATFORMS).filter((p) => p !== here && p.assets.some((a) => !assets.includes(a)));
if (pending.length) {
  for (const p of pending) console.log(`release: falta o ${p.label}: rode o npm run release num ${p.label} antes de publicar`);
  process.exit(0);
}
console.log(`release: pronto (Windows e Linux) — revise as notas e publique em https://github.com/${R}/releases`);

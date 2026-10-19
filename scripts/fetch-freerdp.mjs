// Baixa o cliente RDP (wfreerdp.exe) compilado pelo workflow freerdp.yml para vendor/freerdp,
// conferindo o SHA-256. Usado antes do build do instalador e nos testes.
// Uso: node scripts/fetch-freerdp.mjs   (não faz nada se a versão certa já está lá)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '3.32.2';
const BUILD = 2; // configuração do build no workflow freerdp.yml
const SHA256 = '505ee9c11044b0d6fa6043aa73f92ff8f98d74bf75cb49a8cff815266a447ead';
const URL = `https://github.com/acacio90/MultTerm/releases/download/freerdp-${VERSION}/freerdp-${VERSION}-win64-${BUILD}.zip`;

const dest = join(import.meta.dirname, '..', 'vendor', 'freerdp');
const stamp = join(dest, 'VERSION');
if (existsSync(join(dest, 'wfreerdp.exe')) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === `${VERSION}-${BUILD} ${SHA256}`) {
  console.log(`fetch-freerdp: FreeRDP ${VERSION} já está em vendor/freerdp`);
  process.exit(0);
}

const res = await fetch(URL);
if (!res.ok) throw new Error(`fetch-freerdp: ${URL} respondeu ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
const hash = createHash('sha256').update(zip).digest('hex');
if (hash !== SHA256) throw new Error(`fetch-freerdp: hash não confere (${hash}); o arquivo foi trocado?`);

const tmp = join(tmpdir(), `multterm-freerdp-${process.pid}.zip`);
writeFileSync(tmp, zip);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const ps = (s) => `'${s.replace(/'/g, "''")}'`;
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${ps(tmp)} -DestinationPath ${ps(dest)} -Force`], { stdio: 'inherit' });
rmSync(tmp, { force: true });
if (!existsSync(join(dest, 'wfreerdp.exe'))) throw new Error('fetch-freerdp: o pacote não tem wfreerdp.exe');
writeFileSync(stamp, `${VERSION}-${BUILD} ${SHA256}\n`);
console.log(`fetch-freerdp: FreeRDP ${VERSION} em vendor/freerdp`);

// Executa o Electron com uma entrada: "node scripts/electron.mjs ." (app) ou
// "node scripts/electron.mjs scripts/render-icon.mjs". Remove ELECTRON_RUN_AS_NODE, que o
// VS Code e outros apps Electron repassam aos processos filhos e faria o Electron rodar como Node puro.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const [entry = '.', ...args] = process.argv.slice(2);
const child = spawn(electron, [entry, ...args], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

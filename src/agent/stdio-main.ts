/*
 * Ponte stdio do agente MCP. Executado pelo próprio executável do MultTerm em modo Node
 * (ELECTRON_RUN_AS_NODE=1), sem janela: node stdio-main.js <arquivo de conexão>.
 */
import { runStdioBridge } from './stdio-bridge.ts';

const connectionFile = process.argv[2];
if (!connectionFile) {
  process.stderr.write('uso: stdio-main <arquivo de conexão do agente>\n');
  process.exit(2);
}
await runStdioBridge({
  connectionFile,
  input: process.stdin,
  output: process.stdout,
  log: (m) => process.stderr.write(`multterm: ${m}\n`),
});
process.exit(0);

import { readFile } from 'node:fs/promises';

/*
 * Ponte stdio → HTTP para agentes MCP que só iniciam servidores por stdio: lê mensagens JSON-RPC
 * (uma por linha) do stdin, repassa ao MultTerm aberto e escreve as respostas no stdout.
 * O endereço e o token vêm do arquivo de conexão que o app grava ao ligar o agente.
 */

export interface AgentConnection {
  port: number;
  token: string;
}

export async function readConnection(file: string): Promise<AgentConnection> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error('o agente do MultTerm está desligado: abra o MultTerm e ligue em Agente');
  }
  const c = JSON.parse(raw) as Partial<AgentConnection>;
  if (!Number.isInteger(c.port) || typeof c.token !== 'string') throw new Error('arquivo de conexão do agente inválido');
  return c as AgentConnection;
}

export async function runStdioBridge(opts: {
  connectionFile: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (msg: string) => void;
}): Promise<void> {
  const write = (o: unknown) => opts.output.write(`${JSON.stringify(o)}\n`);
  let buffer = '';
  let queue = Promise.resolve();
  const forward = async (line: string) => {
    let msg: { id?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
      return;
    }
    try {
      // Relê a conexão a cada pedido: o app pode ter sido reaberto (porta/token novos).
      const c = await readConnection(opts.connectionFile);
      const res = await fetch(`http://127.0.0.1:${c.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${c.token}` },
        body: line,
      });
      if (res.status === 202) return;
      const text = await res.text();
      opts.output.write(`${text.trim()}\n`);
    } catch (err) {
      const message = (err as Error).message.includes('fetch failed')
        ? 'o MultTerm não respondeu: ele está aberto e com o agente ligado?'
        : (err as Error).message;
      opts.log?.(message);
      if (msg.id !== undefined && msg.id !== null) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message } });
    }
  };
  await new Promise<void>((resolve) => {
    opts.input.setEncoding?.('utf8');
    opts.input.on('data', (d: string) => {
      buffer += d;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) queue = queue.then(() => forward(line));
      }
    });
    opts.input.on('end', () => void queue.then(() => resolve()));
  });
}

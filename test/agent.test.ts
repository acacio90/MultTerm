import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { OutputBuffer, stripAnsi, terminalText } from '../src/agent/text.ts';
import { McpServer, type SharedTerminal, type TerminalBridge } from '../src/agent/mcp.ts';
import { startAgentHttp } from '../src/agent/http.ts';
import { runStdioBridge } from '../src/agent/stdio-bridge.ts';

test('saída do terminal vira texto: ANSI, \\r, backspace e tab', () => {
  assert.equal(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]0;título\x07fim'), 'ok fim');
  assert.equal(terminalText('progresso 10%\rprogresso 100%\r\nabc\b\bX\n\tY'), 'progresso 100%\naXc\n        Y');
  assert.equal(terminalText('linha   \r\n\x1b[2K\x1b[Gprompt$ '), 'linha\nprompt$');
  const b = new OutputBuffer(20);
  b.push('0123456789');
  const mark = b.total;
  b.push('abcdefghij');
  b.push('KLMNO');
  assert.equal(b.since(mark), 'abcdefghijKLMNO');
  assert.equal(b.total, 25);
  assert.equal(b.since(0), 'abcdefghijKLMNO'); // o começo já saiu do buffer
});

/** Terminal falso: ecoa o que é digitado e responde a "echo X". */
function fakeTerminals(modes: Record<string, SharedTerminal['mode']>) {
  const buffers = new Map<string, OutputBuffer>();
  const written: [string, string][] = [];
  for (const id of Object.keys(modes)) {
    const b = new OutputBuffer();
    b.push('Bem-vindo\r\nuser@srv:~$ ');
    buffers.set(id, b);
  }
  const bridge: TerminalBridge = {
    list: () => Object.entries(modes).map(([id, mode]) => ({ id, title: `aba ${id}`, detail: `${id}.example`, mode, running: true })),
    tail: (id, n) => buffers.get(id)!.tail(n),
    mark: (id) => buffers.get(id)!.total,
    since: (id, m) => buffers.get(id)!.since(m),
    write: (id, data) => {
      written.push([id, data]);
      const b = buffers.get(id)!;
      setTimeout(() => {
        b.push(data.replace('\r', '\r\n'));
        const m = /^echo (.*)\r$/.exec(data);
        if (m) b.push(`${m[1]}\r\nuser@srv:~$ `);
      }, 20);
    },
    waitQuiet: (_id, quiet) => new Promise((r) => setTimeout(() => r(true), quiet + 60)),
  };
  return { bridge, written };
}

const call = (mcp: McpServer, name: string, args: Record<string, unknown> = {}) =>
  mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;

test('MCP: inicialização, lista de ferramentas e só os terminais compartilhados', async () => {
  const { bridge } = fakeTerminals({ a: 'auto', b: 'off', c: 'read' });
  const mcp = new McpServer({ bridge, approve: async () => true, version: '1.2.3' });
  const init = await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) as { result: { protocolVersion: string; serverInfo: { version: string }; capabilities: object } };
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.version, '1.2.3');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const tools = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['list_terminals', 'read_terminal', 'run_command', 'send_input', 'send_keys']);
  const list = JSON.parse((await call(mcp, 'list_terminals')).result.content[0].text);
  assert.deepEqual(list.map((t: { id: string; permission: string }) => [t.id, t.permission]), [['a', 'auto'], ['c', 'read']]);
  const unknown = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nada' }) as { error: { code: number } };
  assert.equal(unknown.error.code, -32601);
  const bad = await mcp.handle({ id: 4, method: 'ping' }) as { error: { code: number } };
  assert.equal(bad.error.code, -32600);
});

test('MCP: rodar comando, ler, permissões e aprovação', async () => {
  const { bridge, written } = fakeTerminals({ a: 'auto', b: 'off', c: 'read', d: 'approve' });
  const asked: string[] = [];
  let allow = false;
  const activity: string[] = [];
  const mcp = new McpServer({ bridge, approve: async (t, desc) => { asked.push(`${t.id}: ${desc}`); return allow; }, activity: (l) => activity.push(l) });

  const run = await call(mcp, 'run_command', { id: 'a', command: 'echo olá', quiet_ms: 200 });
  assert.equal(run.result.isError, undefined);
  assert.equal(run.result.content[0].text, 'olá\nuser@srv:~$');
  assert.match((await call(mcp, 'read_terminal', { id: 'a', lines: 2 })).result.content[0].text, /olá\nuser@srv:~\$$/);

  let r = await call(mcp, 'run_command', { id: 'c', command: 'rm -rf /' });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /só para leitura/);
  r = await call(mcp, 'read_terminal', { id: 'b' });
  assert.match(r.result.content[0].text, /não está compartilhado/);
  r = await call(mcp, 'run_command', { id: 'a', command: 'a\nb' });
  assert.match(r.result.content[0].text, /sem quebras de linha/);

  r = await call(mcp, 'send_input', { id: 'd', text: 'sim', enter: true });
  assert.match(r.result.content[0].text, /recusou/);
  assert.deepEqual(asked, ['d: digitar e apertar Enter: sim']);
  allow = true;
  r = await call(mcp, 'send_keys', { id: 'd', keys: ['ctrl+c', 'up', 'enter'] });
  assert.equal(r.result.content[0].text, 'enviado');
  assert.deepEqual(written.at(-1), ['d', '\x03\x1b[A\r']);
  r = await call(mcp, 'send_keys', { id: 'd', keys: ['f13'] });
  assert.match(r.result.content[0].text, /desconhecidas: f13/);
  assert.ok(written.every(([id]) => id === 'a' || id === 'd'));
  assert.ok(activity.some((l) => /recusado pelo usuário em "aba d": sim⏎/.test(l)));
  assert.ok(activity.some((l) => /enviou para "aba d": Ctrl\+C/.test(l)));
});

test('HTTP: token, Origin, Host, notificações e ponte stdio', async () => {
  const { bridge } = fakeTerminals({ a: 'read' });
  const mcp = new McpServer({ bridge, approve: async () => false });
  const srv = await startAgentHttp(mcp, { port: 0, token: 't0k3n' });
  const url = `http://127.0.0.1:${srv.port}/mcp`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t0k3n', ...headers }, body: JSON.stringify(body),
  });
  const dir = await mkdtemp(join(tmpdir(), 'multterm-agent-'));
  try {
    const ok = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.tools.length, 5);
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer errado' })).status, 401);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://site-malicioso.example' })).status, 403);
    // DNS rebinding: o fetch não deixa trocar o Host, o http.request deixa.
    const { request } = await import('node:http');
    const evil = await new Promise<number>((resolve) => {
      const r = request({ host: '127.0.0.1', port: srv.port, path: '/mcp', method: 'POST', headers: { Host: `evil.example:${srv.port}`, Authorization: 'Bearer t0k3n' } }, (res) => resolve(res.statusCode ?? 0));
      r.end('{}');
    });
    assert.equal(evil, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer t0k3n' }, body: '{x' })).status, 400);

    // Ponte stdio: duas mensagens (uma notificação) → uma resposta.
    const conn = join(dir, 'agent.json');
    await writeFile(conn, JSON.stringify({ port: srv.port, token: 't0k3n' }));
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => { out += d; });
    const done = runStdioBridge({ connectionFile: conn, input, output });
    input.end(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_terminals', arguments: {} } })}\n`);
    await done;
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).id, 7);
    assert.match(JSON.parse(lines[0]).result.content[0].text, /"permission": "read"/);

    // Sem o app: erro claro para o agente.
    const input2 = new PassThrough();
    const output2 = new PassThrough();
    let out2 = '';
    output2.on('data', (d) => { out2 += d; });
    const done2 = runStdioBridge({ connectionFile: join(dir, 'nao-existe.json'), input: input2, output: output2 });
    input2.end(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' })}\n`);
    await done2;
    assert.match(JSON.parse(out2).error.message, /agente do MultTerm está desligado/);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('terminais locais e comando do agente', async () => {
  const { localShellCommand, agentLaunchCommand } = await import('../src/desktop/local-terminal.ts');
  assert.deepEqual(localShellCommand('cmd', 'C:\Win'), { file: join('C:\Win', 'System32', 'cmd.exe'), args: [] });
  assert.equal(localShellCommand('powershell', 'C:\Win').file, join('C:\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(localShellCommand('wsl', 'C:\Win').args, ['--cd', '~']);
  const a = agentLaunchCommand("meu-agente --mcp-config {mcp}", "C:\Users\d'Ávila\agent-mcp.json", 'C:\Win');
  assert.deepEqual(a.args, ['-NoLogo', '-NoExit', '-Command', "meu-agente --mcp-config 'C:\Users\d''Ávila\agent-mcp.json'"]);
  assert.deepEqual(agentLaunchCommand('outro-agente', 'x').args.at(-1), 'outro-agente');
  assert.throws(() => agentLaunchCommand('  ', 'x'), /configure o comando/);
  assert.throws(() => agentLaunchCommand('a\nb', 'x'), /inválido/);
});

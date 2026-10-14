import { terminalText } from './text.ts';

/*
 * Servidor MCP (JSON-RPC 2.0, protocolo Model Context Protocol) com as ferramentas dos terminais.
 * Não sabe de transporte nem de Electron: recebe uma "ponte" com os terminais compartilhados e
 * uma função de aprovação. Só existe o que o usuário compartilhou.
 */

export type ShareMode = 'off' | 'read' | 'approve' | 'auto';

export interface SharedTerminal {
  id: string;
  title: string;
  detail?: string;
  mode: ShareMode;
  running: boolean;
}

export interface TerminalBridge {
  list(): SharedTerminal[];
  /** Últimas linhas como texto. */
  tail(id: string, lines: number): string;
  /** Marca do total de saída recebida (para ler só o que veio depois). */
  mark(id: string): number;
  /** Saída bruta desde a marca. */
  since(id: string, mark: number): string;
  write(id: string, data: string): void;
  /** Espera a saída ficar parada por `quietMs` (ou o tempo esgotar). */
  waitQuiet(id: string, quietMs: number, timeoutMs: number): Promise<boolean>;
}

/** Pergunta ao usuário se permite o envio (modo "aprovar"); resolve true para permitir. */
export type Approver = (t: SharedTerminal, description: string, data: string) => Promise<boolean>;
export type Activity = (line: string) => void;

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const KEYS: Record<string, string> = {
  enter: '\r', tab: '\t', escape: '\x1b', esc: '\x1b', backspace: '\x7f', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F',
  pageup: '\x1b[5~', pagedown: '\x1b[6~', delete: '\x1b[3~',
  'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+z': '\x1a', 'ctrl+l': '\x0c', 'ctrl+u': '\x15', 'ctrl+a': '\x01', 'ctrl+e': '\x05', 'ctrl+r': '\x12',
};

const TOOLS = [
  {
    name: 'list_terminals',
    title: 'Listar terminais',
    description: 'Lista os terminais do MultTerm que o usuário compartilhou com o agente (id, título, host e permissão: read = só leitura, approve = cada envio precisa da aprovação do usuário, auto = controle livre).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_terminal',
    title: 'Ler terminal',
    description: 'Lê as últimas linhas da saída de um terminal compartilhado, como texto (sem códigos de cor).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id do terminal (de list_terminals)' },
        lines: { type: 'integer', minimum: 1, maximum: 2000, default: 100, description: 'quantas linhas do fim' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_command',
    title: 'Rodar comando',
    description: 'Digita um comando no terminal, aperta Enter e devolve a saída produzida até ela parar (ou o tempo esgotar). O comando roda no sistema remoto da sessão (ex.: shell do servidor SSH). Pode exigir a aprovação do usuário.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        command: { type: 'string', description: 'uma linha de comando' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 30 },
        quiet_ms: { type: 'integer', minimum: 200, maximum: 30000, default: 1500, description: 'considera terminado quando não chega saída por este tempo' },
      },
      required: ['id', 'command'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'send_input',
    title: 'Digitar texto',
    description: 'Digita um texto no terminal (para responder a um prompt, por exemplo). Com enter=true, aperta Enter no fim. Pode exigir a aprovação do usuário.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        enter: { type: 'boolean', default: false },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'send_keys',
    title: 'Apertar teclas',
    description: `Aperta teclas especiais no terminal, em ordem. Teclas: ${Object.keys(KEYS).join(', ')}. Pode exigir a aprovação do usuário.`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, keys: { type: 'array', items: { type: 'string', enum: Object.keys(KEYS) }, minItems: 1, maxItems: 20 } },
      required: ['id', 'keys'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
];

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

class ToolError extends Error {}

const visible = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, (c) => {
  const name: Record<string, string> = { '\r': '⏎', '\n': '⏎', '\t': '⇥', '\x1b': 'Esc', '\x03': 'Ctrl+C', '\x04': 'Ctrl+D', '\x1a': 'Ctrl+Z', '\x7f': '⌫' };
  return name[c] ?? `^${String.fromCharCode(c.charCodeAt(0) + 64)}`;
});

export class McpServer {
  private readonly bridge: TerminalBridge;
  private readonly approve: Approver;
  private readonly activity: Activity;
  private readonly serverName: string;
  private readonly version: string;

  constructor(opts: { bridge: TerminalBridge; approve: Approver; activity?: Activity; name?: string; version?: string }) {
    this.bridge = opts.bridge;
    this.approve = opts.approve;
    this.activity = opts.activity ?? (() => {});
    this.serverName = opts.name ?? 'multterm';
    this.version = opts.version ?? '0.0.0';
  }

  /** Trata uma mensagem (ou lote); devolve a resposta, ou undefined para notificações. */
  async handle(msg: unknown): Promise<unknown> {
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => this.one(m as Request)))).filter((r) => r !== undefined);
      return out.length ? out : undefined;
    }
    return this.one(msg as Request);
  }

  private async one(req: Request): Promise<unknown> {
    const isNotification = req?.id === undefined || req?.id === null;
    const reply = (result: unknown) => (isNotification ? undefined : { jsonrpc: '2.0', id: req.id, result });
    const error = (code: number, message: string) => (isNotification ? undefined : { jsonrpc: '2.0', id: req?.id ?? null, error: { code, message } });
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return error(-32600, 'pedido JSON-RPC inválido');
    switch (req.method) {
      case 'initialize': {
        const asked = String(req.params?.protocolVersion ?? '');
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.serverName, title: 'MultTerm', version: this.version },
          instructions: 'Terminais do MultTerm compartilhados pelo usuário. Comece por list_terminals; leia com read_terminal antes de agir. '
            + 'Comandos rodam nos sistemas remotos das sessões (servidores reais): seja cuidadoso e explique o que vai fazer.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await this.call(name, args);
          return reply({ content: [{ type: 'text', text }] });
        } catch (err) {
          if (err instanceof ToolError) return reply({ content: [{ type: 'text', text: err.message }], isError: true });
          return error(-32603, (err as Error).message);
        }
      }
      default:
        return error(-32601, `método desconhecido: ${req.method}`);
    }
  }

  private terminal(id: unknown): SharedTerminal {
    const t = this.bridge.list().find((x) => x.id === String(id));
    if (!t || t.mode === 'off') throw new ToolError(`terminal "${String(id)}" não existe ou não está compartilhado (use list_terminals)`);
    if (!t.running) throw new ToolError(`o terminal "${t.title}" foi encerrado`);
    return t;
  }

  private async write(t: SharedTerminal, description: string, data: string) {
    if (t.mode === 'read') throw new ToolError(`o terminal "${t.title}" está compartilhado só para leitura`);
    if (t.mode === 'approve' && !(await this.approve(t, description, data))) {
      this.activity(`recusado pelo usuário em "${t.title}": ${visible(data)}`);
      throw new ToolError('o usuário recusou este envio');
    }
    this.activity(`enviou para "${t.title}": ${visible(data)}`);
    this.bridge.write(t.id, data);
  }

  private async call(name: string, a: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'list_terminals': {
        const list = this.bridge.list().filter((t) => t.mode !== 'off');
        this.activity('listou os terminais');
        if (!list.length) return 'Nenhum terminal compartilhado. Peça ao usuário para compartilhar uma aba no botão Agente do MultTerm.';
        return JSON.stringify(list.map((t) => ({ id: t.id, title: t.title, ...(t.detail ? { host: t.detail } : {}), permission: t.mode, running: t.running })), null, 2);
      }
      case 'read_terminal': {
        const t = this.bridge.list().find((x) => x.id === String(a.id));
        if (!t || t.mode === 'off') throw new ToolError(`terminal "${String(a.id)}" não existe ou não está compartilhado`);
        const lines = Math.min(Math.max(Number(a.lines) || 100, 1), 2000);
        this.activity(`leu ${lines} linha(s) de "${t.title}"`);
        return this.bridge.tail(t.id, lines) || '(sem saída ainda)';
      }
      case 'run_command': {
        const t = this.terminal(a.id);
        const command = String(a.command ?? '');
        if (!command.trim() || /[\r\n]/.test(command)) throw new ToolError('envie uma linha de comando (sem quebras de linha)');
        const timeout = Math.min(Math.max(Number(a.timeout_seconds) || 30, 1), 600) * 1000;
        const quiet = Math.min(Math.max(Number(a.quiet_ms) || 1500, 200), 30_000);
        const mark = this.bridge.mark(t.id);
        await this.write(t, `rodar o comando: ${command}`, `${command}\r`);
        const finished = await this.bridge.waitQuiet(t.id, quiet, timeout);
        let out = terminalText(this.bridge.since(t.id, mark));
        // Tira o eco do próprio comando na primeira linha, se houver.
        const first = out.indexOf('\n');
        if (first >= 0 && out.slice(0, first).includes(command.trim())) out = out.slice(first + 1);
        if (out.length > 30_000) out = `…(${out.length - 30_000} caracteres antes omitidos)\n${out.slice(-30_000)}`;
        return `${out.trimEnd() || '(sem saída)'}${finished ? '' : `\n\n[a saída não parou em ${timeout / 1000} s: o comando pode continuar rodando; use read_terminal ou send_keys ctrl+c]`}`;
      }
      case 'send_input': {
        const t = this.terminal(a.id);
        const text = String(a.text ?? '');
        if (!text && !a.enter) throw new ToolError('nada para enviar');
        await this.write(t, a.enter ? `digitar e apertar Enter: ${text}` : `digitar: ${text}`, `${text}${a.enter ? '\r' : ''}`);
        return 'enviado';
      }
      case 'send_keys': {
        const t = this.terminal(a.id);
        const keys = Array.isArray(a.keys) ? a.keys.map(String) : [];
        const unknown = keys.filter((k) => !(k.toLowerCase() in KEYS));
        if (!keys.length || unknown.length) throw new ToolError(`teclas desconhecidas: ${unknown.join(', ') || '(nenhuma)'}`);
        await this.write(t, `apertar: ${keys.join(' ')}`, keys.map((k) => KEYS[k.toLowerCase()]).join(''));
        return 'enviado';
      }
      default:
        throw new ToolError(`ferramenta desconhecida: ${name}`);
    }
  }
}

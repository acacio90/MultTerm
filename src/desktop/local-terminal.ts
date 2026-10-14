import { join } from 'node:path';

/*
 * Terminais locais (PowerShell, Prompt de comando, WSL) e o agente aberto numa aba local.
 * Só monta a linha de comando; quem abre é o openTerminal (ConPTY), como nas abas SSH.
 */

export type LocalShell = 'powershell' | 'cmd' | 'wsl';

export const LOCAL_SHELLS: Record<LocalShell, string> = { powershell: 'PowerShell', cmd: 'Prompt de comando', wsl: 'WSL' };

export function localShellCommand(kind: LocalShell, systemRoot = process.env.SystemRoot ?? 'C:\\Windows'): { file: string; args: string[] } {
  const sys = join(systemRoot, 'System32');
  if (kind === 'cmd') return { file: join(sys, 'cmd.exe'), args: [] };
  if (kind === 'wsl') return { file: join(sys, 'wsl.exe'), args: ['--cd', '~'] };
  return { file: join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] };
}

/** Literal do PowerShell entre aspas simples. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Agente numa aba local: roda o comando configurado no PowerShell e mantém o shell aberto quando ele
 * termina. `{mcp}` vira o caminho do arquivo de configuração MCP (entre aspas, pronto para o shell).
 */
/** Agentes que o MultTerm sabe abrir; {mcp} vira o arquivo de configuração MCP gerado. */
export const AGENTS: Record<string, { label: string; command: string }> = {
  claude: { label: 'Claude Code', command: 'claude --mcp-config {mcp}' },
};
export const DEFAULT_AGENT = 'claude';

export function agentLaunchCommand(template: string, mcpConfig: string, systemRoot?: string): { file: string; args: string[] } {
  const cmd = template.trim();
  if (!cmd) throw new Error('escolha o agente na tela Agente');
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00]/.test(cmd) || cmd.length > 2000) throw new Error('comando do agente inválido');
  const line = cmd.includes('{mcp}') ? cmd.split('{mcp}').join(psQuote(mcpConfig)) : cmd;
  const ps = localShellCommand('powershell', systemRoot);
  return { file: ps.file, args: ['-NoLogo', '-NoExit', '-Command', line] };
}

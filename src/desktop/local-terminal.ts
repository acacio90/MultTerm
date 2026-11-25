import { join } from 'node:path';

/*
 * Terminais locais (PowerShell, Prompt de comando e WSL no Windows; o shell do usuário no Linux)
 * e o agente aberto numa aba local. Só monta a linha de comando; quem abre é o openTerminal
 * (ConPTY no Windows, pty no Linux), como nas abas SSH.
 */

export type LocalShell = 'powershell' | 'cmd' | 'wsl' | 'shell';

export const LOCAL_SHELLS: Record<LocalShell, string> = { powershell: 'PowerShell', cmd: 'Prompt de comando', wsl: 'WSL', shell: 'Terminal' };

/** Terminais locais oferecidos em cada sistema. */
export function localShells(platform: NodeJS.Platform = process.platform): LocalShell[] {
  return platform === 'win32' ? ['powershell', 'cmd', 'wsl'] : ['shell'];
}

export interface ShellEnv {
  platform?: NodeJS.Platform;
  /** %SystemRoot% (Windows). */
  systemRoot?: string;
  /** $SHELL (Linux). */
  shell?: string;
}

/** Shell do usuário fora do Windows: $SHELL, se for um caminho absoluto; senão /bin/sh. */
export function userShell(shell = process.env.SHELL): string {
  return shell && shell.startsWith('/') ? shell : '/bin/sh';
}

export function localShellCommand(kind: LocalShell, env: ShellEnv = {}): { file: string; args: string[] } {
  const platform = env.platform ?? process.platform;
  if (platform !== 'win32') {
    if (kind !== 'shell') throw new Error(`${LOCAL_SHELLS[kind]} só existe no Windows`);
    return { file: userShell(env.shell ?? process.env.SHELL), args: [] };
  }
  const sys = join(env.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  if (kind === 'cmd') return { file: join(sys, 'cmd.exe'), args: [] };
  if (kind === 'wsl') return { file: join(sys, 'wsl.exe'), args: ['--cd', '~'] };
  if (kind === 'shell') throw new Error('no Windows, escolha PowerShell, Prompt de comando ou WSL');
  return { file: join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] };
}

/** Literal do PowerShell entre aspas simples. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Literal do sh entre aspas simples. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Agentes que o MultTerm sabe abrir. `exe` é o executável procurado na máquina; no comando,
 * {exe} vira o caminho encontrado e {mcp} o arquivo de configuração MCP gerado.
 */
export const AGENTS: Record<string, { label: string; exe: string; command: string }> = {
  claude: { label: 'Claude Code', exe: 'claude', command: '{exe} --mcp-config {mcp}' },
};
export const DEFAULT_AGENT = 'claude';

/** Caminho do executável pronto para a linha de comando do shell que abre o agente. */
export function agentExe(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `& ${psQuote(path)}` : shQuote(path);
}

/**
 * Agente numa aba local: roda o comando configurado no shell (PowerShell no Windows, o shell do
 * usuário no Linux) e mantém o shell aberto quando ele termina. `{mcp}` vira o caminho do arquivo
 * de configuração MCP (entre aspas, pronto para o shell).
 */
export function agentLaunchCommand(template: string, mcpConfig: string, env: ShellEnv = {}): { file: string; args: string[] } {
  const platform = env.platform ?? process.platform;
  const cmd = template.trim();
  if (!cmd) throw new Error('escolha o agente na tela Agente');
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00]/.test(cmd) || cmd.length > 2000) throw new Error('comando do agente inválido');
  const quote = platform === 'win32' ? psQuote : shQuote;
  const line = cmd.includes('{mcp}') ? cmd.split('{mcp}').join(quote(mcpConfig)) : cmd;
  if (platform !== 'win32') {
    // Ao fim do agente, o shell do usuário continua (como o -NoExit do PowerShell).
    const shell = userShell(env.shell ?? process.env.SHELL);
    return { file: shell, args: ['-c', `${line}; exec ${shQuote(shell)} -i`] };
  }
  const ps = localShellCommand('powershell', { ...env, platform });
  return { file: ps.file, args: ['-NoLogo', '-NoExit', '-Command', line] };
}

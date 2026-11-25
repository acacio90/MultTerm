import { userShell } from '../desktop/local-terminal.ts';

/*
 * Shell dos servidores que executam comandos (SSH, Telnet, agendador): PowerShell ou cmd no
 * Windows; no Linux, o shell do usuário para sessões interativas e /bin/sh para comandos.
 */

export type ServerShell = 'powershell' | 'cmd' | 'sh';

/** Shell escolhido na configuração, valendo só o que existe no sistema. */
export function serverShell(raw: unknown, platform: NodeJS.Platform = process.platform): ServerShell {
  if (platform !== 'win32') return 'sh';
  return raw === 'cmd' ? 'cmd' : 'powershell';
}

/** Opções do campo "Shell" na tela de servidores. */
export function serverShellOptions(platform: NodeJS.Platform = process.platform): [ServerShell, string][] {
  return platform === 'win32'
    ? [['powershell', 'PowerShell'], ['cmd', 'Prompt de comando (cmd)']]
    : [['sh', 'Shell do usuário (sh para comandos)']];
}

/** Shell interativo (pty) de uma sessão SSH ou Telnet. */
export function interactiveShell(kind: ServerShell | undefined, env: { shell?: string } = {}): { file: string; args: string[] } {
  if (kind === 'cmd') return { file: 'cmd.exe', args: [] };
  if (kind === 'sh') return { file: userShell(env.shell ?? process.env.SHELL), args: ['-l'] };
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

/** Um comando avulso (exec do SSH, tarefa do agendador). */
export function commandShell(kind: ServerShell | undefined, command: string): { file: string; args: string[] } {
  if (kind === 'cmd') return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  if (kind === 'sh') return { file: '/bin/sh', args: ['-c', command] };
  return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
}

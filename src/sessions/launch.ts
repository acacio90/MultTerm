import { join } from 'node:path';
import { DEFAULT_PORTS, effectivePort, SessionError, type Session } from './model.ts';

export interface LaunchEnv {
  platform: NodeJS.Platform;
  /** wt.exe (Windows Terminal) disponível. */
  windowsTerminal: boolean;
  home: string;
  tmp: string;
  fileExists: (path: string) => boolean;
  /** %SystemRoot% (Windows). */
  systemRoot?: string;
}

/**
 * No Windows prefere o OpenSSH do sistema: é ele que usa o ssh-agent do Windows.
 * Pelo PATH poderia vir o ssh do Git, que não usa.
 */
export function sshProgram(env: Pick<LaunchEnv, 'platform' | 'fileExists' | 'systemRoot'>): string {
  if (env.platform !== 'win32') return 'ssh';
  const system = join(env.systemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  return env.fileExists(system) ? system : 'ssh.exe';
}

export interface LaunchPlan {
  command: string;
  args: string[];
  /** Arquivo a gravar antes de executar (ex.: .rdp para o mstsc). */
  file?: { path: string; content: string };
  /** Args já montados como linha de comando do cmd.exe (sem a citação automática do Node). */
  verbatim?: boolean;
  warnings: string[];
}

const CMD_SAFE = /^[\w@.:\\/~+=,-]+$/;

/** Cita um argumento para o cmd.exe; recusa o que o cmd interpretaria mesmo entre aspas. */
export function quoteForCmd(arg: string): string {
  if (/["%!\r\n]/.test(arg)) throw new SessionError(`argumento não suportado no console do Windows: ${arg}`);
  return CMD_SAFE.test(arg) ? arg : `"${arg}"`;
}

/**
 * Abre um programa de console numa janela própria via "cmd /c start".
 * (spawn com detached:true no Windows cria o processo SEM console: o ssh ficaria invisível.)
 */
export function consoleWindowPlan(command: string, args: string[], warnings: string[]): LaunchPlan {
  const line = ['start', '""', command, ...args.map(quoteForCmd)].join(' ');
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true, warnings };
}

export function expandHome(path: string, home: string): string {
  return path === '~' || /^~[\\/]/.test(path) ? join(home, path.slice(1)) : path;
}

export function sshArgs(
  s: Session,
  env: Pick<LaunchEnv, 'home' | 'fileExists'>,
): { args: string[]; warnings: string[] } {
  const args: string[] = [];
  const warnings: string[] = [];
  if (effectivePort(s) !== DEFAULT_PORTS.ssh) args.push('-p', String(effectivePort(s)));
  if (s.identityFile) {
    const key = expandHome(s.identityFile, env.home);
    if (/\.ppk$/i.test(key)) {
      // O OpenSSH não lê .ppk; usa a mesma chave exportada em formato OpenSSH ao lado, se houver.
      const openssh = key.slice(0, -'.ppk'.length);
      if (env.fileExists(openssh)) {
        args.push('-i', openssh);
        warnings.push(`chave .ppk trocada pela versão OpenSSH: ${openssh}`);
      } else {
        warnings.push(
          `chave .ppk ignorada (o OpenSSH não lê o formato PuTTY) e ${openssh} não existe; ` +
          `usando o agente SSH. Para converter: puttygen "${key}" -O private-openssh -o "${openssh}"`,
        );
      }
    } else {
      args.push('-i', key);
    }
  }
  // "--" encerra as opções: o destino nunca é interpretado como opção do ssh.
  args.push('--', s.user ? `${s.user}@${s.host}` : s.host);
  return { args, warnings };
}

export function rdpFileContent(s: Session): string {
  const lines = [`full address:s:${s.host}:${effectivePort(s)}`, 'prompt for credentials:i:1'];
  if (s.user) lines.push(`username:s:${s.user}`);
  return lines.join('\r\n') + '\r\n';
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'sessao';
}

export function planLaunch(s: Session, env: LaunchEnv): LaunchPlan {
  if (s.type === 'rdp') {
    if (env.platform === 'win32') {
      const path = join(env.tmp, 'multterm-rdp', `${safeFileName(s.name)}.rdp`);
      return { command: 'mstsc.exe', args: [path], file: { path, content: rdpFileContent(s) }, warnings: [] };
    }
    const args = [`/v:${s.host}:${effectivePort(s)}`];
    if (s.user) args.push(`/u:${s.user}`);
    return { command: 'xfreerdp', args, warnings: [] };
  }

  const { args, warnings } = sshArgs(s, env);
  if (env.platform === 'win32') {
    if (env.windowsTerminal) {
      // ";" separa comandos na linha de comando do wt.exe.
      const title = s.name.replace(/;/g, ',');
      return { command: 'wt.exe', args: ['new-tab', '--title', title, sshProgram(env), ...args], warnings };
    }
    return consoleWindowPlan(sshProgram(env), args, warnings);
  }
  return { command: 'x-terminal-emulator', args: ['-e', 'ssh', ...args], warnings };
}

/** Comando para rodar a sessão SSH dentro de um terminal embutido (pseudo-terminal). */
export function embeddedSshCommand(
  s: Session,
  env: Pick<LaunchEnv, 'platform' | 'home' | 'fileExists' | 'systemRoot'>,
) {
  if (s.type !== 'ssh') throw new SessionError(`${s.name}: só sessões SSH abrem no terminal embutido`);
  const { args, warnings } = sshArgs(s, env);
  return { file: sshProgram(env), args, warnings };
}

/** ssh-add do mesmo OpenSSH escolhido por sshProgram. */
export function sshAddProgram(env: Pick<LaunchEnv, 'platform' | 'fileExists' | 'systemRoot'>): string {
  const ssh = sshProgram(env);
  return ssh.replace(/ssh(\.exe)?$/i, (_m, ext: string | undefined) => `ssh-add${ext ?? ''}`);
}

export type AgentStatus =
  | { available: true; keys: string[] }
  | { available: false; message: string };

/** Interpreta "ssh-add -l": código 0 = chaves listadas, 1 = agente vazio, outro = sem agente. */
export function parseAgentList(exitCode: number | null, stdout: string, stderr: string): AgentStatus {
  if (exitCode === 0) {
    return { available: true, keys: stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
  }
  if (exitCode === 1) return { available: true, keys: [] };
  return { available: false, message: (stderr || stdout).trim() || 'agente SSH indisponível' };
}

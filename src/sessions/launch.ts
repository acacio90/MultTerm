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

/**
 * Argumentos do cliente FreeRDP (wfreerdp) para abrir a sessão RDP dentro de uma janela do
 * MultTerm: a janela do RDP vira filha de `parent` e a resolução acompanha o tamanho da aba.
 * A senha não vai na linha de comando: o FreeRDP pede (e o Windows guarda, se o usuário quiser).
 */
export function embeddedRdpArgs(s: Session, view: { parent: string; width: number; height: number }): string[] {
  const port = effectivePort(s);
  const args = [`/v:${s.host}${port === DEFAULT_PORTS.rdp ? '' : `:${port}`}`];
  if (s.user) {
    // DOMINIO\usuario vira /d: + /u:; usuario@dominio vai inteiro em /u:.
    const slash = s.user.indexOf('\\');
    if (slash > 0) args.push(`/d:${s.user.slice(0, slash)}`, `/u:${s.user.slice(slash + 1)}`);
    else args.push(`/u:${s.user}`);
  }
  const width = Math.max(200, Math.min(8192, Math.round(view.width)));
  const height = Math.max(200, Math.min(8192, Math.round(view.height)));
  args.push(
    `/parent-window:${view.parent}`,
    `/size:${width}x${height}`,
    '/dynamic-resolution',
    '+clipboard',
    `/title:${s.name}`,
  );
  return args;
}

// Códigos de saída do wfreerdp = último erro do FreeRDP: (classe << 16) | tipo.
// Classe 1: o servidor encerrou (ERRINFO_*); classe 2: falha ao conectar (ERRCONNECT_*).
const RDP_ENDED: Record<number, string> = {
  0x10001: 'um administrador desconectou a sessão',
  0x10002: 'um administrador encerrou a sessão (logoff)',
  0x10003: 'a sessão ficou ociosa por muito tempo e o servidor a desconectou',
  0x10004: 'o tempo para fazer logon esgotou',
  0x10005: 'outra conexão assumiu esta sessão',
  0x10007: 'o servidor recusou a conexão',
  0x10009: 'o usuário não tem permissão para acesso remoto neste servidor',
  0x1000a: 'o servidor exige que a senha seja digitada de novo',
  0x10101: 'o servidor não encontrou um servidor de licenças de RDP',
  0x10102: 'não há licença de RDP disponível no servidor',
};
const RDP_FAILED: Record<number, string> = {
  0x20004: 'falha na consulta DNS do host',
  0x20005: 'o nome do host não foi encontrado (DNS)',
  0x20006: 'não foi possível conectar ao servidor',
  0x20008: 'falha na conexão segura (TLS) com o servidor',
  0x20009: 'falha na autenticação',
  0x2000a: 'privilégios insuficientes',
  0x2000b: 'conexão cancelada',
  0x2000c: 'o servidor não aceitou nenhum dos modos de segurança oferecidos',
  0x2000d: 'não foi possível conectar: o servidor não respondeu ou a porta está fechada/bloqueada',
  0x2000e: 'a senha expirou',
  0x2000f: 'a senha expirou',
  0x20011: 'o controlador de domínio (Kerberos) não está acessível',
  0x20012: 'a conta está desativada',
  0x20013: 'é preciso trocar a senha antes de entrar',
  0x20014: 'usuário ou senha incorretos',
  0x20015: 'senha incorreta',
  0x20016: 'acesso negado',
  0x20017: 'a conta tem restrições que impedem este logon',
  0x20018: 'a conta está bloqueada',
  0x20019: 'a conta expirou',
  0x2001a: 'o usuário não tem permissão de logon remoto neste servidor',
  0x2001b: 'usuário ou senha não informados',
  0x2001c: 'o servidor demorou demais para iniciar a sessão',
  0x2001d: 'o servidor ainda está iniciando; tente de novo em instantes',
  0x2001e: 'o servidor exige autenticação no nível da rede (NLA)',
};
// Fins normais (o próprio usuário saiu ou desconectou pelo Windows remoto).
const RDP_NORMAL = new Set([0, 0x1000b, 0x1000c]);

/** Mensagem para o fim de uma sessão RDP; `normal` = o usuário saiu, não é erro. */
export function rdpExitMessage(code: number | null): { normal: boolean; message: string } {
  if (code === null) return { normal: false, message: 'o cliente RDP não pôde ser iniciado' };
  if (RDP_NORMAL.has(code)) return { normal: true, message: '' };
  const known = RDP_ENDED[code] ?? RDP_FAILED[code];
  return { normal: false, message: known ?? `erro do cliente RDP 0x${code.toString(16).padStart(8, '0')}` };
}

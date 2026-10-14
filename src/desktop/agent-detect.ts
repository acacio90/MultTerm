import { join } from 'node:path';

/*
 * Detecção dos agentes instalados: cada agente do catálogo diz o executável e onde os instaladores
 * costumam colocá-lo; o MultTerm procura no PATH (where.exe) e nesses caminhos, e só oferece na
 * lista os que encontrou.
 */

export interface AgentDetection {
  installed: boolean;
  path?: string;
  version?: string;
}

/** "where.exe nome": um caminho por linha (vazio ou erro = não encontrado). */
export function parseWhere(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Entre os candidatos, o que dá para executar no Windows: .exe primeiro, depois .cmd/.bat (os do
 * npm). O arquivo sem extensão que o npm também cria é um script de shell Unix e fica de fora.
 */
export function pickExecutable(candidates: string[]): string | undefined {
  const by = (re: RegExp) => candidates.find((c) => re.test(c));
  return by(/\.exe$/i) ?? by(/\.(cmd|bat)$/i);
}

/** Caminhos onde os instaladores costumam deixar o executável de um agente. */
export function knownAgentPaths(exe: string, env: { userProfile?: string; appData?: string }): string[] {
  const paths: string[] = [];
  if (env.userProfile) paths.push(join(env.userProfile, '.local', 'bin', `${exe}.exe`));
  if (env.appData) paths.push(join(env.appData, 'npm', `${exe}.cmd`));
  return paths;
}

/** Primeira linha útil de "--version" (ex.: "2.1.4 (Claude Code)" → "2.1.4"). */
export function parseVersion(stdout: string): string | undefined {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line?.match(/\d+(?:\.\d+)+/)?.[0] ?? line?.slice(0, 40);
}

/**
 * Agente a usar: o gravado, se estiver instalado (ou se a detecção ainda não terminou); senão o
 * primeiro instalado do catálogo. `fallback` avisa que o gravado não foi encontrado.
 */
export function chooseAgent(
  saved: string,
  order: string[],
  detected: Record<string, AgentDetection> | undefined,
): { agent: string; fallback: boolean } {
  if (!detected || detected[saved]?.installed !== false) return { agent: saved, fallback: false };
  const first = order.find((id) => detected[id]?.installed);
  return first ? { agent: first, fallback: true } : { agent: saved, fallback: false };
}

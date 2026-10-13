import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/*
 * Base dos servidores locais: tipos comuns, validação de porta e resolução de caminho que
 * nunca sai da pasta raiz (nem por "..", nem por caminho absoluto, nem por link simbólico).
 */

export type LogFn = (line: string) => void;

export interface RunningServer {
  /** Porta efetiva (útil quando a pedida é 0). */
  port: number;
  stop(): Promise<void>;
}

export function checkPort(v: unknown, fallback: number): number {
  const n = v === undefined || v === null || v === '' ? fallback : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('porta inválida (1 a 65535)');
  return n;
}

export function checkRoot(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || !isAbsolute(s)) throw new Error('escolha a pasta raiz');
  return resolve(s);
}

/**
 * Caminho pedido por um cliente → caminho real dentro da raiz, ou undefined se escapar dela.
 * Aceita "/" ou "\" como separador e ignora a barra inicial. `mustExist` = false permite
 * arquivos novos (upload): confere a pasta pai.
 */
export async function resolveInRoot(root: string, requested: string, mustExist = true): Promise<string | undefined> {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(requested) || /^[a-zA-Z]:/.test(requested)) return undefined;
  const clean = normalize(requested.replace(/\\/g, '/').replace(/^\/+/, '') || '.');
  if (clean.split(/[\\/]/).includes('..')) return undefined;
  const target = join(root, clean);
  const realRoot = await realpath(root);
  const inside = (p: string) => {
    const rel = relative(realRoot, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  try {
    const real = await realpath(target);
    return inside(real) ? real : undefined;
  } catch {
    if (mustExist) return undefined;
    // Arquivo novo: a pasta pai precisa existir e estar dentro da raiz.
    const parent = await realpath(join(target, '..')).catch(() => undefined);
    if (!parent || !inside(parent)) return undefined;
    return join(parent, target.split(sep).pop()!);
  }
}

export const timestamp = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

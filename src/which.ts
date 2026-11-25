import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Procura um executável no PATH (o "which" do Unix), sem abrir um shell. Um caminho absoluto só é
 * conferido. Devolve undefined se não achar.
 */
export function which(name: string, pathEnv = process.env.PATH ?? ''): string | undefined {
  const runnable = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(name)) return runnable(name) ? name : undefined;
  if (!name || name.includes('/')) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (runnable(p)) return p;
  }
  return undefined;
}

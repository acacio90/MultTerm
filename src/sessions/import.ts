import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { parseInventory } from './import-inventory.ts';
import type { Session } from './model.ts';
import { parseSessions } from './store.ts';

export interface ImportFile {
  format: 'multterm' | 'inventory';
  sessions: Session[];
  warnings: string[];
}

/** Lê um arquivo para importar: sessões do MultTerm (YAML) ou inventário (INI/YAML). */
export async function readImportFile(path: string, rootFolder = ''): Promise<ImportFile> {
  const text = await readFile(path, 'utf8');
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    doc = undefined;
  }
  if (typeof doc === 'object' && doc !== null && 'sessions' in doc) {
    return { format: 'multterm', sessions: parseSessions(text, path), warnings: [] };
  }
  return { format: 'inventory', ...parseInventory(text, rootFolder) };
}

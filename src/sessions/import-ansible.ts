import { parse } from 'yaml';
import { normalizeFolder, SessionError, sessionKey, validateSession, type Session } from './model.ts';

/*
 * Inventário do Ansible (INI ou YAML) → sessões.
 * - Cada grupo vira uma pasta; grupos filhos (":children" / "children:") viram subpastas.
 * - Um host aparece em cada grupo onde é listado diretamente.
 * - Variáveis: host > grupo > grupos pais > all.
 * - ansible_connection=winrm/psrp → sessão RDP (a porta do WinRM não é usada).
 */

type Vars = Record<string, unknown>;

interface Group {
  hosts: Map<string, Vars>;
  children: Set<string>;
  vars: Vars;
}

export interface Inventory {
  groups: Map<string, Group>;
}

export interface ImportResult {
  sessions: Session[];
  warnings: string[];
}

const IMPLICIT = new Set(['all', 'ungrouped']);

function group(inv: Inventory, name: string): Group {
  let g = inv.groups.get(name);
  if (!g) {
    g = { hosts: new Map(), children: new Set(), vars: {} };
    inv.groups.set(name, g);
  }
  return g;
}

/** Expande faixas de host do Ansible: web[01:03] → web01, web02, web03; db[a:c] → dba, dbb, dbc. */
export function expandHostPattern(pattern: string): string[] {
  const m = /^(.*?)\[([0-9a-z]+):([0-9a-z]+)(?::(\d+))?\](.*)$/i.exec(pattern);
  if (!m) return [pattern];
  const [, prefix, from, to, stepText, suffix] = m;
  const step = stepText ? Number(stepText) : 1;
  const out: string[] = [];
  if (/^\d+$/.test(from) && /^\d+$/.test(to)) {
    const width = from.length;
    for (let i = Number(from); i <= Number(to); i += step) out.push(String(i).padStart(width, '0'));
  } else if (from.length === 1 && to.length === 1) {
    for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c += step) out.push(String.fromCharCode(c));
  } else {
    return [pattern];
  }
  return out.flatMap((part) => expandHostPattern(`${prefix}${part}${suffix}`));
}

/** Divide "a=1 b='x y'" respeitando aspas. */
function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseKeyValues(tokens: string[]): Vars {
  const vars: Vars = {};
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq > 0) vars[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return vars;
}

export function parseIniInventory(text: string): Inventory {
  const inv: Inventory = { groups: new Map() };
  let section = 'ungrouped';
  let kind: 'hosts' | 'children' | 'vars' = 'hosts';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]:]+)(?::(children|vars))?\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      kind = (header[2] as 'children' | 'vars' | undefined) ?? 'hosts';
      group(inv, section);
      continue;
    }
    const g = group(inv, section);
    if (kind === 'children') {
      g.children.add(line.split(/\s+/)[0]);
      group(inv, line.split(/\s+/)[0]);
    } else if (kind === 'vars') {
      Object.assign(g.vars, parseKeyValues([line.replace(/\s*=\s*/, '=')]));
    } else {
      const [pattern, ...rest] = splitArgs(line);
      const vars = parseKeyValues(rest);
      for (const host of expandHostPattern(pattern)) g.hosts.set(host, { ...(g.hosts.get(host) ?? {}), ...vars });
    }
  }
  return inv;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseYamlInventory(doc: unknown): Inventory {
  const inv: Inventory = { groups: new Map() };
  const visit = (name: string, node: unknown) => {
    const g = group(inv, name);
    if (!isObject(node)) return;
    if (isObject(node.vars)) Object.assign(g.vars, node.vars);
    if (isObject(node.hosts)) {
      for (const [pattern, vars] of Object.entries(node.hosts)) {
        for (const host of expandHostPattern(pattern)) {
          g.hosts.set(host, { ...(g.hosts.get(host) ?? {}), ...(isObject(vars) ? vars : {}) });
        }
      }
    }
    if (isObject(node.children)) {
      for (const [child, sub] of Object.entries(node.children)) {
        g.children.add(child);
        visit(child, sub);
      }
    }
  };
  if (isObject(doc)) for (const [name, node] of Object.entries(doc)) visit(name, node);
  return inv;
}

/** Um YAML é inventário do Ansible se os grupos de topo têm hosts/children/vars. */
export function looksLikeYamlInventory(doc: unknown): boolean {
  return isObject(doc) && !('sessions' in doc) &&
    Object.values(doc).some((g) => isObject(g) && ('hosts' in g || 'children' in g || 'vars' in g));
}

/** Caminhos de pasta de cada grupo (a partir dos grupos de topo; "all"/"ungrouped" ficam na raiz). */
function groupPaths(inv: Inventory): Map<string, { folder: string; chain: string[] }> {
  const parents = new Map<string, string>();
  for (const [name, g] of inv.groups) {
    for (const child of g.children) if (!parents.has(child)) parents.set(child, name);
  }
  const paths = new Map<string, { folder: string; chain: string[] }>();
  for (const name of inv.groups.keys()) {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let cur: string | undefined = name; cur && !seen.has(cur); cur = parents.get(cur)) {
      seen.add(cur);
      chain.unshift(cur);
    }
    const folder = chain.filter((n) => !IMPLICIT.has(n)).join('/');
    paths.set(name, { folder, chain });
  }
  return paths;
}

const TEMPLATE = /\{\{|\{%/;

export function inventoryToSessions(inv: Inventory, rootFolder = ''): ImportResult {
  const sessions: Session[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const allVars = inv.groups.get('all')?.vars ?? {};

  for (const [groupName, { folder, chain }] of groupPaths(inv)) {
    const g = inv.groups.get(groupName)!;
    for (const [host, hostVars] of g.hosts) {
      const vars: Vars = { ...allVars };
      for (const name of chain) Object.assign(vars, inv.groups.get(name)?.vars);
      Object.assign(vars, hostVars);

      const label = folder ? `${folder}/${host}` : host;
      const pick = (...keys: string[]): string | undefined => {
        for (const k of keys) {
          const v = vars[k];
          if (v === undefined || v === null || v === '') continue;
          const s = String(v);
          if (TEMPLATE.test(s)) {
            warnings.push(`${label}: ${k} usa template Jinja (${s}); campo ignorado`);
            return undefined;
          }
          return s;
        }
        return undefined;
      };

      const connection = pick('ansible_connection');
      if (connection === 'local') {
        warnings.push(`${label}: ansible_connection=local, ignorado`);
        continue;
      }
      const windows = connection === 'winrm' || connection === 'psrp';
      const raw: Record<string, unknown> = {
        name: host.replace(/\//g, '-'),
        folder: normalizeFolder([rootFolder, folder].filter(Boolean).join('/')),
        type: windows ? 'rdp' : 'ssh',
        host: pick('ansible_host', 'ansible_ssh_host') ?? host,
        user: pick('ansible_user', 'ansible_ssh_user'),
      };
      if (!windows) {
        const port = pick('ansible_port', 'ansible_ssh_port');
        if (port) raw.port = Number(port);
        raw.identityFile = pick('ansible_ssh_private_key_file', 'ansible_private_key_file');
      }

      let session: Session;
      try {
        session = validateSession(raw, label);
      } catch (err) {
        if (!(err instanceof SessionError)) throw err;
        warnings.push(`${err.message}, ignorado`);
        continue;
      }
      const key = sessionKey(session);
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push(session);
    }
  }
  return { sessions, warnings };
}

/** Lê um inventário em texto (INI ou YAML). */
export function parseAnsibleInventory(text: string, rootFolder = ''): ImportResult {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    doc = undefined; // INI com sintaxe que não é YAML válido
  }
  const inv = looksLikeYamlInventory(doc) ? parseYamlInventory(doc) : parseIniInventory(text);
  return inventoryToSessions(inv, rootFolder);
}

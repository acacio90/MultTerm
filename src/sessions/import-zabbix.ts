import { normalizeFolder, normalizeMac, SessionError, sessionKey, validateSession, type Session } from './model.ts';
import type { ImportResult } from './import-inventory.ts';

/*
 * Hosts do Zabbix (resposta do host.get) → sessões, e a sincronização delas com o arquivo.
 * - Cada grupo escolhido vira uma pasta ("/" no nome do grupo cria subpastas); um host em vários
 *   grupos escolhidos aparece em cada um.
 * - Endereço: interface principal do agente (IP ou DNS, conforme "useip"); sem agente, a SNMP.
 *   Hosts com endereço local (localhost, 127.x.x.x, ::1) ficam de fora.
 * - Tipo: tag "multterm.type" (ssh|rdp); senão Windows no inventário ou nos templates vira RDP.
 * - Tags opcionais "multterm.user" e "multterm.port"; MAC do inventário (macaddress_a).
 */

export interface ZabbixGroup {
  groupid: string;
  name: string;
}

export interface ZabbixInterface {
  type: string;
  main: string;
  useip: string;
  ip: string;
  dns: string;
}

export interface ZabbixHost {
  hostid: string;
  host: string;
  name?: string;
  interfaces?: ZabbixInterface[];
  /** O Zabbix devolve uma lista vazia quando o host não tem inventário. */
  inventory?: { os?: string; macaddress_a?: string } | unknown[];
  tags?: { tag: string; value: string }[];
  /** selectHostGroups (6.2+) ou selectGroups (6.0). */
  hostgroups?: ZabbixGroup[];
  groups?: ZabbixGroup[];
  parentTemplates?: { name: string }[];
}

const AGENT = '1';
const SNMP = '2';

/** Endereço da interface principal do agente; sem agente, da SNMP. */
export function hostAddress(host: ZabbixHost): string | undefined {
  const interfaces = host.interfaces ?? [];
  const main = (type: string) => interfaces.find((i) => i.type === type && i.main === '1');
  const iface = main(AGENT) ?? main(SNMP);
  if (!iface) return undefined;
  const preferred = iface.useip === '1' ? iface.ip : iface.dns;
  return (preferred || iface.ip || iface.dns || '').trim() || undefined;
}

/** localhost, 127.x.x.x e ::1: o próprio servidor do Zabbix, que não é alcançável por esse endereço. */
export function isLoopback(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  return a === 'localhost' || a.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(a) || a === '::1' || a === '0:0:0:0:0:0:0:1';
}

function tag(host: ZabbixHost, name: string): string | undefined {
  return host.tags?.find((t) => t.tag.toLowerCase() === name)?.value.trim() || undefined;
}

function inventory(host: ZabbixHost): { os?: string; macaddress_a?: string } {
  return host.inventory && !Array.isArray(host.inventory) ? host.inventory : {};
}

function sessionType(host: ZabbixHost): string {
  const explicit = tag(host, 'multterm.type');
  if (explicit) return explicit.toLowerCase();
  const windows = /windows/i.test(inventory(host).os ?? '') || (host.parentTemplates ?? []).some((t) => /windows/i.test(t.name));
  return windows ? 'rdp' : 'ssh';
}

export function zabbixToSessions(hosts: ZabbixHost[], groupIds: Iterable<string>, rootFolder = ''): ImportResult {
  const chosen = new Set(groupIds);
  const sessions: Session[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const host of hosts) {
    const label = host.name || host.host;
    const address = hostAddress(host);
    if (!address) {
      warnings.push(`${label}: sem interface do agente ou SNMP, ignorado`);
      continue;
    }
    if (isLoopback(address)) {
      warnings.push(`${label}: endereço local (${address}), ignorado`);
      continue;
    }
    const groups = (host.hostgroups ?? host.groups ?? []).filter((g) => chosen.has(g.groupid));
    const type = sessionType(host);
    const mac = normalizeMac(inventory(host).macaddress_a ?? '');
    for (const group of groups) {
      const raw: Record<string, unknown> = {
        name: label.replace(/\//g, '-'),
        folder: normalizeFolder([rootFolder, group.name].filter(Boolean).join('/')),
        type,
        host: address,
        port: tag(host, 'multterm.port'),
        user: tag(host, 'multterm.user'),
        mac,
        zabbixHostId: host.hostid,
      };
      let session: Session;
      try {
        session = validateSession(raw, `${group.name}/${label}`);
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

export interface ZabbixSyncPlan {
  /** O arquivo inteiro depois da sincronização. */
  sessions: Session[];
  added: Session[];
  updated: Session[];
  removed: Session[];
  /** Vindas do Zabbix com a mesma pasta/nome de uma sessão criada à mão (que é mantida). */
  conflicts: Session[];
}

/** Mesmos campos e valores, em qualquer ordem. */
function sameSession(a: Session, b: Session): boolean {
  const norm = (s: Session) => JSON.stringify(Object.entries(s).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

/**
 * Sessão existente atualizada pelo Zabbix: nome, pasta e endereço vêm sempre dele; usuário, porta
 * e MAC só quando o Zabbix tem valor; tipo, chave, VPN, opções e tags ficam como editados aqui.
 */
function updateFromZabbix(prev: Session, inc: Session): Session {
  const next: Session = { ...prev, name: inc.name, folder: inc.folder, host: inc.host, zabbixHostId: inc.zabbixHostId };
  if (inc.user !== undefined) next.user = inc.user;
  if (inc.port !== undefined) next.port = inc.port;
  if (inc.mac !== undefined) next.mac = inc.mac;
  return next;
}

/**
 * Sincroniza as sessões do Zabbix (as que têm zabbixHostId) com o que veio da API: novas entram,
 * existentes são atualizadas e as que não vieram (host removido ou grupo desmarcado) saem.
 * Sessões sem zabbixHostId nunca são alteradas.
 */
export function planZabbixSync(existing: Session[], incoming: Session[]): ZabbixSyncPlan {
  const managed = existing.filter((s) => s.zabbixHostId);
  const others = existing.filter((s) => !s.zabbixHostId);
  const otherKeys = new Set(others.map(sessionKey));
  const byKey = new Map(managed.map((s) => [sessionKey(s), s]));
  const used = new Set<Session>();
  const plan: ZabbixSyncPlan = { sessions: [...others], added: [], updated: [], removed: [], conflicts: [] };

  for (const inc of incoming) {
    if (otherKeys.has(sessionKey(inc))) {
      plan.conflicts.push(inc);
      continue;
    }
    // Mesmo lugar primeiro; senão, outra sessão do mesmo host (grupo ou nome mudou no Zabbix).
    const same = byKey.get(sessionKey(inc));
    const prev = same && same.zabbixHostId === inc.zabbixHostId && !used.has(same)
      ? same
      : managed.find((s) => s.zabbixHostId === inc.zabbixHostId && !used.has(s));
    if (!prev) {
      plan.added.push(inc);
      plan.sessions.push(inc);
      continue;
    }
    used.add(prev);
    const next = updateFromZabbix(prev, inc);
    plan.sessions.push(next);
    if (!sameSession(prev, next)) plan.updated.push(next);
  }
  plan.removed = managed.filter((s) => !used.has(s));
  return plan;
}

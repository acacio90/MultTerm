import { normalizeFolder, normalizeMac, SessionError, sessionKey, validateSession, type Session } from './model.ts';
import type { ImportResult } from './import-inventory.ts';

/*
 * Hosts do Zabbix (resposta do host.get) → sessões.
 * - Cada grupo escolhido vira uma pasta ("/" no nome do grupo cria subpastas); um host em vários
 *   grupos escolhidos aparece em cada um.
 * - Endereço: interface principal do agente (IP ou DNS, conforme "useip"); sem agente, a SNMP.
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

import { isIPv6 } from 'node:net';
import snmp from 'net-snmp';
import { isSafeHost } from '../sessions/model.ts';

export type SnmpVersion = '1' | '2c' | '3';
export type SnmpOperation = 'get' | 'getnext' | 'getbulk' | 'walk';
export type SecurityLevelName = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';

export const AUTH_PROTOCOLS = ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'] as const;
export const PRIV_PROTOCOLS = ['des', 'aes', 'aes256b', 'aes256r'] as const;
type AuthProtocol = (typeof AUTH_PROTOCOLS)[number];
type PrivProtocol = (typeof PRIV_PROTOCOLS)[number];

export interface SnmpUser {
  name: string;
  level: SecurityLevelName;
  authProtocol?: AuthProtocol;
  authKey?: string;
  privProtocol?: PrivProtocol;
  privKey?: string;
}

export interface SnmpRequest {
  host: string;
  port: number;
  version: SnmpVersion;
  community?: string;
  user?: SnmpUser;
  operation: SnmpOperation;
  oids: string[];
  nonRepeaters: number;
  maxRepetitions: number;
  timeoutMs: number;
  retries: number;
  maxResults: number;
}

export interface SnmpResult {
  oid: string;
  name: string;
  type: string;
  value: string;
}

/** Nomes comuns da MIB-2 (e algumas da HOST-RESOURCES e IF-MIB) para digitar e para exibir. */
export const KNOWN_OIDS: Record<string, string> = {
  'mib-2': '1.3.6.1.2.1',
  system: '1.3.6.1.2.1.1',
  sysDescr: '1.3.6.1.2.1.1.1',
  sysObjectID: '1.3.6.1.2.1.1.2',
  sysUpTime: '1.3.6.1.2.1.1.3',
  sysContact: '1.3.6.1.2.1.1.4',
  sysName: '1.3.6.1.2.1.1.5',
  sysLocation: '1.3.6.1.2.1.1.6',
  sysServices: '1.3.6.1.2.1.1.7',
  interfaces: '1.3.6.1.2.1.2',
  ifNumber: '1.3.6.1.2.1.2.1',
  ifTable: '1.3.6.1.2.1.2.2',
  ifIndex: '1.3.6.1.2.1.2.2.1.1',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifMtu: '1.3.6.1.2.1.2.2.1.4',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  ifXTable: '1.3.6.1.2.1.31.1.1',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  ip: '1.3.6.1.2.1.4',
  ipAddrTable: '1.3.6.1.2.1.4.20',
  hrSystem: '1.3.6.1.2.1.25.1',
  hrSystemUptime: '1.3.6.1.2.1.25.1.1',
  hrStorage: '1.3.6.1.2.1.25.2',
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  enterprises: '1.3.6.1.4.1',
};

/** Escalares do grupo "system": digitar só o nome (ex.: sysName) significa a instância ".0". */
const SCALARS = new Set(['sysDescr', 'sysObjectID', 'sysUpTime', 'sysContact', 'sysName', 'sysLocation', 'sysServices', 'ifNumber', 'hrSystemUptime']);

const byLowerName = new Map(Object.entries(KNOWN_OIDS).map(([k, v]) => [k.toLowerCase(), { name: k, oid: v }]));
const byOid = Object.entries(KNOWN_OIDS)
  .map(([name, oid]) => ({ name, oid }))
  .sort((a, b) => b.oid.length - a.oid.length);

/** "sysName", "ifDescr.3", ".1.3.6.1.2.1.1.5.0" ou "1.3.6…" → OID numérico. */
export function resolveOid(text: string, { scalarInstance = true } = {}): string {
  const t = text.trim().replace(/^\./, '');
  const m = /^([A-Za-z][\w-]*)((?:\.\d+)*)$/.exec(t);
  let oid = t;
  if (m) {
    const known = byLowerName.get(m[1].toLowerCase());
    if (!known) throw new Error(`OID desconhecido: "${text}" (use o número, ex.: 1.3.6.1.2.1.1.5.0)`);
    oid = known.oid + (m[2] || (scalarInstance && SCALARS.has(known.name) ? '.0' : ''));
  }
  if (!/^\d+(\.\d+)+$/.test(oid) || oid.split('.').some((n) => Number(n) > 4294967295)) {
    throw new Error(`OID inválido: "${text}"`);
  }
  return oid;
}

/** Nome legível do OID pelo prefixo conhecido mais longo: 1.3.6.1.2.1.2.2.1.2.3 → ifDescr.3 */
export function describeOid(oid: string): string {
  for (const k of byOid) {
    if (oid === k.oid) return k.name;
    if (oid.startsWith(`${k.oid}.`)) return `${k.name}.${oid.slice(k.oid.length + 1)}`;
  }
  return '';
}

const intIn = (v: unknown, min: number, max: number, fallback: number, label: string): number => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} deve estar entre ${min} e ${max}`);
  return n;
};

/** Valida o pedido vindo da interface (mensagens em português). */
export function validateSnmpRequest(raw: unknown): SnmpRequest {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');

  const host = str('host').trim();
  if (!isSafeHost(host)) throw new Error(`host inválido (${host || 'vazio'})`);
  const version = str('version') as SnmpVersion;
  if (!['1', '2c', '3'].includes(version)) throw new Error('versão SNMP inválida (use 1, 2c ou 3)');
  const operation = str('operation') as SnmpOperation;
  if (!['get', 'getnext', 'getbulk', 'walk'].includes(operation)) throw new Error('operação inválida');
  if (operation === 'getbulk' && version === '1') throw new Error('getbulk não existe no SNMPv1: use v2c/v3 ou getnext');

  const oidTexts = str('oids').split(/[\s,;]+/).filter(Boolean);
  if (oidTexts.length === 0) throw new Error('informe ao menos um OID');
  if (operation === 'walk' && oidTexts.length > 1) throw new Error('walk aceita um único OID (a raiz da subárvore)');
  if (oidTexts.length > 50) throw new Error('no máximo 50 OIDs por requisição');
  // get/getnext/getbulk de um escalar pelo nome usa a instância .0; walk e getnext partem do nó.
  const oids = oidTexts.map((t) => resolveOid(t, { scalarInstance: operation === 'get' }));

  const req: SnmpRequest = {
    host,
    port: intIn(o.port, 1, 65535, 161, 'porta'),
    version,
    operation,
    oids,
    nonRepeaters: intIn(o.nonRepeaters, 0, oids.length, 0, 'non-repeaters'),
    maxRepetitions: intIn(o.maxRepetitions, 1, 1000, 20, 'max-repetitions'),
    timeoutMs: intIn(o.timeoutMs, 200, 60000, 3000, 'timeout'),
    retries: intIn(o.retries, 0, 5, 1, 'tentativas'),
    maxResults: intIn(o.maxResults, 1, 100000, 10000, 'limite de resultados'),
  };

  if (version === '3') {
    const name = str('user').trim();
    if (!name) throw new Error('SNMPv3: informe o usuário');
    const level = (str('level') || 'authPriv') as SecurityLevelName;
    if (!['noAuthNoPriv', 'authNoPriv', 'authPriv'].includes(level)) throw new Error('nível de segurança inválido');
    const user: SnmpUser = { name, level };
    if (level !== 'noAuthNoPriv') {
      const authProtocol = (str('authProtocol') || 'sha') as AuthProtocol;
      if (!AUTH_PROTOCOLS.includes(authProtocol)) throw new Error('protocolo de autenticação inválido');
      const authKey = str('authKey');
      if (authKey.length < 8) throw new Error('SNMPv3: a senha de autenticação deve ter ao menos 8 caracteres');
      Object.assign(user, { authProtocol, authKey });
    }
    if (level === 'authPriv') {
      const privProtocol = (str('privProtocol') || 'aes') as PrivProtocol;
      if (!PRIV_PROTOCOLS.includes(privProtocol)) throw new Error('protocolo de privacidade inválido');
      const privKey = str('privKey');
      if (privKey.length < 8) throw new Error('SNMPv3: a senha de privacidade deve ter ao menos 8 caracteres');
      Object.assign(user, { privProtocol, privKey });
    }
    req.user = user;
  } else {
    req.community = str('community') || 'public';
  }
  return req;
}

const TYPE_NAMES: Record<number, string> = {
  1: 'Boolean', 2: 'Integer', 3: 'BitString', 4: 'OctetString', 5: 'Null', 6: 'OID',
  64: 'IpAddress', 65: 'Counter32', 66: 'Gauge32', 67: 'TimeTicks', 68: 'Opaque', 70: 'Counter64',
  128: 'noSuchObject', 129: 'noSuchInstance', 130: 'endOfMibView',
};

/** Centésimos de segundo → "3d 04:05:06 (1234567)". */
export function formatTimeTicks(ticks: number): string {
  let s = Math.floor(ticks / 100);
  const d = Math.floor(s / 86400);
  s %= 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${hh}:${mm}:${ss} (${ticks})`;
}

/** OctetString: texto quando imprimível; MAC (6 bytes) e binários em hexadecimal. */
export function formatOctets(buf: Buffer): string {
  if (buf.length === 0) return '';
  const text = buf.toString('utf8');
  const printable = !text.includes('�') && /^[\t\n\r\x20-\x7E -￿]*$/.test(text.replace(/\0+$/, ''));
  if (printable && !(buf.length === 6 && /[\x00-\x1f]/.test(text))) return text.replace(/\0+$/, '');
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

export function formatVarbind(vb: { oid: string; type: number; value: unknown }): SnmpResult {
  const type = TYPE_NAMES[vb.type] ?? String(vb.type);
  let value: string;
  switch (vb.type) {
    case 128: value = '(objeto não existe)'; break;
    case 129: value = '(instância não existe)'; break;
    case 130: value = '(fim da MIB)'; break;
    case 5: value = ''; break;
    case 4: value = Buffer.isBuffer(vb.value) ? formatOctets(vb.value) : String(vb.value ?? ''); break;
    case 67: value = formatTimeTicks(Number(vb.value)); break;
    case 70: value = Buffer.isBuffer(vb.value) ? BigInt(`0x${vb.value.toString('hex') || '0'}`).toString() : String(vb.value); break;
    case 68: value = Buffer.isBuffer(vb.value) ? vb.value.toString('hex') : String(vb.value); break;
    default: value = Buffer.isBuffer(vb.value) ? vb.value.toString('hex') : String(vb.value ?? '');
  }
  return { oid: vb.oid, name: describeOid(vb.oid), type, value };
}

/** Traduz os erros do net-snmp. */
export function snmpErrorMessage(err: unknown, req: Pick<SnmpRequest, 'version' | 'timeoutMs'>): string {
  const e = err as Error & { name?: string };
  const msg = e?.message ?? String(err);
  if (e?.name === 'RequestTimedOutError' || /timed out/i.test(msg)) {
    return req.version === '3'
      ? `sem resposta em ${req.timeoutMs} ms — confira host, porta, usuário, senhas e protocolos do SNMPv3`
      : `sem resposta em ${req.timeoutMs} ms — confira host, porta, versão e community`;
  }
  if (/unknown user/i.test(msg)) return 'SNMPv3: usuário desconhecido no agente';
  if (/wrong digest/i.test(msg)) return 'SNMPv3: senha ou protocolo de autenticação incorretos';
  if (/unsupported sec(urity)? ?level/i.test(msg)) return 'SNMPv3: nível de segurança não aceito pelo agente para este usuário';
  if (/authentication|usmStats/i.test(msg)) return `SNMPv3 recusado pelo agente: ${msg}`;
  if (/decryption|privacy/i.test(msg)) return `SNMPv3: falha de criptografia (protocolo ou senha de privacidade): ${msg}`;
  return msg;
}

function createSession(req: SnmpRequest) {
  const options = {
    port: req.port,
    retries: req.retries,
    timeout: req.timeoutMs,
    transport: (isIPv6(req.host) ? 'udp6' : 'udp4') as 'udp4' | 'udp6',
  };
  if (req.version === '3' && req.user) {
    const u = req.user;
    const user: Record<string, unknown> = { name: u.name, level: snmp.SecurityLevel[u.level] };
    if (u.authProtocol) Object.assign(user, { authProtocol: snmp.AuthProtocols[u.authProtocol], authKey: u.authKey });
    if (u.privProtocol) Object.assign(user, { privProtocol: snmp.PrivProtocols[u.privProtocol], privKey: u.privKey });
    return snmp.createV3Session(req.host, user as never, options as never);
  }
  return snmp.createSession(req.host, req.community ?? 'public', {
    ...options,
    version: req.version === '1' ? snmp.Version1 : snmp.Version2c,
  } as never);
}

type Varbind = { oid: string; type: number; value: unknown };

/** Executa a operação; resultados também chegam um a um por onResult. Cancelável. */
export function runSnmp(
  req: SnmpRequest,
  opts: { signal?: AbortSignal; onResult?: (r: SnmpResult) => void } = {},
): Promise<SnmpResult[]> {
  return new Promise((resolve, reject) => {
    const results: SnmpResult[] = [];
    const session = createSession(req);
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        session.close();
      } catch {
        // já fechada
      }
      if (err && !opts.signal?.aborted) reject(new Error(snmpErrorMessage(err, req)));
      else resolve(results);
    };
    const onAbort = () => finish();
    if (opts.signal?.aborted) return finish();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    session.on('error', (err: unknown) => finish(err));

    const push = (vb: Varbind) => {
      const r = formatVarbind(vb);
      results.push(r);
      opts.onResult?.(r);
    };
    const flat = (list: unknown[]): Varbind[] =>
      list.flatMap((v) => (Array.isArray(v) ? (v as Varbind[]) : [v as Varbind]));
    const done = (err: unknown, varbinds?: unknown[]) => {
      if (err) return finish(err);
      for (const vb of flat(varbinds ?? [])) push(vb);
      finish();
    };

    switch (req.operation) {
      case 'get':
        session.get(req.oids, done as never);
        break;
      case 'getnext':
        session.getNext(req.oids, done as never);
        break;
      case 'getbulk':
        session.getBulk(req.oids, req.nonRepeaters, req.maxRepetitions, done as never);
        break;
      case 'walk':
        // subtree = "snmpwalk": só os OIDs abaixo da raiz informada.
        (session as unknown as {
          subtree: (oid: string, rep: number, feed: (v: Varbind[]) => boolean | void, end: (e: unknown) => void) => void;
        }).subtree(req.oids[0], req.maxRepetitions, (varbinds) => {
          for (const vb of varbinds) {
            push(vb);
            if (results.length >= req.maxResults || opts.signal?.aborted) return true; // para o walk
          }
          return false;
        }, (err) => finish(err));
        break;
    }
  });
}

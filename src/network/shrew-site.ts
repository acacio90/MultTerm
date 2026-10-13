import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { isSafeSiteName, type SiteDirs } from './shrew.ts';

/*
 * Criação e edição dos sites do Shrew Soft VPN no formato do próprio cliente (linhas
 * "s:chave:texto", "n:chave:número", "b:chave:base64"). Valores conferidos no ipseca.exe
 * (VPN Access Manager) e na libike.dll 2.2.2. Chaves que o editor não conhece (certificados,
 * opções de outras versões) são preservadas na ordem original.
 */

type Kind = 's' | 'n' | 'b';
export type FieldInput = 'text' | 'number' | 'select' | 'bool' | 'ipv4' | 'networks' | 'secret';

export interface SiteField {
  key: string;
  kind: Kind;
  input: FieldInput;
  label: string;
  group: string;
  options?: [string, string][];
  min?: number;
  max?: number;
  /** Fica na seção "Avançado" do editor. */
  advanced?: boolean;
  /** Mostrar só quando outro campo tem um destes valores. */
  when?: { key: string; values: string[] };
  hint?: string;
}

const DH: [string, string][] = [['1', '1 (768)'], ['2', '2 (1024)'], ['5', '5 (1536)'], ['14', '14 (2048)'], ['15', '15 (3072)'], ['16', '16 (4096)'], ['17', '17 (6144)'], ['18', '18 (8192)']];
const KEYLEN: [string, string][] = [['0', 'automático'], ['128', '128'], ['192', '192'], ['256', '256']];
const HASH: [string, string][] = [['auto', 'automático'], ['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha2-256', 'SHA-2 256'], ['sha2-384', 'SHA-2 384'], ['sha2-512', 'SHA-2 512']];
const IDENT: [string, string][] = [['address', 'Endereço IP'], ['fqdn', 'Nome de domínio (FQDN)'], ['ufqdn', 'E-mail (UFQDN)'], ['keyid', 'Identificador de chave'], ['asn1dn', 'DN do certificado (ASN.1)']];
const XAUTH = ['hybrid-rsa-xauth', 'hybrid-grp-xauth', 'mutual-rsa-xauth', 'mutual-psk-xauth'];
const PSK = ['hybrid-grp-xauth', 'mutual-psk-xauth', 'mutual-psk'];
const on = (key: string, ...values: string[]) => ({ key, values });

export const SITE_FIELDS: SiteField[] = [
  { key: 'network-host', kind: 's', input: 'text', label: 'Gateway (host ou IP)', group: 'Geral' },
  { key: 'network-ike-port', kind: 'n', input: 'number', label: 'Porta IKE', group: 'Geral', min: 1, max: 65535 },
  {
    key: 'auth-method', kind: 's', input: 'select', label: 'Autenticação', group: 'Autenticação', options: [
      ['mutual-psk-xauth', 'Chave compartilhada + usuário e senha (Mutual PSK + XAuth)'],
      ['mutual-psk', 'Só chave compartilhada (Mutual PSK)'],
      ['hybrid-grp-xauth', 'Grupo + usuário e senha (Hybrid GRP + XAuth)'],
      ['hybrid-rsa-xauth', 'Certificado do gateway + usuário e senha (Hybrid RSA + XAuth)'],
      ['mutual-rsa-xauth', 'Certificados + usuário e senha (Mutual RSA + XAuth)'],
      ['mutual-rsa', 'Certificados (Mutual RSA)'],
    ],
  },
  {
    key: 'auth-mutual-psk', kind: 'b', input: 'secret', label: 'Chave compartilhada (PSK)', group: 'Autenticação',
    when: on('auth-method', ...PSK), hint: 'em branco mantém a atual',
  },
  { key: 'client-saved-username', kind: 's', input: 'text', label: 'Usuário (lembrado)', group: 'Autenticação', when: on('auth-method', ...XAUTH) },
  { key: 'ident-client-type', kind: 's', input: 'select', label: 'Identificação local', group: 'Autenticação', options: IDENT, advanced: true },
  { key: 'ident-client-data', kind: 's', input: 'text', label: 'Valor da identificação local', group: 'Autenticação', advanced: true, hint: 'vazio = automático' },
  { key: 'ident-server-type', kind: 's', input: 'select', label: 'Identificação do gateway', group: 'Autenticação', options: [['any', 'Qualquer'], ...IDENT], advanced: true },
  { key: 'ident-server-data', kind: 's', input: 'text', label: 'Valor da identificação do gateway', group: 'Autenticação', advanced: true, hint: 'vazio = automático' },

  { key: 'client-auto-mode', kind: 's', input: 'select', label: 'Configuração automática', group: 'Cliente', options: [['pull', 'Obter do gateway (ike config pull)'], ['push', 'Gateway envia (ike config push)'], ['dhcp', 'DHCP sobre IPsec'], ['disabled', 'Desativada']], advanced: true },
  { key: 'client-iface', kind: 's', input: 'select', label: 'Adaptador', group: 'Cliente', options: [['virtual', 'Adaptador virtual (endereço da VPN)'], ['direct', 'Adaptador existente (sem endereço próprio)']], advanced: true },
  { key: 'client-addr-auto', kind: 'n', input: 'bool', label: 'Obter endereço automaticamente', group: 'Cliente', advanced: true, when: on('client-iface', 'virtual') },
  { key: 'client-ip-addr', kind: 's', input: 'ipv4', label: 'Endereço', group: 'Cliente', advanced: true, when: on('client-addr-auto', '0') },
  { key: 'client-ip-mask', kind: 's', input: 'ipv4', label: 'Máscara', group: 'Cliente', advanced: true, when: on('client-addr-auto', '0') },
  { key: 'network-mtu-size', kind: 'n', input: 'number', label: 'MTU', group: 'Cliente', min: 68, max: 9000, advanced: true },
  { key: 'client-dns-used', kind: 'n', input: 'bool', label: 'Usar o DNS da VPN', group: 'Cliente', advanced: true },
  { key: 'client-dns-auto', kind: 'n', input: 'bool', label: 'Obter DNS automaticamente', group: 'Cliente', advanced: true, when: on('client-dns-used', '1') },
  { key: 'client-dns-addr', kind: 's', input: 'ipv4', label: 'Servidor DNS', group: 'Cliente', advanced: true, when: on('client-dns-auto', '0') },
  { key: 'client-dns-suffix-auto', kind: 'n', input: 'bool', label: 'Obter sufixo DNS automaticamente', group: 'Cliente', advanced: true, when: on('client-dns-used', '1') },
  { key: 'client-dns-suffix', kind: 's', input: 'text', label: 'Sufixo DNS', group: 'Cliente', advanced: true, when: on('client-dns-suffix-auto', '0') },
  { key: 'client-splitdns-used', kind: 'n', input: 'bool', label: 'DNS dividido (split DNS)', group: 'Cliente', advanced: true },
  { key: 'client-splitdns-auto', kind: 'n', input: 'bool', label: 'Obter domínios do DNS dividido', group: 'Cliente', advanced: true, when: on('client-splitdns-used', '1') },
  { key: 'client-wins-used', kind: 'n', input: 'bool', label: 'Usar WINS da VPN', group: 'Cliente', advanced: true },
  { key: 'client-wins-auto', kind: 'n', input: 'bool', label: 'Obter WINS automaticamente', group: 'Cliente', advanced: true, when: on('client-wins-used', '1') },
  { key: 'client-banner-enable', kind: 'n', input: 'bool', label: 'Mostrar o aviso (banner) do gateway', group: 'Cliente', advanced: true },

  { key: 'network-natt-mode', kind: 's', input: 'select', label: 'NAT Traversal', group: 'Rede', options: [['enable', 'Ativado'], ['disable', 'Desativado'], ['force-draft', 'Forçar (draft)'], ['force-rfc', 'Forçar (RFC)'], ['force-cisco-udp', 'Forçar (Cisco UDP)']], advanced: true },
  { key: 'network-natt-port', kind: 'n', input: 'number', label: 'Porta NAT-T', group: 'Rede', min: 1, max: 65535, advanced: true, when: on('network-natt-mode', 'enable', 'force-draft', 'force-rfc', 'force-cisco-udp') },
  { key: 'network-natt-rate', kind: 'n', input: 'number', label: 'Keep-alive NAT-T (s)', group: 'Rede', min: 0, max: 3600, advanced: true, when: on('network-natt-mode', 'enable', 'force-draft', 'force-rfc', 'force-cisco-udp') },
  { key: 'network-frag-mode', kind: 's', input: 'select', label: 'Fragmentação IKE', group: 'Rede', options: [['enable', 'Ativada'], ['disable', 'Desativada'], ['force', 'Forçada']], advanced: true },
  { key: 'network-frag-size', kind: 'n', input: 'number', label: 'Tamanho máximo do pacote IKE', group: 'Rede', min: 256, max: 9000, advanced: true, when: on('network-frag-mode', 'enable', 'force') },
  { key: 'network-dpd-enable', kind: 'n', input: 'bool', label: 'Detectar gateway inativo (DPD)', group: 'Rede', advanced: true },
  { key: 'network-notify-enable', kind: 'n', input: 'bool', label: 'Notificações ISAKMP', group: 'Rede', advanced: true },

  { key: 'phase1-exchange', kind: 's', input: 'select', label: 'Modo de troca', group: 'Fase 1', options: [['main', 'Main'], ['aggressive', 'Aggressive']], advanced: true },
  { key: 'phase1-dhgroup', kind: 'n', input: 'select', label: 'Grupo DH', group: 'Fase 1', options: DH, advanced: true },
  { key: 'phase1-cipher', kind: 's', input: 'select', label: 'Cifra', group: 'Fase 1', options: [['auto', 'automática'], ['aes', 'AES'], ['blowfish', 'Blowfish'], ['3des', '3DES'], ['cast', 'CAST'], ['des', 'DES']], advanced: true },
  { key: 'phase1-keylen', kind: 'n', input: 'select', label: 'Tamanho da chave', group: 'Fase 1', options: KEYLEN, advanced: true },
  { key: 'phase1-hash', kind: 's', input: 'select', label: 'Hash', group: 'Fase 1', options: HASH, advanced: true },
  { key: 'phase1-life-secs', kind: 'n', input: 'number', label: 'Vida (segundos)', group: 'Fase 1', min: 0, max: 31_536_000, advanced: true },
  { key: 'phase1-life-kbytes', kind: 'n', input: 'number', label: 'Vida (KB, 0 = sem limite)', group: 'Fase 1', min: 0, max: 2_147_483_647, advanced: true },
  { key: 'vendor-chkpt-enable', kind: 'n', input: 'bool', label: 'Compatibilidade Check Point', group: 'Fase 1', advanced: true },

  { key: 'phase2-transform', kind: 's', input: 'select', label: 'Transformação', group: 'Fase 2', options: [['auto', 'automática'], ['esp-aes', 'ESP-AES'], ['esp-blowfish', 'ESP-Blowfish'], ['esp-3des', 'ESP-3DES'], ['esp-cast', 'ESP-CAST'], ['esp-des', 'ESP-DES']], advanced: true },
  { key: 'phase2-keylen', kind: 'n', input: 'select', label: 'Tamanho da chave', group: 'Fase 2', options: KEYLEN, advanced: true },
  { key: 'phase2-hmac', kind: 's', input: 'select', label: 'HMAC', group: 'Fase 2', options: HASH, advanced: true },
  { key: 'phase2-pfsgroup', kind: 'n', input: 'select', label: 'Grupo PFS', group: 'Fase 2', options: [['0', 'desativado'], ...DH], advanced: true },
  { key: 'ipcomp-transform', kind: 's', input: 'select', label: 'Compressão', group: 'Fase 2', options: [['disabled', 'desativada'], ['deflate', 'Deflate'], ['lzs', 'LZS']], advanced: true },
  { key: 'phase2-life-secs', kind: 'n', input: 'number', label: 'Vida (segundos)', group: 'Fase 2', min: 0, max: 31_536_000, advanced: true },
  { key: 'phase2-life-kbytes', kind: 'n', input: 'number', label: 'Vida (KB, 0 = sem limite)', group: 'Fase 2', min: 0, max: 2_147_483_647, advanced: true },

  { key: 'policy-level', kind: 's', input: 'select', label: 'Nível da política', group: 'Políticas', options: [['auto', 'automático'], ['use', 'use'], ['require', 'require'], ['unique', 'unique'], ['shared', 'shared']], advanced: true },
  { key: 'policy-nailed', kind: 'n', input: 'bool', label: 'Manter as SAs abertas (nailed)', group: 'Políticas', advanced: true },
  { key: 'policy-list-auto', kind: 'n', input: 'bool', label: 'Obter as redes do gateway automaticamente', group: 'Políticas' },
  {
    key: 'policy-list-include', kind: 's', input: 'networks', label: 'Redes pela VPN', group: 'Políticas', when: on('policy-list-auto', '0'),
    hint: 'CIDR separados por vírgula, ex.: 10.0.0.0/8, 192.168.10.0/24',
  },
  { key: 'policy-list-exclude', kind: 's', input: 'networks', label: 'Redes fora da VPN', group: 'Políticas', when: on('policy-list-auto', '0'), advanced: true },
];

const FIELD = new Map(SITE_FIELDS.map((f) => [f.key, f]));

/** Padrões de um site novo: os atuais do Shrew com cifras fortes (AES-256, SHA-2, DH 14). */
export const SITE_DEFAULTS: Record<string, string> = {
  'network-ike-port': '500', 'auth-method': 'mutual-psk-xauth', 'ident-client-type': 'address', 'ident-server-type': 'address',
  'client-auto-mode': 'pull', 'client-iface': 'virtual', 'client-addr-auto': '1', 'network-mtu-size': '1380',
  'client-dns-used': '1', 'client-dns-auto': '1', 'client-dns-suffix-auto': '1', 'client-splitdns-used': '1', 'client-splitdns-auto': '1',
  'client-wins-used': '1', 'client-wins-auto': '1', 'client-banner-enable': '1',
  'network-natt-mode': 'enable', 'network-natt-port': '4500', 'network-natt-rate': '15', 'network-frag-mode': 'enable', 'network-frag-size': '540',
  'network-dpd-enable': '1', 'network-notify-enable': '1',
  'phase1-exchange': 'main', 'phase1-dhgroup': '14', 'phase1-cipher': 'aes', 'phase1-keylen': '256', 'phase1-hash': 'sha2-256',
  'phase1-life-secs': '86400', 'phase1-life-kbytes': '0', 'vendor-chkpt-enable': '0',
  'phase2-transform': 'esp-aes', 'phase2-keylen': '256', 'phase2-hmac': 'sha2-256', 'phase2-pfsgroup': '14', 'ipcomp-transform': 'disabled',
  'phase2-life-secs': '28800', 'phase2-life-kbytes': '0',
  'policy-level': 'auto', 'policy-nailed': '0', 'policy-list-auto': '1',
};

interface Line {
  kind: Kind;
  key: string;
  value: string;
}

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([snb]):([\w-]+):(.*)$/.exec(raw);
    if (m) out.push({ kind: m[1] as Kind, key: m[2], value: m[3] });
  }
  return out;
}

const MASK_BITS = (mask: string) => {
  const n = mask.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const bits = n.toString(2).replace(/0+$/, '');
  return /^1*$/.test(bits) ? bits.length : -1;
};
const BITS_MASK = (bits: number) => {
  const n = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
};

/** "10.0.0.0 / 255.0.0.0,192.168.1.0 / 255.255.255.0" → "10.0.0.0/8, 192.168.1.0/24". */
export function networksToCidr(value: string): string {
  return value.split(',').map((item) => {
    const [addr, mask] = item.split('/').map((s) => s.trim());
    if (!addr) return '';
    const bits = mask && mask.includes('.') ? MASK_BITS(mask) : Number(mask ?? 32);
    return bits >= 0 ? `${addr}/${bits}` : `${addr} / ${mask}`;
  }).filter(Boolean).join(', ');
}

/** "10.0.0.0/8, 192.168.1.0/24" → formato do Shrew; aceita também "endereço / máscara". */
export function cidrToNetworks(value: string): string {
  const items = value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  return items.map((item) => {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2}|\d{1,3}(?:\.\d{1,3}){3})$/.exec(item);
    if (!m || !isIPv4(m[1])) throw new Error(`rede inválida: "${item}" (use CIDR, ex.: 10.0.0.0/8)`);
    const bits = m[2].includes('.') ? (isIPv4(m[2]) ? MASK_BITS(m[2]) : -1) : Number(m[2]);
    if (bits < 0 || bits > 32) throw new Error(`máscara inválida em "${item}"`);
    return `${m[1]} / ${BITS_MASK(bits)}`;
  }).join(',');
}

export interface SiteEdit {
  name: string;
  public: boolean;
  /** Valores do editor (sem a PSK); redes em CIDR. */
  values: Record<string, string>;
  pskSet: boolean;
}

function toEdit(name: string, lines: Line[], isPublic: boolean): SiteEdit {
  // Chave ausente no arquivo aparece com o padrão (o Shrew exige todas; sem isso o editor
  // mostraria a primeira opção e gravaria um valor que ninguém escolheu).
  const values: Record<string, string> = { ...SITE_DEFAULTS };
  for (const l of lines) {
    const f = FIELD.get(l.key);
    if (!f || f.input === 'secret') continue;
    values[l.key] = f.input === 'networks' ? networksToCidr(l.value) : l.value;
  }
  return { name, public: isPublic, values, pskSet: lines.some((l) => l.key === 'auth-mutual-psk' && l.value.trim() !== '') };
}

async function findSiteFile(dirs: SiteDirs, name: string): Promise<{ path: string; public: boolean } | undefined> {
  for (const [dir, isPublic] of [[dirs.user, false], [dirs.public, true]] as const) {
    if (!dir) continue;
    const match = (await readdir(dir).catch(() => [] as string[])).find((n) => n.toLowerCase() === name.toLowerCase());
    if (match) return { path: join(dir, match), public: isPublic };
  }
  return undefined;
}

export async function readSite(dirs: SiteDirs, name: string): Promise<SiteEdit> {
  if (!isSafeSiteName(name)) throw new Error('nome de site inválido');
  const found = await findSiteFile(dirs, name);
  if (!found) throw new Error(`site "${name}" não encontrado`);
  return toEdit(name, parseLines(await readFile(found.path, 'utf8')), found.public);
}

export function newSite(): SiteEdit {
  return { name: '', public: false, values: { ...SITE_DEFAULTS }, pskSet: false };
}

/** Confere um valor do editor e devolve como vai para o arquivo ('' = remover a chave). */
function checkValue(f: SiteField, raw: unknown): string {
  const v = String(raw ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(v) || v.length > 1000) throw new Error(`${f.label}: valor inválido`);
  if (v === '') return '';
  switch (f.input) {
    case 'select':
      if (!f.options!.some(([o]) => o === v)) throw new Error(`${f.label}: opção inválida (${v})`);
      return v;
    case 'bool':
      if (v !== '0' && v !== '1') throw new Error(`${f.label}: valor inválido`);
      return v;
    case 'number': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < (f.min ?? 0) || n > (f.max ?? Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${f.label}: use um número entre ${f.min ?? 0} e ${f.max}`);
      }
      return String(n);
    }
    case 'ipv4':
      if (!isIPv4(v)) throw new Error(`${f.label}: endereço IPv4 inválido`);
      return v;
    case 'networks':
      return cidrToNetworks(v);
    default:
      return v;
  }
}

export interface SiteSave {
  /** Nome atual (edição) ou ausente (site novo). */
  original?: string;
  name: string;
  values: Record<string, unknown>;
  /** Nova PSK; vazia mantém a atual. */
  psk?: string;
}

/**
 * Grava o site na pasta do usuário. Um site público editado vira uma cópia do usuário (que tem
 * precedência). Mantém a ordem e as chaves desconhecidas do arquivo original.
 */
export async function saveSite(dirs: SiteDirs, req: SiteSave): Promise<SiteEdit> {
  const name = String(req.name ?? '').trim();
  if (!isSafeSiteName(name)) throw new Error('nome do site inválido (sem / \\ : * ? " < > | e até 100 caracteres)');
  let lines: Line[] = [];
  let originalPath: string | undefined;
  if (req.original) {
    const found = await findSiteFile(dirs, req.original);
    if (!found) throw new Error(`site "${req.original}" não encontrado`);
    lines = parseLines(await readFile(found.path, 'utf8'));
    if (!found.public) originalPath = found.path;
  } else {
    lines = [{ kind: 'n', key: 'version', value: '4' }];
  }
  // Sem "network-host" nos valores, vale o do arquivo (ex.: só renomear ou trocar a PSK).
  const host = String(req.values['network-host'] ?? lines.find((l) => l.key === 'network-host')?.value ?? '').trim();
  if (!host || /\s/.test(host) || host.startsWith('-') || host.length > 255) throw new Error('informe o gateway (host ou IP)');
  const renamed = !req.original || req.original.toLowerCase() !== name.toLowerCase();
  if (renamed && (await findSiteFile({ user: dirs.user }, name))) throw new Error(`já existe um site "${name}"`);

  const set = (key: string, kind: Kind, value: string) => {
    const i = lines.findIndex((l) => l.key === key);
    if (value === '') {
      if (i >= 0) lines.splice(i, 1);
    } else if (i >= 0) lines[i] = { kind, key, value };
    else lines.push({ kind, key, value });
  };
  for (const f of SITE_FIELDS) {
    if (f.input === 'secret') continue;
    if (!(f.key in req.values)) continue;
    set(f.key, f.kind, f.key === 'network-host' ? host : checkValue(f, req.values[f.key]));
  }
  const psk = typeof req.psk === 'string' ? req.psk : '';
  if (psk) {
    if (psk.length > 256 || /[\r\n\0]/.test(psk)) throw new Error('chave compartilhada inválida');
    set('auth-mutual-psk', 'b', Buffer.from(psk, 'utf8').toString('base64'));
  }

  const target = join(dirs.user, name);
  const text = `${lines.map((l) => `${l.kind}:${l.key}:${l.value}`).join('\n')}\n`;
  await mkdir(dirs.user, { recursive: true });
  const tmp = `${target}.multterm-tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, target);
  if (originalPath && renamed) await rm(originalPath, { force: true });
  return toEdit(name, lines, false);
}

/** Exclui só sites do usuário (os públicos pertencem a todos os usuários da máquina). */
export async function deleteSite(dirs: SiteDirs, name: string): Promise<void> {
  if (!isSafeSiteName(name)) throw new Error('nome de site inválido');
  const found = await findSiteFile({ user: dirs.user }, name);
  if (!found) throw new Error(`site "${name}" não é do usuário (sites de todos os usuários não são excluídos aqui)`);
  await rm(found.path);
}

/** Exporta no formato .vpn (o mesmo arquivo do site, que o Shrew e o MultTerm importam). */
export async function exportSite(dirs: SiteDirs, name: string, dest: string): Promise<void> {
  if (!isSafeSiteName(name)) throw new Error('nome de site inválido');
  const found = await findSiteFile(dirs, name);
  if (!found) throw new Error(`site "${name}" não encontrado`);
  await copyFile(found.path, dest);
}

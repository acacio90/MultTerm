import { isIPv4 } from 'node:net';
import { IdType, ipv4 } from './ike/packet.ts';
import type { IkeConfig, Phase1Proposal } from './ike/client.ts';
import type { CipherName, HashName } from './ike/crypto.ts';
import { parseSiteFile } from '../network/shrew.ts';
import { networksToCidr } from '../network/shrew-site.ts';

/*
 * Site do Shrew (o mesmo arquivo do editor) → configuração do motor de VPN do MultTerm.
 * O que o motor ainda não faz (certificados, modo agressivo, sem NAT-T...) é recusado com
 * uma mensagem clara, para usar o Shrew nesses casos.
 */

export interface NativeVpnOptions {
  ike: IkeConfig;
  staticAddress?: string;
  networks?: string[];
  dns: { use: boolean; servers?: string[]; domain?: string };
}

const HASHES: Record<string, HashName[]> = {
  auto: ['sha256', 'sha1', 'md5'], md5: ['md5'], sha1: ['sha1'], 'sha2-256': ['sha256'], 'sha2-384': ['sha384'], 'sha2-512': ['sha512'],
};

function ciphers(name: string, keylen: number, what: string): { cipher: CipherName; keyBits?: number }[] {
  const aes = (bits: number) => (bits ? [{ cipher: 'aes' as const, keyBits: bits }] : [256, 192, 128].map((b) => ({ cipher: 'aes' as const, keyBits: b })));
  switch (name.replace(/^esp-/, '')) {
    case 'auto': return [...aes(keylen), { cipher: '3des' }];
    case 'aes': return aes(keylen);
    case '3des': return [{ cipher: '3des' }];
    case 'des': return [{ cipher: 'des' }];
    default: throw new Error(`${what}: a cifra "${name}" não é suportada pelo motor do MultTerm (use AES ou 3DES, ou o Shrew)`);
  }
}

function proposals(cipher: string, keylen: number, hash: string, what: string): Phase1Proposal[] {
  const hashes = HASHES[hash];
  if (!hashes) throw new Error(`${what}: hash "${hash}" desconhecido`);
  return ciphers(cipher, keylen, what).flatMap((c) => hashes.map((h) => ({ ...c, hash: h })));
}

export function siteToVpnOptions(text: string, creds: { user?: string; password?: string }): NativeVpnOptions {
  const cfg = parseSiteFile(text);
  const s = (k: string, d = '') => cfg.get(k) ?? d;
  const n = (k: string, d: number) => {
    const v = Number(cfg.get(k));
    return Number.isFinite(v) && cfg.has(k) ? v : d;
  };

  const host = s('network-host');
  if (!host) throw new Error('o site não tem gateway');
  const auth = s('auth-method', 'mutual-psk-xauth');
  if (auth !== 'mutual-psk-xauth' && auth !== 'mutual-psk') {
    throw new Error(`autenticação "${auth}" ainda não é suportada pelo motor do MultTerm (só chave compartilhada, com ou sem usuário e senha); use o Shrew`);
  }
  const psk = Buffer.from(s('auth-mutual-psk'), 'base64');
  if (!psk.length) throw new Error('o site não tem chave compartilhada (PSK)');
  if (s('phase1-exchange', 'main') !== 'main') throw new Error('o modo aggressive ainda não é suportado pelo motor do MultTerm; use o Shrew');
  if (s('network-natt-mode', 'enable') === 'disable') throw new Error('o motor do MultTerm exige NAT-T (ESP em UDP); ative o NAT Traversal no site');
  const xauth = auth === 'mutual-psk-xauth';
  if (xauth && (!creds.user || !creds.password)) throw new Error('informe usuário e senha');

  const mode = s('client-auto-mode', 'pull');
  if (mode === 'push' || mode === 'dhcp') throw new Error(`configuração automática "${mode}" ainda não é suportada pelo motor do MultTerm (use "pull" ou desativada)`);
  const staticAddress = n('client-addr-auto', 1) === 0 || mode === 'disabled' ? s('client-ip-addr') : undefined;
  if (mode === 'disabled' && !(staticAddress && isIPv4(staticAddress))) throw new Error('sem configuração automática, o site precisa de um endereço fixo');

  let localId: IkeConfig['localId'];
  const idType = s('ident-client-type', 'address');
  const idData = s('ident-client-data');
  if (idData) {
    if (idType === 'address') {
      if (!isIPv4(idData)) throw new Error('identificação local: endereço inválido');
      localId = { type: IdType.IPv4, data: ipv4(idData) };
    } else if (idType === 'fqdn') localId = { type: IdType.FQDN, data: Buffer.from(idData) };
    else if (idType === 'ufqdn') localId = { type: IdType.UserFQDN, data: Buffer.from(idData) };
    else if (idType === 'keyid') localId = { type: IdType.KeyId, data: Buffer.from(idData) };
    else throw new Error(`identificação local "${idType}" não é suportada pelo motor do MultTerm`);
  }

  const networks = n('policy-list-auto', 1) === 0 && s('policy-list-include')
    ? networksToCidr(s('policy-list-include')).split(', ').filter(Boolean)
    : undefined;
  const dnsUsed = n('client-dns-used', 1) === 1;
  const dns = {
    use: dnsUsed,
    ...(dnsUsed && n('client-dns-auto', 1) === 0 && s('client-dns-addr') ? { servers: [s('client-dns-addr')] } : {}),
    ...(dnsUsed && n('client-dns-suffix-auto', 1) === 0 && s('client-dns-suffix') ? { domain: s('client-dns-suffix') } : {}),
  };

  return {
    ike: {
      host,
      ikePort: n('network-ike-port', 500),
      nattPort: n('network-natt-port', 4500),
      psk,
      ...(xauth ? { user: creds.user, password: creds.password } : {}),
      xauth,
      dhGroup: n('phase1-dhgroup', 2),
      phase1: proposals(s('phase1-cipher', 'auto'), n('phase1-keylen', 0), s('phase1-hash', 'auto'), 'fase 1'),
      phase1Life: n('phase1-life-secs', 86400) || 86400,
      phase2: proposals(s('phase2-transform', 'auto'), n('phase2-keylen', 0), s('phase2-hmac', 'auto'), 'fase 2'),
      pfsGroup: n('phase2-pfsgroup', 0),
      phase2Life: n('phase2-life-secs', 3600) || 3600,
      ...(localId ? { localId } : {}),
      modeConfig: mode === 'pull',
    },
    ...(staticAddress ? { staticAddress } : {}),
    ...(networks?.length ? { networks } : {}),
    dns,
  };
}

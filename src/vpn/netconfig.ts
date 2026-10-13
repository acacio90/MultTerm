import { execFile } from 'node:child_process';
import { isIPv4 } from 'node:net';
import type { NetConfig, NetSetup } from './tunnel.ts';
import type { Tun } from './wintun.ts';

/*
 * IP, rotas e DNS do adaptador da VPN no Windows (PowerShell/NetTCPIP, só na memória: nada
 * fica gravado e tudo some com o adaptador). Exige administrador (roda no processo auxiliar).
 */

const CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function checkSetup(s: NetSetup, gateway: string) {
  if (!isIPv4(s.address)) throw new Error('endereço da VPN inválido');
  if (!isIPv4(gateway)) throw new Error('endereço do gateway inválido');
  for (const n of s.networks) {
    const m = CIDR.exec(n);
    if (!m || !isIPv4(m[1]) || Number(m[2]) > 32) throw new Error(`rede inválida: ${n}`);
  }
  for (const d of s.dns) if (!isIPv4(d)) throw new Error(`DNS inválido: ${d}`);
  if (s.domain && !DOMAIN.test(s.domain)) throw new Error('sufixo DNS inválido');
}

/** Script do PowerShell (todos os valores já validados entram como literais). */
export function netScript(luid: bigint, s: NetSetup, gateway: string, mtu = 1400): string {
  checkSetup(s, gateway);
  const q = (v: string) => `'${v}'`;
  // Túnel completo: duas metades (/1) no lugar da rota padrão e o gateway pela rota atual.
  const full = s.networks.includes('0.0.0.0/0');
  const routes = full ? [...s.networks.filter((n) => n !== '0.0.0.0/0'), '0.0.0.0/1', '128.0.0.0/1'] : s.networks;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$luid = [uint64]${luid.toString()}`,
    '$i = $null',
    'for ($n = 0; $n -lt 50 -and -not $i; $n++) {',
    '  $i = (Get-NetAdapter -IncludeHidden | Where-Object { $_.NetLuid -eq $luid }).ifIndex',
    '  if (-not $i) { Start-Sleep -Milliseconds 100 }',
    '}',
    "if (-not $i) { throw 'adaptador da VPN não apareceu' }",
    ...(full ? [
      `$r = Find-NetRoute -RemoteIPAddress ${q(gateway)} | Where-Object { $_.NextHop } | Select-Object -First 1`,
      `if ($r) { New-NetRoute -DestinationPrefix ${q(`${gateway}/32`)} -InterfaceIndex $r.InterfaceIndex -NextHop $r.NextHop -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null }`,
    ] : []),
    `Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled -NlMtuBytes ${mtu} -InterfaceMetric 5`,
    `New-NetIPAddress -InterfaceIndex $i -IPAddress ${q(s.address)} -PrefixLength 32 -PolicyStore ActiveStore | Out-Null`,
    ...routes.map((n) => `New-NetRoute -InterfaceIndex $i -DestinationPrefix ${q(n)} -NextHop '0.0.0.0' -RouteMetric 1 -PolicyStore ActiveStore | Out-Null`),
    ...(s.dns.length ? [`Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses @(${s.dns.map(q).join(',')})`] : []),
    ...(s.domain ? [`Set-DnsClient -InterfaceIndex $i -ConnectionSpecificSuffix ${q(s.domain)}`] : []),
    "'ok'",
  ].join('\n');
}

export function clearScript(gateway: string): string {
  if (!isIPv4(gateway)) throw new Error('endereço do gateway inválido');
  return `Remove-NetRoute -DestinationPrefix '${gateway}/32' -PolicyStore ActiveStore -Confirm:$false -ErrorAction SilentlyContinue`;
}

function powershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`falha ao configurar a rede da VPN: ${String(stderr || err.message).trim().split('\n')[0]}`));
        else resolve(stdout);
      });
  });
}

export class WindowsNetConfig implements NetConfig {
  private readonly gateway: string;
  private full = false;

  constructor(gateway: string) {
    this.gateway = gateway;
  }

  async apply(tun: Tun, setup: NetSetup) {
    if (tun.luid === undefined) throw new Error('adaptador sem LUID');
    this.full = setup.networks.includes('0.0.0.0/0');
    await powershell(netScript(tun.luid, setup, this.gateway));
  }

  async clear() {
    if (this.full) await powershell(clearScript(this.gateway));
  }
}

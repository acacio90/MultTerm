import { execFile } from 'node:child_process';

export interface Connection {
  proto: 'TCP' | 'UDP';
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number | null;
  state: string;
  pid: number;
  process: string;
}

/** PowerShell: conexões TCP e endpoints UDP com o nome do processo, em JSON. */
export const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$names = @{}; Get-Process | ForEach-Object { $names[[int]$_.Id] = $_.ProcessName }',
  '$tcp = Get-NetTCPConnection | ForEach-Object { [pscustomobject]@{ proto = "TCP"; la = $_.LocalAddress; lp = [int]$_.LocalPort; ra = $_.RemoteAddress; rp = [int]$_.RemotePort; st = [string]$_.State; pid = [int]$_.OwningProcess; name = $names[[int]$_.OwningProcess] } }',
  '$udp = Get-NetUDPEndpoint | ForEach-Object { [pscustomobject]@{ proto = "UDP"; la = $_.LocalAddress; lp = [int]$_.LocalPort; ra = ""; rp = $null; st = "Bound"; pid = [int]$_.OwningProcess; name = $names[[int]$_.OwningProcess] } }',
  'ConvertTo-Json -Compress -InputObject @(@($tcp) + @($udp))',
].join('; ');

const STATES: Record<string, string> = {
  Listen: 'escutando', Established: 'estabelecida', TimeWait: 'time-wait', CloseWait: 'close-wait',
  SynSent: 'syn-enviado', SynReceived: 'syn-recebido', FinWait1: 'fin-wait-1', FinWait2: 'fin-wait-2',
  LastAck: 'last-ack', Closing: 'fechando', Closed: 'fechada', Bound: 'aberta (UDP)', DeleteTCB: 'removendo',
};

export function stateLabel(state: string): string {
  return STATES[state] ?? state;
}

/** Interpreta a saída JSON do WINDOWS_SCRIPT. */
export function parseWindowsConnections(json: string): Connection[] {
  const text = json.trim();
  if (!text) return [];
  const data = JSON.parse(text) as unknown;
  const rows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  return rows
    .filter((r) => r && (r.proto === 'TCP' || r.proto === 'UDP'))
    .map((r) => ({
      proto: r.proto as 'TCP' | 'UDP',
      localAddress: String(r.la ?? ''),
      localPort: Number(r.lp),
      remoteAddress: String(r.ra ?? ''),
      remotePort: r.proto === 'UDP' || r.rp === null || r.rp === undefined ? null : Number(r.rp),
      state: String(r.st ?? ''),
      pid: Number(r.pid),
      process: typeof r.name === 'string' && r.name ? r.name : '',
    }))
    .sort((a, b) => a.proto.localeCompare(b.proto) || a.localPort - b.localPort || a.pid - b.pid);
}

/** Estados do "ss" (Linux) com os nomes do Windows, que a interface já traduz. */
const SS_STATES: Record<string, string> = {
  LISTEN: 'Listen', ESTAB: 'Established', 'TIME-WAIT': 'TimeWait', 'CLOSE-WAIT': 'CloseWait', 'SYN-SENT': 'SynSent',
  'SYN-RECV': 'SynReceived', 'FIN-WAIT-1': 'FinWait1', 'FIN-WAIT-2': 'FinWait2', 'LAST-ACK': 'LastAck', CLOSING: 'Closing',
  CLOSED: 'Closed',
};

/** "127.0.0.53%lo:53", "[::1]:631", "*:22" → endereço (sem a placa) e porta. */
function splitSsEndpoint(text: string): { address: string; port: number | null } {
  const i = text.lastIndexOf(':');
  const rawPort = text.slice(i + 1);
  let address = text.slice(0, i).replace(/^\[(.*)\]$/, '$1').replace(/%[^%]*$/, '');
  if (address === '*') address = text.startsWith('[') ? '::' : '0.0.0.0';
  return { address, port: rawPort === '*' ? null : Number(rawPort) };
}

/**
 * Interpreta "ss -Htunap": netid, estado, filas, local, remoto e o processo (só aparece para os
 * sockets do próprio usuário, ou de todos com root). UDP vira "Bound", como no Windows.
 */
export function parseSsConnections(stdout: string): Connection[] {
  const rows: Connection[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || (cols[0] !== 'tcp' && cols[0] !== 'udp')) continue;
    const proto = cols[0] === 'tcp' ? 'TCP' : 'UDP';
    const local = splitSsEndpoint(cols[4]);
    const remote = splitSsEndpoint(cols[5]);
    if (local.port === null || !Number.isInteger(local.port)) continue;
    const user = /users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(cols.slice(6).join(' '));
    rows.push({
      proto,
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: proto === 'UDP' ? '' : remote.address,
      remotePort: proto === 'UDP' ? null : remote.port ?? 0,
      state: proto === 'UDP' ? 'Bound' : SS_STATES[cols[1]] ?? cols[1],
      pid: user ? Number(user[2]) : 0,
      process: user ? user[1] : '',
    });
  }
  return rows.sort((a, b) => a.proto.localeCompare(b.proto) || a.localPort - b.localPort || a.pid - b.pid);
}

export function listConnections(platform: NodeJS.Platform = process.platform): Promise<Connection[]> {
  if (platform !== 'win32') {
    return new Promise((resolve, reject) => {
      execFile('ss', ['-Htunap'], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error(`não foi possível listar as conexões (ss, do iproute2): ${err.message}`));
        resolve(parseSsConnections(stdout));
      });
    });
  }
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`não foi possível listar as conexões: ${err.message}`));
        try {
          resolve(parseWindowsConnections(stdout));
        } catch (e) {
          reject(new Error(`saída inesperada do PowerShell: ${(e as Error).message}`));
        }
      },
    );
  });
}

/** "endereço:porta", com colchetes em IPv6 ("[::]:135"). */
export function formatEndpoint(address: string, port: number | null): string {
  if (port === null) return address || '*';
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, dirname, join } from 'node:path';

/*
 * Modo de reserva da captura de pacotes: o pktmon do Windows (10 1809+ / 11), para quando
 * não há Wireshark/Npcap. O pktmon exige administrador; o app eleva só um script do PowerShell
 * (uma confirmação do UAC) que inicia a captura, espera o pedido de parada (um arquivo), para,
 * converte o .etl em .pcapng e informa o andamento num arquivo de status.
 */

export const PKTMON_PROTOCOLS = ['TCP', 'UDP', 'ICMP'] as const;

export interface PktmonRequest {
  ip?: string;
  port?: number;
  protocol?: (typeof PKTMON_PROTOCOLS)[number];
  maxSeconds?: number;
}

export function findPktmon(env: { systemRoot?: string; fileExists: (p: string) => boolean }): string | undefined {
  const path = join(env.systemRoot || 'C:\\Windows', 'System32', 'PktMon.exe');
  return env.fileExists(path) ? path : undefined;
}

export function validatePktmonRequest(raw: unknown): PktmonRequest {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const req: PktmonRequest = {};
  const ip = String(o.ip ?? '').trim();
  if (ip) {
    if (!isIP(ip)) throw new Error(`IP inválido no filtro: "${ip}"`);
    req.ip = ip;
  }
  if (o.port !== undefined && o.port !== null && o.port !== '') {
    const port = Number(o.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('porta inválida no filtro');
    req.port = port;
  }
  const protocol = String(o.protocol ?? '').trim().toUpperCase();
  if (protocol) {
    if (!(PKTMON_PROTOCOLS as readonly string[]).includes(protocol)) throw new Error('protocolo inválido no filtro (TCP, UDP ou ICMP)');
    req.protocol = protocol as PktmonRequest['protocol'];
  }
  if (o.maxSeconds !== undefined && o.maxSeconds !== null && o.maxSeconds !== '') {
    const s = Number(o.maxSeconds);
    if (!Number.isInteger(s) || s < 1 || s > 86_400) throw new Error('limite de tempo (s) deve estar entre 1 e 86400');
    req.maxSeconds = s;
  }
  return req;
}

/** Literal do PowerShell entre aspas simples (aspas simples dobradas). */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface PktmonFiles {
  pktmon: string;
  etl: string;
  pcapng: string;
  status: string;
  stop: string;
}

/** Script elevado: todos os valores entram como literais validados, nada é interpolado como comando. */
export function pktmonScript(files: PktmonFiles, req: PktmonRequest): string {
  const filter: string[] = [];
  if (req.ip) filter.push(psQuote('-i'), psQuote(req.ip));
  if (req.port) filter.push(psQuote('-p'), psQuote(String(req.port)));
  if (req.protocol) filter.push(psQuote('-t'), psQuote(req.protocol));
  const deadline = req.maxSeconds ? `(Get-Date).AddSeconds(${req.maxSeconds})` : '[datetime]::MaxValue';
  return [
    '# Gerado pelo MultTerm: captura com o pktmon (executado como administrador).',
    `$pktmon = ${psQuote(files.pktmon)}`,
    `$status = ${psQuote(files.status)}`,
    'function Status([string]$s) { [IO.File]::WriteAllText($status, $s) }',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8 # o pktmon escreve em UTF-8',
    'function Run([string[]]$a) {',
    // "$_" converte as linhas do stderr (ErrorRecord) só no texto; linhas vazias viram RemoteException.
    "  $out = (& $pktmon @a 2>&1 | ForEach-Object { \"$_\".Trim() } | Where-Object { $_ -and $_ -notmatch '^System\\.Management\\.Automation\\.' }) -join ' '",
    "  if ($LASTEXITCODE -ne 0) { throw ('pktmon ' + ($a -join ' ') + ': ' + $out) }",
    '}',
    'try {',
    '  & $pktmon stop 2>&1 | Out-Null',
    '  & $pktmon filter remove 2>&1 | Out-Null',
    ...(filter.length ? [`  Run @('filter', 'add', 'MultTerm', ${filter.join(', ')})`] : []),
    `  Run @('start', '--capture', '--comp', 'nics', '--pkt-size', '0', '-f', ${psQuote(files.etl)})`,
    "  Status 'capturing'",
    `  $limite = ${deadline}`,
    `  while (-not (Test-Path -LiteralPath ${psQuote(files.stop)}) -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 250 }`,
    "  Status 'converting'",
    "  Run @('stop')",
    `  Run @('etl2pcap', ${psQuote(files.etl)}, '--out', ${psQuote(files.pcapng)})`,
    '  & $pktmon filter remove 2>&1 | Out-Null',
    `  Remove-Item -LiteralPath ${psQuote(files.etl)} -ErrorAction SilentlyContinue`,
    "  Status 'done'",
    '} catch {',
    '  & $pktmon stop 2>&1 | Out-Null',
    '  & $pktmon filter remove 2>&1 | Out-Null',
    "  Status ('error: ' + $_.Exception.Message)",
    '}',
    '',
  ].join('\r\n');
}

/** Conta os pacotes de um .pcapng (blocos EPB, SPB e o antigo PB). */
export function countPcapngPackets(buf: Buffer): number {
  if (buf.length < 12 || buf.readUInt32LE(0) !== 0x0a0d0d0a) throw new Error('arquivo pcapng inválido');
  const le = buf.readUInt32LE(8) === 0x1a2b3c4d;
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  let count = 0;
  for (let off = 0; off + 8 <= buf.length;) {
    const type = u32(off);
    const len = u32(off + 4);
    if (len < 12 || off + len > buf.length) break; // bloco truncado no fim
    if (type === 6 || type === 3 || type === 2) count++;
    off += len;
  }
  return count;
}

/** Eleva o script com o UAC; resolve quando o processo elevado foi iniciado. */
export type Elevate = (scriptPath: string) => Promise<void>;

export const elevateWithUac: Elevate = (scriptPath) =>
  new Promise((resolve, reject) => {
    const args = `-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
    const command = `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${psQuote(args)}`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (err, _out, stderr) => {
      if (!err) return resolve();
      const text = String(stderr || err.message);
      reject(new Error(/cancel/i.test(text) ? 'a elevação foi recusada no UAC' : `não foi possível elevar o pktmon: ${text.trim()}`));
    });
  });

export interface PktmonResult {
  file: string;
  packets: number;
}

/** Captura até o limite de tempo ou até o sinal ser abortado (Parar). */
export async function runPktmonCapture(opts: {
  pktmon: string;
  file: string;
  workDir: string;
  request: PktmonRequest;
  signal?: AbortSignal;
  onBytes?: (n: number) => void;
  elevate?: Elevate;
  pollMs?: number;
  startTimeoutMs?: number;
}): Promise<PktmonResult> {
  const base = basename(opts.file, '.pcapng');
  const files: PktmonFiles = {
    pktmon: opts.pktmon,
    etl: join(dirname(opts.file), `${base}.etl`),
    pcapng: opts.file,
    status: join(opts.workDir, `${base}.status`),
    stop: join(opts.workDir, `${base}.stop`),
  };
  const script = join(opts.workDir, `${base}.ps1`);
  await mkdir(opts.workDir, { recursive: true });
  // BOM: o PowerShell 5.1 só lê o script como UTF-8 com ele (caminhos com acento).
  await writeFile(script, `\ufeff${pktmonScript(files, opts.request)}`, 'utf8');
  const cleanup = () => Promise.all([script, files.status, files.stop].map((f) => rm(f, { force: true })));
  try {
    await (opts.elevate ?? elevateWithUac)(script);
    const poll = opts.pollMs ?? 300;
    const startedAt = Date.now();
    let capturing = false;
    let stopRequested = false;
    for (;;) {
      if (opts.signal?.aborted && !stopRequested) {
        stopRequested = true;
        await writeFile(files.stop, 'stop');
      }
      const status = await readFile(files.status, 'utf8').catch(() => '');
      if (status === 'done') {
        return { file: opts.file, packets: countPcapngPackets(await readFile(opts.file)) };
      }
      if (status.startsWith('error: ')) throw new Error(`o pktmon falhou: ${status.slice(7).trim()}`);
      if (status === 'capturing' || status === 'converting') capturing = true;
      if (capturing && opts.onBytes) {
        const size = await stat(files.etl).then((s) => s.size, () => 0);
        opts.onBytes(size);
      }
      if (!capturing && Date.now() - startedAt > (opts.startTimeoutMs ?? 120_000)) {
        throw new Error('o pktmon não iniciou (a janela do UAC foi aceita?)');
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  } finally {
    await cleanup();
  }
}

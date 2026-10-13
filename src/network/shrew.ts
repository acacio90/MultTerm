import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/*
 * VPN pelo Shrew Soft VPN Client instalado (IPsec/IKEv1). O cliente não é embutido (a licença
 * proíbe redistribuir modificado): o MultTerm abre o ipsecc.exe com o site, oculta a janela,
 * preenche usuário e senha pelos campos (a senha não aparece na linha de comando), clica em
 * Connect e acompanha o estado pelos botões e pelo log da própria janela.
 *
 * Do ipsecc.exe/libike.dll 2.2.2: opções -r <site>, -u <usuário>, -p <senha>, -a (conectar);
 * sites em %LOCALAPPDATA%\Shrew Soft VPN\sites e, os públicos, em %ProgramData%\Shrew Soft VPN\sites,
 * um arquivo por site com linhas "s:chave:texto", "n:chave:número" e "b:chave:base64".
 * Controles da janela: 0x40e usuário, 0x40f senha, 0x428 Connect/Disconnect, 0x427 Exit/Cancel,
 * RICHEDIT com o log.
 */

export function findShrew(env: { programFiles?: string[]; fileExists: (p: string) => boolean }): string | undefined {
  for (const dir of env.programFiles ?? []) {
    if (!dir) continue;
    const exe = join(dir, 'ShrewSoft', 'VPN Client', 'ipsecc.exe');
    if (env.fileExists(exe)) return exe;
  }
  return undefined;
}

/** Lê um arquivo de site (ou .vpn exportado). Valores podem conter ":". */
export function parseSiteFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([snb]):([\w-]+):(.*)$/.exec(line);
    if (m) out.set(m[2], m[3]);
  }
  return out;
}

export interface ShrewSite {
  name: string;
  host: string;
  port?: number;
  auth?: string;
  /** Usa usuário e senha (XAuth). */
  credentials: boolean;
  savedUser?: string;
  public: boolean;
}

export function siteInfo(name: string, text: string, isPublic: boolean): ShrewSite {
  const cfg = parseSiteFile(text);
  const host = cfg.get('network-host') ?? '';
  const port = Number(cfg.get('network-ike-port'));
  const auth = cfg.get('auth-method');
  return {
    name,
    host,
    ...(Number.isInteger(port) && port > 0 && port !== 500 ? { port } : {}),
    ...(auth ? { auth } : {}),
    credentials: !auth || /xauth/i.test(auth),
    ...(cfg.get('client-saved-username') ? { savedUser: cfg.get('client-saved-username') } : {}),
    public: isPublic,
  };
}

/** Nome de site seguro como nome de arquivo e como argumento (sem aspas nem separadores). */
export function isSafeSiteName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[^\\/:*?"<>|\x00-\x1f]{1,100}$/.test(name) && !/^\.+$/.test(name) && name.trim() === name && !name.startsWith('-');
}

export interface SiteDirs {
  user: string;
  public?: string;
}

/** Sites do usuário primeiro; um público com o mesmo nome fica escondido (o ipsecc carrega o do usuário). */
export async function listSites(dirs: SiteDirs): Promise<ShrewSite[]> {
  const sites = new Map<string, ShrewSite>();
  for (const [dir, isPublic] of [[dirs.user, false], [dirs.public, true]] as const) {
    if (!dir) continue;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!isSafeSiteName(name) || sites.has(name.toLowerCase())) continue;
      const text = await readFile(join(dir, name), 'utf8').catch(() => '');
      const site = siteInfo(name, text, isPublic);
      if (site.host) sites.set(name.toLowerCase(), site);
    }
  }
  return [...sites.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Copia um .vpn exportado para a pasta de sites do usuário; nome repetido ganha " (2)", " (3)"... */
export async function importSite(file: string, userDir: string): Promise<ShrewSite> {
  const text = await readFile(file, 'utf8');
  const base = basename(file, extname(file)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/^[-.]+/, '') || 'site';
  const probe = siteInfo(base, text, false);
  if (!probe.host) throw new Error('o arquivo não é um site do Shrew Soft VPN (falta o gateway "network-host")');
  await mkdir(userDir, { recursive: true });
  const taken = new Set((await readdir(userDir)).map((n) => n.toLowerCase()));
  let name = base.slice(0, 90);
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 90)} (${i})`;
  await copyFile(file, join(userDir, name));
  return { ...probe, name };
}

/** Traduz o motivo da falha a partir do log do cliente. */
export function shrewErrorMessage(log: string): string | undefined {
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/config error : ([\w-]+) undefined/, (m) => `configuração do site incompleta (falta "${m[1]}")`],
    [/failed to load '([^']*)'/, (m) => `site "${m[1]}" não encontrado`],
    [/failed to attach to key daemon/, () => 'o serviço do Shrew (IKE Daemon) não está rodando'],
    [/user authentication error|xauth.*(fail|denied)|authentication failed/i, () => 'usuário ou senha recusados pelo gateway'],
    [/negotiation timout occurred|negotiation timeout occurred/, () => 'o gateway não respondeu (tempo esgotado)'],
    [/peer (certificate|cert).*(fail|invalid)|failed to (load|validate).*cert/i, () => 'falha no certificado do gateway'],
    [/remote peer.*(disconnect|terminate)|peer has disconnected|session terminated by gateway/i, () => 'o gateway encerrou a conexão'],
  ];
  for (const [re, msg] of rules) {
    const m = re.exec(log);
    if (m) return msg(m);
  }
  return undefined;
}

/** Estado da janela do cliente, como o controlador informa. */
export interface ShrewWindowState {
  connect: string;
  connectEnabled: boolean;
  cancel: string;
  log: string;
}

export type ShrewPhase = 'connecting' | 'connected' | 'idle';

export function shrewPhase(w: ShrewWindowState): ShrewPhase {
  if (/^disconnect$/i.test(w.connect.trim())) return 'connected';
  if (/^cancel$/i.test(w.cancel.trim())) return 'connecting';
  return 'idle';
}

/**
 * Controlador em PowerShell: lê {exe, site, user, password} (JSON em base64) na primeira linha do stdin, abre o
 * ipsecc, oculta a janela, preenche os campos e clica em Connect; depois escreve uma linha JSON a
 * cada mudança e aceita os comandos "disconnect", "exit", "show" e "hide". Fim do stdin = sair.
 */
export const SHREW_CONTROLLER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class ShrewUi {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
  static string Cls(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }
  public static IntPtr FindMain(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Cls(h) == "SHREWSOFT_CON") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static IntPtr Control(IntPtr top, int id, string cls) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, (h, l) => {
      if (GetDlgCtrlID(h) == id && Cls(h).StartsWith(cls, StringComparison.OrdinalIgnoreCase)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    var s = new StringBuilder(65536); SendMessage(h, 0x0D, (IntPtr)65536, s); return s.ToString();
  }
  public static void SetText(IntPtr h, string t) { SendMessage(h, 0x0C, IntPtr.Zero, t); }
  public static void Click(IntPtr h) { PostMessage(h, 0xF5, IntPtr.Zero, IntPtr.Zero); }
}
'@
# Pedido em base64 (UTF-8): o stdin do PowerShell descarta barras invertidas e acentos.
# Console.In é síncrono (ReadLineAsync bloqueia); o StreamReader sobre o fluxo lê de verdade em segundo plano.
$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput())
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($stdin.ReadLine())) | ConvertFrom-Json
$argv = @('-r', ('"' + $req.site + '"'))
if ($req.user) { $argv += @('-u', ('"' + $req.user + '"')) }
try { $proc = Start-Process -FilePath $req.exe -ArgumentList $argv -PassThru }
catch { Emit @{ event = 'error'; message = ('não foi possível abrir o cliente do Shrew: ' + $_.Exception.Message) }; exit 1 }
$win = [IntPtr]::Zero
$limit = (Get-Date).AddSeconds(20)
while ($win -eq [IntPtr]::Zero) {
  if ($proc.HasExited) { Emit @{ event = 'error'; message = 'o cliente do Shrew fechou ao abrir' }; exit 1 }
  if ((Get-Date) -gt $limit) { Emit @{ event = 'error'; message = 'a janela do cliente do Shrew não apareceu' }; Stop-Process -Id $proc.Id -Force; exit 1 }
  Start-Sleep -Milliseconds 100
  $win = [ShrewUi]::FindMain([uint32]$proc.Id)
}
$visible = [bool]$req.show
if (-not $visible) { [void][ShrewUi]::ShowWindow($win, 0) }
$btnConnect = [ShrewUi]::Control($win, 0x428, 'Button')
$btnCancel = [ShrewUi]::Control($win, 0x427, 'Button')
$editUser = [ShrewUi]::Control($win, 0x40e, 'Edit')
$editPass = [ShrewUi]::Control($win, 0x40f, 'Edit')
$log = [ShrewUi]::Control($win, 0x439, 'RichEdit')
Emit @{ event = 'window'; pid = $proc.Id; credentials = [ShrewUi]::IsWindowVisible($editPass) }
# Espera o cliente carregar o site e liberar o botão (ou falhar ao carregar).
$limit = (Get-Date).AddSeconds(10)
while (-not [ShrewUi]::IsWindowEnabled($btnConnect) -and (Get-Date) -lt $limit -and -not $proc.HasExited) { Start-Sleep -Milliseconds 100 }
if ([ShrewUi]::IsWindowEnabled($editUser) -and $req.user) { [ShrewUi]::SetText($editUser, [string]$req.user) }
if ([ShrewUi]::IsWindowEnabled($editPass) -and $req.password) { [ShrewUi]::SetText($editPass, [string]$req.password) }
$req = $null
if ([ShrewUi]::IsWindowEnabled($btnConnect)) { [ShrewUi]::Click($btnConnect) }
$last = ''
$pending = $stdin.ReadLineAsync()
$quit = $false
while ($true) {
  if ($proc.HasExited) { Emit @{ event = 'exited' }; break }
  $state = @{ event = 'state'; connect = [ShrewUi]::Text($btnConnect); connectEnabled = [ShrewUi]::IsWindowEnabled($btnConnect); cancel = [ShrewUi]::Text($btnCancel); log = [ShrewUi]::Text($log) }
  $key = $state.connect + '|' + $state.connectEnabled + '|' + $state.cancel + '|' + $state.log
  if ($key -ne $last) { $last = $key; Emit $state }
  if (-not $visible -and [ShrewUi]::IsWindowVisible($win)) { [void][ShrewUi]::ShowWindow($win, 0) }
  if ($pending.IsCompleted) {
    $cmd = $pending.Result
    if ($cmd -eq $null) { $quit = $true } else { $pending = $stdin.ReadLineAsync() }
    switch ($cmd) {
      'disconnect' { if ($state.connect -eq 'Disconnect') { [ShrewUi]::Click($btnConnect) } elseif ($state.cancel -eq 'Cancel') { [ShrewUi]::Click($btnCancel) } }
      'exit' { $quit = $true }
      'show' { $visible = $true; [void][ShrewUi]::ShowWindow($win, 5) }
      'hide' { $visible = $false; [void][ShrewUi]::ShowWindow($win, 0) }
    }
  }
  if ($quit) {
    # Desconecta, espera o túnel cair e fecha o cliente pelo botão Exit.
    $limit = (Get-Date).AddSeconds(15)
    while (-not $proc.HasExited -and (Get-Date) -lt $limit) {
      $c = [ShrewUi]::Text($btnConnect); $x = [ShrewUi]::Text($btnCancel)
      if ($c -eq 'Disconnect') { [ShrewUi]::Click($btnConnect) }
      elseif ($x -eq 'Cancel') { [ShrewUi]::Click($btnCancel) }
      elseif ($x -eq 'Exit' -and [ShrewUi]::IsWindowEnabled($btnCancel)) { [ShrewUi]::Click($btnCancel) }
      Start-Sleep -Milliseconds 300
    }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Emit @{ event = 'exited' }
    break
  }
  Start-Sleep -Milliseconds 300
}
} catch { Emit @{ event = 'error'; message = $_.Exception.Message }; exit 1 }
`;

export interface ShrewRequest {
  exe: string;
  site: string;
  user?: string;
  password?: string;
  /** Mantém a janela do cliente visível (diagnóstico). */
  show?: boolean;
}

/** Processo do controlador (injetável nos testes). */
export interface ControllerProcess {
  stdin: { write(s: string): unknown; end(): unknown };
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  on(ev: 'exit', cb: (code: number | null) => void): unknown;
  kill(): unknown;
}

export const spawnController = (): ControllerProcess => {
  const encoded = Buffer.from(SHREW_CONTROLLER, 'utf16le').toString('base64');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

export type VpnState = 'connecting' | 'connected' | 'disconnecting' | 'off';

export interface VpnStatus {
  site: string;
  state: VpnState;
  log: string;
  error?: string;
  since?: number;
}

/**
 * Uma conexão do Shrew. Emite "status" (VpnStatus) a cada mudança. connect() resolve quando o
 * túnel sobe e rejeita com o motivo traduzido quando falha; disconnect() derruba e fecha o cliente.
 */
export class ShrewConnection extends EventEmitter {
  status: VpnStatus;
  private proc?: ControllerProcess;
  private seenConnecting = false;
  private closing = false;
  private exited?: Promise<void>;

  private readonly req: ShrewRequest;
  private readonly spawnFn: () => ControllerProcess;

  constructor(req: ShrewRequest, spawnFn: () => ControllerProcess = spawnController) {
    super();
    this.req = req;
    this.spawnFn = spawnFn;
    this.status = { site: req.site, state: 'off', log: '' };
  }

  private set(patch: Partial<VpnStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  connect(timeoutMs = 120_000): Promise<void> {
    if (this.proc) throw new Error('conexão já iniciada');
    this.set({ state: 'connecting', error: undefined, log: '' });
    const proc = this.spawnFn();
    this.proc = proc;
    let buffer = '';
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const fail = (message: string) => {
        this.set({ state: 'off', error: message });
        done(new Error(message));
        void this.disconnect();
      };
      const timer = setTimeout(() => fail('tempo esgotado ao conectar a VPN'), timeoutMs);
      this.exited = new Promise((r) => proc.on('exit', () => {
        if (this.status.state !== 'off') this.set({ state: 'off', ...(this.closing ? {} : { error: this.status.error ?? 'o cliente do Shrew foi fechado' }) });
        done(new Error(this.status.error ?? (this.closing ? 'conexão cancelada' : 'o cliente do Shrew foi fechado')));
        r();
      }));
      proc.stdout.on('data', (d: Buffer) => {
        buffer += d.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.event === 'error') fail(String(ev.message ?? 'falha no controlador do Shrew'));
          else if (ev.event === 'exited') {
            if (this.status.state !== 'off') this.set({ state: 'off' });
          } else if (ev.event === 'state') {
            const w = ev as unknown as ShrewWindowState;
            const phase = shrewPhase(w);
            const log = String(w.log ?? '').replace(/\r\n/g, '\n');
            if (phase === 'connected') {
              if (this.status.state !== 'connected') this.set({ state: 'connected', since: Date.now(), log });
              else this.set({ log });
              done();
            } else if (phase === 'connecting') {
              this.seenConnecting = true;
              this.set({ state: this.closing ? 'disconnecting' : 'connecting', log });
            } else {
              // Botões voltaram a Connect/Exit: falhou, caiu ou foi desconectado.
              const wasUp = this.status.state === 'connected';
              const error = this.closing ? undefined : (shrewErrorMessage(log) ?? (wasUp ? 'a VPN caiu' : undefined));
              if (this.closing || wasUp || this.seenConnecting || error) {
                this.set({ state: this.closing ? 'disconnecting' : 'off', log, ...(error ? { error } : {}) });
                if (!this.closing) fail(error ?? 'a conexão falhou');
              } else this.set({ log });
            }
          }
        }
      });
      const request = { exe: this.req.exe, site: this.req.site, user: this.req.user ?? '', password: this.req.password ?? '', show: !!this.req.show };
      proc.stdin.write(`${Buffer.from(JSON.stringify(request), 'utf8').toString('base64')}\n`);
      void stderr;
    });
  }

  /** Mostra ou oculta a janela do cliente do Shrew (diagnóstico). */
  showWindow(show: boolean) {
    this.proc?.stdin.write(show ? 'show\n' : 'hide\n');
  }

  async disconnect(): Promise<void> {
    if (!this.proc) return;
    if (!this.closing) {
      this.closing = true;
      if (this.status.state !== 'off') this.set({ state: 'disconnecting' });
      try {
        this.proc.stdin.end(); // fim do stdin = desconectar e fechar o cliente
      } catch { /* processo já saiu */ }
      const proc = this.proc;
      const killer = setTimeout(() => proc.kill(), 25_000);
      await this.exited;
      clearTimeout(killer);
    } else await this.exited;
    if (this.status.state !== 'off') this.set({ state: 'off' });
  }
}

/** IP e redes do adaptador virtual do Shrew (saída JSON do PowerShell). */
export interface VpnNetworks {
  ip?: string;
  networks: string[];
}

export const VPN_NETWORKS_SCRIPT = [
  "$a = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -like 'Shrew Soft Virtual Adapter*' -and $_.Status -eq 'Up' } | Select-Object -First 1",
  'if (-not $a) { "{}"; exit }',
  '$ip = (Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress',
  '$routes = @(Get-NetRoute -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.DestinationPrefix })',
  '@{ ip = $ip; routes = $routes } | ConvertTo-Json -Compress',
].join('; ');

/** Fica com as redes de destino úteis: sem multicast, broadcast, rotas de host e a rota padrão. */
export function parseVpnNetworks(json: string): VpnNetworks {
  let raw: { ip?: unknown; routes?: unknown };
  try {
    raw = JSON.parse(json || '{}');
  } catch {
    return { networks: [] };
  }
  const ip = typeof raw.ip === 'string' && raw.ip ? raw.ip : undefined;
  const list = Array.isArray(raw.routes) ? raw.routes : typeof raw.routes === 'string' ? [raw.routes] : [];
  const networks = [...new Set(list.filter((r): r is string => typeof r === 'string'))].filter((cidr) => {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
    if (!m) return false;
    const first = Number(m[1]);
    const bits = Number(m[5]);
    return bits > 0 && bits < 32 && first < 224 && !(first === 169 && Number(m[2]) === 254);
  });
  return { ...(ip ? { ip } : {}), networks: networks.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) };
}

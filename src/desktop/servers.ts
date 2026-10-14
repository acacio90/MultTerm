import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listenOptions, timestamp, type RunningServer } from '../servers/common.ts';
import { ensureSelfSignedPfx } from '../servers/cert.ts';
import { startFtp, validateFtp } from '../servers/ftp.ts';
import { startHttp, validateHttp } from '../servers/http.ts';
import { startIperf, validateIperf } from '../servers/iperf.ts';
import { startTelnet, validateTelnet } from '../servers/telnet.ts';
import { ensureHostKey, startSsh, validateSsh } from '../servers/ssh.ts';
import { startCron, validateCron } from '../servers/cron.ts';
import { startTftp, validateTftp } from '../servers/tftp.ts';

/*
 * Servidores locais (Ferramentas → Servidores): iniciar/parar, parar sozinho depois de N
 * segundos, log por servidor e configurações lembradas. Todos param ao sair do app. Senhas
 * ficam cifradas pelo Windows (safeStorage) e nunca voltam para a interface.
 */

/** Senha guardada: cifrada pelo sistema (base64) — nunca em texto puro. */
const seal = (text: string) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('o Windows não liberou a cifra para guardar a senha');
  return safeStorage.encryptString(text).toString('base64');
};
const unseal = (b64: unknown) => {
  if (typeof b64 !== 'string' || !b64) return '';
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return '';
  }
};

/** Pergunta, numa janela do Windows, se aceita a conexão (recusa sozinho em 60 s). */
async function confirmConnection(server: string, client: string): Promise<boolean> {
  const win = BrowserWindow.getAllWindows()[0];
  const opts = {
    type: 'question' as const, buttons: ['Aceitar', 'Recusar'], defaultId: 1, cancelId: 1,
    title: 'MultTerm', message: `Aceitar a conexão ${server} de ${client}?`,
  };
  const answer = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  const timeout = new Promise<{ response: number }>((r) => setTimeout(() => r({ response: 1 }), 60_000));
  return (await Promise.race([answer, timeout])).response === 0;
}

const certPath = () => join(app.getPath('userData'), 'certs', 'servidores.pfx');

export interface ServerField {
  key: string;
  label: string;
  type: 'dir' | 'number' | 'bool' | 'text' | 'password' | 'select' | 'textarea';
  options?: [string, string][];
  min?: number;
  max?: number;
  hint?: string;
}

interface ServerDef {
  kind: string;
  title: string;
  description: string;
  fields: ServerField[];
  defaults: () => Record<string, unknown>;
  start: (raw: Record<string, unknown>, log: (l: string) => void, notify: (text: string) => void) => Promise<RunningServer>;
}

const filesDir = () => join(app.getPath('documents'), 'MultTerm', 'Servidor');
// Endereço de escuta: as opções (interfaces desta máquina) são montadas na hora, em servers:list.
const HOST_FIELD: ServerField = {
  key: 'host', label: 'Escutar em', type: 'select', options: [],
  hint: 'todas as interfaces, só esta máquina ou uma placa de rede específica',
};

const COMMON: ServerField[] = [
  { key: 'stopAfter', label: 'Parar depois de (segundos, 0 = nunca)', type: 'number', min: 0, max: 86400 },
];

const DEFS: ServerDef[] = [
  {
    kind: 'tftp',
    title: 'TFTP',
    description: 'Envio e recebimento de arquivos por TFTP (firmware e configurações de equipamentos).',
    fields: [
      { key: 'root', label: 'Pasta raiz', type: 'dir' },
      { key: 'port', label: 'Porta', type: 'number', min: 1, max: 65535 },
      HOST_FIELD,
      { key: 'maxBlockSize', label: 'Maior bloco (bytes)', type: 'number', min: 8, max: 65464, hint: 'negociado com o cliente (blksize)' },
      { key: 'allowUpload', label: 'Permitir envio (upload)', type: 'bool' },
      { key: 'allowOverwrite', label: 'Permitir sobrescrever arquivos', type: 'bool' },
      { key: 'notify', label: 'Avisar a cada transferência concluída', type: 'bool' },
      ...COMMON,
    ],
    defaults: () => ({ root: filesDir(), port: 69, maxBlockSize: 8192, allowUpload: true, allowOverwrite: true, notify: true, stopAfter: 3600 }),
    start: (raw, log, notify) => startTftp({
      ...validateTftp(raw),
      onTransfer: raw.notify === false ? undefined
        : (t) => notify(`TFTP: ${t.client.split(':')[0]} ${t.dir === 'download' ? 'baixou' : 'enviou'} ${t.file} (${t.bytes} bytes)`),
    }, log),
  },
  {
    kind: 'ftp',
    title: 'FTP',
    description: 'Servidor FTP para trocar arquivos com equipamentos (usuário e senha, ou anônimo só leitura).',
    fields: [
      { key: 'root', label: 'Pasta raiz', type: 'dir' },
      { key: 'port', label: 'Porta', type: 'number', min: 1, max: 65535 },
      HOST_FIELD,
      { key: 'user', label: 'Usuário', type: 'text' },
      { key: 'password', label: 'Senha', type: 'password' },
      { key: 'anonymous', label: 'Permitir acesso anônimo (só leitura)', type: 'bool' },
      { key: 'tls', label: 'FTPS implícito (TLS com certificado autoassinado)', type: 'bool' },
      { key: 'confirm', label: 'Perguntar antes de aceitar cada conexão', type: 'bool' },
      ...COMMON,
    ],
    defaults: () => ({ root: filesDir(), port: 21, user: 'multterm', password: '', anonymous: false, tls: false, confirm: false, stopAfter: 3600 }),
    start: async (raw, log) => {
      const base = validateFtp(raw);
      let tls: { pfx: Buffer; passphrase: string } | undefined;
      if (raw.tls === true) {
        const cert = await ensureSelfSignedPfx(certPath(), unseal(configs._cert?.passphrase) || undefined);
        if (cert.created) {
          configs._cert = { passphrase: seal(cert.passphrase) };
          await saveConfigs();
          log('certificado autoassinado gerado para o FTPS');
        }
        tls = { pfx: cert.pfx, passphrase: cert.passphrase };
      }
      return startFtp({
        ...base,
        tls,
        confirm: raw.confirm === true ? (client) => confirmConnection('FTP', client) : undefined,
      }, log);
    },
  },
  {
    kind: 'http',
    title: 'HTTP',
    description: 'Servidor web de arquivos (só leitura) para baixar arquivos pelo navegador ou por wget/curl.',
    fields: [
      { key: 'root', label: 'Pasta raiz', type: 'dir' },
      { key: 'port', label: 'Porta', type: 'number', min: 1, max: 65535 },
      HOST_FIELD,
      { key: 'listing', label: 'Mostrar o conteúdo das pastas', type: 'bool' },
      ...COMMON,
    ],
    defaults: () => ({ root: filesDir(), port: 8080, listing: true, stopAfter: 3600 }),
    start: (raw, log) => startHttp(validateHttp(raw), log),
  },
  {
    kind: 'ssh',
    title: 'SSH/SFTP',
    description: 'Servidor SSH com SFTP na pasta raiz e shell do Windows pelo ConPTY (ssh usuário@ip deste computador). ' +
      'Na primeira conexão, confira a impressão digital da chave mostrada no log.',
    fields: [
      { key: 'root', label: 'Pasta raiz do SFTP', type: 'dir' },
      { key: 'port', label: 'Porta', type: 'number', min: 1, max: 65535 },
      HOST_FIELD,
      { key: 'user', label: 'Usuário', type: 'text' },
      { key: 'password', label: 'Senha', type: 'password' },
      { key: 'shell', label: 'Shell', type: 'select', options: [['powershell', 'PowerShell'], ['cmd', 'Prompt de comando (cmd)']] },
      ...COMMON,
    ],
    defaults: () => ({ root: filesDir(), port: 22, user: 'multterm', password: '', shell: 'powershell', stopAfter: 3600 }),
    start: async (raw, log) => {
      const host = await ensureHostKey(join(app.getPath('userData'), 'certs', 'ssh_host_ed25519'));
      if (host.created) log('chave de host gerada');
      log(`impressão digital da chave de host: ${host.fingerprint}`);
      return startSsh({ ...validateSsh(raw), hostKey: host.key }, log);
    },
  },
  {
    kind: 'telnet',
    title: 'Telnet',
    description: 'Shell do Windows por Telnet, para equipamentos que só falam Telnet. O Telnet não é cifrado: ' +
      'a senha e tudo o que for digitado trafegam em texto puro — use só em rede confiável e por pouco tempo.',
    fields: [
      { key: 'port', label: 'Porta', type: 'number', min: 1, max: 65535 },
      HOST_FIELD,
      { key: 'password', label: 'Senha de acesso', type: 'password' },
      { key: 'shell', label: 'Shell', type: 'select', options: [['powershell', 'PowerShell'], ['cmd', 'Prompt de comando (cmd)']] },
      { key: 'confirm', label: 'Perguntar antes de aceitar cada conexão', type: 'bool' },
      ...COMMON,
    ],
    defaults: () => ({ port: 23, password: '', shell: 'powershell', confirm: true, stopAfter: 900 }),
    start: (raw, log) => startTelnet({
      ...validateTelnet(raw),
      confirm: raw.confirm === true ? (client) => confirmConnection('Telnet', client) : undefined,
    }, log),
  },
  {
    kind: 'cron',
    title: 'Agendador (cron)',
    description: 'Roda comandos em horários marcados enquanto o MultTerm estiver aberto, no formato do crontab: ' +
      'minuto hora dia mês dia-da-semana comando (ex.: "*/5 * * * * ping -n 1 10.0.0.1", "0 7 * * mon-fri backup.cmd", ' +
      '"@daily ..."). Linhas com # são comentários. A saída de cada execução vai para o log.',
    fields: [
      { key: 'jobs', label: 'Tarefas (uma por linha)', type: 'textarea' },
      { key: 'shell', label: 'Shell', type: 'select', options: [['powershell', 'PowerShell'], ['cmd', 'Prompt de comando (cmd)']] },
      { key: 'startWithApp', label: 'Iniciar o agendador junto com o MultTerm', type: 'bool' },
      ...COMMON,
    ],
    defaults: () => ({ jobs: '# minuto hora dia mês dia-da-semana comando\n', shell: 'powershell', startWithApp: false, stopAfter: 0 }),
    start: (raw, log) => startCron(validateCron(raw), log),
  },
  {
    kind: 'iperf',
    title: 'Iperf',
    description: 'Teste de banda com o cliente iperf3 (iperf3 -c <ip deste computador>; -R mede no sentido contrário, ' +
      '-P N usa vários fluxos). Clientes iperf3 do Windows usam buffer pequeno: para medir acima de ~600 Mbit/s, use -P 4 ou -w 1M.',
    fields: [
      { key: 'port', label: 'Porta', type: 'number', min: 1, max: 65535 },
      HOST_FIELD,
      ...COMMON,
    ],
    defaults: () => ({ port: 5201, stopAfter: 3600 }),
    start: (raw, log) => startIperf(validateIperf(raw), log),
  },
];

interface Running {
  server: RunningServer;
  startedAt: number;
  stopAt?: number;
  timer?: NodeJS.Timeout;
}

const running = new Map<string, Running>();
const logs = new Map<string, string[]>();
let configs: Record<string, Record<string, unknown>> & { _cert?: { passphrase?: string } } = {};
// MULTTERM_SERVERS_FILE troca o arquivo de configurações (testes).
const configFile = () => process.env.MULTTERM_SERVERS_FILE || join(app.getPath('userData'), 'servers.json');

let loadedConfigs: Promise<void> | undefined;
const configsReady = () => (loadedConfigs ??= loadConfigs());

async function loadConfigs() {
  try {
    configs = JSON.parse(await readFile(configFile(), 'utf8'));
  } catch {
    configs = {};
  }
}

async function saveConfigs() {
  await mkdir(join(configFile(), '..'), { recursive: true });
  await writeFile(configFile(), JSON.stringify(configs, null, 2));
}

function passwordKeys(def: ServerDef) {
  return def.fields.filter((f) => f.type === 'password').map((f) => f.key);
}

/** Configuração para a interface: sem as senhas (só "chaveSet"). */
function publicConfig(def: ServerDef) {
  const cfg: Record<string, unknown> = { ...def.defaults(), ...configs[def.kind] };
  for (const k of passwordKeys(def)) {
    cfg[`${k}Set`] = !!cfg[`${k}Sealed`];
    delete cfg[`${k}Sealed`];
    cfg[k] = '';
  }
  return cfg;
}

function broadcast(kind: string, extra: Record<string, unknown> = {}) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('servers:event', { kind, state: stateOf(kind), ...extra });
  }
}

function stateOf(kind: string) {
  const r = running.get(kind);
  return r ? { port: r.server.port, startedAt: r.startedAt, stopAt: r.stopAt } : null;
}

function log(kind: string, line: string) {
  const list = logs.get(kind) ?? [];
  const entry = `[${timestamp()}] ${line}`;
  list.push(entry);
  if (list.length > 500) list.splice(0, list.length - 500);
  logs.set(kind, list);
  broadcast(kind, { line: entry });
}

async function stop(kind: string) {
  const r = running.get(kind);
  if (!r) return;
  running.delete(kind);
  clearTimeout(r.timer);
  await r.server.stop().catch((err: Error) => log(kind, `erro ao parar: ${err.message}`));
  broadcast(kind);
}

const plainKeys = (def: ServerDef) => def.fields.filter((f) => f.type !== 'password').map((f) => f.key);

/** Configurações para o backup, sem as senhas (cifradas para este usuário do Windows). */
export async function exportServerConfigs(): Promise<Record<string, Record<string, unknown>>> {
  await configsReady();
  const out: Record<string, Record<string, unknown>> = {};
  for (const def of DEFS) {
    const cfg = configs[def.kind];
    if (cfg) out[def.kind] = Object.fromEntries(plainKeys(def).filter((k) => k in cfg).map((k) => [k, cfg[k]]));
  }
  return out;
}

/** Restaura do backup só servidores e campos conhecidos; as senhas guardadas aqui continuam. */
export async function importServerConfigs(raw: Record<string, Record<string, unknown>>): Promise<number> {
  await configsReady();
  let restored = 0;
  for (const def of DEFS) {
    const given = raw[def.kind];
    if (!given) continue;
    const picked = Object.fromEntries(plainKeys(def)
      .filter((k) => ['string', 'number', 'boolean'].includes(typeof given[k]))
      .map((k) => [k, given[k]]));
    configs[def.kind] = { ...configs[def.kind], ...picked };
    restored++;
  }
  if (restored) await saveConfigs();
  return restored;
}

export async function stopAllServers() {
  await Promise.all([...running.keys()].map(stop));
}

export function registerServersIpc(): void {
  const loaded = configsReady();

  ipcMain.handle('servers:list', async () => {
    await loaded;
    return DEFS.map((d) => {
      const config = publicConfig(d);
      return {
        kind: d.kind, title: d.title, description: d.description,
        fields: d.fields.map((fl) => (fl.key === 'host' ? { ...fl, options: listenOptions(config.host) } : fl)),
        config,
        state: stateOf(d.kind),
        log: logs.get(d.kind) ?? [],
      };
    });
  });

  ipcMain.handle('servers:start', async (_e, kind: unknown, raw: unknown) => {
    await loaded;
    return startServer(kind, raw);
  });

  // Agendador marcado para iniciar junto com o app (com a configuração guardada).
  void loaded.then(() => {
    if (configs.cron?.startWithApp === true) {
      startServer('cron', configs.cron).catch((err: Error) => log('cron', `não iniciou junto com o app: ${err.message}`));
    }
  });

  async function startServer(kind: unknown, raw: unknown) {
    const def = DEFS.find((d) => d.kind === kind);
    if (!def) throw new Error('servidor desconhecido');
    if (running.has(def.kind)) return stateOf(def.kind);
    const given = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const cfg: Record<string, unknown> = { ...def.defaults(), ...given };
    // Senhas: a digitada vale; em branco, usa a guardada. Só a versão cifrada é gravada.
    const stored: Record<string, unknown> = { ...cfg };
    for (const k of passwordKeys(def)) {
      const typed = typeof given[k] === 'string' ? given[k] as string : '';
      const sealed = typed ? seal(typed) : configs[def.kind]?.[`${k}Sealed`];
      cfg[k] = typed || unseal(sealed);
      delete stored[k];
      delete stored[`${k}Set`];
      if (sealed) stored[`${k}Sealed`] = sealed;
    }
    const stopAfter = Number(cfg.stopAfter ?? 0);
    if (!Number.isInteger(stopAfter) || stopAfter < 0 || stopAfter > 86400) throw new Error('tempo para parar inválido (0 a 86400 s)');
    // A pasta padrão é criada; uma escolhida pelo usuário precisa existir.
    if (cfg.root === def.defaults().root) await mkdir(String(cfg.root), { recursive: true });
    configs[def.kind] = stored;
    await saveConfigs();
    log(def.kind, `iniciando o servidor ${def.title}…`);
    let server: RunningServer;
    try {
      server = await def.start(cfg, (l) => log(def.kind, l), (text) => {
        if (Notification.isSupported()) new Notification({ title: 'MultTerm', body: text }).show();
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const msg = e.code === 'EADDRINUSE' ? `a porta ${cfg.port} já está em uso por outro programa`
        : e.code === 'EACCES' ? `sem permissão para usar a porta ${cfg.port}`
          : e.code === 'EADDRNOTAVAIL' ? `o endereço ${cfg.host} não existe nesta máquina agora (a placa de rede mudou?); escolha outro em "Escutar em"`
            : e.message;
      log(def.kind, `falha ao iniciar: ${msg}`);
      throw new Error(msg);
    }
    const r: Running = { server, startedAt: Date.now() };
    if (stopAfter > 0) {
      r.stopAt = Date.now() + stopAfter * 1000;
      r.timer = setTimeout(() => {
        log(def.kind, `parando: tempo limite de ${stopAfter} s`);
        void stop(def.kind);
      }, stopAfter * 1000);
    }
    running.set(def.kind, r);
    if (def.fields.some((fl) => fl.key === 'host')) {
      const where = cfg.host ? String(cfg.host) : 'todas as interfaces';
      log(def.kind, `escutando em ${where}, porta ${server.port}`);
      // Fora do localhost, o Firewall do Windows pode barrar outros equipamentos.
      if (cfg.host !== '127.0.0.1') {
        log(def.kind, 'se outros equipamentos não conseguirem conectar, libere a porta no Firewall do Windows (o Windows costuma perguntar na primeira vez)');
      }
    }
    broadcast(def.kind);
    return stateOf(def.kind);
  }

  ipcMain.handle('servers:stop', (_e, kind: unknown) => stop(String(kind)));
  ipcMain.handle('servers:clear-log', (_e, kind: unknown) => {
    logs.set(String(kind), []);
  });
  ipcMain.handle('servers:choose-dir', async (e, current: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Pasta raiz do servidor', defaultPath: typeof current === 'string' ? current : undefined, properties: ['openDirectory' as const, 'createDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  app.on('before-quit', () => {
    void stopAllServers();
  });
}

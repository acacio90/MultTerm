import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timestamp, type RunningServer } from '../servers/common.ts';
import { startHttp, validateHttp } from '../servers/http.ts';
import { startTftp, validateTftp } from '../servers/tftp.ts';

/*
 * Servidores locais (Ferramentas → Servidores): iniciar/parar, parar sozinho depois de N
 * segundos, log por servidor e configurações lembradas. Todos param ao sair do app.
 */

export interface ServerField {
  key: string;
  label: string;
  type: 'dir' | 'number' | 'bool' | 'text';
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
    kind: 'http',
    title: 'HTTP',
    description: 'Servidor web de arquivos (só leitura) para baixar arquivos pelo navegador ou por wget/curl.',
    fields: [
      { key: 'root', label: 'Pasta raiz', type: 'dir' },
      { key: 'port', label: 'Porta', type: 'number', min: 1, max: 65535 },
      { key: 'listing', label: 'Mostrar o conteúdo das pastas', type: 'bool' },
      ...COMMON,
    ],
    defaults: () => ({ root: filesDir(), port: 8080, listing: true, stopAfter: 3600 }),
    start: (raw, log) => startHttp(validateHttp(raw), log),
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
let configs: Record<string, Record<string, unknown>> = {};
// MULTTERM_SERVERS_FILE troca o arquivo de configurações (testes).
const configFile = () => process.env.MULTTERM_SERVERS_FILE || join(app.getPath('userData'), 'servers.json');

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

export async function stopAllServers() {
  await Promise.all([...running.keys()].map(stop));
}

export function registerServersIpc(): void {
  const loaded = loadConfigs();

  ipcMain.handle('servers:list', async () => {
    await loaded;
    return DEFS.map((d) => ({
      kind: d.kind, title: d.title, description: d.description, fields: d.fields,
      config: { ...d.defaults(), ...configs[d.kind] },
      state: stateOf(d.kind),
      log: logs.get(d.kind) ?? [],
    }));
  });

  ipcMain.handle('servers:start', async (_e, kind: unknown, raw: unknown) => {
    await loaded;
    const def = DEFS.find((d) => d.kind === kind);
    if (!def) throw new Error('servidor desconhecido');
    if (running.has(def.kind)) return stateOf(def.kind);
    const cfg = { ...def.defaults(), ...(typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}) };
    const stopAfter = Number(cfg.stopAfter ?? 0);
    if (!Number.isInteger(stopAfter) || stopAfter < 0 || stopAfter > 86400) throw new Error('tempo para parar inválido (0 a 86400 s)');
    // A pasta padrão é criada; uma escolhida pelo usuário precisa existir.
    if (cfg.root === def.defaults().root) await mkdir(String(cfg.root), { recursive: true });
    configs[def.kind] = cfg;
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
        : e.code === 'EACCES' ? `sem permissão para usar a porta ${cfg.port}` : e.message;
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
    broadcast(def.kind);
    return stateOf(def.kind);
  });

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

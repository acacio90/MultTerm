const { contextBridge, ipcRenderer } = require('electron');

// Abas oferecidas por outra janela podem chegar antes do app registrar o listener: guarda até lá.
const adoptQueue = [];
let adoptCb = null;
ipcRenderer.on('term:adopt', (_e, offer) => (adoptCb ? adoptCb(offer) : adoptQueue.push(offer)));
// O mesmo para os comandos do menu do topo, que podem chegar antes de a página terminar de abrir.
const menuQueue = [];
let menuCb = null;
ipcRenderer.on('menu:command', (_e, command) => (menuCb ? menuCb(command) : menuQueue.push(command)));

// Única ponte entre a interface e o processo principal.
contextBridge.exposeInMainWorld('multterm', {
  load: () => ipcRenderer.invoke('sessions:load'),
  save: (sessions) => ipcRenderer.invoke('sessions:save', sessions),
  chooseFile: () => ipcRenderer.invoke('sessions:choose-file'),
  chooseKeyFile: (current) => ipcRenderer.invoke('sessions:choose-key', current),
  setDefaults: (defaults) => ipcRenderer.invoke('sessions:set-defaults', defaults),
  importSessions: () => ipcRenderer.invoke('sessions:import'),
  // Importar hosts do Zabbix (token e senha ficam no processo principal).
  zabbixConfig: () => ipcRenderer.invoke('zabbix:config'),
  zabbixConnect: (req) => ipcRenderer.invoke('zabbix:connect', req),
  zabbixImport: (req) => ipcRenderer.invoke('zabbix:import', req),
  exportSessions: (folder) => ipcRenderer.invoke('sessions:export', folder),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  connect: (session, opts) => ipcRenderer.invoke('session:connect', session, opts),

  termOpen: (id, session, cols, rows) => ipcRenderer.invoke('term:open', id, session, cols, rows),
  termOpenLocal: (id, kind, cols, rows) => ipcRenderer.invoke('term:open-local', id, kind, cols, rows),
  // Destacar/devolver abas entre janelas.
  isDetached: new URLSearchParams(location.search).get('detached') === '1',
  termDetach: (id, meta) => ipcRenderer.invoke('term:detach', id, meta),
  termReattach: (id, meta) => ipcRenderer.invoke('term:reattach', id, meta),
  termAdopt: (fromWc, fromId, toId) => ipcRenderer.invoke('term:adopt', fromWc, fromId, toId),
  onTermAdopt: (cb) => {
    adoptCb = cb;
    for (const offer of adoptQueue.splice(0)) cb(offer);
  },
  // RDP numa aba (FreeRDP encaixado numa janela nativa sobre a área da aba).
  rdpAvailable: () => ipcRenderer.invoke('rdp:available'),
  rdpOpen: (id, session, view, credentials) => ipcRenderer.invoke('rdp:open', id, session, view, credentials),
  rdpView: (id, view) => ipcRenderer.send('rdp:view', id, view),
  rdpClose: (id) => ipcRenderer.invoke('rdp:close', id),
  onRdpReady: (cb) => ipcRenderer.on('rdp:ready', (_e, id) => cb(id)),
  rdpCtrlAltDel: (id) => ipcRenderer.invoke('rdp:ctrl-alt-del', id),
  onRdpReconnectSize: (cb) => ipcRenderer.on('rdp:reconnect-size', (_e, id) => cb(id)),
  onRdpExit: (cb) => ipcRenderer.on('rdp:exit', (_e, id, code, end) => cb(id, code, end)),
  // Comandos do menu do topo (Arquivo, Sessão, Ferramentas...).
  // Expandir a janela para todas as telas (e voltar).
  onMenuCommand: (cb) => {
    menuCb = cb;
    for (const command of menuQueue.splice(0)) cb(command);
  },
  // Janela destacada: fechar devolve as abas à principal.
  onReturnTabs: (cb) => ipcRenderer.on('window:return-tabs', () => cb()),
  closeWindowNow: () => ipcRenderer.send('window:close-now'),
  onTermReleased: (cb) => ipcRenderer.on('term:released', (_e, id) => cb(id)),
  termInput: (id, data) => ipcRenderer.send('term:input', id, data),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  termClose: (id) => ipcRenderer.send('term:close', id),
  onTermData: (cb) => ipcRenderer.on('term:data', (_e, id, data) => cb(id, data)),
  onTermExit: (cb) => ipcRenderer.on('term:exit', (_e, id, code) => cb(id, code)),

  // Ferramentas de rede.
  termOpenTool: (id, req, cols, rows) => ipcRenderer.invoke('term:open-tool', id, req, cols, rows),
  portScan: (id, host, spec, timeoutMs) => ipcRenderer.invoke('tools:portscan', id, host, spec, timeoutMs),
  netScan: (id, spec, timeoutMs, snmp) => ipcRenderer.invoke('tools:netscan', id, spec, timeoutMs, snmp),
  cancelTool: (id) => ipcRenderer.send('tools:cancel', id),
  onToolResult: (cb) => ipcRenderer.on('tools:result', (_e, id, result) => cb(id, result)),
  onToolProgress: (cb) => ipcRenderer.on('tools:progress', (_e, id, done, total) => cb(id, done, total)),
  dnsQuery: (name, type, server) => ipcRenderer.invoke('tools:dns', name, type, server),
  snmp: (id, req) => ipcRenderer.invoke('tools:snmp', id, req),
  wol: (req) => ipcRenderer.invoke('tools:wol', req),
  captureInfo: () => ipcRenderer.invoke('capture:info'),
  captureStart: (id, req) => ipcRenderer.invoke('capture:start', id, req),
  captureOpen: (file) => ipcRenderer.invoke('capture:open', file),
  captureShow: (file) => ipcRenderer.send('capture:show', file),
  localPorts: () => ipcRenderer.invoke('tools:local-ports'),
  saveCsv: (name, csv) => ipcRenderer.invoke('tools:save-csv', name, csv),

  // Agente MCP (terminais compartilhados).
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentEnable: (on) => ipcRenderer.invoke('agent:enable', on),
  agentSetPort: (port) => ipcRenderer.invoke('agent:set-port', port),
  agentNewToken: () => ipcRenderer.invoke('agent:new-token'),
  agentSetAgent: (id) => ipcRenderer.invoke('agent:set-agent', id),
  agentDetect: () => ipcRenderer.invoke('agent:detect'),
  agentShare: (tab, mode, title, detail) => ipcRenderer.invoke('agent:share', tab, mode, title, detail),
  agentUnshareAll: () => ipcRenderer.invoke('agent:unshare-all'),
  onAgentEvent: (cb) => ipcRenderer.on('agent:event', (_e, ev) => cb(ev)),

  // Servidores locais (TFTP, HTTP...).
  serversList: () => ipcRenderer.invoke('servers:list'),
  serversStart: (kind, config) => ipcRenderer.invoke('servers:start', kind, config),
  serversStop: (kind) => ipcRenderer.invoke('servers:stop', kind),
  serversClearLog: (kind) => ipcRenderer.invoke('servers:clear-log', kind),
  serversChooseDir: (current) => ipcRenderer.invoke('servers:choose-dir', current),
  onServersEvent: (cb) => ipcRenderer.on('servers:event', (_e, ev) => cb(ev)),

  // VPN (motor IPsec do MultTerm).
  vpnInfo: () => ipcRenderer.invoke('vpn:info'),
  vpnImport: () => ipcRenderer.invoke('vpn:import'),
  vpnExportAll: () => ipcRenderer.invoke('vpn:export-all'),
  vpnConnect: (req) => ipcRenderer.invoke('vpn:connect', req),
  vpnDisconnect: () => ipcRenderer.invoke('vpn:disconnect'),
  vpnNetworks: () => ipcRenderer.invoke('vpn:networks'),
  vpnSiteSchema: () => ipcRenderer.invoke('vpn:site-schema'),
  vpnSiteGet: (name) => ipcRenderer.invoke('vpn:site-get', name),
  vpnSiteSave: (req) => ipcRenderer.invoke('vpn:site-save', req),
  vpnSiteDelete: (name) => ipcRenderer.invoke('vpn:site-delete', name),
  vpnSiteExport: (name) => ipcRenderer.invoke('vpn:site-export', name),
  onVpnStatus: (cb) => ipcRenderer.on('vpn:status', (_e, status) => cb(status)),

  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),

  appInfo: () => ipcRenderer.invoke('app:info'),
  openRepo: (path) => ipcRenderer.send('app:open-repo', path),
  showSessionsFile: () => ipcRenderer.send('app:show-sessions-file'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, status) => cb(status)),
});

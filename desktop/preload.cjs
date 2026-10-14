const { contextBridge, ipcRenderer } = require('electron');

// Única ponte entre a interface e o processo principal.
contextBridge.exposeInMainWorld('multterm', {
  load: () => ipcRenderer.invoke('sessions:load'),
  save: (sessions) => ipcRenderer.invoke('sessions:save', sessions),
  chooseFile: () => ipcRenderer.invoke('sessions:choose-file'),
  importSessions: () => ipcRenderer.invoke('sessions:import'),
  exportSessions: (folder) => ipcRenderer.invoke('sessions:export', folder),
  connect: (session) => ipcRenderer.invoke('session:connect', session),

  termOpen: (id, session, cols, rows) => ipcRenderer.invoke('term:open', id, session, cols, rows),
  termOpenLocal: (id, kind, cols, rows) => ipcRenderer.invoke('term:open-local', id, kind, cols, rows),
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
  agentSetCommand: (cmd) => ipcRenderer.invoke('agent:set-command', cmd),
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

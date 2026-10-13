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

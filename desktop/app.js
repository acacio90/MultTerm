import { buildToolPanel, TOOL_TITLES } from './tools.js';

// Interface: árvore de sessões + formulário de edição + abas de terminal.
const api = window.multterm;
const $ = (id) => document.getElementById(id);
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const DEFAULT_PORTS = { ssh: 22, rdp: 3389 };

const state = {
  path: '',
  sessions: [],
  selected: null, // chave da sessão selecionada
  editing: null, // chave em edição; null + form visível = nova sessão
  filter: '',
  collapsed: new Set(readCollapsed()),
};

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem('collapsed') ?? '[]');
  } catch {
    return [];
  }
}

function writeCollapsed() {
  try {
    localStorage.setItem('collapsed', JSON.stringify([...state.collapsed]));
  } catch {
    // armazenamento indisponível: só não lembra as pastas fechadas
  }
}

const normalizeFolder = (f) => f.split(/[\\/]+/).map((p) => p.trim()).filter(Boolean).join('/');
const keyOf = (s) => (s.folder ? `${s.folder}/${s.name}` : s.name);
const parentOf = (folder) => folder.split('/').slice(0, -1).join('/');

function cleanError(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

function message(text, kind = 'ok') {
  const p = document.createElement('p');
  p.className = kind;
  p.textContent = text;
  $('messages').append(p);
}

function clearMessages() {
  $('messages').replaceChildren();
}

function matches(s) {
  if (!state.filter) return true;
  const q = state.filter.toLowerCase();
  return [s.name, s.host, s.folder, s.user ?? '', ...(s.tags ?? [])].some((v) => v.toLowerCase().includes(q));
}

// ---------- árvore ----------

function buildTree(sessions) {
  const folders = new Map([['', { folders: new Set(), sessions: [] }]]);
  const ensure = (path) => {
    if (folders.has(path)) return folders.get(path);
    const node = { folders: new Set(), sessions: [] };
    folders.set(path, node);
    ensure(parentOf(path)).folders.add(path);
    return node;
  };
  for (const s of sessions) ensure(s.folder).sessions.push(s);
  return folders;
}

function treeItem({ depth, label, cls, twisty = '', badge = '' }) {
  const li = document.createElement('li');
  li.className = cls;
  li.style.paddingLeft = `${6 + depth * 16}px`;
  li.tabIndex = 0;
  const t = document.createElement('span');
  t.className = 'twisty';
  t.textContent = twisty;
  li.append(t);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = badge;
    li.append(b);
  }
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  li.append(l);
  return li;
}

function renderTree() {
  const visible = state.sessions.filter(matches);
  const tree = buildTree(visible);
  const items = [];

  const walk = (path, depth) => {
    const node = tree.get(path);
    const childFolders = [...node.folders].sort((a, b) => collator.compare(a, b));
    for (const folder of childFolders) {
      const open = state.filter || !state.collapsed.has(folder);
      const li = treeItem({
        depth,
        label: folder.split('/').pop(),
        cls: 'folder',
        twisty: open ? '▾' : '▸',
      });
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-expanded', String(open));
      li.addEventListener('click', () => {
        if (state.collapsed.has(folder)) state.collapsed.delete(folder);
        else state.collapsed.add(folder);
        writeCollapsed();
        renderTree();
      });
      items.push(li);
      if (open) walk(folder, depth + 1);
    }
    for (const s of [...node.sessions].sort((a, b) => collator.compare(a.name, b.name))) {
      const key = keyOf(s);
      const li = treeItem({ depth, label: s.name, cls: key === state.selected ? 'session selected' : 'session', badge: s.type });
      li.setAttribute('role', 'treeitem');
      li.title = `${s.user ? `${s.user}@` : ''}${s.host}:${s.port ?? DEFAULT_PORTS[s.type]}`;
      li.addEventListener('click', () => select(key));
      li.addEventListener('dblclick', () => connect(s));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') connect(s);
      });
      items.push(li);
    }
  };
  walk('', 0);

  $('tree').replaceChildren(...items);
  $('status-count').textContent = state.filter
    ? `${visible.length} de ${state.sessions.length} sessões`
    : `${state.sessions.length} sessões · sem limite`;
  $('status-path').textContent = state.path;
  $('status-path').title = state.path;

  const folders = [...new Set(state.sessions.map((s) => s.folder).filter(Boolean))].sort(collator.compare);
  $('folders').replaceChildren(...folders.map((f) => Object.assign(document.createElement('option'), { value: f })));
}

// ---------- formulário ----------

const form = $('form');

function showForm(session) {
  $('empty').hidden = true;
  form.hidden = false;
  $('form-title').textContent = session ? session.name : 'Nova sessão';
  form.name.value = session?.name ?? '';
  form.folder.value = session?.folder ?? '';
  form.type.value = session?.type ?? 'ssh';
  form.host.value = session?.host ?? '';
  form.port.value = session?.port ?? '';
  form.user.value = session?.user ?? '';
  form.identityFile.value = session?.identityFile ?? '';
  form.tags.value = (session?.tags ?? []).join(', ');
  $('btn-connect').disabled = !session;
  $('btn-external').disabled = !session;
  $('btn-delete').disabled = !session;
  updateTypeFields();
}

function updateTypeFields() {
  const type = form.type.value;
  form.port.placeholder = String(DEFAULT_PORTS[type]);
  for (const el of form.querySelectorAll('.ssh-only')) el.hidden = type !== 'ssh';
}

function readForm() {
  const tags = form.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const session = {
    name: form.name.value.trim(),
    folder: normalizeFolder(form.folder.value),
    type: form.type.value,
    host: form.host.value.trim(),
  };
  if (form.port.value) session.port = Number(form.port.value);
  if (form.user.value.trim()) session.user = form.user.value.trim();
  if (form.type.value === 'ssh' && form.identityFile.value.trim()) session.identityFile = form.identityFile.value.trim();
  if (tags.length) session.tags = tags;
  return session;
}

function select(key) {
  state.selected = key;
  state.editing = key;
  clearMessages();
  showForm(state.sessions.find((s) => keyOf(s) === key));
  renderTree();
}

function apply(snapshot) {
  state.path = snapshot.path;
  state.sessions = snapshot.sessions;
  if (state.selected && !state.sessions.some((s) => keyOf(s) === state.selected)) {
    state.selected = state.editing = null;
    form.hidden = true;
    $('empty').hidden = false;
  }
  renderTree();
}

async function save(event) {
  event.preventDefault();
  clearMessages();
  const session = readForm();
  const others = state.sessions.filter((s) => keyOf(s) !== state.editing);
  try {
    apply(await api.save([...others, session]));
    select(keyOf(session));
    message('Sessão salva.');
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

async function remove() {
  const session = state.sessions.find((s) => keyOf(s) === state.editing);
  if (!session || !confirm(`Excluir a sessão "${session.name}"?`)) return;
  clearMessages();
  try {
    apply(await api.save(state.sessions.filter((s) => keyOf(s) !== state.editing)));
    message(`Sessão "${session.name}" excluída.`);
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

/** SSH abre numa aba de terminal embutido; RDP (ou "Janela externa") abre fora do app. */
async function connect(session, { external = false } = {}) {
  if (session.type === 'ssh' && !external) {
    await openSessionTab(session);
    return;
  }
  showEditor();
  clearMessages();
  try {
    const { warnings } = await api.connect(session);
    message(`Conectando a ${session.name}…`);
    for (const w of warnings) message(w, 'warn');
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

// ---------- abas (terminais e ferramentas) ----------

// id da aba -> aba. Nas abas de terminal o mesmo id identifica o terminal no processo
// principal; a aba é registrada antes da abertura, então nenhuma saída chega antes dela.
const tabsById = new Map();
let tabSeq = 0;
let activeTab = null; // null = aba "Sessão"

function showEditor() {
  activeTab = null;
  $('tab-editor').classList.add('active');
  $('panel-editor').hidden = false;
  $('terminals').hidden = true;
  for (const t of tabsById.values()) {
    t.button.classList.remove('active');
    t.panel.hidden = true;
  }
}

function showTab(tab) {
  activeTab = tab;
  $('tab-editor').classList.remove('active');
  $('panel-editor').hidden = true;
  $('terminals').hidden = false;
  for (const t of tabsById.values()) {
    t.button.classList.toggle('active', t === tab);
    t.panel.hidden = t !== tab;
  }
  requestAnimationFrame(() => {
    if (tab.term) {
      tab.fit.fit();
      tab.term.focus();
    } else {
      tab.onShow?.();
    }
  });
}

function closeTab(tab) {
  if (tab.term) {
    if (tab.running) api.termClose(tab.id);
    tab.term.dispose();
  }
  tab.onClose?.();
  tab.panel.remove();
  tab.button.remove();
  tabsById.delete(tab.id);
  if (activeTab === tab) {
    const next = [...tabsById.values()].pop();
    if (next) showTab(next);
    else showEditor();
  }
}

/** Cria e registra uma aba (botão + painel) de qualquer tipo. */
function createTab({ title, tooltip = '', panelClass }) {
  const tab = { id: ++tabSeq };
  tab.panel = document.createElement('div');
  tab.panel.className = `panel ${panelClass}`;
  $('terminals').append(tab.panel);

  tab.button = document.createElement('button');
  tab.button.type = 'button';
  tab.button.className = 'tab';
  tab.button.setAttribute('role', 'tab');
  tab.button.title = tooltip;
  const label = document.createElement('span');
  label.className = 'title';
  label.textContent = title;
  const close = document.createElement('span');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Fechar';
  tab.button.append(label, close);
  tab.button.addEventListener('click', (e) => (e.target === close ? closeTab(tab) : showTab(tab)));
  tab.button.addEventListener('auxclick', (e) => {
    if (e.button === 1) closeTab(tab); // botão do meio fecha, como no navegador
  });
  $('tabs').append(tab.button);
  tabsById.set(tab.id, tab);
  return tab;
}

function pasteInto(tab) {
  if (tab.running) api.clipboardRead().then((text) => tab.term.paste(text));
}

function markEnded(tab, code) {
  tab.running = false;
  tab.button.classList.add('ended');
  const detail = code === null ? '' : ` (código ${code})`;
  tab.term.writeln(`\r\n\x1b[90m[${tab.endedText}${detail}. Pressione R para ${tab.restartText}.]\x1b[0m`);
}

function showNotice(tab, warnings) {
  tab.notice.replaceChildren();
  tab.notice.hidden = warnings.length === 0;
  if (!warnings.length) return;
  const text = document.createElement('span');
  text.textContent = warnings.join(' · ');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Fechar aviso';
  close.addEventListener('click', () => {
    tab.notice.hidden = true;
    tab.term.focus();
  });
  tab.notice.append(text, close);
}

async function startTab(tab) {
  // O ConPTY limpa a tela e volta ao topo ao iniciar: numa reconexão, empurra a saída
  // anterior para o histórico (rolagem) em vez de deixá-la ser sobrescrita.
  if (tab.started) tab.term.write('\r\n'.repeat(tab.term.rows) + '\x1b[H');
  tab.started = true;
  tab.running = true;
  tab.button.classList.remove('ended');
  try {
    const result = await tab.open(tab.id, tab.term.cols, tab.term.rows);
    showNotice(tab, result?.warnings ?? []);
  } catch (err) {
    tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`);
    if (tab.running) markEnded(tab, null);
  }
}

/**
 * Aba com terminal embutido. `open(id, cols, rows)` inicia o processo no processo principal
 * (sessão SSH ou ferramenta como ping/traceroute).
 */
async function openTerminalTab({ title, tooltip, open, endedText = 'sessão encerrada', restartText = 'reconectar' }) {
  const tab = createTab({ title, tooltip, panelClass: 'term-panel' });
  Object.assign(tab, { open, endedText, restartText, running: false, started: false });

  tab.notice = document.createElement('div');
  tab.notice.className = 'term-notice';
  tab.notice.hidden = true;
  tab.host = document.createElement('div');
  tab.host.className = 'term-host';
  tab.panel.append(tab.notice, tab.host);

  tab.term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 10000,
    theme: { background: '#1e1f22', foreground: '#e3e5e8', cursor: '#e3e5e8' },
  });
  tab.fit = new FitAddon.FitAddon();
  tab.term.loadAddon(tab.fit);
  showTab(tab);
  tab.term.open(tab.host);
  tab.fit.fit();

  tab.term.onData((data) => {
    if (!tab.running) {
      if (data === 'r' || data === 'R') {
        tab.term.writeln('');
        startTab(tab);
      }
      return;
    }
    api.termInput(tab.id, data);
  });
  tab.term.onResize(({ cols, rows }) => {
    if (tab.running) api.termResize(tab.id, cols, rows);
  });
  // Selecionar copia, botão direito cola. Ctrl+Shift+C/V também.
  tab.term.onSelectionChange(() => {
    const text = tab.term.getSelection();
    if (text) api.clipboardWrite(text);
  });
  tab.panel.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    pasteInto(tab);
  });
  tab.term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyV') {
      pasteInto(tab);
      return false;
    }
    if (e.code === 'KeyC') {
      const text = tab.term.getSelection();
      if (text) api.clipboardWrite(text);
      return false;
    }
    return true;
  });
  new ResizeObserver(() => {
    if (!tab.panel.hidden) tab.fit.fit();
  }).observe(tab.host);

  await startTab(tab);
  return tab;
}

function openSessionTab(session) {
  return openTerminalTab({
    title: session.name,
    tooltip: `${session.user ? `${session.user}@` : ''}${session.host}`,
    open: (id, cols, rows) => api.termOpen(id, session, cols, rows),
  });
}

api.onTermData((id, data) => tabsById.get(id)?.term?.write(data));
api.onTermExit((id, code) => {
  const tab = tabsById.get(id);
  if (tab?.running) markEnded(tab, code);
});

$('tab-editor').addEventListener('click', showEditor);
$('terminals').hidden = true;

// ---------- barra de ferramentas ----------

$('btn-new').addEventListener('click', () => {
  state.selected = state.editing = null;
  clearMessages();
  renderTree();
  showEditor();
  showForm(null);
  form.name.focus();
});

$('btn-import').addEventListener('click', async () => {
  clearMessages();
  try {
    const result = await api.importSessions();
    if (!result) return;
    apply(result);
    const origem = result.format === 'ansible' ? ' do inventário do Ansible' : '';
    message(`${result.added} sessões importadas${origem}, ${result.skipped} já existiam.`);
    for (const w of result.warnings) message(w, 'warn');
  } catch (err) {
    message(cleanError(err), 'error');
  }
});

$('btn-file').addEventListener('click', async () => {
  clearMessages();
  try {
    const result = await api.chooseFile();
    if (result) apply(result);
  } catch (err) {
    message(cleanError(err), 'error');
  }
});

$('btn-reload').addEventListener('click', () => load());

$('search').addEventListener('input', (e) => {
  state.filter = e.target.value.trim();
  renderTree();
});

form.addEventListener('submit', save);
form.type.addEventListener('change', updateTypeFields);
$('btn-delete').addEventListener('click', remove);
$('btn-connect').addEventListener('click', () => {
  const session = state.sessions.find((s) => keyOf(s) === state.editing);
  if (session) connect(session);
});
$('btn-external').addEventListener('click', () => {
  const session = state.sessions.find((s) => keyOf(s) === state.editing);
  if (session) connect(session, { external: true });
});

// ---------- ajuda e atualizações ----------

const help = $('help');

function renderUpdate(status) {
  const text = $('update-text');
  const progress = $('update-progress');
  $('update-badge').hidden = !['available', 'downloaded'].includes(status.state);
  $('btn-check').disabled = ['checking', 'downloading', 'unsupported'].includes(status.state);
  $('btn-download').hidden = status.state !== 'available';
  $('btn-install').hidden = status.state !== 'downloaded';
  progress.hidden = status.state !== 'downloading';

  switch (status.state) {
    case 'unsupported':
      text.textContent = status.message;
      break;
    case 'checking':
      text.textContent = 'Procurando atualizações…';
      break;
    case 'available':
      text.textContent = `Nova versão disponível: ${status.version}.` + (status.notes ? `\n${status.notes}` : '');
      break;
    case 'not-available':
      text.textContent = 'Você está usando a versão mais recente.';
      break;
    case 'downloading':
      text.textContent = `Baixando atualização… ${status.percent}%`;
      progress.value = status.percent;
      break;
    case 'downloaded':
      text.textContent = `Versão ${status.version} baixada. Reinicie para instalar (as abas abertas serão fechadas).`;
      break;
    case 'error':
      text.textContent = `Não foi possível verificar/baixar: ${status.message}`;
      break;
    default:
      text.textContent = '';
  }
}

async function openHelp() {
  if (!help.open) help.showModal();
  renderUpdate(await api.updateStatus());
  try {
    const info = await api.appInfo();
    $('help-title').textContent = `${info.name} ${info.version}`;
    $('help-version').textContent = info.version;
    $('help-sessions').textContent = info.sessionsPath;
    $('help-ssh').textContent = info.ssh;
    $('help-platform').textContent = info.platform;
    $('help-runtime').textContent = `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`;
    $('help-agent').textContent = info.agent.available
      ? info.agent.keys.length === 1 ? '1 chave carregada' : `${info.agent.keys.length} chaves carregadas`
      : `indisponível (${info.agent.message})`;
    $('help-agent').title = info.agent.available ? info.agent.keys.join('\n') : '';
  } catch (err) {
    $('help-agent').textContent = cleanError(err);
  }
}

$('btn-help').addEventListener('click', openHelp);
$('help-close').addEventListener('click', () => help.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    openHelp();
  }
});
$('btn-check').addEventListener('click', async () => renderUpdate(await api.checkUpdates()));
$('btn-download').addEventListener('click', async () => renderUpdate(await api.downloadUpdate()));
$('btn-install').addEventListener('click', () => {
  const open = [...tabsById.values()].filter((t) => t.running).length;
  if (open && !confirm(`Há ${open} sessão(ões) aberta(s). Reiniciar e instalar mesmo assim?`)) return;
  api.installUpdate();
});
$('btn-releases').addEventListener('click', () => api.openRepo('/releases'));
$('btn-repo').addEventListener('click', () => api.openRepo(''));
$('btn-issues').addEventListener('click', () => api.openRepo('/issues'));
$('btn-show-sessions').addEventListener('click', () => api.showSessionsFile());
api.onUpdateStatus(renderUpdate);
api.updateStatus().then(renderUpdate);

// ---------- ferramentas de rede ----------

const selectedSession = () => state.sessions.find((s) => keyOf(s) === state.selected);

/** Rede /24 do host selecionado, como sugestão para o scanner de rede. */
function guessNetwork(host) {
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(host ?? '');
  return m ? `${m[1]}.0/24` : '';
}

/** Abre o formulário de nova sessão já preenchido (ex.: a partir do scanner de rede). */
function newSessionFrom({ name, host, type }) {
  state.selected = state.editing = null;
  clearMessages();
  renderTree();
  showEditor();
  showForm(null);
  form.name.value = name;
  form.host.value = host;
  form.type.value = type;
  updateTypeFields();
  message('Revise os dados e clique em Salvar para criar a sessão.');
  form.name.focus();
}

function openToolTab(kind) {
  const tab = createTab({ title: TOOL_TITLES[kind], panelClass: 'tool-panel' });
  const session = selectedSession();
  const ctx = { api, cleanError, host: session?.host, network: guessNetwork(session?.host), newSession: newSessionFrom };
  const hooks = buildToolPanel(kind, ctx, tab);
  Object.assign(tab, { onResult: hooks.onResult, onProgress: hooks.onProgress, onClose: hooks.onClose, onShow: hooks.focus });
  showTab(tab);
}

api.onToolResult((id, result) => tabsById.get(id)?.onResult?.(result));
api.onToolProgress((id, done, total) => tabsById.get(id)?.onProgress?.(done, total));

// Ping/traceroute: pergunta o host e roda num terminal embutido.
const diagDialog = $('diag-dialog');
const diagForm = $('diag-form');
let diagKind = 'ping';

function openDiagDialog(kind) {
  diagKind = kind;
  $('diag-title').textContent = kind === 'ping' ? 'Ping' : 'Traceroute';
  $('diag-count-label').hidden = kind !== 'ping';
  diagForm.host.value = selectedSession()?.host ?? diagForm.host.value;
  diagForm.count.value = '';
  diagDialog.showModal();
  diagForm.host.select();
}

diagForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const req = { kind: diagKind, host: diagForm.host.value.trim(), count: diagForm.count.value };
  diagDialog.close();
  openTerminalTab({
    title: `${req.kind} ${req.host}`,
    tooltip: req.kind === 'ping' && !req.count ? 'Ctrl+C para parar' : '',
    open: (id, cols, rows) => api.termOpenTool(id, req, cols, rows),
    endedText: `${req.kind} encerrado`,
    restartText: 'executar de novo',
  });
});
$('diag-cancel').addEventListener('click', () => diagDialog.close());

// Menu "Ferramentas".
const toolsMenu = $('tools-menu');
function setToolsMenu(open) {
  toolsMenu.hidden = !open;
  $('btn-tools').setAttribute('aria-expanded', String(open));
}
$('btn-tools').addEventListener('click', (e) => {
  e.stopPropagation();
  setToolsMenu(toolsMenu.hidden);
});
toolsMenu.addEventListener('click', (e) => {
  const kind = e.target.closest('[data-tool]')?.dataset.tool;
  if (!kind) return;
  setToolsMenu(false);
  if (kind === 'ping' || kind === 'traceroute') openDiagDialog(kind);
  else openToolTab(kind);
});
document.addEventListener('click', () => setToolsMenu(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setToolsMenu(false);
});

async function load() {
  clearMessages();
  try {
    apply(await api.load());
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

load();

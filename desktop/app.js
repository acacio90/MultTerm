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
  multi: new Set(), // seleção múltipla (Ctrl/Shift+clique)
  anchor: null, // início do intervalo do Shift+clique
  editing: null, // chave em edição; null + form visível = nova sessão
  filter: '',
  collapsed: new Set(readCollapsed()),
};

// Pastas criadas pelo menu de contexto que ainda não têm sessão: aparecem na árvore e são
// gravadas no arquivo quando uma sessão é salva dentro delas (só existem nesta execução).
const pendingFolders = new Set();
const isUnder = (folder, path) => folder === path || folder.startsWith(`${path}/`);
const hasSessions = (path) => state.sessions.some((s) => isUnder(s.folder, path));

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

function buildTree(sessions, extraFolders = []) {
  const folders = new Map([['', { folders: new Set(), sessions: [] }]]);
  const ensure = (path) => {
    if (folders.has(path)) return folders.get(path);
    const node = { folders: new Set(), sessions: [] };
    folders.set(path, node);
    ensure(parentOf(path)).folders.add(path);
    return node;
  };
  for (const s of sessions) ensure(s.folder).sessions.push(s);
  for (const f of extraFolders) ensure(f);
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

// Chaves das sessões na ordem em que aparecem na árvore (para o Shift+clique).
let treeOrder = [];

function renderTree() {
  treeOrder = [];
  const visible = state.sessions.filter(matches);
  const tree = buildTree(visible, state.filter ? [] : [...pendingFolders]);
  const items = [];

  const walk = (path, depth) => {
    const node = tree.get(path);
    const childFolders = [...node.folders].sort((a, b) => collator.compare(a, b));
    for (const folder of childFolders) {
      const open = state.filter || !state.collapsed.has(folder);
      const li = treeItem({
        depth,
        label: folder.split('/').pop(),
        cls: hasSessions(folder) ? 'folder' : 'folder pending',
        twisty: open ? '▾' : '▸',
      });
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-expanded', String(open));
      li.dataset.folder = folder;
      li.addEventListener('contextmenu', (e) => openFolderMenu(e, folder));
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
      treeOrder.push(key);
      const marked = state.multi.size ? state.multi.has(key) : key === state.selected;
      const li = treeItem({ depth, label: s.name, cls: marked ? 'session selected' : 'session', badge: s.type });
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-selected', String(marked));
      li.title = `${s.user ? `${s.user}@` : ''}${s.host}:${s.port ?? DEFAULT_PORTS[s.type]}`;
      li.addEventListener('click', (e) => clickSession(e, key));
      li.addEventListener('dblclick', () => connect(s));
      li.addEventListener('contextmenu', (e) => openSessionMenu(e, s));
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
  if (state.multi.size) $('status-count').textContent += ` · ${state.multi.size} selecionadas`;
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
  form.mac.value = session?.mac ?? '';
  form.vpn.value = session?.vpn ?? '';
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
  if (form.mac.value.trim()) session.mac = form.mac.value.trim();
  if (form.vpn.value.trim()) session.vpn = form.vpn.value.trim();
  if (tags.length) session.tags = tags;
  return session;
}

/** Clique numa sessão: simples edita; Ctrl alterna na seleção múltipla; Shift seleciona o intervalo. */
function clickSession(e, key) {
  if (e.ctrlKey || e.metaKey) {
    if (!state.multi.size && state.selected) state.multi.add(state.selected);
    if (state.multi.has(key)) state.multi.delete(key);
    else state.multi.add(key);
    if (!state.multi.size) state.selected = null; // desmarcou a única selecionada
    state.anchor = key;
    renderTree();
    return;
  }
  const from = treeOrder.indexOf(state.anchor ?? state.selected);
  const to = treeOrder.indexOf(key);
  if (e.shiftKey && from >= 0 && to >= 0) {
    state.multi = new Set(treeOrder.slice(Math.min(from, to), Math.max(from, to) + 1));
    renderTree();
    return;
  }
  state.anchor = key;
  select(key);
}

function clearMulti() {
  if (!state.multi.size) return;
  state.multi.clear();
  renderTree();
}

function select(key) {
  state.multi.clear();
  state.selected = key;
  state.editing = key;
  clearMessages();
  showForm(state.sessions.find((s) => keyOf(s) === key));
  renderTree();
}

function apply(snapshot) {
  state.path = snapshot.path;
  state.sessions = snapshot.sessions;
  // Pasta pendente que ganhou sessão passa a existir no arquivo.
  for (const p of [...pendingFolders]) if (hasSessions(p)) pendingFolders.delete(p);
  for (const k of [...state.multi]) if (!state.sessions.some((x) => keyOf(x) === k)) state.multi.delete(k);
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
  // Sessão atrás de uma VPN: conecta a VPN primeiro e depois abre a sessão.
  if (session.vpn && !(vpnStatus?.site === session.vpn && vpnStatus.state === 'connected')) {
    openToolTab('vpn', {
      vpnSite: session.vpn,
      vpnNotice: `A sessão "${session.name}" usa a VPN "${session.vpn}". Ela abre assim que a VPN conectar.`,
      vpnThen: () => connect(session, { external }),
    });
    return;
  }
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

/**
 * Conecta várias sessões em sequência. Se uma delas usa uma VPN desconectada, abre a VPN e
 * continua a partir dela quando a VPN conectar.
 */
async function connectMany(sessions) {
  for (const [i, session] of sessions.entries()) {
    if (session.vpn && !(vpnStatus?.site === session.vpn && vpnStatus.state === 'connected')) {
      openToolTab('vpn', {
        vpnSite: session.vpn,
        vpnNotice: `${sessions.length - i} sessão(ões) usam a VPN "${session.vpn}". Elas abrem assim que a VPN conectar.`,
        vpnThen: () => connectMany(sessions.slice(i)),
      });
      return;
    }
    await connect(session);
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

function closeTab(tab, { keepProcess = false } = {}) {
  if (tab.term) {
    // keepProcess: a aba foi para outra janela; o processo (e o compartilhamento) seguem lá.
    if (tab.running && !keepProcess) api.termClose(tab.id);
    tab.term.dispose();
    if (!keepProcess && tab.agentMode && tab.agentMode !== 'off') void api.agentShare(tab.id, 'off', tab.title);
  }
  tab.onClose?.();
  tab.panel.remove();
  tab.button.remove();
  tabsById.delete(tab.id);
  notifyTabsChanged();
  if (activeTab === tab) {
    const next = [...tabsById.values()].pop();
    if (next) showTab(next);
    else if (api.isDetached) window.close(); // janela destacada sem abas: fecha
    else showEditor();
  }
}

/** Cria e registra uma aba (botão + painel) de qualquer tipo. */
function createTab({ title, tooltip = '', panelClass }) {
  const tab = { id: ++tabSeq, title, tooltip };
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
  setTimeout(notifyTabsChanged, 0); // depois que a aba de terminal ganha o term
  return tab;
}

/** Painéis que listam as abas (ex.: o do agente) se atualizam. */
function notifyTabsChanged() {
  for (const t of tabsById.values()) t.onTabsChanged?.();
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
async function openTerminalTab({ title, tooltip, open, spec, adopt, endedText = 'sessão encerrada', restartText = 'reconectar' }) {
  const tab = createTab({ title, tooltip, panelClass: 'term-panel' });
  Object.assign(tab, { open: open ?? openFor(spec), spec, endedText, restartText, running: false, started: false });

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
  tab.button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTabMenu(e, tab);
  });

  if (adopt) await adoptInto(tab, adopt);
  else await startTab(tab);
  return tab;
}

/** Recria a função que abre o processo de uma aba (para reconectar em outra janela). */
function openFor(spec) {
  if (spec?.type === 'ssh') return (id, cols, rows) => api.termOpen(id, spec.session, cols, rows);
  if (spec?.type === 'local') return (id, cols, rows) => api.termOpenLocal(id, spec.kind, cols, rows);
  if (spec?.type === 'diag') return (id, cols, rows) => api.termOpenTool(id, spec.req, cols, rows);
  return async () => { throw new Error('esta aba não pode ser reaberta aqui'); };
}

/** Assume um processo que veio de outra janela: redesenha a tela e segue a sessão. */
async function adoptInto(tab, { fromWc, fromId }) {
  try {
    const { output, running } = await api.termAdopt(fromWc, fromId, tab.id);
    tab.started = true;
    if (output) tab.term.write(output);
    tab.running = running;
    if (running) api.termResize(tab.id, tab.term.cols, tab.term.rows);
    else markEnded(tab, null);
  } catch (err) {
    tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`);
    markEnded(tab, null);
  }
}

/** Dados para recriar a aba em outra janela. */
const tabMeta = (tab) => ({ title: tab.title, tooltip: tab.tooltip, spec: tab.spec, endedText: tab.endedText, restartText: tab.restartText });

// Menu de contexto da aba de terminal: destacar em janela própria ou devolver à principal.
let tabMenu = null;
function openTabMenu(e, tab) {
  tabMenu?.remove();
  const item = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', () => {
      tabMenu?.remove();
      tabMenu = null;
      fn();
    });
    return b;
  };
  tabMenu = document.createElement('div');
  tabMenu.className = 'menu tab-menu';
  tabMenu.setAttribute('role', 'menu');
  tabMenu.append(
    api.isDetached
      ? item('Devolver à janela principal', () => api.termReattach(tab.id, tabMeta(tab)).catch((err) => tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`)))
      : item('Abrir em janela separada', () => api.termDetach(tab.id, tabMeta(tab)).catch((err) => tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`))),
    item('Fechar aba', () => closeTab(tab)),
  );
  tabMenu.style.left = `${e.clientX}px`;
  tabMenu.style.top = `${e.clientY}px`;
  document.body.append(tabMenu);
  const away = (ev) => {
    if (tabMenu && !tabMenu.contains(ev.target)) {
      tabMenu.remove();
      tabMenu = null;
      document.removeEventListener('mousedown', away, true);
    }
  };
  document.addEventListener('mousedown', away, true);
}

// A outra janela assumiu a aba: tira daqui sem encerrar o processo.
api.onTermReleased((id) => {
  const tab = tabsById.get(id);
  if (tab) closeTab(tab, { keepProcess: true });
});
// Uma aba chegando de outra janela.
api.onTermAdopt((offer) => {
  const meta = offer.meta ?? {};
  if (api.isDetached) document.title = `${meta.title ?? 'terminal'} — MultTerm`;
  void openTerminalTab({ title: meta.title ?? 'terminal', tooltip: meta.tooltip ?? '', spec: meta.spec, endedText: meta.endedText, restartText: meta.restartText, adopt: offer });
});
if (api.isDetached) document.body.classList.add('detached');

const LOCAL_TITLES = { powershell: 'PowerShell', cmd: 'Prompt de comando', wsl: 'WSL', agent: 'Agente' };

/** Terminal local (PowerShell, cmd, WSL) ou o agente numa aba local. */
function openLocalTab(kind) {
  return openTerminalTab({
    spec: { type: 'local', kind },
    title: LOCAL_TITLES[kind] ?? kind,
    tooltip: kind === 'agent' ? 'agente de IA (o shell continua aberto quando ele termina)' : 'terminal local',
    endedText: kind === 'agent' ? 'agente encerrado' : 'terminal encerrado',
    restartText: 'abrir de novo',
  });
}

function openSessionTab(session) {
  return openTerminalTab({
    spec: { type: 'ssh', session },
    title: session.name,
    tooltip: `${session.user ? `${session.user}@` : ''}${session.host}`,
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

/** Botão com menu suspenso (Importar/Exportar): fecha ao escolher, clicar fora ou Esc. */
function dropdown(buttonId, menuId, run) {
  const button = $(buttonId);
  const menu = $(menuId);
  const set = (open) => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const other of document.querySelectorAll('.toolbar .menu')) if (other !== menu) other.hidden = true;
    set(menu.hidden);
  });
  menu.addEventListener('click', (e) => {
    const what = e.target.closest('[data-what]')?.dataset.what;
    if (!what) return;
    set(false);
    run(what);
  });
  document.addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') set(false);
  });
}

dropdown('btn-import', 'import-menu', (what) => {
  if (what === 'sessions') void importSessions();
  else if (what === 'vpn') void importVpnSite();
  else if (what === 'backup') void importBackup();
});
dropdown('btn-export', 'export-menu', (what) => {
  if (what === 'sessions') void exportSessions();
  else if (what === 'vpn') void exportVpnSites();
  else if (what === 'backup') void exportBackup();
});

async function importVpnSite() {
  showEditor();
  clearMessages();
  try {
    const site = await api.vpnImport();
    if (site) message(`Site de VPN "${site.name}" importado. Conecte por Ferramentas → VPN.`);
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

async function exportVpnSites() {
  showEditor();
  clearMessages();
  try {
    const result = await api.vpnExportAll();
    if (result) message(`${result.count} site(s) de VPN exportado(s) para ${result.dir} (os arquivos contêm a chave compartilhada; guarde com cuidado).`);
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

async function exportBackup() {
  showEditor();
  clearMessages();
  try {
    const r = await api.exportBackup();
    if (!r) return;
    message(`Backup salvo em ${r.path}: ${r.sessions} sessão(ões), ${r.vpnSites} site(s) de VPN e ${r.servers} servidor(es) configurado(s).`);
    message('O backup contém as chaves compartilhadas das VPNs; guarde com cuidado. Senhas dos servidores e o token do agente não vão no backup (são cifrados para este usuário do Windows).', 'warn');
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

async function importBackup() {
  showEditor();
  clearMessages();
  if (!confirm('Importar um backup completo?\n\nSessões e sites de VPN que já existem são mantidos (só os novos entram). As configurações dos servidores e a escolha do agente são substituídas pelas do backup.')) return;
  try {
    const r = await api.importBackup();
    if (!r) return;
    apply(r);
    message(`Backup importado: ${r.added} sessão(ões) nova(s) (${r.skipped} já existiam), ${r.sites.added} site(s) de VPN novo(s) (${r.sites.skipped} já existiam) e ${r.servers} servidor(es) configurado(s).`);
    if (r.servers) message('Senhas dos servidores não vêm no backup: preencha de novo ao iniciar cada um.', 'warn');
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

async function importSessions() {
  showEditor();
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
}

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

// ---------- exportar ----------

/** Exporta todas as sessões ou só uma pasta (com subpastas) para um YAML que a importação lê. */
async function exportSessions(folder = '') {
  showEditor();
  clearMessages();
  try {
    const result = await api.exportSessions(folder);
    if (result) message(`${result.count} sessão(ões) exportada(s) para ${result.path}`);
  } catch (err) {
    message(cleanError(err), 'error');
  }
}


// ---------- pastas: menu de contexto ----------

const joinFolder = (parent, name) => (parent ? `${parent}/${name}` : name);
const folderExists = (path) => pendingFolders.has(path) || hasSessions(path);

function folderNameError(name) {
  if (!name) return 'informe um nome';
  if (/[\\/]/.test(name)) return 'o nome não pode ter / nem \\ (crie um nível de cada vez)';
  if (name.length > 100) return 'nome longo demais (máximo 100 caracteres)';
  return '';
}

/** Diálogo de nome (o Electron não oferece window.prompt). Resolve null se cancelado. */
function askName(title, label, value = '') {
  const dialog = $('name-dialog');
  const nameForm = $('name-form');
  const input = nameForm.folderName;
  $('name-title').textContent = title;
  $('name-label').textContent = label;
  $('name-error').textContent = '';
  input.value = value;
  return new Promise((resolve) => {
    const done = (result) => {
      nameForm.onsubmit = null;
      $('name-cancel').onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(result);
    };
    nameForm.onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      const error = folderNameError(name);
      if (error) $('name-error').textContent = error;
      else done(name);
    };
    $('name-cancel').onclick = () => done(null);
    dialog.oncancel = (e) => {
      e.preventDefault();
      done(null);
    };
    dialog.showModal();
    input.select();
  });
}

const treeMenu = $('tree-menu');
const hideTreeMenu = () => {
  treeMenu.hidden = true;
};

/** Botão direito numa pasta (ou na área vazia da árvore, folder = ''). */
function openFolderMenu(e, folder) {
  e.preventDefault();
  e.stopPropagation();
  const inside = state.sessions.filter((s) => isUnder(s.folder, folder));
  const items = folder
    ? [...(inside.length ? [['connect-all', `Conectar todas (${inside.length})`]] : []), ['subfolder', 'Nova subpasta…'], ['session', 'Nova sessão aqui'], ['rename', 'Renomear…'], ['export', 'Exportar pasta…'], ['delete', 'Excluir pasta']]
    : [['subfolder', 'Nova pasta…'], ['session', 'Nova sessão na raiz'], ['export', 'Exportar sessões…']];
  treeMenu.replaceChildren(...items.map(([action, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideTreeMenu();
      folderAction(action, folder);
    });
    return b;
  }));
  treeMenu.hidden = false;
  treeMenu.style.left = `${Math.min(e.clientX, window.innerWidth - treeMenu.offsetWidth - 8)}px`;
  treeMenu.style.top = `${Math.min(e.clientY, window.innerHeight - treeMenu.offsetHeight - 8)}px`;
}

$('tree').addEventListener('contextmenu', (e) => {
  if (!e.target.closest('li')) openFolderMenu(e, '');
});
document.addEventListener('click', hideTreeMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideTreeMenu();
    clearMulti();
  }
});
window.addEventListener('blur', hideTreeMenu);

function expandFolder(path) {
  for (let p = path; p; p = parentOf(p)) state.collapsed.delete(p);
  writeCollapsed();
}

async function folderAction(action, folder) {
  if (action === 'connect-all') {
    const inside = state.sessions.filter((s) => isUnder(s.folder, folder));
    if (inside.length > 10 && !confirm(`Conectar as ${inside.length} sessões de "${folder}"?`)) return;
    await connectMany(inside.sort((a, b) => collator.compare(a.folder ?? '', b.folder ?? '') || collator.compare(a.name, b.name)));
    return;
  }
  showEditor();
  clearMessages();

  if (action === 'session') {
    state.selected = state.editing = null;
    renderTree();
    showForm(null);
    form.folder.value = folder;
    form.name.focus();
    return;
  }

  if (action === 'export') {
    await exportSessions(folder);
    return;
  }

  if (action === 'subfolder') {
    const name = await askName(folder ? `Nova subpasta em "${folder}"` : 'Nova pasta', 'Nome da pasta');
    if (!name) return;
    const path = joinFolder(folder, name);
    if (folderExists(path)) {
      message(`A pasta "${path}" já existe.`, 'warn');
      return;
    }
    pendingFolders.add(path);
    expandFolder(folder);
    renderTree();
    message(`Pasta "${path}" criada. Ela é gravada no arquivo quando você salvar uma sessão dentro dela (botão direito → Nova sessão aqui).`);
    return;
  }

  if (action === 'rename') {
    const oldName = folder.split('/').pop();
    const name = await askName(`Renomear "${folder}"`, 'Novo nome', oldName);
    if (!name || name === oldName) return;
    const target = joinFolder(parentOf(folder), name);
    if (folderExists(target)) {
      message(`Já existe a pasta "${target}"; escolha outro nome.`, 'error');
      return;
    }
    const move = (f) => (isUnder(f, folder) ? target + f.slice(folder.length) : f);
    const affected = state.sessions.filter((s) => isUnder(s.folder, folder)).length;
    try {
      if (affected) apply(await api.save(state.sessions.map((s) => ({ ...s, folder: move(s.folder) }))));
    } catch (err) {
      message(cleanError(err), 'error');
      return;
    }
    for (const p of [...pendingFolders]) {
      if (isUnder(p, folder)) {
        pendingFolders.delete(p);
        pendingFolders.add(move(p));
      }
    }
    for (const c of [...state.collapsed]) {
      if (isUnder(c, folder)) {
        state.collapsed.delete(c);
        state.collapsed.add(move(c));
      }
    }
    writeCollapsed();
    renderTree();
    message(`Pasta renomeada para "${target}" (${affected} sessão(ões) movida(s)).`);
    return;
  }

  if (action === 'delete') {
    const count = state.sessions.filter((s) => isUnder(s.folder, folder)).length;
    if (count) {
      message(`A pasta "${folder}" tem ${count} sessão(ões). Mova ou exclua as sessões antes de excluir a pasta.`, 'error');
      return;
    }
    for (const p of [...pendingFolders]) if (isUnder(p, folder)) pendingFolders.delete(p);
    renderTree();
    message(`Pasta "${folder}" excluída.`);
  }
}

// ---------- sessões: menu de contexto ----------

/** Liga a máquina da sessão por Wake-on-LAN (broadcast local). */
async function wakeSession(session) {
  showEditor();
  clearMessages();
  try {
    const sent = await api.wol({ mac: session.mac });
    message(`Pacote Wake-on-LAN enviado para ${session.name} (${sent.mac}, ${sent.address}:${sent.port}).`);
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

/** Seleção múltipla: o menu age sobre todas as sessões marcadas. */
function openMultiMenu(e) {
  const chosen = treeOrder.filter((k) => state.multi.has(k)).map((k) => state.sessions.find((s) => keyOf(s) === k)).filter(Boolean);
  showTreeMenu(e, [
    ['connect-selected', `Conectar as ${chosen.length} selecionadas`, () => connectMany(chosen)],
    ['clear-selection', 'Limpar seleção', clearMulti],
  ]);
}

function openSessionMenu(e, session) {
  if (state.multi.size > 1 && state.multi.has(keyOf(session))) {
    openMultiMenu(e);
    return;
  }
  clearMulti();
  const items = [
    ['connect', 'Conectar', () => connect(session)],
    ...(session.type === 'ssh' ? [['external', 'Janela externa', () => connect(session, { external: true })]] : []),
    ...(session.mac ? [['wol', 'Ligar (Wake-on-LAN)', () => wakeSession(session)]] : []),
    ['ping', 'Ping…', () => openDiagDialog('ping', session.host)],
    ['traceroute', 'Traceroute…', () => openDiagDialog('traceroute', session.host)],
    ['portscan', 'Scanner de portas', () => openToolTab('portscan', session)],
    ['snmp', 'Consulta SNMP', () => openToolTab('snmp', session)],
    ['edit', 'Editar', () => select(keyOf(session))],
  ];
  showTreeMenu(e, items);
}

/** Mostra o menu de contexto da árvore com itens [ação, rótulo, função]. */
function showTreeMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  treeMenu.replaceChildren(...items.map(([action, label, run]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideTreeMenu();
      run();
    });
    return b;
  }));
  treeMenu.hidden = false;
  treeMenu.style.left = `${Math.min(e.clientX, window.innerWidth - treeMenu.offsetWidth - 8)}px`;
  treeMenu.style.top = `${Math.min(e.clientY, window.innerHeight - treeMenu.offsetHeight - 8)}px`;
}

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

function openToolTab(kind, target) {
  // Uma aba de VPN e uma de servidores (o estado é único).
  if (kind === 'vpn' || kind === 'servers' || kind === 'agent') for (const t of tabsById.values()) if (t.kind === kind) closeTab(t);
  const tab = createTab({ title: TOOL_TITLES[kind], panelClass: 'tool-panel' });
  tab.kind = kind;
  const session = selectedSession();
  const host = target?.host ?? session?.host;
  const ctx = {
    api, cleanError, host, network: target?.network ?? guessNetwork(host), newSession: newSessionFrom,
    mac: target?.mac ?? session?.mac, sessions: state.sessions, openTool: openToolTab, openLocal: openLocalTab,
    terminalTabs: () => [...tabsById.values()].filter((t) => t.term).map((t) => ({ id: t.id, title: t.title, detail: t.tooltip || undefined })),
    vpnSite: target?.vpnSite ?? session?.vpn, vpnNotice: target?.vpnNotice, vpnThen: target?.vpnThen,
  };
  const hooks = buildToolPanel(kind, ctx, tab);
  Object.assign(tab, {
    onResult: hooks.onResult, onProgress: hooks.onProgress, onClose: hooks.onClose, onShow: hooks.focus, onVpnStatus: hooks.onVpnStatus, onServersEvent: hooks.onServersEvent, onAgentEvent: hooks.onAgentEvent, onTabsChanged: hooks.onTabsChanged,
  });
  showTab(tab);
}

// Indicador da VPN na barra superior (clique abre a aba da VPN).
let vpnStatus = null;
function renderVpnIndicator() {
  const btn = $('vpn-indicator');
  const on = vpnStatus && vpnStatus.state !== 'off';
  btn.hidden = !on;
  if (!on) return;
  btn.className = `vpn-indicator vpn-${vpnStatus.state}`;
  btn.textContent = `VPN: ${vpnStatus.site}`;
  btn.title = vpnStatus.state === 'connected' ? 'VPN conectada' : 'VPN conectando…';
}
api.onVpnStatus((s) => {
  vpnStatus = s;
  renderVpnIndicator();
  for (const t of tabsById.values()) t.onVpnStatus?.(s);
});
$('vpn-indicator').addEventListener('click', () => openToolTab('vpn'));
api.onServersEvent((ev) => {
  for (const t of tabsById.values()) t.onServersEvent?.(ev);
});

// Agente MCP: indicador no botão e marca nas abas compartilhadas.
function renderAgent(s) {
  $('agent-badge').hidden = !s.enabled;
  const modes = new Map((s.shares ?? []).map((x) => [x.tab, x.mode]));
  for (const t of tabsById.values()) {
    if (!t.term) continue;
    t.agentMode = modes.get(t.id) ?? 'off';
    t.button.classList.toggle('agent-shared', t.agentMode !== 'off');
    t.button.classList.toggle('agent-control', t.agentMode === 'approve' || t.agentMode === 'auto');
    t.button.title = t.agentMode === 'off' ? t.tooltip : `${t.tooltip ? `${t.tooltip} · ` : ''}compartilhada com o agente (${{ read: 'somente leitura', approve: 'aprovar cada envio', auto: 'controle livre' }[t.agentMode]})`;
  }
}
api.onAgentEvent((ev) => {
  renderAgent(ev);
  for (const t of tabsById.values()) t.onAgentEvent?.(ev);
});
$('btn-agent').addEventListener('click', () => openToolTab('agent'));
api.agentStatus().then(renderAgent, () => {});
api.vpnInfo().then((info) => {
  vpnStatus = info.status ?? null;
  renderVpnIndicator();
  // Sugestões do campo VPN do formulário: os sites de VPN.
  $('vpn-sites').replaceChildren(...info.sites.map((s) => Object.assign(document.createElement('option'), { value: s.name })));
}, () => {});

api.onToolResult((id, result) => tabsById.get(id)?.onResult?.(result));
api.onToolProgress((id, done, total) => tabsById.get(id)?.onProgress?.(done, total));

// Ping/traceroute: pergunta o host e roda num terminal embutido.
const diagDialog = $('diag-dialog');
const diagForm = $('diag-form');
let diagKind = 'ping';

function openDiagDialog(kind, host) {
  diagKind = kind;
  $('diag-title').textContent = kind === 'ping' ? 'Ping' : 'Traceroute';
  $('diag-count-label').hidden = kind !== 'ping';
  diagForm.host.value = host ?? selectedSession()?.host ?? diagForm.host.value;
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
    spec: { type: 'diag', req },
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
  else if (kind.startsWith('local-')) openLocalTab(kind.slice(6));
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

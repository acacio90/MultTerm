import { buildToolPanel, TOOL_TITLES } from './tools.js';

// Interface: árvore de sessões + formulário de edição + abas de terminal.
const api = window.multterm;
const $ = (id) => document.getElementById(id);
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const DEFAULT_PORTS = { ssh: 22, rdp: 3389 };

const state = {
  path: '',
  sessions: [],
  defaults: {}, // padrões do arquivo (chave SSH padrão)
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
  form.legacyTls.checked = session?.legacyTls === true;
  form.legacySsh.checked = session?.legacySsh === true;
  form.multimon.checked = session?.multimon === true;
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
  for (const el of form.querySelectorAll('.rdp-only')) el.hidden = type !== 'rdp';
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
  if (form.type.value === 'rdp' && form.legacyTls.checked) session.legacyTls = true;
  if (form.type.value === 'ssh' && form.legacySsh.checked) session.legacySsh = true;
  if (form.type.value === 'rdp' && form.multimon.checked) session.multimon = true;
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
  state.defaults = snapshot.defaults ?? {};
  form.identityFile.placeholder = state.defaults.identityFile
    ? `vazio = chave padrão (${state.defaults.identityFile})`
    : '~/.ssh/id_ed25519 (vazio = agente SSH)';
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

/**
 * Confirmação do MultTerm (no lugar do confirm do navegador): título, texto, lista de itens e um
 * botão de ação em vermelho. O foco começa em Cancelar, para Enter não confirmar por engano.
 */
function askConfirm({ title, text, items = [], note = '', confirmLabel = 'Excluir' }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  const parts = [Object.assign(document.createElement('p'), { textContent: text })];
  if (items.length) {
    const ul = document.createElement('ul');
    const shown = items.slice(0, 12);
    for (const it of shown) ul.append(Object.assign(document.createElement('li'), { textContent: it }));
    if (items.length > shown.length) ul.append(Object.assign(document.createElement('li'), { textContent: `… e mais ${items.length - shown.length}` }));
    parts.push(ul);
  }
  if (note) parts.push(Object.assign(document.createElement('p'), { className: 'muted', textContent: note }));
  $('confirm-body').replaceChildren(...parts);
  $('confirm-ok').textContent = confirmLabel;
  return new Promise((resolve) => {
    const done = (ok) => {
      $('confirm-form').onsubmit = null;
      $('confirm-cancel').onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(ok);
    };
    $('confirm-form').onsubmit = (e) => {
      e.preventDefault();
      done(true);
    };
    $('confirm-cancel').onclick = () => done(false);
    dialog.oncancel = (e) => {
      e.preventDefault();
      done(false);
    };
    dialog.showModal();
    $('confirm-cancel').focus();
  });
}

/** Abas abertas de uma sessão (terminal SSH ou RDP). */
function tabsOfSession(session) {
  const key = keyOf(session);
  return [...tabsById.values()].filter((t) => {
    const s = t.spec?.type === 'ssh' ? t.spec.session : t.kind === 'rdp' ? t.session : null;
    return s && keyOf(s) === key;
  });
}

/** Exclui sessões do arquivo depois de confirmar (uma ou várias). As abas abertas continuam. */
async function deleteSessions(sessions) {
  if (!sessions.length) return;
  const one = sessions.length === 1;
  const describe = (s) => `${s.name} — ${s.folder ? `${s.folder} · ` : ''}${s.type.toUpperCase()} ${s.host}`;
  const withTabs = sessions.filter((s) => tabsOfSession(s).length);
  const ok = await askConfirm({
    title: one ? 'Excluir sessão' : `Excluir ${sessions.length} sessões`,
    text: one ? 'A sessão abaixo será removida do arquivo de sessões:' : 'As sessões abaixo serão removidas do arquivo de sessões:',
    items: sessions.map(describe),
    note: withTabs.length
      ? `${withTabs.length === 1 ? 'Há uma aba aberta' : `Há abas abertas de ${withTabs.length} delas`}: as abas continuam abertas; só a sessão sai do arquivo.`
      : '',
  });
  if (!ok) return;
  showEditor();
  clearMessages();
  const gone = new Set(sessions.map(keyOf));
  try {
    apply(await api.save(state.sessions.filter((s) => !gone.has(keyOf(s)))));
    state.multi.clear();
    renderTree();
    message(one ? `Sessão "${sessions[0].name}" excluída.` : `${sessions.length} sessões excluídas.`);
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

async function remove() {
  const session = state.sessions.find((s) => keyOf(s) === state.editing);
  if (session) await deleteSessions([session]);
}

/**
 * SSH abre numa aba de terminal embutido; RDP numa aba, ou fora do app ("Janela externa" e
 * "Abrir em todos os monitores", que usam o cliente do Windows).
 */
async function connect(session, { external = false, multimon = session.type === 'rdp' && session.multimon === true } = {}) {
  // Sessão atrás de uma VPN: conecta a VPN primeiro e depois abre a sessão.
  if (session.vpn && !(vpnStatus?.site === session.vpn && vpnStatus.state === 'connected')) {
    openToolTab('vpn', {
      vpnSite: session.vpn,
      vpnNotice: `A sessão "${session.name}" usa a VPN "${session.vpn}". Ela abre assim que a VPN conectar.`,
      vpnThen: () => connect(session, { external, multimon }),
    });
    return;
  }
  if (session.type === 'ssh' && !external) {
    await openSessionTab(session);
    return;
  }
  if (multimon) {
    // A conexão nova assumiria a sessão remota da aba: fecha a aba antes.
    for (const tab of tabsOfSession(session)) if (tab.kind === 'rdp') closeTab(tab);
  }
  if (session.type === 'rdp' && !external && !multimon && await api.rdpAvailable()) {
    await openRdpTab(session);
    return;
  }
  showEditor();
  clearMessages();
  try {
    const { warnings } = await api.connect(session, session.type === 'rdp' ? { multimon } : undefined);
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

/*
 * Layout da área de abas: uma aba, duas lado a lado ou duas empilhadas. Na tela dividida cada
 * metade mostra uma aba e só muda de aba de propósito: arrastando a aba para a metade, pelo menu
 * de contexto da aba ou, ao clicar numa aba fora de vista com as duas metades ocupadas, escolhendo
 * a metade num menu. Clicar dentro de uma metade passa o foco para ela.
 */
const LAYOUTS = ['single', 'cols', 'rows'];
let layout = readLayout();
let panes = [null, null]; // id da aba em cada metade
let focusedPane = 0;
const paneCount = () => (layout === 'single' ? 1 : 2);
const paneName = (i) => (layout === 'rows' ? ['de cima', 'de baixo'] : ['esquerda', 'direita'])[i];
/** Primeira metade sem aba (começando pela em foco), ou -1. */
const emptyPane = () => [focusedPane, 1 - focusedPane].find((i) => i < paneCount() && !tabsById.has(panes[i])) ?? -1;

function readLayout() {
  try {
    const saved = localStorage.getItem('tabLayout');
    return LAYOUTS.includes(saved) ? saved : 'single';
  } catch {
    return 'single';
  }
}

/** Mostra as abas das metades (na ordem certa), o destaque da metade em foco e as metades vazias. */
function renderPanes() {
  const n = paneCount();
  const visible = panes.slice(0, n);
  const area = $('terminals');
  area.classList.toggle('layout-cols', layout === 'cols');
  area.classList.toggle('layout-rows', layout === 'rows');
  for (const t of tabsById.values()) {
    const at = visible.indexOf(t.id);
    t.panel.hidden = at < 0;
    t.panel.style.order = at < 0 ? '' : String(at);
    t.panel.classList.toggle('pane-focus', n > 1 && at === focusedPane);
    t.button.classList.toggle('active', activeTab !== null && at === focusedPane);
    t.button.classList.toggle('in-pane', n > 1 && at >= 0 && at !== focusedPane);
  }
  for (let i = 0; i < 2; i++) {
    let empty = document.getElementById(`pane-empty-${i}`);
    const needed = n > 1 && i < n && !tabsById.has(visible[i]);
    if (!needed) {
      empty?.remove();
      continue;
    }
    if (!empty) {
      empty = Object.assign(document.createElement('div'), { id: `pane-empty-${i}`, className: 'pane-empty' });
      empty.textContent = 'Arraste uma aba para cá ou clique numa aba.';
      empty.addEventListener('mousedown', () => {
        focusedPane = i;
        renderPanes();
      });
      area.append(empty);
    }
    empty.style.order = String(i);
    empty.classList.toggle('pane-focus', i === focusedPane);
  }
  for (const b of document.querySelectorAll('#layout-picker [data-layout]')) {
    b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
  }
}

function setLayout(next) {
  if (!LAYOUTS.includes(next)) return;
  layout = next;
  try {
    localStorage.setItem('tabLayout', layout);
  } catch {
    // sem armazenamento: o layout vale só até fechar
  }
  if (paneCount() === 1) {
    panes = [panes[focusedPane] ?? panes[0], null];
    focusedPane = 0;
  } else if (!tabsById.has(panes[1]) || panes[1] === panes[0]) {
    // A segunda metade começa com a aba aberta mais recente que não está na primeira.
    const other = [...tabsById.values()].reverse().find((t) => t.id !== panes[0]);
    panes[1] = other?.id ?? null;
  }
  const focused = tabsById.get(panes[focusedPane]);
  if (activeTab && focused) showTab(focused);
  else renderPanes();
}

function showEditor() {
  activeTab = null;
  $('tab-editor').classList.add('active');
  $('panel-editor').hidden = false;
  $('terminals').hidden = true;
  for (const t of tabsById.values()) {
    t.button.classList.remove('active', 'in-pane');
    t.panel.hidden = true;
  }
}

/**
 * Mostra a aba. Já está numa metade: ela ganha o foco. Senão, entra numa metade vazia ou, sem
 * nenhuma, na metade em foco (abas novas; o clique na barra passa por clickTab).
 */
function showTab(tab) {
  const at = panes.slice(0, paneCount()).indexOf(tab.id);
  if (at >= 0) focusedPane = at;
  else {
    if (emptyPane() >= 0) focusedPane = emptyPane();
    panes[focusedPane] = tab.id;
  }
  activeTab = tab;
  $('tab-editor').classList.remove('active');
  $('panel-editor').hidden = true;
  $('terminals').hidden = false;
  renderPanes();
  requestAnimationFrame(() => {
    for (const id of panes.slice(0, paneCount())) {
      const t = tabsById.get(id);
      if (t?.term) t.fit.fit();
      else t?.onShow?.();
    }
    if (tab.term) tab.term.focus();
  });
}

/** Coloca a aba na metade `pane`; se ela estava na outra metade, as duas trocam de lugar. */
function showTabIn(tab, pane) {
  const from = panes.slice(0, paneCount()).indexOf(tab.id);
  if (from >= 0 && from !== pane) panes[from] = panes[pane];
  panes[pane] = tab.id;
  showTab(tab);
}

/** Clique na aba: com as duas metades ocupadas por outras abas, pergunta em qual mostrar. */
function clickTab(tab) {
  const shown = panes.slice(0, paneCount());
  if (paneCount() === 1 || shown.includes(tab.id) || emptyPane() >= 0) {
    showTab(tab);
    return;
  }
  const r = tab.button.getBoundingClientRect();
  showMenu(r.left, r.bottom, paneItems(tab));
}

/** Itens "Mostrar na metade X" (dizendo qual aba sai de lá). */
function paneItems(tab) {
  return [0, 1].map((i) => {
    const there = tabsById.get(panes[i]);
    const label = `Mostrar na metade ${paneName(i)}${there && there !== tab ? ` (no lugar de ${there.title})` : ''}`;
    return Object.assign(menuItem(label, () => showTabIn(tab, i)), { disabled: there === tab });
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
  // A metade da aba fechada passa a mostrar outra aba aberta que não esteja à vista.
  const at = panes.indexOf(tab.id);
  if (at >= 0) {
    const shown = new Set(panes.slice(0, paneCount()));
    panes[at] = [...tabsById.values()].reverse().find((t) => !shown.has(t.id))?.id ?? null;
  }
  if (activeTab === tab) {
    const next = tabsById.get(panes[focusedPane]) ?? panes.slice(0, paneCount()).map((id) => tabsById.get(id)).find(Boolean);
    if (next) showTab(next);
    else if (api.isDetached) api.closeWindowNow(); // janela destacada sem abas: fecha
    else showEditor();
  } else if (at >= 0) {
    renderPanes();
  }
}

/** Cria e registra uma aba (botão + painel) de qualquer tipo. */
function createTab({ title, tooltip = '', panelClass }) {
  const tab = { id: ++tabSeq, title, tooltip };
  tab.panel = document.createElement('div');
  tab.panel.className = `panel ${panelClass}`;
  $('terminals').append(tab.panel);
  // Clicar dentro de uma metade da tela dividida passa o foco para ela.
  tab.panel.addEventListener('mousedown', () => {
    const at = panes.slice(0, paneCount()).indexOf(tab.id);
    if (paneCount() > 1 && at >= 0 && (at !== focusedPane || activeTab !== tab)) {
      focusedPane = at;
      activeTab = tab;
      renderPanes();
    }
  });

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
  tab.button.addEventListener('click', (e) => (e.target === close ? closeTab(tab) : clickTab(tab)));
  tab.button.addEventListener('auxclick', (e) => {
    if (e.button === 1) closeTab(tab); // botão do meio fecha, como no navegador
  });
  tab.button.dataset.tabId = String(tab.id);
  tab.button.draggable = true;
  tab.button.addEventListener('dragstart', (e) => {
    draggedTab = tab;
    tab.button.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Tipo próprio, não texto: um campo de texto (como o do terminal) aceitaria a aba e digitaria
    // o título dela no shell; assim, soltar fora da barra fica sem destino e a aba é destacada.
    e.dataTransfer.setData('application/x-multterm-tab', String(tab.id));
  });
  tab.button.addEventListener('dragend', (e) => {
    draggedTab = null;
    tab.button.classList.remove('dragging');
    clearDropMarks();
    // Solta fora da barra de abas (e de qualquer área que aceite a aba): vai para uma janela própria.
    if (e.dataTransfer.dropEffect === 'none' && tab.term && droppedAwayFromTabBar(e)) {
      api.termDetach(tab.id, { ...tabMeta(tab), position: { x: e.screenX, y: e.screenY } })
        .catch((err) => tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`));
    }
  });
  tab.button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTabMenu(e, tab);
  });
  $('tabs').append(tab.button);
  tabsById.set(tab.id, tab);
  setTimeout(notifyTabsChanged, 0); // depois que a aba de terminal ganha o term
  return tab;
}

// ---------- ordem das abas ----------

/*
 * A ordem das abas é a dos botões na barra. O mapa tabsById é refeito na mesma ordem a cada
 * mudança, então tudo que percorre as abas (próxima ao fechar, tela dividida, lista do agente)
 * segue a ordem que o usuário vê. A aba "Sessão" fica sempre no início.
 */
let draggedTab = null;
const orderedTabs = () => [...tabsById.values()];

function moveTab(tab, index) {
  const order = orderedTabs().filter((t) => t !== tab);
  const to = Math.max(0, Math.min(order.length, index));
  if (orderedTabs().indexOf(tab) === to) return;
  order.splice(to, 0, tab);
  for (const t of order) $('tabs').append(t.button);
  tabsById.clear();
  for (const t of order) tabsById.set(t.id, t);
  notifyTabsChanged();
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** A aba foi solta longe da barra de abas (com uma margem, para não destacar sem querer)? */
function droppedAwayFromTabBar(e) {
  if (!e.screenX && !e.screenY && !e.clientX && !e.clientY) return false; // posição desconhecida
  const r = document.querySelector('.tabbar').getBoundingClientRect();
  const margin = 40;
  const inside = e.clientX >= r.left - margin && e.clientX <= r.right + margin
    && e.clientY >= r.top - margin && e.clientY <= r.bottom + margin;
  return !inside;
}

function clearDropMarks() {
  for (const b of document.querySelectorAll('.drop-before, .drop-after, .drop-pane')) b.classList.remove('drop-before', 'drop-after', 'drop-pane');
}

/** A metade da tela dividida sob o ponteiro (o elemento e o índice), ou null. */
function paneAt(e) {
  const el = e.target.closest?.('.terminals > .panel:not([hidden]), .terminals > .pane-empty');
  return el && paneCount() > 1 ? { el, index: Number(el.style.order) } : null;
}

/** Onde a aba arrastada cairia: antes ou depois da aba sob o ponteiro. */
function dropTarget(e) {
  const over = e.target.closest?.('.tab[data-tab-id]');
  if (!over) return null;
  const r = over.getBoundingClientRect();
  return { over, after: e.clientX > r.left + r.width / 2 };
}

$('tabs').addEventListener('dragover', (e) => {
  if (!draggedTab) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  const target = dropTarget(e);
  if (target && target.over !== draggedTab.button) target.over.classList.add(target.after ? 'drop-after' : 'drop-before');
});
$('tabs').addEventListener('dragleave', (e) => {
  if (!$('tabs').contains(e.relatedTarget)) clearDropMarks();
});
$('tabs').addEventListener('drop', (e) => {
  if (!draggedTab) return;
  e.preventDefault();
  const tab = draggedTab;
  clearDropMarks();
  const target = dropTarget(e);
  const order = orderedTabs().filter((t) => t !== tab);
  let index;
  if (!target) index = e.target.closest?.('#tab-editor') ? 0 : order.length; // solto no início ou no vazio
  else {
    const over = tabsById.get(Number(target.over.dataset.tabId));
    if (over === tab) return;
    index = order.indexOf(over) + (target.after ? 1 : 0);
  }
  moveTab(tab, index);
});

// Soltar a aba numa metade da tela dividida a mostra lá (em vez de destacá-la em outra janela).
$('terminals').addEventListener('dragover', (e) => {
  const pane = draggedTab && paneAt(e);
  if (!pane) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!pane.el.classList.contains('drop-pane')) {
    clearDropMarks();
    pane.el.classList.add('drop-pane');
  }
});
$('terminals').addEventListener('dragleave', (e) => {
  if (!$('terminals').contains(e.relatedTarget)) clearDropMarks();
});
$('terminals').addEventListener('drop', (e) => {
  const pane = draggedTab && paneAt(e);
  if (!pane) return;
  e.preventDefault();
  clearDropMarks();
  showTabIn(draggedTab, pane.index);
});

// Ctrl+Shift+PageUp/PageDown move a aba ativa (como no Windows Terminal).
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || !activeTab || (e.code !== 'PageUp' && e.code !== 'PageDown')) return;
  e.preventDefault();
  const at = orderedTabs().indexOf(activeTab);
  moveTab(activeTab, at + (e.code === 'PageUp' ? -1 : 1));
});

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
    if (e.code === 'PageUp' || e.code === 'PageDown') return false; // mover a aba (atalho da página)
    return true;
  });
  new ResizeObserver(() => {
    if (!tab.panel.hidden) tab.fit.fit();
  }).observe(tab.host);

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

// Menus das abas (contexto e escolha da metade): um aberto por vez, fecha ao clicar fora.
let tabMenu = null;
function closeMenu() {
  tabMenu?.remove();
  tabMenu = null;
}

function menuItem(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.textContent = label;
  b.addEventListener('click', () => {
    closeMenu();
    fn();
  });
  return b;
}

function showMenu(x, y, nodes) {
  closeMenu();
  tabMenu = document.createElement('div');
  tabMenu.className = 'menu tab-menu';
  tabMenu.setAttribute('role', 'menu');
  tabMenu.append(...nodes);
  tabMenu.style.left = `${x}px`;
  tabMenu.style.top = `${y}px`;
  document.body.append(tabMenu);
  const menu = tabMenu;
  const away = (ev) => {
    if (tabMenu === menu && menu.contains(ev.target)) return;
    if (tabMenu === menu) closeMenu();
    document.removeEventListener('mousedown', away, true);
  };
  document.addEventListener('mousedown', away, true);
}

// Menu de contexto da aba: ordem, metade da tela dividida, janela própria e fechar.
function openTabMenu(e, tab) {
  const order = orderedTabs();
  const at = order.indexOf(tab);
  const moveItem = (label, enabled, fn) => Object.assign(menuItem(label, fn), { disabled: !enabled });
  const nodes = [
    moveItem('Mover para a esquerda', at > 0, () => moveTab(tab, at - 1)),
    moveItem('Mover para a direita', at < order.length - 1, () => moveTab(tab, at + 1)),
    moveItem('Mover para o início', at > 0, () => moveTab(tab, 0)),
    moveItem('Mover para o fim', at < order.length - 1, () => moveTab(tab, order.length - 1)),
    document.createElement('hr'),
  ];
  if (paneCount() > 1) nodes.push(...paneItems(tab), document.createElement('hr'));
  // Só abas de terminal mudam de janela.
  if (tab.term) {
    nodes.push(api.isDetached
      ? menuItem('Devolver à janela principal', () => api.termReattach(tab.id, tabMeta(tab)).catch((err) => tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`)))
      : menuItem('Abrir em janela separada', () => api.termDetach(tab.id, tabMeta(tab)).catch((err) => tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`))));
  }
  if (tab.kind === 'rdp') {
    nodes.push(
      // Pelo teclado, Ctrl+Alt+Del fica no Windows local.
      Object.assign(menuItem('Enviar Ctrl+Alt+Del', () => sendCtrlAltDel(tab)), { disabled: !tab.running }),
      menuItem('Abrir em todos os monitores', () => connect(tab.session, { multimon: true })),
      document.createElement('hr'),
    );
  }
  nodes.push(menuItem('Fechar aba', () => closeTab(tab)));
  showMenu(e.clientX, e.clientY, nodes);
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

// Fechar a janela destacada (X, Alt+F4) devolve as abas de terminal à janela principal, sem
// reiniciar as sessões; as outras abas só fecham. A janela fecha quando a última aba sai.
let returningTabs = false;
api.onReturnTabs(() => {
  if (returningTabs) return;
  returningTabs = true;
  for (const t of [...tabsById.values()]) {
    if (t.term) {
      api.termReattach(t.id, tabMeta(t)).catch(() => closeTab(t));
    } else {
      closeTab(t);
    }
  }
  if (!tabsById.size) api.closeWindowNow();
  // Se alguma aba não for adotada a tempo, fecha mesmo assim (não deixa a janela presa).
  setTimeout(() => api.closeWindowNow(), 5000);
});

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

// ---------- RDP numa aba ----------

/** Menus e diálogos abertos sobre a área (a janela nativa do RDP ficaria por cima deles). */
function coversRect(r) {
  for (const el of document.querySelectorAll('.menu:not([hidden]), .tab-menu, dialog[open]')) {
    const o = el.getBoundingClientRect();
    if (o.width && o.height && o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top) return true;
  }
  return false;
}

/** Área da aba em pixels físicos, e se a sessão deve aparecer. */
function rdpView(tab) {
  const r = tab.screen.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const visible = !tab.panel.hidden && !$('terminals').hidden && r.width > 0 && r.height > 0 && !coversRect(r);
  return { x: r.left * dpr, y: r.top * dpr, width: r.width * dpr, height: r.height * dpr, visible };
}

function rdpStatus(tab, text, { error = '', log = '', actions = [] } = {}) {
  const p = document.createElement('p');
  p.textContent = text;
  const parts = [p];
  if (error) parts.push(Object.assign(document.createElement('p'), { className: 'rdp-error', textContent: error }));
  if (log) {
    const details = document.createElement('details');
    details.append(
      Object.assign(document.createElement('summary'), { textContent: 'Detalhes técnicos' }),
      Object.assign(document.createElement('pre'), { textContent: log }),
    );
    parts.push(details);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    for (const [label, fn, primary] of actions) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: primary ? 'primary' : '' });
      b.addEventListener('click', fn);
      row.append(b);
    }
    parts.push(row);
  }
  tab.status.replaceChildren(...parts);
}

/** Usuário e senha da sessão RDP (a senha não é gravada). Devolve null se cancelar. */
function askRdpCredentials(session, user) {
  const dialog = $('rdp-auth-dialog');
  const authForm = $('rdp-auth-form');
  $('rdp-auth-title').textContent = `Conectar a ${session.name}`;
  authForm.rdpUser.value = user ?? session.user ?? '';
  authForm.rdpPassword.value = '';
  return new Promise((resolve) => {
    const done = (result) => {
      authForm.onsubmit = null;
      $('rdp-auth-cancel').onclick = null;
      dialog.oncancel = null;
      authForm.rdpPassword.value = '';
      dialog.close();
      resolve(result);
    };
    authForm.onsubmit = (e) => {
      e.preventDefault();
      done({ user: authForm.rdpUser.value.trim(), password: authForm.rdpPassword.value });
    };
    $('rdp-auth-cancel').onclick = () => done(null);
    dialog.oncancel = (e) => {
      e.preventDefault();
      done(null);
    };
    dialog.showModal();
    (authForm.rdpUser.value ? authForm.rdpPassword : authForm.rdpUser).focus();
  });
}

async function startRdp(tab) {
  // Senha pedida pelo MultTerm (fica só na memória da aba, para reconectar sem digitar de novo).
  if (!tab.credentials) {
    const credentials = await askRdpCredentials(tab.session, tab.lastUser);
    if (!credentials) {
      endRdp(tab, { normal: false, message: 'conexão cancelada' });
      return;
    }
    tab.credentials = credentials;
    tab.lastUser = credentials.user;
  }
  tab.running = true;
  tab.lastView = '';
  tab.button.classList.remove('ended');
  rdpStatus(tab, `Conectando a ${tab.session.host}…`);
  await new Promise(requestAnimationFrame); // espera o layout da aba
  try {
    await api.rdpOpen(tab.id, tab.session, rdpView(tab), tab.credentials);
  } catch (err) {
    endRdp(tab, { normal: false, message: cleanError(err) });
  }
}

/** `end`: { normal, message, log } vindo do processo principal (ou só a mensagem de um erro local). */
// Falhas de usuário/senha: a próxima tentativa pede a senha de novo.
const RDP_AUTH_ERRORS = new Set([0x20009, 0x20014, 0x20015, 0x2001b]);

function endRdp(tab, end) {
  tab.running = false;
  tab.button.classList.add('ended');
  if (RDP_AUTH_ERRORS.has(end.code)) tab.credentials = null;
  // ERRCONNECT_TLS_CONNECT_FAILED: em geral, servidor que só fala TLS 1.0.
  const tlsFailed = end.code === 0x20008 && !tab.session.legacyTls;
  rdpStatus(tab, 'Sessão RDP encerrada.', {
    error: end.normal ? '' : end.message + (tlsFailed
      ? '. Servidores Windows antigos só aceitam TLS 1.0, que o MultTerm recusa por padrão; o cliente do Windows aceita.'
      : ''),
    log: end.normal ? '' : end.log,
    actions: [
      ...(tlsFailed ? [['Permitir TLS antigo nesta sessão e reconectar', () => allowLegacyTls(tab), true]] : []),
      ['Reconectar', () => startRdp(tab), !tlsFailed],
      ['Abrir no cliente do Windows', () => connect(tab.session, { external: true, multimon: false })],
    ],
  });
}

/** Grava uma opção numa sessão (só nela) e devolve a sessão atualizada. */
async function updateSession(session, patch) {
  const key = keyOf(session);
  const updated = { ...session, ...patch };
  apply(await api.save(state.sessions.map((s) => (keyOf(s) === key ? updated : s))));
  if (state.editing === key) showForm(updated);
  return updated;
}

/** Grava "aceitar TLS antigo" na sessão (só nela) e reconecta. */
async function allowLegacyTls(tab) {
  try {
    tab.session = await updateSession(tab.session, { legacyTls: true });
    await startRdp(tab);
  } catch (err) {
    rdpStatus(tab, 'Não foi possível gravar a sessão.', { error: cleanError(err) });
  }
}

/** Aba com a sessão RDP (cliente FreeRDP encaixado sobre a área da aba). */
async function openRdpTab(session) {
  const tab = createTab({ title: session.name, tooltip: `RDP ${session.user ? `${session.user}@` : ''}${session.host}`, panelClass: 'rdp-panel' });
  Object.assign(tab, { kind: 'rdp', session, running: false });
  tab.screen = document.createElement('div');
  tab.screen.className = 'rdp-screen';
  tab.status = document.createElement('div');
  tab.status.className = 'rdp-status';
  tab.screen.append(tab.status);
  tab.panel.append(tab.screen);
  // Avisa o processo principal da posição/visibilidade, no máximo uma vez por quadro e só se mudou.
  let frame = 0;
  tab.sync = () => {
    if (!tab.running || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!tab.running) return;
      const view = rdpView(tab);
      const key = JSON.stringify(view);
      if (key === tab.lastView) return;
      tab.lastView = key;
      api.rdpView(tab.id, view);
    });
  };
  new ResizeObserver(tab.sync).observe(tab.screen);
  tab.onShow = tab.sync;
  tab.onClose = () => {
    if (tab.running) void api.rdpClose(tab.id);
    tab.running = false;
    tab.credentials = null;
  };
  showTab(tab);
  await startRdp(tab);
  return tab;
}

/** Envia Ctrl+Alt+Del à sessão depois que o menu fecha e a sessão volta a aparecer. */
function sendCtrlAltDel(tab) {
  tab.sync();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (tab.running) void api.rdpCtrlAltDel(tab.id);
  }));
}

const rdpTabs = () => [...tabsById.values()].filter((t) => t.kind === 'rdp');
// Troca de aba, menus, diálogos, barra lateral redimensionada: reposiciona/esconde as sessões RDP.
new MutationObserver(() => {
  for (const t of rdpTabs()) t.sync();
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'class', 'style'] });
window.addEventListener('resize', () => {
  for (const t of rdpTabs()) t.sync();
});
api.onRdpReady((id) => tabsById.get(id)?.sync?.());
// Servidor sem ajuste de resolução: reconecta no tamanho novo da aba (a senha está na memória).
api.onRdpReconnectSize(async (id) => {
  const tab = tabsById.get(id);
  if (tab?.kind !== 'rdp' || !tab.running) return;
  tab.running = false;
  await api.rdpClose(tab.id);
  await startRdp(tab);
});
api.onRdpExit((id, code, end) => {
  const tab = tabsById.get(id);
  if (tab?.kind === 'rdp' && tab.running) endRdp(tab, { ...end, code });
});

// O ssh recusou os algoritmos do servidor (equipamento antigo): a aba oferece aceitar os antigos.
const SSH_NEGOTIATION_FAILED = /Unable to negotiate with .+?: no matching (key exchange method|host key type|cipher|MAC) found/;

api.onTermData((id, data) => {
  const tab = tabsById.get(id);
  if (!tab?.term) return;
  tab.term.write(data);
  if (tab.spec?.type === 'ssh' && !tab.spec.session.legacySsh) tab.tail = ((tab.tail ?? '') + data).slice(-4000);
});
api.onTermExit((id, code) => {
  const tab = tabsById.get(id);
  if (!tab?.running) return;
  markEnded(tab, code);
  if (tab.spec?.type === 'ssh' && SSH_NEGOTIATION_FAILED.test(tab.tail ?? '')) offerLegacySsh(tab);
  tab.tail = '';
});

/** Faixa na aba: o servidor só fala algoritmos antigos; um clique os permite nesta sessão. */
function offerLegacySsh(tab) {
  const text = document.createElement('span');
  text.textContent = 'O servidor só oferece algoritmos antigos (SHA-1, ssh-rsa, CBC), que o SSH recusa por padrão. Comum em switches e equipamentos antigos.';
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'primary';
  allow.textContent = 'Permitir algoritmos antigos nesta sessão e reconectar';
  allow.addEventListener('click', async () => {
    try {
      const session = await updateSession(tab.spec.session, { legacySsh: true });
      tab.spec = { ...tab.spec, session };
      tab.open = openFor(tab.spec);
      tab.notice.hidden = true;
      tab.term.writeln('');
      await startTab(tab);
    } catch (err) {
      tab.term.writeln(`\x1b[31m${cleanError(err)}\x1b[0m`);
    }
  });
  tab.notice.replaceChildren(text, allow);
  tab.notice.hidden = false;
}

$('tab-editor').addEventListener('click', showEditor);

$('layout-picker').addEventListener('click', (e) => {
  const next = e.target.closest('[data-layout]')?.dataset.layout;
  if (next) setLayout(next);
});
renderPanes();
$('terminals').hidden = true;

// ---------- barra de ferramentas ----------

function newSession() {
  state.selected = state.editing = null;
  clearMessages();
  renderTree();
  showEditor();
  showForm(null);
  form.name.focus();
}
$('btn-new').addEventListener('click', newSession);

async function importVpnSite() {
  showEditor();
  clearMessages();
  try {
    const site = await api.vpnImport();
    if (site) message(`Site de VPN "${site.name}" importado. Conecte pelo botão VPN, na barra superior.`);
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
    const origem = result.format === 'inventory' ? ' do inventário' : '';
    message(`${result.added} sessões importadas${origem}, ${result.skipped} já existiam.`);
    for (const w of result.warnings) message(w, 'warn');
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

/** Troca o arquivo de sessões em uso (ex.: um sessions.yaml versionado no git). */
async function chooseSessionsFile() {
  showEditor();
  clearMessages();
  try {
    const result = await api.chooseFile();
    if (result) apply(result);
  } catch (err) {
    message(cleanError(err), 'error');
  }
}

$('search').addEventListener('input', (e) => {
  state.filter = e.target.value.trim();
  renderTree();
});

form.addEventListener('submit', save);
form.type.addEventListener('change', updateTypeFields);
/** Botão "Procurar…" ao lado de um campo de chave: preenche com o arquivo escolhido. */
async function pickKeyInto(input) {
  try {
    const path = await api.chooseKeyFile(input.value || state.defaults?.identityFile || '');
    if (path) input.value = path;
  } catch (err) {
    message(cleanError(err), 'error');
  }
}
$('pick-key').addEventListener('click', () => pickKeyInto(form.identityFile));
$('key-pick').addEventListener('click', () => pickKeyInto($('key-form').defaultKey));

/** Chave SSH padrão: vale para as sessões SSH sem chave própria (gravada no arquivo de sessões). */
function editDefaultKey() {
  const dialog = $('key-dialog');
  const keyForm = $('key-form');
  keyForm.defaultKey.value = state.defaults?.identityFile ?? '';
  const done = () => {
    keyForm.onsubmit = null;
    $('key-cancel').onclick = null;
    dialog.close();
  };
  keyForm.onsubmit = async (e) => {
    e.preventDefault();
    done();
    showEditor();
    clearMessages();
    const identityFile = keyForm.defaultKey.value.trim();
    try {
      apply(await api.setDefaults(identityFile ? { identityFile } : {}));
      message(identityFile ? `Chave SSH padrão: ${identityFile}` : 'Sem chave SSH padrão: as sessões sem chave própria usam o agente SSH.');
    } catch (err) {
      message(cleanError(err), 'error');
    }
  };
  $('key-cancel').onclick = done;
  dialog.showModal();
}
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
    '-',
    ['delete-selected', `Excluir as ${chosen.length} selecionadas…`, () => deleteSessions(chosen)],
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
    ['external', session.type === 'rdp' ? 'Janela externa (cliente do Windows)' : 'Janela externa', () => connect(session, { external: true, multimon: false })],
    ...(session.type === 'rdp' ? [['multimon', 'Abrir em todos os monitores', () => connect(session, { multimon: true })]] : []),
    ...(session.mac ? [['wol', 'Ligar (Wake-on-LAN)', () => wakeSession(session)]] : []),
    ['ping', 'Ping…', () => openDiagDialog('ping', session.host)],
    ['traceroute', 'Traceroute…', () => openDiagDialog('traceroute', session.host)],
    ['portscan', 'Scanner de portas', () => openToolTab('portscan', session)],
    ['snmp', 'Consulta SNMP', () => openToolTab('snmp', session)],
    ['edit', 'Editar', () => select(keyOf(session))],
    '-',
    ['delete', 'Excluir…', () => deleteSessions([session])],
  ];
  showTreeMenu(e, items);
}

/** Mostra o menu de contexto da árvore com itens [ação, rótulo, função]. */
function showTreeMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  treeMenu.replaceChildren(...items.map((entry) => {
    if (entry === '-') return document.createElement('hr');
    const [action, label, run] = entry;
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

// Botão da VPN na barra superior: abre a aba da VPN e mostra o estado (site e ponto colorido).
let vpnStatus = null;
function renderVpnIndicator() {
  const btn = $('btn-vpn');
  const on = vpnStatus && vpnStatus.state !== 'off';
  btn.className = `vpn-indicator vpn-${on ? vpnStatus.state : 'off'}`;
  btn.textContent = on ? `VPN: ${vpnStatus.site}` : 'VPN';
  btn.title = !on ? 'VPN IPsec: conectar e editar os sites'
    : vpnStatus.state === 'connected' ? `VPN conectada (${vpnStatus.site})` : 'VPN conectando…';
}
api.onVpnStatus((s) => {
  vpnStatus = s;
  renderVpnIndicator();
  for (const t of tabsById.values()) t.onVpnStatus?.(s);
});
$('btn-vpn').addEventListener('click', () => openToolTab('vpn'));
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
function runTool(kind) {
  if (kind === 'ping' || kind === 'traceroute') openDiagDialog(kind);
  else if (kind.startsWith('local-')) openLocalTab(kind.slice(6));
  else openToolTab(kind);
}
toolsMenu.addEventListener('click', (e) => {
  const kind = e.target.closest('[data-tool]')?.dataset.tool;
  if (!kind) return;
  setToolsMenu(false);
  runTool(kind);
});

// ---------- menu do topo ----------

/** Sessão selecionada na árvore, ou aviso para escolher uma. */
function withSession(run) {
  const session = selectedSession();
  if (session) return run(session);
  showEditor();
  clearMessages();
  message('Selecione uma sessão na árvore primeiro.', 'warn');
}

const MENU_COMMANDS = {
  'new-session': newSession,
  'new-folder': () => folderAction('subfolder', ''),
  'open-file': chooseSessionsFile,
  reload: () => load(),
  'default-key': editDefaultKey,
  'import-sessions': importSessions,
  'import-vpn': importVpnSite,
  'import-backup': importBackup,
  'export-sessions': () => exportSessions(),
  'export-vpn': exportVpnSites,
  'export-backup': exportBackup,
  connect: () => withSession((s) => connect(s)),
  external: () => withSession((s) => connect(s, { external: true, multimon: false })),
  wol: () => withSession((s) => {
    if (s.mac) return wakeSession(s);
    showEditor();
    clearMessages();
    message(`A sessão "${s.name}" não tem endereço MAC; preencha o campo MAC para usar o Wake-on-LAN.`, 'warn');
  }),
  edit: () => withSession((s) => select(keyOf(s))),
  delete: () => withSession((s) => deleteSessions([s])),
  'wol-tool': () => openToolTab('wol'),
  'toggle-sidebar': () => document.body.classList.toggle('no-sidebar'),
  help: openHelp,
  'check-updates': async () => {
    await openHelp();
    renderUpdate(await api.checkUpdates());
  },
};
api.onMenuCommand((command) => {
  if (api.isDetached) return;
  const run = MENU_COMMANDS[command] ?? (() => runTool(command));
  void run();
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

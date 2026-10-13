// Painéis das ferramentas de rede (scanner de portas, scanner de rede, DNS, portas locais).
// Cada painel recebe um contexto do app.js e devolve ganchos para a aba.

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function field(label, input) {
  return el('label', {}, label, input);
}

/** Tabela simples: colunas = [{ key, label, cls? }]; linhas adicionadas incrementalmente. */
function table(columns) {
  const body = el('tbody');
  const head = el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { textContent: c.label }))));
  const node = el('table', { className: 'results' }, head, body);
  const rows = [];
  return {
    node,
    rows,
    clear() {
      rows.length = 0;
      body.replaceChildren();
    },
    add(row, extra) {
      rows.push(row);
      const tr = el('tr', {}, ...columns.map((c) => {
        const td = el('td', { textContent: String(row[c.key] ?? '') });
        if (c.cls) td.className = c.cls(row);
        return td;
      }));
      if (extra) tr.append(el('td', {}, extra));
      body.append(tr);
      return tr;
    },
    csv() {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\r\n');
    },
  };
}

function statusLine() {
  return el('p', { className: 'tool-status' });
}

async function exportCsv(ctx, tbl, name, status) {
  if (!tbl.rows.length) return;
  try {
    const path = await ctx.api.saveCsv(name, tbl.csv());
    if (path) status.textContent = `Exportado para ${path}`;
  } catch (err) {
    status.textContent = ctx.cleanError(err);
  }
}

/** Ferramenta com varredura em andamento: botões iniciar/cancelar e progresso. */
function scanControls(ctx, tab, runLabel) {
  const run = el('button', { type: 'submit', className: 'primary', textContent: runLabel });
  const cancel = el('button', { type: 'button', textContent: 'Cancelar', disabled: true });
  const csv = el('button', { type: 'button', textContent: 'Exportar CSV', disabled: true });
  const progress = el('progress', { max: 1, value: 0, hidden: true });
  const status = statusLine();
  cancel.addEventListener('click', () => ctx.api.cancelTool(tab.id));
  return {
    run, cancel, csv, progress, status,
    start(total) {
      run.disabled = true;
      cancel.disabled = false;
      csv.disabled = true;
      progress.hidden = false;
      progress.max = Math.max(total, 1);
      progress.value = 0;
    },
    progressTo(done, total) {
      progress.max = Math.max(total, 1);
      progress.value = done;
    },
    finish(hasRows) {
      run.disabled = false;
      cancel.disabled = true;
      csv.disabled = !hasRows;
      progress.hidden = true;
    },
  };
}

// ---------- scanner de portas ----------

function portScanPanel(ctx, tab) {
  const host = el('input', { name: 'host', required: true, value: ctx.host ?? '', autocomplete: 'off' });
  const ports = el('input', { name: 'ports', value: 'comuns', autocomplete: 'off' });
  const timeout = el('input', { name: 'timeout', type: 'number', min: 100, max: 30000, value: 1500 });
  const onlyOpen = el('input', { type: 'checkbox', checked: true });
  const c = scanControls(ctx, tab, 'Escanear');
  const tbl = table([
    { key: 'port', label: 'Porta' },
    { key: 'service', label: 'Serviço' },
    { key: 'label', label: 'Estado', cls: (r) => `state-${r.state}` },
  ]);
  const LABELS = { open: 'aberta', closed: 'fechada', filtered: 'filtrada' };
  let counts = { open: 0, closed: 0, filtered: 0 };
  let live = false;

  function addRow(r) {
    counts[r.state]++;
    if (onlyOpen.checked && r.state !== 'open') return;
    tbl.add({ ...r, label: LABELS[r.state] });
    // Mantém a tabela em ordem de porta mesmo com resultados chegando fora de ordem.
    const body = tbl.node.tBodies[0];
    body.append(...[...body.rows].sort((a, b) => Number(a.cells[0].textContent) - Number(b.cells[0].textContent)));
    tbl.rows.sort((a, b) => a.port - b.port);
  }

  const form = el('form', { className: 'tool-form' },
    field('Host ou IP', host),
    field('Portas', ports),
    field('Timeout (ms)', timeout),
    el('label', { className: 'check' }, onlyOpen, ' só abertas'),
    el('div', { className: 'actions' }, c.run, c.cancel, c.csv),
  );
  const hint = el('p', { className: 'muted', textContent: 'Portas: lista e faixas (22,80,8000-8100) ou predefinições: comuns, web, bancos, windows.' });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    tbl.clear();
    counts = { open: 0, closed: 0, filtered: 0 };
    c.status.textContent = 'Escaneando…';
    c.start(1);
    live = true;
    try {
      const { cancelled, results } = await ctx.api.portScan(tab.id, host.value, ports.value, Number(timeout.value));
      // A resposta é a fonte da verdade: eventos atrasados são ignorados e a tabela é refeita.
      live = false;
      tbl.clear();
      counts = { open: 0, closed: 0, filtered: 0 };
      for (const r of results) addRow(r);
      c.status.textContent = `${cancelled ? 'Cancelado' : 'Concluído'}: ${counts.open} aberta(s), ${counts.closed} fechada(s), ${counts.filtered} filtrada(s).`;
    } catch (err) {
      c.status.textContent = ctx.cleanError(err);
    }
    live = false;
    c.finish(tbl.rows.length > 0);
  });
  c.csv.addEventListener('click', () => exportCsv(ctx, tbl, `portas-${host.value}.csv`, c.status));

  return {
    title: 'Scanner de portas',
    content: [form, hint, c.progress, c.status, tbl.node],
    focus: () => host.focus(),
    onProgress: (done, total) => {
      if (live) c.progressTo(done, total);
    },
    onResult: (r) => {
      if (live) addRow(r);
    },
    onClose: () => ctx.api.cancelTool(tab.id),
  };
}

// ---------- scanner de rede ----------

function netScanPanel(ctx, tab) {
  const range = el('input', { name: 'range', required: true, value: ctx.network ?? '', placeholder: '10.0.0.0/24, 10.0.0.10-50 ou lista', autocomplete: 'off' });
  const timeout = el('input', { name: 'timeout', type: 'number', min: 100, max: 30000, value: 800 });
  // Nome via SNMP (sysName) quando o DNS reverso não tem registro.
  const cred = snmpCredentials({ allowOff: true, onChange: () => { snmpPortField.hidden = !cred.enabled(); } });
  const snmpPort = el('input', { name: 'snmpPort', type: 'number', min: 1, max: 65535, value: 161 });
  const snmpPortField = field('Porta SNMP', snmpPort);
  snmpPortField.hidden = true;
  const c = scanControls(ctx, tab, 'Escanear');
  const tbl = table([
    { key: 'target', label: 'Endereço' },
    { key: 'name', label: 'Nome' },
    { key: 'source', label: 'Fonte' },
    { key: 'latency', label: 'Resposta' },
    { key: 'ports', label: 'Portas abertas' },
  ]);

  const form = el('form', { className: 'tool-form' },
    field('Faixa', range),
    field('Timeout (ms)', timeout),
    el('div', { className: 'break' }),
    ...cred.fields, snmpPortField,
    el('div', { className: 'actions' }, c.run, c.cancel, c.csv),
  );
  let live = false;
  const hint = el('p', {
    className: 'muted',
    textContent: 'Descobre hosts por conexão TCP nas portas 22, 80, 443, 445 e 3389 (resposta recusada também conta). Hosts que bloqueiam tudo não aparecem. O nome vem do DNS reverso; com SNMP configurado, hosts sem DNS reverso são consultados pelo sysName. As credenciais não são gravadas.',
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    tbl.clear();
    c.status.textContent = 'Escaneando…';
    c.start(1);
    live = true;
    try {
      const { cancelled, results } = await ctx.api.netScan(tab.id, range.value, Number(timeout.value),
        cred.enabled() ? { ...cred.read(), port: snmpPort.value } : null);
      // A resposta é a fonte da verdade: eventos atrasados são ignorados e a tabela é refeita.
      live = false;
      tbl.clear();
      for (const r of results) addHost(r);
      c.status.textContent = `${cancelled ? 'Cancelado' : 'Concluído'}: ${results.length} host(s) ativo(s).`;
    } catch (err) {
      c.status.textContent = ctx.cleanError(err);
    }
    live = false;
    c.finish(tbl.rows.length > 0);
  });
  c.csv.addEventListener('click', () => exportCsv(ctx, tbl, 'hosts.csv', c.status));

  const NAMES = { 22: 'ssh', 80: 'http', 443: 'https', 445: 'smb', 3389: 'rdp' };
  return {
    title: 'Scanner de rede',
    content: [form, hint, c.progress, c.status, tbl.node],
    focus: () => range.focus(),
    onProgress: (done, total) => {
      if (!live) return;
      c.progressTo(done, total);
      c.status.textContent = `Escaneando… ${done}/${total}`;
    },
    onResult: (r) => {
      if (live) addHost(r);
    },
    onClose: () => {
      ctx.api.cancelTool(tab.id);
      cred.clear();
    },
  };

  function addHost(r) {
    const row = {
      target: r.target,
      name: r.name ?? '',
      source: { dns: 'DNS', snmp: 'SNMP' }[r.nameSource] ?? '',
      latency: r.latencyMs === undefined ? '' : `${r.latencyMs} ms`,
      ports: r.open.map((p) => `${p} (${NAMES[p] ?? p})`).join(', '),
    };
    const actions = el('span', { className: 'row-actions' });
    const create = (type) => {
      const b = el('button', { type: 'button', className: 'link', textContent: `+ sessão ${type.toUpperCase()}` });
      b.addEventListener('click', () => ctx.newSession({ name: r.name || r.target, host: r.target, type }));
      return b;
    };
    if (r.open.includes(22) || !r.open.includes(3389)) actions.append(create('ssh'));
    if (r.open.includes(3389)) actions.append(create('rdp'));
    tbl.add(row, actions);
  }
}

// ---------- SNMP ----------

/** Campo de senha com botão para mostrar/ocultar. */
function secret(name, placeholder = '') {
  const input = el('input', { name, type: 'password', autocomplete: 'off', placeholder });
  const toggle = el('button', { type: 'button', className: 'link', textContent: 'mostrar' });
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'ocultar' : 'mostrar';
  });
  return { input, node: el('span', { className: 'secret' }, input, toggle) };
}

const select = (name, options, value) =>
  el('select', { name }, ...options.map(([v, label]) => el('option', { value: v, textContent: label, selected: v === value })));

/**
 * Campos de credencial SNMP (versão, community ou usuário/nível/protocolos/senhas do v3),
 * compartilhados pela consulta SNMP e pelo scanner de rede. `allowOff` adiciona "não usar".
 */
function snmpCredentials({ allowOff = false, onChange } = {}) {
  const versions = [['1', 'v1'], ['2c', 'v2c'], ['3', 'v3']];
  const version = select('version', allowOff ? [['', 'não usar'], ...versions] : versions, allowOff ? '' : '2c');
  const community = secret('community', 'public');
  const user = el('input', { name: 'user', autocomplete: 'off' });
  const level = select('level', [['noAuthNoPriv', 'sem autenticação (noAuthNoPriv)'], ['authNoPriv', 'autenticação (authNoPriv)'], ['authPriv', 'autenticação + criptografia (authPriv)']], 'authPriv');
  const authProtocol = select('authProtocol', [['md5', 'MD5'], ['sha', 'SHA-1'], ['sha224', 'SHA-224'], ['sha256', 'SHA-256'], ['sha384', 'SHA-384'], ['sha512', 'SHA-512']], 'sha');
  const authKey = secret('authKey', 'mínimo 8 caracteres');
  const privProtocol = select('privProtocol', [['des', 'DES'], ['aes', 'AES-128'], ['aes256b', 'AES-256 (Blumenthal)'], ['aes256r', 'AES-256 (Reeder)']], 'aes');
  const privKey = secret('privKey', 'mínimo 8 caracteres');

  const credCommunity = field('Community', community.node);
  const credV3 = [field('Usuário', user), field('Nível de segurança', level)];
  const credAuth = [field('Autenticação', authProtocol), field('Senha de autenticação', authKey.node)];
  const credPriv = [field('Criptografia', privProtocol), field('Senha de criptografia', privKey.node)];

  function update() {
    const off = version.value === '';
    const v3 = version.value === '3';
    credCommunity.hidden = off || v3;
    for (const f of credV3) f.hidden = !v3;
    for (const f of credAuth) f.hidden = !v3 || level.value === 'noAuthNoPriv';
    for (const f of credPriv) f.hidden = !v3 || level.value !== 'authPriv';
  }
  for (const s of [version, level]) {
    s.addEventListener('change', () => {
      update();
      onChange?.();
    });
  }
  update();

  return {
    version,
    fields: [field(allowOff ? 'SNMP' : 'Versão', version), credCommunity, ...credV3, ...credAuth, ...credPriv],
    enabled: () => version.value !== '',
    read: () => ({
      version: version.value, community: community.input.value,
      user: user.value, level: level.value, authProtocol: authProtocol.value, authKey: authKey.input.value,
      privProtocol: privProtocol.value, privKey: privKey.input.value,
    }),
    // Não deixa senhas na memória da página depois de fechar a aba.
    clear: () => {
      community.input.value = authKey.input.value = privKey.input.value = '';
    },
  };
}

function snmpPanel(ctx, tab) {
  const host = el('input', { name: 'host', required: true, value: ctx.host ?? '', autocomplete: 'off' });
  const port = el('input', { name: 'port', type: 'number', min: 1, max: 65535, value: 161 });
  const cred = snmpCredentials({ onChange: () => updateFields() });
  const { version } = cred;

  const operation = select('operation', [['get', 'get'], ['getnext', 'getnext'], ['getbulk', 'getbulk'], ['walk', 'walk']], 'get');
  const oids = el('input', { name: 'oids', value: 'sysName sysDescr sysUpTime', autocomplete: 'off' });
  const nonRepeaters = el('input', { name: 'nonRepeaters', type: 'number', min: 0, value: 0 });
  const maxRepetitions = el('input', { name: 'maxRepetitions', type: 'number', min: 1, max: 1000, value: 20 });
  const maxResults = el('input', { name: 'maxResults', type: 'number', min: 1, max: 100000, value: 10000 });
  const timeout = el('input', { name: 'timeout', type: 'number', min: 200, max: 60000, value: 3000 });
  const retries = el('input', { name: 'retries', type: 'number', min: 0, max: 5, value: 1 });
  const c = scanControls(ctx, tab, 'Executar');
  const tbl = table([
    { key: 'oid', label: 'OID' },
    { key: 'name', label: 'Nome' },
    { key: 'type', label: 'Tipo' },
    { key: 'value', label: 'Valor', cls: () => 'wrap' },
  ]);
  let live = false;

  const bulkFields = [field('Non-repeaters', nonRepeaters), field('Max-repetitions', maxRepetitions)];
  const walkFields = [field('Limite de resultados', maxResults)];
  const PLACEHOLDERS = {
    get: 'sysName sysDescr ou 1.3.6.1.2.1.1.5.0',
    getnext: 'ifDescr (devolve o próximo OID)',
    getbulk: 'ifDescr ifOperStatus',
    walk: 'system, interfaces, ifDescr ou um OID numérico',
  };

  function updateFields() {
    for (const f of bulkFields) f.hidden = operation.value !== 'getbulk';
    for (const f of walkFields) f.hidden = operation.value !== 'walk';
    oids.placeholder = PLACEHOLDERS[operation.value];
    // getbulk não existe no v1: oferece só o que funciona.
    operation.querySelector('option[value=getbulk]').disabled = version.value === '1';
    if (version.value === '1' && operation.value === 'getbulk') operation.value = 'getnext';
  }
  operation.addEventListener('change', updateFields);
  updateFields();

  const form = el('form', { className: 'tool-form' },
    field('Host ou IP', host), field('Porta', port), ...cred.fields,
    el('div', { className: 'break' }),
    field('Operação', operation), el('label', { className: 'wide' }, 'OIDs', oids), ...bulkFields, ...walkFields,
    field('Timeout (ms)', timeout), field('Tentativas', retries),
    el('div', { className: 'actions' }, c.run, c.cancel, c.csv),
  );
  const hint = el('p', {
    className: 'muted',
    textContent: 'OIDs numéricos ou nomes comuns (sysName, sysDescr, sysUpTime, ifDescr, ifOperStatus, ifHCInOctets…); vários separados por espaço. walk percorre a subárvore do OID. As credenciais não são gravadas.',
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    tbl.clear();
    c.status.textContent = 'Consultando…';
    c.start(1);
    live = true;
    try {
      const { cancelled, results } = await ctx.api.snmp(tab.id, {
        host: host.value, port: port.value, ...cred.read(),
        operation: operation.value, oids: oids.value, nonRepeaters: nonRepeaters.value,
        maxRepetitions: maxRepetitions.value, maxResults: maxResults.value, timeoutMs: timeout.value, retries: retries.value,
      });
      live = false;
      tbl.clear();
      for (const r of results) tbl.add(r);
      const limit = operation.value === 'walk' && results.length >= Number(maxResults.value) ? ' (limite atingido)' : '';
      c.status.textContent = `${cancelled ? 'Cancelado' : 'Concluído'}: ${results.length} resultado(s)${limit}.`;
    } catch (err) {
      c.status.textContent = ctx.cleanError(err);
    }
    live = false;
    c.finish(tbl.rows.length > 0);
  });
  c.csv.addEventListener('click', () => exportCsv(ctx, tbl, `snmp-${host.value}.csv`, c.status));

  return {
    title: 'Consulta SNMP',
    content: [form, hint, c.progress, c.status, tbl.node],
    focus: () => host.focus(),
    onResult: (r) => {
      if (live) tbl.add(r);
    },
    onClose: () => {
      ctx.api.cancelTool(tab.id);
      cred.clear();
    },
  };
}

// ---------- captura de pacotes ----------

function capturePanel(ctx, tab) {
  const body = el('div');
  const status = statusLine();
  let running = false;
  let started = 0;
  let progress = '';
  let timer = null;

  const elapsed = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const showRunning = () => {
    status.textContent = `Capturando… ${progress}${progress ? ' · ' : ''}${elapsed()}`;
  };
  const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  function renderMissing() {
    const again = el('button', { type: 'button', textContent: 'Verificar de novo' });
    again.addEventListener('click', load);
    body.replaceChildren(
      el('p', {
        textContent: 'Para capturar pacotes, instale o Wireshark (wireshark.org) marcando a instalação do Npcap. ' +
          'O MultTerm usa o dumpcap do Wireshark e, com o Npcap no modo padrão, não precisa rodar como administrador.',
      }),
      el('div', { className: 'actions' }, again),
    );
  }

  function renderForm(info) {
    const engines = [];
    if (info.dumpcap && info.interfaces.length) engines.push(['dumpcap', 'Wireshark (dumpcap)']);
    if (info.pktmon) engines.push(['pktmon', 'pktmon do Windows (pede administrador)']);
    const engine = el('select', { name: 'backend' }, ...engines.map(([value, label]) => el('option', { value, textContent: label })));

    // dumpcap: interface + filtro BPF.
    const iface = el('select', { name: 'iface' },
      ...info.interfaces.map((i) => el('option', { value: i.device, textContent: i.name })));
    const filter = el('input', { name: 'filter', placeholder: 'opcional (BPF): host 10.0.0.5 and port 22', autocomplete: 'off' });
    const maxPackets = el('input', { name: 'maxPackets', type: 'number', min: 1, placeholder: 'sem limite' });
    // pktmon: filtros simples, todas as placas de rede.
    const ip = el('input', { name: 'ip', placeholder: 'opcional: 10.0.0.5', autocomplete: 'off' });
    const port = el('input', { name: 'port', type: 'number', min: 1, max: 65535, placeholder: 'qualquer' });
    const protocol = select('protocol', [['', 'qualquer'], ['TCP', 'TCP'], ['UDP', 'UDP'], ['ICMP', 'ICMP']]);
    const maxSeconds = el('input', { name: 'maxSeconds', type: 'number', min: 1, placeholder: 'sem limite' });

    const start = el('button', { type: 'submit', className: 'primary', textContent: 'Iniciar' });
    const stop = el('button', { type: 'button', textContent: 'Parar', disabled: true });
    const result = el('div', { className: 'actions' });
    const note = el('p', { className: 'muted' });
    stop.addEventListener('click', () => ctx.api.cancelTool(tab.id));

    const dumpcapFields = [field('Interface', iface), el('label', { className: 'wide' }, 'Filtro', filter), field('Parar após (pacotes)', maxPackets)];
    const pktmonFields = [field('IP', ip), field('Porta', port), field('Protocolo', protocol)];
    const form = el('form', { className: 'tool-form' },
      ...(engines.length > 1 ? [field('Motor', engine)] : []),
      ...dumpcapFields, ...pktmonFields, field('Parar após (segundos)', maxSeconds),
      el('div', { className: 'actions' }, start, stop),
    );
    const isPktmon = () => engine.value === 'pktmon';
    const switchEngine = () => {
      for (const f of dumpcapFields) f.hidden = isPktmon();
      for (const f of pktmonFields) f.hidden = !isPktmon();
      note.textContent = isPktmon()
        ? `Grava em ${info.folder} (formato pcapng). O pktmon captura em todas as placas de rede e exige administrador: ` +
          'o Windows pede confirmação (UAC) a cada captura. Os filtros são opcionais e se combinam.'
        : `Grava em ${info.folder} (formato pcapng). O filtro usa a sintaxe de captura do Wireshark/BPF, ` +
          'por exemplo: "host 10.0.0.5", "port 161", "tcp and not port 22".';
    };
    engine.addEventListener('change', switchEngine);
    switchEngine();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      result.replaceChildren();
      const pktmon = isPktmon();
      running = true;
      progress = pktmon ? '' : '0 pacote(s)';
      started = Date.now();
      start.disabled = true;
      stop.disabled = false;
      engine.disabled = true;
      if (pktmon) status.textContent = 'Aguardando a confirmação do administrador (UAC)…';
      else showRunning();
      timer = setInterval(() => {
        if (!pktmon || progress) showRunning();
      }, 1000);
      try {
        const req = pktmon
          ? { backend: 'pktmon', ip: ip.value, port: port.value, protocol: protocol.value, maxSeconds: maxSeconds.value }
          : { backend: 'dumpcap', iface: iface.value, filter: filter.value, maxPackets: maxPackets.value, maxSeconds: maxSeconds.value };
        const { results } = await ctx.api.captureStart(tab.id, req);
        status.textContent = `${results.packets} pacote(s) em ${elapsed()} salvos em ${results.file}`;
        const open = el('button', { type: 'button', className: 'primary', textContent: info.wireshark ? 'Abrir no Wireshark' : 'Abrir' });
        const show = el('button', { type: 'button', textContent: 'Mostrar na pasta' });
        open.addEventListener('click', () => ctx.api.captureOpen(results.file).catch((err) => {
          status.textContent = ctx.cleanError(err);
        }));
        show.addEventListener('click', () => ctx.api.captureShow(results.file));
        result.replaceChildren(open, show);
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
      clearInterval(timer);
      running = false;
      start.disabled = false;
      stop.disabled = true;
      engine.disabled = false;
    });

    body.replaceChildren(form, note, result);
    (isPktmon() ? ip : iface).focus();
  }

  async function load() {
    status.textContent = 'Procurando o Wireshark…';
    try {
      const info = await ctx.api.captureInfo();
      status.textContent = '';
      if (info.dumpcap && info.interfaces.length) renderForm(info);
      else if (info.pktmon) {
        renderForm(info);
        status.textContent = info.dumpcap
          ? 'O dumpcap não listou nenhuma interface (o Npcap está ativo?); usando o pktmon do Windows.'
          : 'Wireshark não encontrado: usando o pktmon do Windows. Instale o Wireshark com o Npcap para capturar sem administrador.';
      } else {
        renderMissing();
        if (info.dumpcap) status.textContent = 'O dumpcap não listou nenhuma interface (o Npcap está instalado e ativo?).';
      }
    } catch (err) {
      status.textContent = ctx.cleanError(err);
    }
  }
  load();

  return {
    title: 'Captura de pacotes',
    content: [body, status],
    // dumpcap informa pacotes; pktmon (total -1), o tamanho do arquivo de rastreamento.
    onProgress: (n, total) => {
      if (!running) return;
      progress = total === -1 ? `${size(n)} capturados` : `${n} pacote(s)`;
      showRunning();
    },
    onClose: () => {
      clearInterval(timer);
      ctx.api.cancelTool(tab.id); // para a captura ao fechar a aba
    },
  };
}

// ---------- Wake-on-LAN ----------

function wolPanel(ctx) {
  const withMac = (ctx.sessions ?? []).filter((s) => s.mac);
  const pick = el('select', { name: 'session' },
    el('option', { value: '', textContent: withMac.length ? '— escolher —' : '(nenhuma sessão com MAC)' }),
    ...withMac.map((s, i) => el('option', { value: String(i), textContent: `${s.folder ? `${s.folder}/` : ''}${s.name} (${s.mac})` })));
  const mac = el('input', { name: 'mac', required: true, value: ctx.mac ?? '', placeholder: 'aa:bb:cc:dd:ee:ff', autocomplete: 'off' });
  const address = el('input', { name: 'address', value: '255.255.255.255', autocomplete: 'off' });
  const port = el('input', { name: 'port', type: 'number', min: 1, max: 65535, value: 9 });
  const run = el('button', { type: 'submit', className: 'primary', textContent: 'Enviar' });
  const status = statusLine();
  pick.addEventListener('change', () => {
    const s = withMac[Number(pick.value)];
    if (s) mac.value = s.mac;
  });

  const form = el('form', { className: 'tool-form' },
    field('Sessão', pick), field('MAC', mac), field('Broadcast', address), field('Porta UDP', port),
    el('div', { className: 'actions' }, run),
  );
  const hint = el('p', {
    className: 'muted',
    textContent: 'Envia o pacote mágico por UDP. 255.255.255.255 alcança a rede local; para outra sub-rede use o broadcast dela (ex.: 10.0.5.255), se o roteador permitir. A máquina precisa ter Wake-on-LAN ativo na BIOS/placa de rede. Cadastre o MAC na sessão para ligá-la pelo botão direito.',
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    run.disabled = true;
    try {
      const sent = await ctx.api.wol({ mac: mac.value, address: address.value, port: port.value });
      status.textContent = `Pacote mágico enviado para ${sent.mac} via ${sent.address}:${sent.port}.`;
    } catch (err) {
      status.textContent = ctx.cleanError(err);
    }
    run.disabled = false;
  });
  return { title: 'Wake-on-LAN', content: [form, hint, status], focus: () => mac.focus() };
}

// ---------- DNS ----------

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV'];

function dnsPanel(ctx) {
  const name = el('input', { name: 'name', required: true, value: ctx.host ?? '', placeholder: 'nome ou IP (IP faz a consulta reversa)', autocomplete: 'off' });
  const type = el('select', { name: 'type' }, ...DNS_TYPES.map((t) => el('option', { value: t, textContent: t })));
  const server = el('input', { name: 'server', placeholder: 'padrão do sistema (ou IP, ex.: 1.1.1.1)', autocomplete: 'off' });
  const run = el('button', { type: 'submit', className: 'primary', textContent: 'Consultar' });
  const status = statusLine();
  const out = el('pre', { className: 'dns-result' });

  const form = el('form', { className: 'tool-form' },
    field('Nome ou IP', name), field('Tipo', type), field('Servidor DNS', server),
    el('div', { className: 'actions' }, run),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    run.disabled = true;
    status.textContent = 'Consultando…';
    out.textContent = '';
    try {
      const r = await ctx.api.dnsQuery(name.value, type.value, server.value);
      status.textContent = `${r.query} ${r.type} via ${r.server}: ${r.records.length} registro(s)`;
      out.textContent = r.records.join('\n') || '(nenhum registro)';
    } catch (err) {
      status.textContent = ctx.cleanError(err);
    }
    run.disabled = false;
  });

  return { title: 'Consulta DNS', content: [form, status, out], focus: () => name.focus() };
}

// ---------- portas abertas locais ----------

function localPortsPanel(ctx, tab) {
  const filter = el('input', { type: 'search', placeholder: 'filtrar por porta, endereço ou processo', autocomplete: 'off' });
  const view = el('select', {},
    el('option', { value: 'listen', textContent: 'Em escuta (TCP) e UDP' }),
    el('option', { value: 'established', textContent: 'Conexões estabelecidas' }),
    el('option', { value: 'all', textContent: 'Todas' }),
  );
  const refresh = el('button', { type: 'button', className: 'primary', textContent: 'Atualizar' });
  const auto = el('input', { type: 'checkbox' });
  const csv = el('button', { type: 'button', textContent: 'Exportar CSV', disabled: true });
  const status = statusLine();
  const tbl = table([
    { key: 'proto', label: 'Protocolo' },
    { key: 'local', label: 'Local' },
    { key: 'remote', label: 'Remoto' },
    { key: 'state', label: 'Estado' },
    { key: 'process', label: 'Processo' },
    { key: 'pid', label: 'PID' },
  ]);
  let all = [];
  let timer = null;

  const endpoint = (a, p) => (p === null ? a || '*' : a.includes(':') ? `[${a}]:${p}` : `${a}:${p}`);
  const STATE = { Listen: 'escutando', Established: 'estabelecida', TimeWait: 'time-wait', CloseWait: 'close-wait', Bound: 'aberta (UDP)' };

  function render() {
    const q = filter.value.trim().toLowerCase();
    tbl.clear();
    const shown = all.filter((r) => {
      if (view.value === 'listen' && !(r.state === 'Listen' || r.proto === 'UDP')) return false;
      if (view.value === 'established' && r.state !== 'Established') return false;
      if (!q) return true;
      return [r.localPort, r.remotePort, r.localAddress, r.remoteAddress, r.process, r.pid].some((v) => String(v ?? '').toLowerCase().includes(q));
    });
    for (const r of shown) {
      tbl.add({
        proto: r.proto,
        local: endpoint(r.localAddress, r.localPort),
        // Em escuta (e UDP) não há par remoto: o sistema mostra 0.0.0.0:0, que só confunde.
        remote: r.proto === 'UDP' || r.state === 'Listen' ? '' : endpoint(r.remoteAddress, r.remotePort),
        state: STATE[r.state] ?? r.state,
        process: r.process || '(sem acesso)',
        pid: r.pid,
      });
    }
    csv.disabled = shown.length === 0;
    status.textContent = `${shown.length} de ${all.length} entradas · atualizado às ${new Date().toLocaleTimeString()}`;
  }

  async function load() {
    refresh.disabled = true;
    try {
      all = await ctx.api.localPorts();
      render();
    } catch (err) {
      status.textContent = ctx.cleanError(err);
    }
    refresh.disabled = false;
  }

  filter.addEventListener('input', render);
  view.addEventListener('change', render);
  refresh.addEventListener('click', load);
  auto.addEventListener('change', () => {
    clearInterval(timer);
    timer = auto.checked ? setInterval(load, 5000) : null;
  });
  csv.addEventListener('click', () => exportCsv(ctx, tbl, 'conexoes.csv', status));

  const bar = el('div', { className: 'tool-form' },
    field('Mostrar', view), field('Filtro', filter),
    el('label', { className: 'check' }, auto, ' atualizar a cada 5 s'),
    el('div', { className: 'actions' }, refresh, csv),
  );
  load();
  return {
    title: 'Portas locais',
    content: [bar, status, tbl.node],
    focus: () => filter.focus(),
    onClose: () => clearInterval(timer),
  };
}

const PANELS = { portscan: portScanPanel, netscan: netScanPanel, dns: dnsPanel, snmp: snmpPanel, localports: localPortsPanel, wol: wolPanel, capture: capturePanel };

/** Cria o painel da ferramenta `kind` dentro de `tab.panel`; devolve os ganchos da aba. */
export function buildToolPanel(kind, ctx, tab) {
  const make = PANELS[kind];
  if (!make) throw new Error(`ferramenta desconhecida: ${kind}`);
  const p = make(ctx, tab);
  tab.panel.append(el('div', { className: 'tool-body' }, el('h2', { textContent: p.title }), ...p.content));
  return p;
}

export const TOOL_TITLES = { portscan: 'Scanner de portas', netscan: 'Scanner de rede', dns: 'Consulta DNS', snmp: 'Consulta SNMP', localports: 'Portas locais', wol: 'Wake-on-LAN', capture: 'Captura de pacotes' };

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

// ---------- agente MCP ----------

const AGENT_MODES = [
  ['off', 'Não compartilhar'],
  ['read', 'Somente leitura'],
  ['approve', 'Aprovar cada envio'],
  ['auto', 'Controle livre'],
];

function agentPanel(ctx) {
  const body = el('div', { className: 'agent' });
  const status = statusLine();
  let state = null;
  let logBox = null;
  let rendered = false;
  // O que foi digitado e ainda não salvo sobrevive aos redesenhos (eventos de abas e do agente).
  const draft = { port: null };

  const copyButton = (getText) => {
    const b = el('button', { type: 'button', textContent: 'Copiar' });
    b.addEventListener('click', async () => {
      await ctx.api.clipboardWrite(getText());
      b.textContent = 'Copiado';
      setTimeout(() => { b.textContent = 'Copiar'; }, 1500);
    });
    return b;
  };

  function configs(s) {
    const stdio = { mcpServers: { multterm: s.stdio } };
    const httpCfg = { mcpServers: { multterm: { type: 'http', url: s.url, headers: { Authorization: `Bearer ${s.token}` } } } };
    return { stdio: JSON.stringify(stdio, null, 2), http: JSON.stringify(httpCfg, null, 2) };
  }

  function render() {
    const s = state;
    const toggle = el('button', { type: 'button', className: s.enabled ? '' : 'primary', textContent: s.enabled ? 'Desligar o agente' : 'Ligar o agente' });
    toggle.addEventListener('click', async () => {
      status.textContent = '';
      try {
        state = { ...state, ...(await ctx.api.agentEnable(!s.enabled)) };
        render();
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });
    const port = el('input', { name: 'port', type: 'number', min: 1024, max: 65535, value: draft.port ?? s.port });
    port.addEventListener('input', () => { draft.port = port.value; });
    const savePort = el('button', { type: 'button', textContent: 'Trocar porta' });
    savePort.addEventListener('click', async () => {
      try {
        state = { ...state, ...(await ctx.api.agentSetPort(Number(port.value))) };
        draft.port = null;
        render();
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });
    const newToken = el('button', { type: 'button', textContent: 'Gerar token novo' });
    newToken.addEventListener('click', async () => {
      if (!confirm('Gerar um token novo? Agentes configurados com o token atual deixam de conectar até você atualizar a configuração deles.')) return;
      state = { ...state, ...(await ctx.api.agentNewToken()) };
      render();
    });

    const cfg = configs(s);
    const stdioBox = el('pre', { className: 'dns-result agent-config', textContent: cfg.stdio });
    const httpBox = el('pre', { className: 'dns-result agent-config', textContent: cfg.http.replace(s.token, '••••••••') });
    const reveal = el('button', { type: 'button', className: 'link', textContent: 'mostrar o token' });
    reveal.addEventListener('click', () => {
      const hidden = httpBox.textContent.includes('••••');
      httpBox.textContent = hidden ? cfg.http : cfg.http.replace(s.token, '••••••••');
      reveal.textContent = hidden ? 'ocultar o token' : 'mostrar o token';
    });

    // Terminais abertos com o modo de compartilhamento de cada um.
    const terms = ctx.terminalTabs();
    const shareRows = terms.map((t) => {
      const current = s.shares.find((x) => x.tab === t.id)?.mode ?? 'off';
      const sel = select(`share-${t.id}`, AGENT_MODES, current);
      sel.addEventListener('change', async () => {
        await ctx.api.agentShare(t.id, sel.value, t.title, t.detail);
      });
      return el('tr', {}, el('td', { textContent: t.title }), el('td', { className: 'muted', textContent: t.detail ?? '' }), el('td', {}, sel));
    });
    // Mesmo modo para todas as abas de uma vez.
    const all = select('shareAll', [['', 'Definir todas…'], ...AGENT_MODES], '');
    all.addEventListener('change', async () => {
      const mode = all.value;
      all.value = '';
      if (!mode) return;
      if (mode === 'auto' && !confirm(`Dar controle livre ao agente em ${terms.length} aba(s)? Ele poderá digitar nelas sem perguntar.`)) return;
      status.textContent = '';
      try {
        for (const t of terms) await ctx.api.agentShare(t.id, mode, t.title, t.detail);
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });
    if (terms.length > 1) {
      shareRows.unshift(el('tr', { className: 'agent-share-all' },
        el('td', { textContent: 'Todas as abas' }), el('td', { className: 'muted', textContent: `${terms.length} abas` }), el('td', {}, all)));
    }
    const unshare = el('button', { type: 'button', className: 'danger', textContent: 'Parar de compartilhar tudo', disabled: !s.shares.length });
    unshare.addEventListener('click', () => ctx.api.agentUnshareAll());

    logBox = el('pre', { className: 'dns-result server-log', textContent: (s.log ?? []).join('\n') });

    // Abrir o agente escolhido numa aba local, já apontado para este servidor.
    const agentSel = select('agent', (s.agents ?? []).map((a) => [a.id, a.label]), s.agent);
    agentSel.addEventListener('change', async () => {
      try {
        state = { ...state, ...(await ctx.api.agentSetAgent(agentSel.value)) };
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });
    const launch = el('button', { type: 'button', className: 'primary', textContent: 'Abrir o agente' });
    launch.addEventListener('click', async () => {
      status.textContent = '';
      try {
        await ctx.openLocal('agent');
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });

    // Redesenha sem perder a posição da rolagem.
    const scroller = body.closest('.panel');
    const top = scroller?.scrollTop ?? 0;
    body.replaceChildren(
      el('p', {
        textContent: 'Liga um servidor MCP local para um agente de IA (configurado por você, com a sua conta) ler e operar os ' +
          'terminais que você compartilhar. Só as abas marcadas abaixo ficam visíveis; nada é compartilhado por padrão.',
      }),
      el('div', { className: 'actions' }, toggle, el('span', { className: `agent-state ${s.enabled ? 'on' : 'off'}`, textContent: s.enabled ? `ligado em ${s.url}` : 'desligado' })),
      el('h3', { textContent: 'Abrir o agente no MultTerm' }),
      el('div', { className: 'tool-form' }, field('Agente', agentSel), el('div', { className: 'actions' }, launch)),
      el('p', {
        className: 'muted',
        textContent: 'O agente abre numa aba de terminal local (PowerShell), já ligado a este servidor, com a conta que você tem ' +
          'nele nesta máquina (ele precisa estar instalado). Converse com ele nessa aba; ele opera as abas que você compartilhar.',
      }),
      el('h3', { textContent: 'Terminais compartilhados' }),
      terms.length
        ? el('table', { className: 'results agent-shares' }, el('tbody', {}, ...shareRows))
        : el('p', { className: 'muted', textContent: 'Nenhuma aba de terminal aberta. Abra uma sessão e volte aqui para compartilhá-la.' }),
      el('p', {
        className: 'muted',
        textContent: 'Somente leitura: o agente só lê a saída. Aprovar cada envio: o MultTerm pergunta antes de cada comando ou tecla. ' +
          'Controle livre: o agente digita sem perguntar — use só quando estiver acompanhando. Os comandos rodam nos servidores reais das sessões.',
      }),
      el('div', { className: 'actions' }, unshare),
      el('h3', { textContent: 'Configuração do agente' }),
      el('p', { className: 'muted', textContent: 'Agentes que iniciam servidores por linha de comando (stdio):' }),
      stdioBox, el('div', { className: 'actions' }, copyButton(() => cfg.stdio)),
      el('p', { className: 'muted', textContent: 'Agentes que conectam por HTTP:' }),
      httpBox, el('div', { className: 'actions' }, copyButton(() => cfg.http), reveal),
      el('div', { className: 'tool-form' }, field('Porta', port), el('div', { className: 'actions' }, savePort, newToken)),
      el('div', { className: 'server-log-head' }, el('strong', { textContent: 'Atividade do agente' })),
      logBox,
    );
    if (scroller) scroller.scrollTop = top;
    rendered = true;
  }

  async function load() {
    try {
      state = await ctx.api.agentStatus();
      render();
    } catch (err) {
      status.textContent = ctx.cleanError(err);
    }
  }
  load();

  return {
    title: 'Agente',
    content: [body, status],
    onAgentEvent: (ev) => {
      if (!state) return;
      const keepLog = state.log ?? [];
      state = { ...state, ...ev, log: ev.line ? [...keepLog, ev.line] : keepLog };
      if (ev.line && rendered && logBox) {
        logBox.textContent += `${logBox.textContent ? '\n' : ''}${ev.line}`;
        logBox.scrollTop = logBox.scrollHeight;
      }
      if (!ev.line) render();
    },
    onTabsChanged: () => {
      if (state) render();
    },
  };
}

// ---------- servidores locais ----------

function serversPanel(ctx) {
  const body = el('div', { className: 'servers' });
  const status = statusLine();
  const rows = new Map();
  let servers = [];
  let selected = null;
  let detail = null;
  let ticker = null;

  const remaining = (state) => {
    if (!state?.stopAt) return '';
    const s = Math.max(0, Math.round((state.stopAt - Date.now()) / 1000));
    return ` · para em ${s} s`;
  };
  const stateText = (srv) => (srv.state ? `rodando${srv.state.port ? ` na porta ${srv.state.port}` : ''}${remaining(srv.state)}` : 'parado');

  function renderRow(srv) {
    const row = rows.get(srv.kind);
    row.badge.textContent = stateText(srv);
    row.badge.className = `server-state ${srv.state ? 'on' : 'off'}`;
    row.start.disabled = !!srv.state;
    row.stop.disabled = !srv.state;
    row.node.classList.toggle('selected', selected === srv.kind);
  }

  async function start(srv) {
    status.textContent = '';
    try {
      const config = detail?.kind === srv.kind ? detail.read() : srv.config;
      await ctx.api.serversStart(srv.kind, config);
      // Recarrega o que ficou gravado (ex.: a senha passa a constar como "definida").
      srv.config = (await ctx.api.serversList()).find((s) => s.kind === srv.kind)?.config ?? config;
    } catch (err) {
      status.textContent = `${srv.title}: ${ctx.cleanError(err)}`;
    }
  }

  function renderDetail(srv) {
    const inputs = new Map();
    const fields = srv.fields.map((f) => {
      const value = srv.config[f.key];
      if (f.type === 'bool') {
        const input = el('input', { type: 'checkbox', name: f.key, checked: value !== false });
        inputs.set(f.key, input);
        return el('label', { className: 'check' }, input, f.label);
      }
      if (f.type === 'textarea') {
        const input = el('textarea', { name: f.key, value: value ?? '', rows: 8, spellcheck: false, className: 'server-textarea' });
        inputs.set(f.key, input);
        return el('label', { className: 'wide' }, f.label, input);
      }
      if (f.type === 'select') {
        const input = select(f.key, f.options, value);
        inputs.set(f.key, input);
        return field(f.label, input);
      }
      if (f.type === 'password') {
        // A senha guardada nunca vem para a tela: em branco mantém a atual.
        const pw = secret(f.key, srv.config[`${f.key}Set`] ? 'em branco mantém' : '');
        inputs.set(f.key, pw.input);
        return field(f.label, pw.node);
      }
      if (f.type === 'dir') {
        const input = el('input', { name: f.key, value: value ?? '', autocomplete: 'off' });
        const pick = el('button', { type: 'button', textContent: 'Escolher…' });
        pick.addEventListener('click', async () => {
          const dir = await ctx.api.serversChooseDir(input.value);
          if (dir) input.value = dir;
        });
        inputs.set(f.key, input);
        return el('label', { className: 'wide' }, f.label, el('span', { className: 'dir-pick' }, input, pick));
      }
      const input = el('input', {
        name: f.key, value: value ?? '', autocomplete: 'off',
        ...(f.type === 'number' ? { type: 'number', min: f.min, max: f.max } : {}),
        ...(f.hint ? { title: f.hint } : {}),
      });
      inputs.set(f.key, input);
      return field(f.label, input);
    });
    const logBox = el('pre', { className: 'dns-result server-log', textContent: srv.log.join('\n') });
    const clear = el('button', { type: 'button', className: 'link', textContent: 'limpar' });
    clear.addEventListener('click', async () => {
      await ctx.api.serversClearLog(srv.kind);
      srv.log = [];
      logBox.textContent = '';
    });
    const node = el('div', { className: 'server-detail' },
      el('h3', { textContent: `Servidor ${srv.title}` }),
      el('p', { className: 'muted', textContent: srv.description }),
      el('div', { className: 'tool-form' }, ...fields),
      el('p', { className: 'muted', textContent: 'As alterações valem na próxima vez que o servidor for iniciado.' }),
      el('div', { className: 'server-log-head' }, el('strong', { textContent: 'Saída do servidor' }), clear),
      logBox,
    );
    detail = {
      kind: srv.kind,
      read: () => Object.fromEntries([...inputs].map(([k, input]) => [k, input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value])),
      append: (line) => {
        logBox.textContent += `${logBox.textContent ? '\n' : ''}${line}`;
        logBox.scrollTop = logBox.scrollHeight;
      },
    };
    return node;
  }

  function selectServer(kind) {
    selected = kind;
    const srv = servers.find((s) => s.kind === kind);
    for (const s of servers) renderRow(s);
    body.querySelector('.server-detail')?.replaceWith(renderDetail(srv));
  }

  async function load() {
    servers = await ctx.api.serversList();
    const list = el('div', { className: 'server-list' });
    for (const srv of servers) {
      const badge = el('span', { className: 'server-state' });
      const startBtn = el('button', { type: 'button', className: 'primary', textContent: 'Iniciar' });
      const stopBtn = el('button', { type: 'button', textContent: 'Parar' });
      const name = el('button', { type: 'button', className: 'server-name', textContent: srv.title });
      const node = el('div', { className: 'server-row' }, name, badge, el('span', { className: 'row-actions' }, startBtn, stopBtn));
      node.dataset.kind = srv.kind;
      name.addEventListener('click', () => selectServer(srv.kind));
      startBtn.addEventListener('click', () => {
        if (selected !== srv.kind) selectServer(srv.kind);
        void start(srv);
      });
      stopBtn.addEventListener('click', () => ctx.api.serversStop(srv.kind));
      rows.set(srv.kind, { node, badge, start: startBtn, stop: stopBtn });
      list.append(node);
    }
    body.replaceChildren(list, el('div', { className: 'server-detail' }));
    selectServer(servers[0].kind);
    ticker = setInterval(() => {
      for (const s of servers) if (s.state?.stopAt) renderRow(s);
    }, 1000);
  }
  load().catch((err) => {
    status.textContent = ctx.cleanError(err);
  });

  return {
    title: 'Servidores',
    content: [body, status],
    onServersEvent: (ev) => {
      const srv = servers.find((s) => s.kind === ev.kind);
      if (!srv) return;
      srv.state = ev.state;
      if (ev.line) {
        srv.log.push(ev.line);
        if (detail?.kind === ev.kind) detail.append(ev.line);
      }
      renderRow(srv);
    },
    onClose: () => clearInterval(ticker),
  };
}

// ---------- VPN (motor IPsec do MultTerm) ----------

const VPN_STATES = { connecting: 'Conectando…', connected: 'Conectada', disconnecting: 'Desconectando…', off: 'Desconectada' };

/**
 * Editor de site de VPN montado a partir do esquema do processo principal (campos, grupos,
 * opções e dependências). A PSK nunca vem preenchida: em branco mantém a atual.
 */
async function siteEditor(ctx, name, { onSaved, onCancel, status }) {
  const [schema, site] = await Promise.all([ctx.api.vpnSiteSchema(), ctx.api.vpnSiteGet(name)]);
  const inputs = new Map();
  const labels = new Map();
  const nameInput = el('input', { name: 'site-name', required: true, value: site.name, autocomplete: 'off', maxLength: 100 });
  let psk = null;

  const control = (f) => {
    const value = site.values[f.key] ?? '';
    if (f.input === 'select') {
      const opts = [...f.options];
      if (value && !opts.some(([v]) => v === value)) opts.push([value, `${value} (atual)`]);
      return select(f.key, opts, value || opts[0][0]);
    }
    if (f.input === 'bool') return el('input', { type: 'checkbox', name: f.key, checked: value === '1' });
    if (f.input === 'secret') {
      psk = secret(f.key, site.pskSet ? 'em branco mantém' : 'obrigatória');
      return psk.node;
    }
    return el('input', {
      name: f.key, value, autocomplete: 'off',
      ...(f.input === 'number' ? { type: 'number', min: f.min, max: f.max } : {}),
      ...(f.hint ? { placeholder: f.hint } : {}),
    });
  };
  const valueOf = (key) => {
    const input = inputs.get(key);
    if (!input) return site.values[key] ?? '';
    if (input.type === 'checkbox') return input.checked ? '1' : '0';
    return input.value;
  };

  const groups = new Map();
  for (const f of schema) {
    const input = control(f);
    const real = f.input === 'secret' ? psk.input : input;
    inputs.set(f.key, real);
    const label = f.input === 'bool'
      ? el('label', { className: 'check' }, input, f.label)
      : el('label', { className: f.input === 'networks' ? 'wide' : '' }, f.label, input);
    labels.set(f.key, label);
    const id = `${f.advanced ? 'a' : 'b'}:${f.group}`;
    if (!groups.has(id)) groups.set(id, { title: f.group, advanced: !!f.advanced, nodes: [] });
    groups.get(id).nodes.push(label);
  }

  // Mostra cada campo só quando a dependência dele está satisfeita (em cadeia).
  const visible = (key) => {
    const f = schema.find((x) => x.key === key);
    if (!f?.when) return true;
    return visible(f.when.key) && f.when.values.includes(valueOf(f.when.key));
  };
  const sync = () => {
    for (const f of schema) labels.get(f.key).hidden = !visible(f.key);
  };

  const section = (g) => el('fieldset', { className: 'site-group' }, el('legend', { textContent: g.title }), el('div', { className: 'tool-form' }, ...g.nodes));
  const basic = [...groups.values()].filter((g) => !g.advanced);
  const advanced = [...groups.values()].filter((g) => g.advanced);
  const save = el('button', { type: 'submit', className: 'primary', textContent: 'Salvar site' });
  const cancel = el('button', { type: 'button', textContent: 'Cancelar' });
  const form = el('form', { className: 'site-editor' },
    el('h3', { textContent: name ? `Editar site "${name}"` : 'Novo site' }),
    el('div', { className: 'tool-form' }, el('label', { className: 'wide' }, 'Nome do site', nameInput)),
    ...basic.map(section),
    el('details', { className: 'site-advanced' }, el('summary', { textContent: 'Avançado (cliente, rede, fases 1 e 2, políticas)' }),
      ...advanced.map(section)),
    el('p', {
      className: 'muted',
      textContent: 'Os valores precisam bater com a configuração do gateway. Opções que o editor não mostra (certificados, por ' +
        'exemplo) são mantidas como estão no arquivo do site.',
    }),
    el('div', { className: 'actions' }, save, cancel),
  );
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  cancel.addEventListener('click', onCancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of schema) {
      // Campo oculto não vai: o valor do arquivo fica como está.
      if (f.input === 'secret' || !visible(f.key)) continue;
      values[f.key] = valueOf(f.key);
    }
    if (!name && visible('auth-mutual-psk') && !psk.input.value) {
      status.textContent = 'Informe a chave compartilhada (PSK).';
      psk.input.focus();
      return;
    }
    save.disabled = true;
    try {
      const saved = await ctx.api.vpnSiteSave({ original: name || undefined, name: nameInput.value, values, psk: psk.input.value });
      psk.input.value = '';
      onSaved(saved);
    } catch (err) {
      status.textContent = ctx.cleanError(err);
      save.disabled = false;
    }
  });
  sync();
  return { form, focus: () => nameInput.focus() };
}

function vpnPanel(ctx, tab) {
  const body = el('div');
  const status = statusLine();
  let onStatus = () => {};

  function renderUnsupported() {
    body.replaceChildren(el('p', { textContent: 'A VPN do MultTerm só funciona no Windows (usa o adaptador Wintun).' }));
  }

  function renderForm(info) {
    const site = el('select', { name: 'site' },
      ...info.sites.map((s) => el('option', {
        value: s.name, textContent: `${s.name} — ${s.host}${s.port ? `:${s.port}` : ''}`,
      })));
    const importBtn = el('button', { type: 'button', textContent: 'Importar site (.vpn)…' });
    const newBtn = el('button', { type: 'button', textContent: 'Novo site' });
    const editBtn = el('button', { type: 'button', textContent: 'Editar' });
    const exportBtn = el('button', { type: 'button', textContent: 'Exportar…' });
    const deleteBtn = el('button', { type: 'button', className: 'danger', textContent: 'Excluir' });
    const user = el('input', { name: 'user', autocomplete: 'off' });
    const pass = secret('password');
    const connectBtn = el('button', { type: 'submit', className: 'primary', textContent: 'Conectar' });
    const disconnectBtn = el('button', { type: 'button', textContent: 'Desconectar', disabled: true });
    const state = el('p', { className: 'vpn-state' });
    const log = el('pre', { className: 'dns-result vpn-log' });
    const networks = el('div', { className: 'vpn-networks' });
    const userField = field('Usuário', user);
    const passField = field('Senha', pass.node);
    const notice = el('p', {
      className: 'muted',
      textContent: 'O MultTerm conecta sozinho (IPsec/IKEv1) e cria o adaptador "MultTerm VPN": o Windows pede permissão de ' +
        'administrador (UAC) a cada conexão. A senha não é gravada. A conexão continua ao fechar esta aba e é encerrada ao sair do MultTerm.',
    });

    const current = () => info.sites.find((s) => s.name === site.value);
    let vpnState = info.status;
    const syncSite = () => {
      const s = current();
      userField.hidden = passField.hidden = !s?.credentials;
      if (s && !user.value) user.value = s.savedUser ?? '';
      const inUse = vpnState && vpnState.state !== 'off' && vpnState.site === s?.name;
      editBtn.disabled = exportBtn.disabled = !s;
      deleteBtn.disabled = !s || !!inUse;
      deleteBtn.title = inUse ? 'desconecte antes de excluir' : '';
    };
    if (ctx.vpnSite && info.sites.some((s) => s.name === ctx.vpnSite)) site.value = ctx.vpnSite;
    site.addEventListener('change', () => {
      user.value = '';
      syncSite();
    });
    syncSite();

    importBtn.addEventListener('click', async () => {
      try {
        const added = await ctx.api.vpnImport();
        if (!added) return;
        ctx.vpnSite = added.name;
        await load();
        status.textContent = `Site "${added.name}" importado.`;
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });
    const openEditor = async (name) => {
      status.textContent = '';
      try {
        const ed = await siteEditor(ctx, name, {
          status,
          onSaved: async (saved) => {
            ctx.vpnSite = saved.name;
            await load();
            status.textContent = `Site "${saved.name}" salvo.`;
          },
          onCancel: () => load(),
        });
        body.replaceChildren(ed.form);
        ed.focus();
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    };
    newBtn.addEventListener('click', () => openEditor(null));
    editBtn.addEventListener('click', () => openEditor(site.value));
    exportBtn.addEventListener('click', async () => {
      try {
        const path = await ctx.api.vpnSiteExport(site.value);
        if (path) status.textContent = `Site exportado para ${path}`;
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });
    deleteBtn.addEventListener('click', async () => {
      const name = site.value;
      if (!confirm(`Excluir o site de VPN "${name}"?`)) return;
      try {
        await ctx.api.vpnSiteDelete(name);
        ctx.vpnSite = undefined;
        await load();
        status.textContent = `Site "${name}" excluído.`;
      } catch (err) {
        status.textContent = ctx.cleanError(err);
      }
    });
    disconnectBtn.addEventListener('click', () => ctx.api.vpnDisconnect().catch((err) => {
      status.textContent = ctx.cleanError(err);
    }));

    async function showNetworks() {
      networks.replaceChildren();
      const { ip, networks: nets } = await ctx.api.vpnNetworks().catch(() => ({ networks: [] }));
      if (!ip && !nets.length) return;
      const tbl = table([{ key: 'network', label: 'Rede acessível pela VPN' }]);
      for (const network of nets) {
        const scan = el('button', { type: 'button', className: 'link', textContent: 'Escanear' });
        scan.addEventListener('click', () => ctx.openTool('netscan', { network }));
        tbl.add({ network }, scan);
      }
      networks.replaceChildren(
        ...(ip ? [el('p', { className: 'muted', textContent: `IP recebido na VPN: ${ip}` })] : []),
        ...(nets.length ? [tbl.node] : []),
      );
    }

    onStatus = (s) => {
      if (!s) return;
      vpnState = s;
      syncSite();
      const busy = s.state === 'connecting' || s.state === 'disconnecting';
      const up = s.state === 'connected';
      state.textContent = `${s.site}: ${VPN_STATES[s.state] ?? s.state}${up && s.since ? ` desde ${new Date(s.since).toLocaleTimeString('pt-BR')}` : ''}`;
      state.className = `vpn-state vpn-${s.state}`;
      if (s.error) status.textContent = s.error;
      log.textContent = s.log.trim();
      connectBtn.disabled = busy || up;
      disconnectBtn.disabled = s.state === 'off' || s.state === 'disconnecting';
      site.disabled = editBtn.disabled = busy || up;
      if (up) void showNetworks();
      else networks.replaceChildren();
    };

    const form = el('form', { className: 'tool-form' },
      el('label', { className: 'wide' }, 'Site', site),
      el('div', { className: 'actions site-actions' }, newBtn, editBtn, exportBtn, deleteBtn, importBtn),
      el('div', { className: 'break' }), userField, passField,
      el('div', { className: 'actions' }, connectBtn, disconnectBtn),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.textContent = '';
      connectBtn.disabled = true;
      try {
        await ctx.api.vpnConnect({ site: site.value, user: user.value, password: pass.input.value });
        pass.input.value = '';
        status.textContent = '';
        ctx.vpnThen?.();
        ctx.vpnThen = undefined;
      } catch (err) {
        status.textContent = ctx.cleanError(err);
        connectBtn.disabled = false;
      }
    });

    body.replaceChildren(
      ...(ctx.vpnNotice ? [el('p', { className: 'notice', textContent: ctx.vpnNotice })] : []),
      ...(info.sites.length ? [form] : [
        el('p', {
          textContent: 'Nenhum site de VPN configurado. Crie um aqui ou importe um arquivo .vpn.',
        }),
        el('div', { className: 'actions' }, newBtn, importBtn),
      ]),
      state, networks, log, notice,
    );
    onStatus(info.status);
    (info.sites.length ? (current()?.credentials && user.value ? pass.input : user) : newBtn).focus();
  }

  async function load() {
    status.textContent = 'Carregando os sites…';
    try {
      const info = await ctx.api.vpnInfo();
      status.textContent = '';
      if (!info.supported) renderUnsupported();
      else renderForm(info);
    } catch (err) {
      status.textContent = ctx.cleanError(err);
    }
  }
  load();

  return {
    title: 'VPN',
    content: [body, status],
    onVpnStatus: (s) => onStatus(s),
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

const PANELS = { portscan: portScanPanel, netscan: netScanPanel, dns: dnsPanel, snmp: snmpPanel, localports: localPortsPanel, wol: wolPanel, capture: capturePanel, vpn: vpnPanel, servers: serversPanel, agent: agentPanel };

/** Cria o painel da ferramenta `kind` dentro de `tab.panel`; devolve os ganchos da aba. */
export function buildToolPanel(kind, ctx, tab) {
  const make = PANELS[kind];
  if (!make) throw new Error(`ferramenta desconhecida: ${kind}`);
  const p = make(ctx, tab);
  tab.panel.append(el('div', { className: 'tool-body' }, el('h2', { textContent: p.title }), ...p.content));
  return p;
}

export const TOOL_TITLES = { portscan: 'Scanner de portas', netscan: 'Scanner de rede', dns: 'Consulta DNS', snmp: 'Consulta SNMP', localports: 'Portas locais', wol: 'Wake-on-LAN', capture: 'Captura de pacotes', vpn: 'VPN', servers: 'Servidores', agent: 'Agente' };

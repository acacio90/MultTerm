import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cidrToNetworks, deleteSite, exportSite, networksToCidr, newSite, readSite, saveSite, SITE_DEFAULTS, SITE_FIELDS,
} from '../src/network/shrew-site.ts';
import { listSites } from '../src/network/shrew.ts';

const ORIGINAL = [
  'n:version:4',
  's:network-host:vpn.example.org',
  's:auth-method:mutual-psk-xauth',
  'b:auth-mutual-psk:c2VncmVkbw==',
  's:auth-server-cert:C:\\certs\\ca.pem',
  'n:phase1-dhgroup:14',
  's:phase1-hash:sha2-256',
  's:policy-list-include:10.0.0.0 / 255.0.0.0,192.168.10.0 / 255.255.255.0',
  'n:policy-list-auto:0',
  '',
].join('\n');

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'multterm-site-'));
  const user = join(root, 'user');
  const pub = join(root, 'public');
  await mkdir(user);
  await mkdir(pub);
  return { root, user, public: pub };
}

test('redes: CIDR na interface, "endereço / máscara" no arquivo', () => {
  assert.equal(networksToCidr('10.0.0.0 / 255.0.0.0,192.168.10.0 / 255.255.255.0'), '10.0.0.0/8, 192.168.10.0/24');
  assert.equal(cidrToNetworks('10.0.0.0/8, 192.168.10.0/24'), '10.0.0.0 / 255.0.0.0,192.168.10.0 / 255.255.255.0');
  assert.equal(cidrToNetworks('172.16.0.0 / 255.240.0.0; 10.1.1.1/32'), '172.16.0.0 / 255.240.0.0,10.1.1.1 / 255.255.255.255');
  assert.equal(cidrToNetworks(''), '');
  assert.throws(() => cidrToNetworks('10.0.0.0'), /rede inválida/);
  assert.throws(() => cidrToNetworks('10.0.0.0/33'), /máscara inválida/);
  assert.throws(() => cidrToNetworks('10.0.0.0/255.0.255.0'), /máscara inválida/);
});

test('o esquema cobre os padrões e as opções são coerentes', () => {
  const keys = new Set(SITE_FIELDS.map((f) => f.key));
  for (const [k, v] of Object.entries(SITE_DEFAULTS)) {
    assert.ok(keys.has(k), k);
    const f = SITE_FIELDS.find((x) => x.key === k)!;
    if (f.options) assert.ok(f.options.some(([o]) => o === v), `${k}=${v}`);
  }
  for (const f of SITE_FIELDS) if (f.when) assert.ok(keys.has(f.when.key), `${f.key} depende de ${f.when.key}`);
  assert.equal(newSite().values['phase1-hash'], 'sha2-256');
});

test('readSite não expõe a PSK e converte as redes', async () => {
  const d = await dirs();
  try {
    await writeFile(join(d.user, 'Matriz'), ORIGINAL);
    const site = await readSite(d, 'matriz');
    assert.equal(site.pskSet, true);
    assert.equal(JSON.stringify(site).includes('c2VncmVkbw'), false);
    assert.equal(site.values['policy-list-include'], '10.0.0.0/8, 192.168.10.0/24');
    assert.equal(site.values['auth-server-cert'], undefined); // chave fora do editor
    await assert.rejects(readSite(d, 'nao-existe'), /não encontrado/);
  } finally {
    await rm(d.root, { recursive: true, force: true });
  }
});

test('saveSite edita mantendo a ordem, a PSK e as chaves desconhecidas', async () => {
  const d = await dirs();
  try {
    await writeFile(join(d.user, 'Matriz'), ORIGINAL);
    await saveSite(d, {
      original: 'Matriz', name: 'Matriz',
      values: { 'network-host': 'novo.example.org', 'phase1-dhgroup': '15', 'policy-list-include': '10.0.0.0/8', 'client-ip-addr': '', 'network-ike-port': '500' },
    });
    const text = await readFile(join(d.user, 'Matriz'), 'utf8');
    assert.equal(text, [
      'n:version:4',
      's:network-host:novo.example.org',
      's:auth-method:mutual-psk-xauth',
      'b:auth-mutual-psk:c2VncmVkbw==',
      's:auth-server-cert:C:\\certs\\ca.pem',
      'n:phase1-dhgroup:15',
      's:phase1-hash:sha2-256',
      's:policy-list-include:10.0.0.0 / 255.0.0.0',
      'n:policy-list-auto:0',
      'n:network-ike-port:500',
      '',
    ].join('\n'));
    // Nova PSK e renomear.
    await saveSite(d, { original: 'Matriz', name: 'Matriz 2', values: {}, psk: 'nova chave' });
    assert.deepEqual(await readdir(d.user), ['Matriz 2']);
    assert.match(await readFile(join(d.user, 'Matriz 2'), 'utf8'), new RegExp(`b:auth-mutual-psk:${Buffer.from('nova chave').toString('base64')}`));
  } finally {
    await rm(d.root, { recursive: true, force: true });
  }
});

test('saveSite cria site novo, valida e não sobrescreve outro', async () => {
  const d = await dirs();
  try {
    const created = await saveSite(d, { name: 'Filial', values: { ...SITE_DEFAULTS, 'network-host': '10.9.9.9' }, psk: 'segredo' });
    assert.equal(created.pskSet, true);
    const [site] = await listSites({ user: d.user });
    assert.deepEqual([site.name, site.host, site.credentials], ['Filial', '10.9.9.9', true]);
    const text = await readFile(join(d.user, 'Filial'), 'utf8');
    assert.match(text, /^n:version:4\n/);
    assert.match(text, /\ns:phase2-hmac:sha2-256\n/);

    const bad: [Record<string, unknown>, RegExp][] = [
      [{ 'network-host': '' }, /gateway/],
      [{ 'network-host': '-x' }, /gateway/],
      [{ 'network-host': 'h', 'phase1-hash': 'sha3' }, /opção inválida/],
      [{ 'network-host': 'h', 'network-ike-port': '70000' }, /Porta IKE/],
      [{ 'network-host': 'h', 'client-ip-addr': '10.0.0' }, /IPv4/],
      [{ 'network-host': 'h', 'policy-list-auto': '2' }, /valor inválido/],
      [{ 'network-host': 'h', 'client-dns-suffix': 'a\nb' }, /valor inválido/],
    ];
    for (const [values, re] of bad) await assert.rejects(saveSite(d, { name: 'Outro', values }), re, JSON.stringify(values));
    await assert.rejects(saveSite(d, { name: 'filial', values: { 'network-host': 'h' } }), /já existe/);
    await assert.rejects(saveSite(d, { name: 'a/b', values: { 'network-host': 'h' } }), /nome do site inválido/);
  } finally {
    await rm(d.root, { recursive: true, force: true });
  }
});

test('site público editado vira cópia do usuário; excluir só os do usuário; exportar', async () => {
  const d = await dirs();
  try {
    await writeFile(join(d.public, 'Campus'), ORIGINAL);
    await saveSite(d, { original: 'Campus', name: 'Campus', values: { 'network-host': 'campus.example.org' } });
    assert.deepEqual(await readdir(d.public), ['Campus']); // o público fica intacto
    assert.equal((await readSite(d, 'Campus')).public, false);
    await deleteSite(d, 'Campus');
    assert.equal((await readSite(d, 'Campus')).public, true); // volta a valer o público
    await assert.rejects(deleteSite(d, 'Campus'), /não é do usuário/);

    const dest = join(d.root, 'Campus.vpn');
    await exportSite(d, 'Campus', dest);
    assert.equal(await readFile(dest, 'utf8'), ORIGINAL);
  } finally {
    await rm(d.root, { recursive: true, force: true });
  }
});

test('readSite completa chaves ausentes com os padrões', async () => {
  const d = await dirs();
  try {
    await writeFile(join(d.user, 'Curto'), 's:network-host:h\nn:phase1-dhgroup:2\n');
    const site = await readSite(d, 'Curto');
    assert.equal(site.values['phase1-dhgroup'], '2'); // o do arquivo vale
    assert.equal(site.values['phase2-hmac'], 'sha2-256'); // ausente: padrão
    assert.equal(site.values['client-addr-auto'], '1');
  } finally {
    await rm(d.root, { recursive: true, force: true });
  }
});

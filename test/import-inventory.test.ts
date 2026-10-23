import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandHostPattern, parseInventory } from '../src/sessions/import-inventory.ts';
import { readImportFile } from '../src/sessions/import.ts';
import { saveSessionFile } from '../src/sessions/store.ts';

const INI = `
# comentário
solto.example.org

[web]
web[01:02].example.org user=deploy
lb.example.org host=10.0.0.5 port=2222 identityFile="~/.ssh/chave lb"

[db]
db1 host=10.0.0.10

[producao:children]
web
db

[producao:vars]
user = admin

[windows]
ad01 host=10.0.0.20 type=rdp port=3390 user=administrador

[outros]
errado type=telnet
tpl host="{{ lookup('env', 'X') }}"
mal host=-oProxyCommand=calc
`;

test('expande faixas numéricas (com zeros) e alfabéticas', () => {
  assert.deepEqual(expandHostPattern('web[01:03].x'), ['web01.x', 'web02.x', 'web03.x']);
  assert.deepEqual(expandHostPattern('db-[a:c]'), ['db-a', 'db-b', 'db-c']);
  assert.deepEqual(expandHostPattern('n[1:5:2]'), ['n1', 'n3', 'n5']);
  assert.deepEqual(expandHostPattern('simples'), ['simples']);
});

test('INI: grupos viram pastas (filhos aninhados) e variáveis seguem a precedência', () => {
  const { sessions } = parseInventory(INI);
  const by = (folder: string, name: string) => sessions.find((s) => s.folder === folder && s.name === name);

  assert.deepEqual(by('', 'solto.example.org'), { name: 'solto.example.org', folder: '', type: 'ssh', host: 'solto.example.org' });
  // host > grupo > grupo pai: web01 tem user próprio; db1 herda "admin" de producao:vars
  assert.equal(by('producao/web', 'web01.example.org')?.user, 'deploy');
  assert.equal(by('producao/web', 'web02.example.org')?.user, 'deploy');
  assert.equal(by('producao/db', 'db1')?.user, 'admin');
  assert.equal(by('producao/db', 'db1')?.host, '10.0.0.10');
  assert.deepEqual(by('producao/web', 'lb.example.org'), {
    name: 'lb.example.org', folder: 'producao/web', type: 'ssh', host: '10.0.0.5', port: 2222, user: 'admin',
    identityFile: '~/.ssh/chave lb',
  });
});

test('INI: type=rdp vira RDP; type desconhecido, template e host inválido geram aviso', () => {
  const { sessions, warnings } = parseInventory(INI);
  assert.deepEqual(sessions.find((s) => s.name === 'ad01'), {
    name: 'ad01', folder: 'windows', type: 'rdp', host: '10.0.0.20', port: 3390, user: 'administrador',
  });
  assert.equal(sessions.some((s) => s.name === 'errado'), false);
  assert.equal(sessions.find((s) => s.name === 'tpl')?.host, 'tpl');
  assert.equal(sessions.some((s) => s.name === 'mal'), false);
  assert.ok(warnings.some((w) => /"type" deve ser/.test(w)));
  assert.ok(warnings.some((w) => /usa template/.test(w)));
  assert.ok(warnings.some((w) => /"host" inválido/.test(w)));
});

test('YAML: all → children → hosts, com vars de grupo e pasta raiz opcional', () => {
  const yaml = `
all:
  vars:
    user: ops
  children:
    rede:
      children:
        switches:
          hosts:
            sw[1:2]:
              host: 10.1.0.1
    servidores:
      hosts:
        app01:
          port: 2200
`;
  const { sessions } = parseInventory(yaml, 'Inventario');
  assert.deepEqual(sessions.map((s) => `${s.folder}/${s.name}`).sort(), [
    'Inventario/rede/switches/sw1', 'Inventario/rede/switches/sw2', 'Inventario/servidores/app01',
  ]);
  assert.equal(sessions.find((s) => s.name === 'app01')?.port, 2200);
  assert.ok(sessions.every((s) => s.user === 'ops'));
});

test('readImportFile detecta o formato do arquivo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-'));
  try {
    const own = join(dir, 'sessions.yaml');
    await saveSessionFile(own, [{ name: 'a', folder: '', type: 'ssh', host: 'a.example.org' }]);
    assert.equal((await readImportFile(own)).format, 'multterm');

    const ini = join(dir, 'hosts.ini');
    await writeFile(ini, INI);
    const r = await readImportFile(ini);
    assert.equal(r.format, 'inventory');
    assert.ok(r.sessions.length >= 6);

    await assert.rejects(readImportFile(join(dir, 'nao-existe.yaml')), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

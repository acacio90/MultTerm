import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/sessions/model.ts';
import { exportFileName, groupByFolder, loadSessionFile, mergeSessions, parseSessions, saveSessionFile, serializeSessions, sessionsInFolder, validateSessions } from '../src/sessions/store.ts';

const A: Session = { name: 'ZABBIX', folder: 'Servidores/Monitoramento', type: 'ssh', host: 'zabbix.example.org', port: 22, user: 'pedro' };
const B: Session = { name: 'ANSIBLE', folder: 'Servidores/Infraestrutura', type: 'ssh', host: 'ansible.example.org', port: 2222 };
const C: Session = { name: 'GERENTE AD', folder: '', type: 'rdp', host: '10.0.0.9' };

test('serialização é determinística e omite porta padrão', () => {
  const text = serializeSessions([A, B, C]);
  assert.equal(text, serializeSessions([C, A, B]));
  assert.match(text, /^# Sessões do MultTerm/);
  assert.doesNotMatch(text, /port: 22\b/);
  assert.match(text, /port: 2222/);
  // raiz primeiro, depois pastas em ordem alfabética
  assert.ok(text.indexOf('GERENTE AD') < text.indexOf('ANSIBLE'));
  assert.ok(text.indexOf('ANSIBLE') < text.indexOf('ZABBIX'));
});

test('ida e volta YAML preserva as sessões', () => {
  const back = parseSessions(serializeSessions([A, B, C]));
  assert.deepEqual(back.map((s) => s.name), ['GERENTE AD', 'ANSIBLE', 'ZABBIX']);
  assert.equal(back[1].port, 2222);
  assert.equal(back[2].user, 'pedro');
});

test('validação: campos obrigatórios, tipo, porta e duplicadas', () => {
  assert.throws(() => parseSessions('sessions:\n  - host: x'), /"name" é obrigatório/);
  assert.throws(() => parseSessions('sessions:\n  - name: a'), /"host" é obrigatório/);
  assert.throws(() => parseSessions('sessions:\n  - {name: a, host: x, type: vnc}'), /"type"/);
  assert.throws(() => parseSessions('sessions:\n  - {name: a, host: x, port: 70000}'), /"port" inválida/);
  assert.throws(() => parseSessions('sessions:\n  - {name: a, host: x}\n  - {name: a, host: y}'), /duplicada "a"/);
  assert.throws(() => parseSessions('version: 2\nsessions: []'), /versão 2/);
});

test('type padrão é ssh e pasta aceita "\\"', () => {
  const [s] = parseSessions('sessions:\n  - {name: a, host: x, folder: "Rede\\\\Wi-Fi"}');
  assert.equal(s.type, 'ssh');
  assert.equal(s.folder, 'Rede/Wi-Fi');
});

test('merge mantém existentes e acrescenta novas', () => {
  const changed = { ...A, host: 'outro.example.org' };
  const { merged, added, skipped } = mergeSessions([A], [changed, B]);
  assert.deepEqual(added, [B]);
  assert.deepEqual(skipped, [changed]);
  assert.equal(merged.find((s) => s.name === 'ZABBIX')?.host, 'zabbix.example.org');
});

test('groupByFolder agrupa na ordem do arquivo', () => {
  assert.deepEqual([...groupByFolder([A, B, C]).keys()], ['', 'Servidores/Infraestrutura', 'Servidores/Monitoramento']);
});

test('arquivo inexistente vira lista vazia; salvar e recarregar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-'));
  try {
    const file = join(dir, 'sessions.yaml');
    assert.deepEqual(await loadSessionFile(file), []);
    await saveSessionFile(file, [A, B, C]);
    assert.equal((await loadSessionFile(file)).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateSessions valida listas vindas da interface', () => {
  assert.equal(validateSessions([{ name: 'a', host: 'x' }], 'ui').length, 1);
  assert.throws(() => validateSessions({}, 'ui'), /deve ser uma lista/);
  assert.throws(() => validateSessions([{ name: 'a', host: 'x' }, { name: 'a', host: 'y' }], 'ui'), /duplicada/);
});

test('host e usuário não podem virar opções do ssh', () => {
  assert.throws(() => validateSessions([{ name: 'a', host: '-oProxyCommand=calc' }], 'ui'), /"host" inválido/);
  assert.throws(() => validateSessions([{ name: 'a', host: 'h x' }], 'ui'), /"host" inválido/);
  assert.throws(() => validateSessions([{ name: 'a', host: 'h', user: '-oX' }], 'ui'), /"user" inválido/);
  assert.throws(() => validateSessions([{ name: 'a', host: 'h', user: 'a@b' }], 'ui'), /"user" inválido/);
  assert.equal(validateSessions([{ name: 'a', host: 'h', user: 'DOMINIO\\pedro' }], 'ui')[0].user, 'DOMINIO\\pedro');
});

test('sessionsInFolder e exportFileName', () => {
  assert.deepEqual(sessionsInFolder([A, B, C], 'Servidores').map((s) => s.name).sort(), ['ANSIBLE', 'ZABBIX']);
  assert.deepEqual(sessionsInFolder([A, B, C], 'Servidores/Monitoramento').map((s) => s.name), ['ZABBIX']);
  assert.deepEqual(sessionsInFolder([A, B, C], 'Servid'), []);
  assert.equal(sessionsInFolder([A, B, C], '').length, 3);
  const day = new Date('2026-10-13T12:00:00Z');
  assert.equal(exportFileName('', day), 'multterm-sessoes-2026-10-13.yaml');
  assert.equal(exportFileName('Servidores/Produção', day), 'multterm-Servidores-Produção-2026-10-13.yaml');
});

test('legacyTls: só em sessões RDP, gravado só quando ligado', () => {
  const [rdp, ssh] = validateSessions([
    { name: 'AD', type: 'rdp', host: '10.0.0.9', legacyTls: true },
    { name: 'web', type: 'ssh', host: '10.0.0.1', legacyTls: true },
  ], 'teste');
  assert.equal(rdp.legacyTls, true);
  assert.equal(ssh.legacyTls, undefined);
  assert.equal(validateSessions([{ name: 'AD', type: 'rdp', host: '10.0.0.9', legacyTls: false }], 'teste')[0].legacyTls, undefined);
  assert.throws(() => validateSessions([{ name: 'AD', type: 'rdp', host: '10.0.0.9', legacyTls: 'sim' }], 'teste'), /legacyTls/);
  const yaml = serializeSessions([rdp, { ...C }]);
  assert.equal(yaml.match(/legacyTls: true/g)?.length, 1);
});

test('legacySsh: só em sessões SSH, gravado só quando ligado', () => {
  const [ssh, rdp] = validateSessions([
    { name: 'SW', type: 'ssh', host: '172.17.0.2', legacySsh: true },
    { name: 'AD', type: 'rdp', host: '10.0.0.9', legacySsh: true },
  ], 'teste');
  assert.equal(ssh.legacySsh, true);
  assert.equal(rdp.legacySsh, undefined);
  assert.throws(() => validateSessions([{ name: 'SW', type: 'ssh', host: '1.2.3.4', legacySsh: 1 }], 'teste'), /legacySsh/);
  assert.match(serializeSessions([ssh]), /legacySsh: true/);
});

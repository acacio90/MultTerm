import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupFileName, parseBackup, serializeBackup } from '../src/desktop/backup.ts';

const SITE = 's:network-host:vpn.example.org\ns:auth-method:mutual-psk\n';

test('backup: ida e volta', () => {
  const text = serializeBackup({
    createdAt: '2026-10-13T12:00:00.000Z',
    appVersion: '0.4.0',
    sessions: [{ name: 'web', host: '10.0.0.1' }],
    sessionDefaults: { identityFile: '~/.ssh/geral' },
    vpnSites: [{ name: 'Matriz', content: SITE }],
    servers: { tftp: { port: 69 } },
    agent: { port: 47830, agent: 'claude' },
  });
  const b = parseBackup(text);
  assert.equal(b.format, 'multterm-backup');
  assert.deepEqual(b.sessions, [{ name: 'web', host: '10.0.0.1' }]);
  assert.deepEqual(b.sessionDefaults, { identityFile: '~/.ssh/geral' });
  assert.deepEqual(b.vpnSites, [{ name: 'Matriz', content: SITE }]);
  assert.deepEqual(b.servers, { tftp: { port: 69 } });
  assert.deepEqual(b.agent, { port: 47830, agent: 'claude' });
});

test('backup: partes ausentes viram vazias', () => {
  const b = parseBackup(JSON.stringify({ format: 'multterm-backup', version: 1 }));
  assert.deepEqual([b.sessions, b.vpnSites, b.servers, b.agent], [[], [], {}, {}]);
  assert.equal(b.sessionDefaults, undefined);
});

test('backup: recusa o que não é backup ou está corrompido', () => {
  const bad = (o: unknown) => () => parseBackup(JSON.stringify(o));
  assert.throws(() => parseBackup('não é json'), /JSON inválido/);
  assert.throws(bad({ format: 'outra' }), /não é um backup/);
  assert.throws(bad([]), /não é um backup/);
  assert.throws(bad({ format: 'multterm-backup', version: 2 }), /versão de backup não suportada/);
  assert.throws(bad({ format: 'multterm-backup', version: 1, sessions: {} }), /"sessions"/);
  // Nome de site que escaparia da pasta de sites.
  assert.throws(bad({ format: 'multterm-backup', version: 1, vpnSites: [{ name: '..\\x', content: SITE }] }), /nome de site/);
  assert.throws(bad({ format: 'multterm-backup', version: 1, vpnSites: [{ name: 'X', content: 's:auth-method:x\n' }] }), /gateway/);
  assert.throws(bad({ format: 'multterm-backup', version: 1, servers: [] }), /"servers"/);
});

test('backup: nome sugerido com a data', () => {
  assert.equal(backupFileName(new Date(2026, 0, 5)), 'MultTerm-backup-2026-01-05.multterm');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteToVpnOptions } from '../src/vpn/site-config.ts';
import { clearScript, netScript } from '../src/vpn/netconfig.ts';
import { parseCidr } from '../src/vpn/tunnel.ts';
import { IdType } from '../src/vpn/ike/packet.ts';
import { PIPE_RE, TOKEN_RE } from '../src/vpn/helper.ts';

const SITE = [
  's:network-host:vpn.example.org', 'n:network-ike-port:500', 'n:network-natt-port:4500', 's:network-natt-mode:enable',
  's:auth-method:mutual-psk-xauth', `b:auth-mutual-psk:${Buffer.from('chave').toString('base64')}`,
  's:phase1-exchange:main', 'n:phase1-dhgroup:14', 's:phase1-cipher:aes', 'n:phase1-keylen:256', 's:phase1-hash:sha2-256',
  'n:phase1-life-secs:86400', 's:phase2-transform:esp-aes', 'n:phase2-keylen:256', 's:phase2-hmac:sha2-256',
  'n:phase2-pfsgroup:14', 'n:phase2-life-secs:28800', 's:client-auto-mode:pull', 'n:client-addr-auto:1',
  'n:client-dns-used:1', 'n:client-dns-auto:1', 'n:policy-list-auto:1', 's:ident-client-type:address', '',
].join('\n');

test('site do Shrew vira a configuração do motor', () => {
  const o = siteToVpnOptions(SITE, { user: 'ana', password: 'x' });
  assert.equal(o.ike.host, 'vpn.example.org');
  assert.equal(o.ike.psk.toString(), 'chave');
  assert.equal(o.ike.xauth, true);
  assert.equal(o.ike.user, 'ana');
  assert.equal(o.ike.dhGroup, 14);
  assert.deepEqual(o.ike.phase1, [{ cipher: 'aes', keyBits: 256, hash: 'sha256' }]);
  assert.deepEqual(o.ike.phase2, [{ cipher: 'aes', keyBits: 256, hash: 'sha256' }]);
  assert.equal(o.ike.pfsGroup, 14);
  assert.equal(o.ike.phase2Life, 28800);
  assert.equal(o.ike.modeConfig, true);
  assert.equal(o.networks, undefined);
  assert.deepEqual(o.dns, { use: true });
});

test('opções "auto", redes manuais, DNS fixo e identificação', () => {
  const site = SITE
    .replace('s:phase1-cipher:aes', 's:phase1-cipher:auto').replace('n:phase1-keylen:256', 'n:phase1-keylen:0')
    .replace('s:phase1-hash:sha2-256', 's:phase1-hash:auto')
    .replace('n:policy-list-auto:1', 'n:policy-list-auto:0\ns:policy-list-include:10.0.0.0 / 255.0.0.0,192.168.5.0 / 255.255.255.0')
    .replace('n:client-dns-auto:1', 'n:client-dns-auto:0\ns:client-dns-addr:10.0.0.53')
    .replace('s:ident-client-type:address', 's:ident-client-type:fqdn\ns:ident-client-data:cliente.example.org');
  const o = siteToVpnOptions(site, { user: 'ana', password: 'x' });
  assert.equal(o.ike.phase1.length, 4 * 3); // AES 256/192/128 + 3DES × SHA-256/SHA-1/MD5
  assert.deepEqual(o.ike.phase1[0], { cipher: 'aes', keyBits: 256, hash: 'sha256' });
  assert.deepEqual(o.networks, ['10.0.0.0/8', '192.168.5.0/24']);
  assert.deepEqual(o.dns, { use: true, servers: ['10.0.0.53'] });
  assert.equal(o.ike.localId?.type, IdType.FQDN);
  assert.equal(o.ike.localId?.data.toString(), 'cliente.example.org');
});

test('o que o motor ainda não suporta é recusado com mensagem clara', () => {
  const cases: [string, RegExp][] = [
    [SITE.replace('mutual-psk-xauth', 'hybrid-rsa-xauth'), /use o Shrew/],
    [SITE.replace('s:phase1-exchange:main', 's:phase1-exchange:aggressive'), /aggressive/],
    [SITE.replace('s:network-natt-mode:enable', 's:network-natt-mode:disable'), /NAT-T/],
    [SITE.replace('s:phase1-cipher:aes', 's:phase1-cipher:blowfish'), /blowfish/],
    [SITE.replace(/b:auth-mutual-psk:.*\n/, ''), /chave compartilhada/],
    [SITE.replace('s:client-auto-mode:pull', 's:client-auto-mode:push'), /push/],
  ];
  for (const [site, re] of cases) assert.throws(() => siteToVpnOptions(site, { user: 'a', password: 'b' }), re);
  assert.throws(() => siteToVpnOptions(SITE, {}), /usuário e senha/);
  // Sem XAuth não pede usuário.
  const psk = siteToVpnOptions(SITE.replace('mutual-psk-xauth', 'mutual-psk'), {});
  assert.equal(psk.ike.xauth, false);
});

test('scripts de rede: só valores validados, túnel completo protege a rota do gateway', () => {
  const s = netScript(123n, { address: '10.98.0.10', dns: ['10.99.0.53'], domain: 'corp.example', networks: ['10.99.0.0/24'] }, '203.0.113.5');
  assert.match(s, /\$luid = \[uint64\]123/);
  assert.match(s, /New-NetIPAddress -InterfaceIndex \$i -IPAddress '10.98.0.10' -PrefixLength 32/);
  assert.match(s, /-DestinationPrefix '10.99.0.0\/24' -NextHop '0.0.0.0'/);
  assert.match(s, /Set-DnsClientServerAddress -InterfaceIndex \$i -ServerAddresses @\('10.99.0.53'\)/);
  assert.match(s, /ConnectionSpecificSuffix 'corp.example'/);
  assert.doesNotMatch(s, /Find-NetRoute/);
  const full = netScript(1n, { address: '10.98.0.10', dns: [], networks: ['0.0.0.0/0'] }, '203.0.113.5');
  assert.match(full, /Find-NetRoute -RemoteIPAddress '203.0.113.5'/);
  assert.match(full, /'0.0.0.0\/1'/);
  assert.match(full, /'128.0.0.0\/1'/);
  assert.doesNotMatch(full, /'0.0.0.0\/0'/);
  for (const bad of [
    { address: "10.0.0.1'; rm", dns: [], networks: [] },
    { address: '10.0.0.1', dns: ['x'], networks: [] },
    { address: '10.0.0.1', dns: [], networks: ['10.0.0.0/40'] },
    { address: '10.0.0.1', dns: [], networks: [], domain: "a'b" },
  ]) assert.throws(() => netScript(1n, bad, '1.2.3.4'), /inválid/);
  assert.match(clearScript('1.2.3.4'), /'1.2.3.4\/32'/);
  assert.throws(() => clearScript('x'), /inválido/);
});

test('parseCidr e formato do canal com o auxiliar', () => {
  assert.deepEqual(parseCidr('10.99.0.0/24'), { net: 0x0a630000, mask: 0xffffff00, bits: 24 });
  assert.deepEqual(parseCidr('10.99.0.7/24').net, 0x0a630000);
  assert.deepEqual(parseCidr('0.0.0.0/0'), { net: 0, mask: 0, bits: 0 });
  assert.ok(PIPE_RE.test(`\\\\.\\pipe\\multterm-vpn-${'a'.repeat(32)}`));
  assert.ok(!PIPE_RE.test('\\\\.\\pipe\\outro'));
  assert.ok(TOKEN_RE.test('f'.repeat(64)));
  assert.ok(!TOKEN_RE.test('x'));
});

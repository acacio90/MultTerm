// Interoperabilidade do motor IKEv1/ESP com um gateway strongSwan real (Docker).
// Rodar com: npm run test:ipsec  (sobe o container e executa este arquivo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IkeClient, type IkeConfig } from '../../src/vpn/ike/client.ts';
import { EspDecrypt, EspEncrypt, icmpEcho } from '../../src/vpn/esp.ts';

const [host, ikePort, nattPort] = (process.env.MULTTERM_IPSEC_GW ?? '127.0.0.1:1500:14500').split(':');

const base: IkeConfig = {
  host, ikePort: Number(ikePort), nattPort: Number(nattPort),
  psk: Buffer.from('chave de teste'), user: 'ana', password: 'senha da ana', xauth: true,
  dhGroup: 14, phase1: [{ cipher: 'aes', keyBits: 256, hash: 'sha256' }],
  phase2: [{ cipher: 'aes', keyBits: 256, hash: 'sha256' }], pfsGroup: 14, modeConfig: true, timeoutMs: 8000,
};

async function connect(cfg: Partial<IkeConfig>) {
  const c = new IkeClient({ ...base, ...cfg });
  c.on('error', () => {});
  return { c, mc: await c.connect().catch((e) => { c.close(false); throw e; }) };
}

test('Main Mode + XAuth + Mode Config + Quick Mode e ping pelo túnel', async () => {
  const { c, mc } = await connect({});
  try {
    assert.match(mc!.address!, /^10\.98\.0\./);
    assert.deepEqual(mc!.dns, ['10.99.0.53']);
    assert.deepEqual(mc!.networks, ['10.99.0.0/24', '10.97.0.0/16']);
    const child = await c.quickMode(mc!.address!, '10.99.0.0/24');
    const out = new EspEncrypt(child.outbound);
    const inn = new EspDecrypt(child.inbound);
    const reply = new Promise<Buffer>((resolve) => { c.onEsp = (p) => resolve(inn.decapsulate(p)); });
    await new Promise((r) => setTimeout(r, 300)); // o gateway instala a SA depois do QM3
    c.sendEsp(out.encapsulate(icmpEcho(mc!.address!, '10.99.0.1', 1, 1)));
    const ip = await Promise.race([reply, new Promise<Buffer>((_, r) => setTimeout(() => r(new Error('sem resposta')), 5000))]);
    assert.equal([...ip.subarray(12, 16)].join('.'), '10.99.0.1');
    assert.equal(ip[20], 0); // echo reply
  } finally {
    c.close();
  }
});

test('outras propostas: AES-128/SHA-1/DH 2 sem PFS', async () => {
  const { c, mc } = await connect({ dhGroup: 2, phase1: [{ cipher: 'aes', keyBits: 128, hash: 'sha1' }], phase2: [{ cipher: 'aes', keyBits: 128, hash: 'sha1' }], pfsGroup: 0 });
  try {
    const child = await c.quickMode(mc!.address!, '10.97.0.0/16');
    assert.equal(child.outbound.encKey.length, 16);
    assert.equal(child.outbound.hash, 'sha1');
  } finally {
    c.close();
  }
});

test('chave compartilhada errada é recusada', async () => {
  await assert.rejects(connect({ psk: Buffer.from('outra chave') }), /chave compartilhada ou identificação errada/);
});

test('senha errada é recusada no XAuth', async () => {
  await assert.rejects(connect({ password: 'errada' }), /usuário ou senha recusados/);
});

test('proposta que o gateway não aceita', async () => {
  await assert.rejects(connect({ dhGroup: 5, phase1: [{ cipher: '3des', hash: 'md5' }] }), /recusou as propostas|tempo esgotado/);
});

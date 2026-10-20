import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { desEncryptBlock, vncAuthResponse } from '../src/servers/des.ts';
import { changedTiles, encodePixels, startVnc, validateVnc, type Frame } from '../src/servers/vnc.ts';

/** Quadro de teste: gradiente determinístico (B = x, G = y, R = x+y). */
function gradient(w: number, h: number): Frame {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    data[p] = x & 0xff;
    data[p + 1] = y & 0xff;
    data[p + 2] = (x + y) & 0xff;
    data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Leitor sequencial de um socket: read(n) espera n bytes. */
function reader(sock: Socket) {
  let buf = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let closed = false;
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    wake?.();
  });
  sock.on('close', () => {
    closed = true;
    wake?.();
  });
  return {
    async read(n: number): Promise<Buffer> {
      while (buf.length < n) {
        if (closed) throw new Error(`conexão fechada (esperava ${n} bytes, havia ${buf.length})`);
        await new Promise<void>((r) => { wake = r; });
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    closed: () => new Promise<void>((r) => (closed ? r() : sock.once('close', () => r()))),
  };
}

async function handshake(port: number, password: string, version = '003.008') {
  const sock = connect(port, '127.0.0.1');
  const r = reader(sock);
  assert.equal((await r.read(12)).toString(), 'RFB 003.008\n');
  sock.write(`RFB ${version}\n`);
  let challenge: Buffer;
  if (version === '003.003') {
    assert.equal((await r.read(4)).readUInt32BE(0), 2);
    challenge = await r.read(16);
  } else {
    assert.deepEqual([...(await r.read(2))], [1, 2]);
    sock.write(Buffer.from([2]));
    challenge = await r.read(16);
  }
  sock.write(vncAuthResponse(password, challenge));
  return { sock, r };
}

async function init(sock: Socket, r: ReturnType<typeof reader>) {
  assert.equal((await r.read(4)).readUInt32BE(0), 0);
  sock.write(Buffer.from([1]));
  const head = await r.read(20);
  const nameLen = (await r.read(4)).readUInt32BE(0);
  return { width: head.readUInt16BE(0), height: head.readUInt16BE(2), bpp: head[4], name: (await r.read(nameLen)).toString() };
}

const fbur = (incremental: boolean, x: number, y: number, w: number, h: number) => {
  const b = Buffer.alloc(10);
  b[0] = 3;
  b[1] = incremental ? 1 : 0;
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  b.writeUInt16BE(w, 6);
  b.writeUInt16BE(h, 8);
  return b;
};

async function readUpdate(r: ReturnType<typeof reader>, bytesPerPixel = 4) {
  const head = await r.read(4);
  assert.equal(head[0], 0);
  const rects: { x: number; y: number; w: number; h: number; enc: number; data: Buffer<ArrayBufferLike> }[] = [];
  for (let i = 0; i < head.readUInt16BE(2); i++) {
    const h = await r.read(12);
    const rect = { x: h.readUInt16BE(0), y: h.readUInt16BE(2), w: h.readUInt16BE(4), h: h.readUInt16BE(6), enc: h.readInt32BE(8), data: Buffer.alloc(0) as Buffer<ArrayBufferLike> };
    if (rect.enc === 0) rect.data = await r.read(rect.w * rect.h * bytesPerPixel);
    rects.push(rect);
  }
  return rects;
}

test('DES e resposta da autenticação VNC', () => {
  assert.equal(desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex'), '85e813540f0ab405');
  const challenge = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const a = vncAuthResponse('segredo', challenge);
  assert.equal(a.length, 16);
  assert.notDeepEqual(a, vncAuthResponse('segredO', challenge));
  // Só os 8 primeiros caracteres contam (limite do protocolo).
  assert.deepEqual(vncAuthResponse('12345678', challenge), vncAuthResponse('12345678xyz', challenge));
});

test('VNC: validação da configuração', () => {
  assert.throws(() => validateVnc({}), /defina a senha/);
  assert.throws(() => validateVnc({ password: '123456789' }), /no máximo 8/);
  assert.throws(() => validateVnc({ password: 'açaí' }), /aceita só/);
  assert.throws(() => validateVnc({ password: 'x', allow: 'pc' }), /cliente permitido inválido/);
  const cfg = validateVnc({ password: 'segredo' });
  assert.equal(cfg.viewOnly, true); // somente visualização por padrão
  assert.equal(cfg.port, 5900);
});

test('VNC: blocos que mudaram e conversão de cor', () => {
  const a = gradient(130, 70);
  const b = { ...a, data: Buffer.from(a.data) };
  b.data[(10 * 130 + 100) * 4] ^= 0xff; // um pixel no bloco (64, 0)
  assert.deepEqual(changedTiles(a, b, 0, 0, 130, 70), [[64, 0, 64, 64]]);
  assert.deepEqual(changedTiles(undefined, b, 0, 0, 130, 70).length, 6); // sem quadro anterior: tudo
  // RGB565 big-endian.
  const pf = { bpp: 16, depth: 16, bigEndian: true, trueColor: true, redMax: 31, greenMax: 63, blueMax: 31, redShift: 11, greenShift: 5, blueShift: 0 };
  const one: Frame = { width: 1, height: 1, data: Buffer.from([255, 0, 255, 255]) }; // B=255 G=0 R=255
  assert.equal(encodePixels(one, 0, 0, 1, 1, pf).readUInt16BE(0), (31 << 11) | 31);
});

test('VNC: senha, quadro inteiro, atualização incremental e formato de 16 bits', async () => {
  let frame = gradient(200, 100);
  const log: string[] = [];
  const inputs: string[] = [];
  const server = await startVnc({ ...validateVnc({ password: 'segredo', port: 0, host: '127.0.0.1', fps: 20 }), name: 'Teste' }, {
    capture: async () => frame,
    input: { pointer: (x, y, b) => inputs.push(`p ${x},${y},${b}`), key: (k, d) => inputs.push(`k ${k} ${d}`) },
  }, (l) => log.push(l));
  try {
    // Senha errada: SecurityResult 1 com o motivo (3.8).
    {
      const { r } = await handshake(server.port, 'errada');
      assert.equal((await r.read(4)).readUInt32BE(0), 1);
      const len = (await r.read(4)).readUInt32BE(0);
      assert.equal((await r.read(len)).toString(), 'senha incorreta');
      assert.ok(log.some((l) => l.includes('senha errada de 127.0.0.1')));
    }

    const { sock, r } = await handshake(server.port, 'segredo');
    const info = await init(sock, r);
    assert.deepEqual(info, { width: 200, height: 100, bpp: 32, name: 'Teste' });

    // SetEncodings (Raw + DesktopSize) e quadro inteiro.
    const enc = Buffer.alloc(12);
    enc[0] = 2;
    enc.writeUInt16BE(2, 2);
    enc.writeInt32BE(0, 4);
    enc.writeInt32BE(-223, 8);
    sock.write(enc);
    sock.write(fbur(false, 0, 0, 200, 100));
    const [full] = await readUpdate(r);
    assert.deepEqual([full.x, full.y, full.w, full.h, full.enc], [0, 0, 200, 100, 0]);
    assert.deepEqual(full.data, frame.data);

    // Muda um pixel: a atualização incremental traz só aquele bloco.
    const next = { ...frame, data: Buffer.from(frame.data) };
    next.data[(70 * 200 + 130) * 4 + 2] ^= 0xff;
    frame = next;
    sock.write(fbur(true, 0, 0, 200, 100));
    const inc = await readUpdate(r);
    assert.deepEqual(inc.map((x) => [x.x, x.y, x.w, x.h]), [[128, 64, 64, 36]]);

    // Somente visualização (padrão): mouse e teclado ignorados.
    sock.write(Buffer.from([5, 1, 0, 10, 0, 20]));
    sock.write(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));

    // Formato de 16 bits: o próximo quadro vem inteiro e com 2 bytes por pixel.
    const spf = Buffer.alloc(20);
    spf[0] = 0;
    Buffer.from([16, 16, 0, 1, 0, 31, 0, 63, 0, 31, 11, 5, 0]).copy(spf, 4);
    sock.write(spf);
    sock.write(fbur(true, 0, 0, 200, 100));
    const [rgb565] = await readUpdate(r, 2);
    assert.equal(rgb565.data.length, 200 * 100 * 2);

    // A tela mudou de tamanho: DesktopSize e o quadro novo inteiro.
    frame = gradient(120, 80);
    sock.write(fbur(true, 0, 0, 200, 100));
    const resized = await readUpdate(r, 2);
    assert.deepEqual(resized.map((x) => [x.enc, x.w, x.h]), [[-223, 120, 80], [0, 120, 80]]);
    assert.deepEqual(inputs, []);
    sock.destroy();
  } finally {
    await server.stop();
  }
});

test('VNC: com controle, RFB 3.3, confirmação e clientes permitidos', async () => {
  const frame = gradient(64, 64);
  const inputs: string[] = [];
  let ask = true;
  const server = await startVnc(validateVnc({ password: 'abc', port: 0, host: '127.0.0.1', viewOnly: false }), {
    capture: async () => frame,
    input: { pointer: (x, y, b) => inputs.push(`p ${x},${y},${b}`), key: (k, d) => inputs.push(`k ${k} ${d}`) },
    confirm: async () => ask,
  }, () => {});
  try {
    const { sock, r } = await handshake(server.port, 'abc', '003.003');
    await init(sock, r);
    sock.write(Buffer.from([5, 1, 0, 10, 0, 20]));
    sock.write(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));
    sock.write(Buffer.from([4, 0, 0, 0, 0, 0, 0, 0x61]));
    for (let i = 0; i < 50 && inputs.length < 3; i++) await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(inputs, ['p 10,20,1', 'k 97 true', 'k 97 false']);
    sock.destroy();

    // O usuário recusa no computador compartilhado.
    ask = false;
    const second = await handshake(server.port, 'abc');
    assert.equal((await second.r.read(4)).readUInt32BE(0), 1);
  } finally {
    await server.stop();
  }

  const only = await startVnc(validateVnc({ password: 'abc', port: 0, host: '127.0.0.1', allow: '10.0.0.0/8' }), { capture: async () => frame }, () => {});
  try {
    const sock = connect(only.port, '127.0.0.1');
    await reader(sock).closed();
  } finally {
    await only.stop();
  }
});

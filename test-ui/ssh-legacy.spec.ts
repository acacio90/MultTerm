import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { launchApp, type LaunchedApp } from './fixture.ts';

/**
 * "Switch antigo": manda a versão e um KEXINIT só com algoritmos antigos. O ssh atual recusa
 * ("no matching key exchange method found"); com os antigos permitidos, ele aceita e segue
 * a troca de chaves (que este servidor não completa: a conexão fica parada, sem erro).
 */
function kexinit(): Buffer {
  const list = (s: string) => {
    const b = Buffer.from(s);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const payload = Buffer.concat([
    Buffer.from([20]), Buffer.alloc(16, 7),
    list('diffie-hellman-group1-sha1'), list('ssh-rsa'),
    list('aes128-cbc'), list('aes128-cbc'), list('hmac-sha1'), list('hmac-sha1'),
    list('none'), list('none'), list(''), list(''),
    Buffer.from([0, 0, 0, 0, 0]),
  ]);
  let pad = 8 - ((payload.length + 5) % 8);
  if (pad < 4) pad += 8;
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + pad + 1);
  head[4] = pad;
  return Buffer.concat([head, payload, Buffer.alloc(pad)]);
}

let ctx: LaunchedApp;
let server: Server;
let port: number;
const sockets = new Set<Socket>();

test.beforeEach(async () => {
  server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.write('SSH-2.0-SwitchAntigo_1.0\r\n');
    sock.write(kexinit());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  ctx = await launchApp(`version: 1\nsessions:\n  - {name: SW, type: ssh, host: 127.0.0.1, port: ${port}, user: admin}\n  - {name: OUTRO, type: ssh, host: 127.0.0.1, port: ${port}}\n`);
});

test.afterEach(async () => {
  await ctx?.close();
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

test('equipamento antigo: a aba oferece permitir algoritmos antigos só nesta sessão', async () => {
  const page = ctx.page;
  await page.locator('#tree li.session', { hasText: 'SW' }).dblclick();
  const rows = page.locator('.term-panel:not([hidden]) .xterm-rows');
  await expect(rows).toContainText('no matching key exchange method found', { timeout: 20_000 });
  const notice = page.locator('.term-panel:not([hidden]) .term-notice');
  await expect(notice).toContainText('algoritmos antigos');
  await notice.locator('button', { hasText: 'Permitir algoritmos antigos nesta sessão e reconectar' }).click();
  await expect(notice).toBeHidden();

  // Gravado só na sessão SW; o ssh agora aceita a troca de chaves antiga (sem novo erro).
  const yaml = await readFile(ctx.sessionsFile, 'utf8');
  expect(yaml).toMatch(/name: SW[\s\S]*?legacySsh: true/);
  expect(yaml.match(/legacySsh: true/g)).toHaveLength(1);
  // A tela anterior vai para o histórico ao reconectar; o erro não pode voltar a aparecer.
  await page.waitForTimeout(3000);
  await expect(rows).not.toContainText('no matching key exchange method found');
  await expect(page.locator('#tabs .tab', { hasText: 'SW' })).not.toHaveClass(/ended/);

  // Formulário: marcada na SW, desmarcada na OUTRO.
  await page.locator('#tree li.session', { hasText: 'SW' }).click();
  await expect(page.locator('#form [name=legacySsh]')).toBeChecked();
  await page.locator('#tree li.session', { hasText: 'OUTRO' }).click();
  await expect(page.locator('#form [name=legacySsh]')).not.toBeChecked();
});

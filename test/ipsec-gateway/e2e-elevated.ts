// Teste manual da pilha completa (exige aprovar o UAC): auxiliar elevado + Wintun + IP/rotas +
// ping do próprio Windows até a rede atrás do gateway de teste (Docker, npm run test:ipsec -- --keep).
// Uso: npm run build && node test/ipsec-gateway/e2e-elevated.ts
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(import.meta.dirname, '..', '..');
const electron = createRequire(import.meta.url)('electron') as string;
const pipe = `\\\\.\\pipe\\multterm-vpn-${randomBytes(16).toString('hex')}`;
const token = randomBytes(32).toString('hex');
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${m}`);

const server = createServer((sock) => {
  server.close();
  let buf = '';
  const send = (o: object) => sock.write(`${JSON.stringify(o)}\n`);
  sock.on('data', (d) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (ev.ev === 'hello') {
        if (ev.token !== token) throw new Error('token errado');
        log(`auxiliar elevado conectado (pid ${ev.pid})`);
        send({ cmd: 'start', options: {
          ike: {
            host: '127.0.0.1', ikePort: 1500, nattPort: 14500, psk: Buffer.from('chave de teste').toString('base64'),
            user: 'ana', password: 'senha da ana', xauth: true, dhGroup: 14,
            phase1: [{ cipher: 'aes', keyBits: 256, hash: 'sha256' }], phase2: [{ cipher: 'aes', keyBits: 256, hash: 'sha256' }],
            pfsGroup: 14, modeConfig: true,
          },
          dns: { use: false },
        } });
      } else if (ev.ev === 'log') log(`  ${ev.msg}`);
      else if (ev.ev === 'up') {
        log(`TÚNEL ATIVO: ${JSON.stringify(ev.setup)}`);
        setTimeout(() => {
          try {
            const adapter = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-NetAdapter -IncludeHidden -Name 'MultTerm VPN' | Format-Table Name,InterfaceDescription,Status -HideTableHeaders | Out-String; Get-NetRoute -InterfaceAlias 'MultTerm VPN' -AddressFamily IPv4 | Where-Object DestinationPrefix -like '10.9*' | ForEach-Object DestinationPrefix"], { encoding: 'utf8' });
            log(`adaptador e rotas:\n${adapter.trim()}`);
            const out = execFileSync('ping', ['-n', '3', '-w', '3000', '10.99.0.1'], { encoding: 'latin1' });
            log(`ping do Windows:\n${out.trim().split(/\r?\n/).filter((l) => /10\.99|Pacotes|Packets|perd|loss/i.test(l)).join('\n')}`);
          } catch (e) {
            log(`falhou: ${(e as { stdout?: string }).stdout ?? (e as Error).message}`);
          }
          log('desconectando');
          send({ cmd: 'stop' });
        }, 1500);
      } else if (ev.ev === 'stats') { /* ignora */ } else log(`evento: ${JSON.stringify(ev)}`);
    }
  });
  sock.on('close', () => {
    log('auxiliar encerrou');
    setTimeout(() => {
      const left = execFileSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-NetAdapter -IncludeHidden -Name 'MultTerm VPN' -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8' }).trim();
      log(`adaptadores "MultTerm VPN" restantes: ${left}`);
      process.exit(0);
    }, 2000);
  });
});

server.listen(pipe, () => {
  const args = [root, '--multterm-vpn-helper', pipe, token].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  log('pedindo UAC…');
  execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath ${ps(electron)} -ArgumentList ${ps(args)} -Verb RunAs -WindowStyle Hidden`], (err) => {
    if (err) {
      log(`UAC recusado ou falhou: ${err.message}`);
      process.exit(1);
    }
  });
});
setTimeout(() => {
  log('tempo esgotado');
  process.exit(1);
}, 180_000).unref();

// Sobe o gateway strongSwan de teste (Docker) e roda os testes de interoperabilidade do motor de VPN.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'ipsec-gateway');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
run('docker', ['build', '-q', '-t', 'multterm-ipsec-gw', dir]);
spawnSync('docker', ['rm', '-f', 'multterm-gw'], { stdio: 'ignore' });
run('docker', ['run', '-d', '--name', 'multterm-gw', '--cap-add', 'NET_ADMIN', '--cap-add', 'SYS_MODULE', '-p', '1500:500/udp', '-p', '14500:4500/udp', 'multterm-ipsec-gw']);
await new Promise((r) => setTimeout(r, 4000));
const res = spawnSync(process.execPath, ['--test', join(dir, 'gateway.ipsec.ts')], { stdio: 'inherit' });
if (!process.argv.includes('--keep')) spawnSync('docker', ['rm', '-f', 'multterm-gw'], { stdio: 'ignore' });
process.exit(res.status ?? 1);

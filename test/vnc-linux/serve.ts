// Sobe o servidor VNC do MultTerm com uma tela sintética (gradiente) para o teste com um cliente
// VNC real no CI. Uso: node test/vnc-linux/serve.ts <senha>
import { startVnc, validateVnc, type Frame } from '../../src/servers/vnc.ts';

const password = process.argv[2];
if (!password) throw new Error('uso: serve.ts <senha>');
const width = 320;
const height = 200;
const data = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const p = (y * width + x) * 4;
  data[p] = x & 0xff; // B
  data[p + 1] = y & 0xff; // G
  data[p + 2] = (x + y) & 0xff; // R
  data[p + 3] = 255;
}
const frame: Frame = { width, height, data };
const server = await startVnc(validateVnc({ password, port: 5900, host: '127.0.0.1' }), { capture: async () => frame }, (l) => console.log(l));
console.log(`pronto na porta ${server.port}`);
process.on('SIGTERM', () => void server.stop().then(() => process.exit(0)));

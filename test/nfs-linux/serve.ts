// Sobe o servidor NFS do MultTerm (portmapper na 111, NFS/MOUNT na 2049) para o teste com o
// cliente NFS do kernel Linux no CI. Uso: sudo node test/nfs-linux/serve.ts <pasta>
import { startNfs, validateNfs } from '../../src/servers/nfs.ts';

const root = process.argv[2];
if (!root) throw new Error('uso: serve.ts <pasta>');
const server = await startNfs(validateNfs({ root, port: 2049, portmapPort: 111 }), (line) => console.log(line));
console.log(`pronto na porta ${server.port}`);
process.on('SIGTERM', () => void server.stop().then(() => process.exit(0)));

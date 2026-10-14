import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Session } from '../src/sessions/model.ts';
import { embeddedRdpArgs, embeddedSshCommand, rdpExitMessage, expandHome, parseAgentList, planLaunch, quoteForCmd, rdpFileContent, sshAddProgram, sshArgs, sshProgram, type LaunchEnv } from '../src/sessions/launch.ts';

const WIN: LaunchEnv = {
  platform: 'win32',
  windowsTerminal: true,
  home: 'C:\\Users\\pedro',
  tmp: 'C:\\Temp',
  fileExists: () => false,
};
const SSH: Session = { name: 'ANSIBLE', folder: 'Servidores', type: 'ssh', host: 'ansible.example.org', user: 'pedro' };

test('ssh: porta padrão omitida, "--" antes do destino', () => {
  assert.deepEqual(sshArgs(SSH, WIN).args, ['--', 'pedro@ansible.example.org']);
  assert.deepEqual(sshArgs({ ...SSH, port: 2222, user: undefined }, WIN).args, ['-p', '2222', '--', 'ansible.example.org']);
});

test('ssh: chave com ~ é expandida', () => {
  const withKey = sshArgs({ ...SSH, identityFile: '~/.ssh/id_ed25519' }, WIN);
  assert.deepEqual(withKey.args.slice(0, 2), ['-i', join(WIN.home, '.ssh/id_ed25519')]);
  assert.deepEqual(withKey.warnings, []);
});

test('ssh: .ppk usa a versão OpenSSH ao lado quando existe', () => {
  const openssh = join(WIN.home, '.ssh/pedro_ed25519');
  const env = { ...WIN, fileExists: (p: string) => p === openssh };
  const { args, warnings } = sshArgs({ ...SSH, identityFile: '~/.ssh/pedro_ed25519.ppk' }, env);
  assert.deepEqual(args.slice(0, 2), ['-i', openssh]);
  assert.match(warnings[0], /trocada pela versão OpenSSH/);
});

test('ssh: .ppk sem versão OpenSSH é ignorada com instrução de conversão', () => {
  const { args, warnings } = sshArgs({ ...SSH, identityFile: 'C:/k/pedro.ppk' }, WIN);
  assert.ok(!args.includes('-i'));
  assert.match(warnings[0], /C:\/k\/pedro não existe.*puttygen "C:\/k\/pedro\.ppk" -O private-openssh -o "C:\/k\/pedro"/);
});

test('expandHome só mexe em "~" no início', () => {
  assert.equal(expandHome('~', '/h'), join('/h'));
  assert.equal(expandHome('a~/b', '/h'), 'a~/b');
});

test('windows: Windows Terminal quando disponível, senão ssh em console próprio', () => {
  const wt = planLaunch({ ...SSH, name: 'A;B' }, WIN);
  assert.equal(wt.command, 'wt.exe');
  assert.deepEqual(wt.args, ['new-tab', '--title', 'A,B', 'ssh.exe', '--', 'pedro@ansible.example.org']);
  const plain = planLaunch({ ...SSH, identityFile: 'C:/Users/Pedro Silva/.ssh/id' }, { ...WIN, windowsTerminal: false });
  assert.equal(plain.command, 'cmd.exe');
  assert.equal(plain.verbatim, true);
  assert.deepEqual(plain.args, ['/d', '/s', '/c', '"start "" ssh.exe -i "C:/Users/Pedro Silva/.ssh/id" -- pedro@ansible.example.org"']);
});

test('rdp no windows: grava .rdp e abre com mstsc', () => {
  const plan = planLaunch({ name: 'GERENTE AD', folder: '', type: 'rdp', host: '10.0.0.9', user: 'admin' }, WIN);
  assert.equal(plan.command, 'mstsc.exe');
  assert.equal(plan.file?.path, join(WIN.tmp, 'multterm-rdp', 'GERENTE_AD.rdp'));
  assert.deepEqual(plan.args, [plan.file?.path]);
  assert.equal(plan.file?.content, 'full address:s:10.0.0.9:3389\r\nprompt for credentials:i:1\r\nusername:s:admin\r\n');
});

test('rdpFileContent respeita porta customizada', () => {
  assert.match(rdpFileContent({ name: 'x', folder: '', type: 'rdp', host: 'h', port: 3390 }), /^full address:s:h:3390\r\n/);
});

test('linux: terminal padrão e xfreerdp', () => {
  const env: LaunchEnv = { ...WIN, platform: 'linux', home: '/home/pedro', tmp: '/tmp' };
  assert.deepEqual(planLaunch(SSH, env).args, ['-e', 'ssh', '--', 'pedro@ansible.example.org']);
  assert.deepEqual(planLaunch({ name: 'r', folder: '', type: 'rdp', host: 'h', user: 'u' }, env).args, ['/v:h:3389', '/u:u']);
});

test('quoteForCmd: aspas só quando preciso; recusa o que o cmd expandiria', () => {
  assert.equal(quoteForCmd('pedro@host.example.org'), 'pedro@host.example.org');
  assert.equal(quoteForCmd('C:\\a b\\k'), '"C:\\a b\\k"');
  assert.equal(quoteForCmd('a&calc'), '"a&calc"');
  for (const bad of ['a"b', '%PATH%', 'a!b']) assert.throws(() => quoteForCmd(bad), /não suportado/);
});

test('windows prefere o OpenSSH do sistema ao ssh do PATH (ex.: o do Git)', () => {
  const system = join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const env = { ...WIN, systemRoot: 'C:\\Windows', fileExists: (p: string) => p === system };
  assert.equal(sshProgram(env), system);
  assert.equal(embeddedSshCommand(SSH, env).file, system);
  assert.equal(planLaunch(SSH, env).args[3], system);
  assert.equal(sshProgram(WIN), 'ssh.exe');
  assert.equal(sshProgram({ ...WIN, platform: 'linux' }), 'ssh');
});

test('terminal embutido: ssh.exe no Windows, mesmos argumentos; RDP é recusado', () => {
  assert.deepEqual(embeddedSshCommand(SSH, WIN), { file: 'ssh.exe', args: ['--', 'pedro@ansible.example.org'], warnings: [] });
  assert.equal(embeddedSshCommand(SSH, { ...WIN, platform: 'linux' }).file, 'ssh');
  assert.throws(() => embeddedSshCommand({ name: 'r', folder: '', type: 'rdp', host: 'h' }, WIN), /só sessões SSH/);
});

test('ssh-add vem do mesmo OpenSSH que o ssh', () => {
  const system = join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const env = { ...WIN, systemRoot: 'C:\\Windows', fileExists: (p: string) => p === system };
  assert.equal(sshAddProgram(env), join('C:\\Windows', 'System32', 'OpenSSH', 'ssh-add.exe'));
  assert.equal(sshAddProgram(WIN), 'ssh-add.exe');
  assert.equal(sshAddProgram({ ...WIN, platform: 'linux' }), 'ssh-add');
});

test('parseAgentList: chaves, agente vazio e sem agente', () => {
  const line = '256 SHA256:abc pedro@desktop (ED25519)';
  assert.deepEqual(parseAgentList(0, `${line}\r\n`, ''), { available: true, keys: [line] });
  assert.deepEqual(parseAgentList(1, 'The agent has no identities.\n', ''), { available: true, keys: [] });
  assert.deepEqual(parseAgentList(2, '', 'Error connecting to agent: No such file or directory\n'),
    { available: false, message: 'Error connecting to agent: No such file or directory' });
});

test('rdp numa aba: argumentos do FreeRDP encaixado na janela do app', () => {
  const rdp: Session = { name: 'AD WIN', folder: '', type: 'rdp', host: '10.0.0.9' };
  const view = { parent: '1234', width: 1280.4, height: 719.6 };
  assert.deepEqual(embeddedRdpArgs(rdp, view), ['/v:10.0.0.9', '/parent-window:1234', '/size:1280x720', '/dynamic-resolution', '+clipboard', '/title:AD WIN']);
  // Porta fora do padrão, DOMINIO\usuario e usuario@dominio.
  const args = embeddedRdpArgs({ ...rdp, port: 3390, user: 'EMPRESA\\ana' }, view);
  assert.deepEqual(args.slice(0, 3), ['/v:10.0.0.9:3390', '/d:EMPRESA', '/u:ana']);
  assert.equal(embeddedRdpArgs({ ...rdp, user: 'ana@empresa.local' }, view)[1], '/u:ana@empresa.local');
  // Área minúscula (aba escondida ao abrir) não vira resolução inválida.
  assert.ok(embeddedRdpArgs(rdp, { parent: '1', width: 0, height: 0 }).includes('/size:200x200'));
  // A senha nunca vai na linha de comando.
  assert.ok(!embeddedRdpArgs({ ...rdp, user: 'ana' }, view).some((a) => a.startsWith('/p:')));
});

test('rdp numa aba: fim da sessão em português', () => {
  assert.deepEqual(rdpExitMessage(0), { normal: true, message: '' });
  assert.equal(rdpExitMessage(0x1000c).normal, true); // logoff pelo usuário
  assert.match(rdpExitMessage(131085).message, /não foi possível conectar/); // ERRCONNECT_CONNECT_TRANSPORT_FAILED
  assert.match(rdpExitMessage(0x20014).message, /usuário ou senha incorretos/);
  assert.match(rdpExitMessage(0x10003).message, /ociosa/);
  assert.equal(rdpExitMessage(0x2abcd).message, 'erro do cliente RDP 0x0002abcd');
  assert.deepEqual(rdpExitMessage(null), { normal: false, message: 'o cliente RDP não pôde ser iniciado' });
});

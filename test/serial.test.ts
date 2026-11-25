import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebContents } from 'electron';
import { createRequire } from 'node:module';
import type { BindingInterface, BindingPortInterface, OpenOptions, SetOptions } from '@serialport/bindings-cpp';
import { describeSerial, effectivePort, isSerialLine, serialSettings, SessionError, validateSession } from '../src/sessions/model.ts';
import { parseSessionFile, serializeSessions } from '../src/sessions/store.ts';
import { planLaunch } from '../src/sessions/launch.ts';
import { listSerialPorts, openSerial, probeSerialLine, serialErrorMessage, serialOpenOptions, setSerialBinding } from '../src/desktop/serial.ts';
import { attachTerminal, breakTerminal, closeTerminalsOf, writeTerminal } from '../src/desktop/terminals.ts';

// O binding-mock não expõe os tipos pelo "exports" do pacote: só o que os testes usam.
interface MockPortBinding extends BindingPortInterface {
  readonly openOptions: Required<OpenOptions>;
  recording: Buffer;
  emitData(data: Buffer | string): void;
}
const { MockBinding } = createRequire(import.meta.url)('@serialport/binding-mock') as {
  MockBinding: BindingInterface<MockPortBinding> & {
    reset(): void;
    createPort(path: string, opt?: { record?: boolean; manufacturer?: string }): void;
  };
};

test('isSerialLine aceita COM e /dev, recusa o resto', () => {
  for (const ok of ['COM1', 'com3', 'COM256', '/dev/ttyUSB0', '/dev/ttyACM1', '/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0']) {
    assert.ok(isSerialLine(ok), ok);
  }
  for (const bad of ['', 'COM0', 'COM1000', 'ttyUSB0', '/dev/', '/dev/../etc/passwd', '/dev/tty USB0', '-oProxy', '10.0.0.1', '\\\\.\\COM3']) {
    assert.ok(!isSerialLine(bad), bad);
  }
});

test('validateSession: sessão serial com os padrões', () => {
  const s = validateSession({ name: 'console', type: 'serial', host: 'com3' }, 't');
  assert.deepEqual(s, { name: 'console', folder: '', type: 'serial', host: 'COM3' });
  assert.deepEqual(serialSettings(s), { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  assert.equal(describeSerial(s), '9600 8N1');
  assert.throws(() => effectivePort(s), SessionError);
});

test('validateSession: configuração serial completa e campos de rede ignorados', () => {
  const s = validateSession({
    name: 'placa', type: 'serial', host: '/dev/ttyUSB0', baudRate: '115200', dataBits: 7, stopBits: 2, parity: 'even',
    flowControl: 'rtscts', port: 22, user: 'root', mac: 'aa:bb:cc:dd:ee:ff', vpn: 'Matriz', legacySsh: true, tags: ['lab'],
  }, 't');
  assert.deepEqual(s, {
    name: 'placa', folder: '', type: 'serial', host: '/dev/ttyUSB0', baudRate: 115200, dataBits: 7, stopBits: 2, parity: 'even',
    flowControl: 'rtscts', tags: ['lab'],
  });
  assert.equal(describeSerial(s), '115200 7E2 RTS/CTS');
  assert.equal(describeSerial({ ...s, stopBits: 1.5, parity: 'none', flowControl: 'xonxoff' }), '115200 7N1.5 XON/XOFF');
});

test('validateSession: erros da sessão serial', () => {
  const base = { name: 'c', type: 'serial', host: 'COM3' };
  assert.throws(() => validateSession({ ...base, host: '' }, 't'), /linha serial/);
  assert.throws(() => validateSession({ ...base, host: '10.0.0.1' }, 't'), /linha serial inválida/);
  assert.throws(() => validateSession({ ...base, baudRate: 10 }, 't'), /baudRate/);
  assert.throws(() => validateSession({ ...base, baudRate: 9600.5 }, 't'), /baudRate/);
  assert.throws(() => validateSession({ ...base, dataBits: 9 }, 't'), /dataBits/);
  assert.throws(() => validateSession({ ...base, stopBits: 3 }, 't'), /stopBits/);
  assert.throws(() => validateSession({ ...base, parity: 'impar' }, 't'), /parity/);
  assert.throws(() => validateSession({ ...base, flowControl: 'dsrdtr' }, 't'), /flowControl/);
  assert.throws(() => validateSession({ ...base, type: 'telnet' }, 't'), /ssh, rdp ou serial/);
});

test('serializeSessions grava a velocidade e só o que foge de 8N1', () => {
  const sessions = [
    validateSession({ name: 'a', type: 'serial', host: 'COM3' }, 't'),
    validateSession({ name: 'b', type: 'serial', host: '/dev/ttyUSB0', baudRate: 115200, dataBits: 8, parity: 'odd', flowControl: 'xonxoff' }, 't'),
  ];
  const text = serializeSessions(sessions);
  assert.match(text, /name: a\n {4}type: serial\n {4}host: COM3\n {4}baudRate: 9600\n/);
  assert.match(text, /host: \/dev\/ttyUSB0\n {4}baudRate: 115200\n {4}parity: odd\n {4}flowControl: xonxoff\n/);
  assert.doesNotMatch(text, /dataBits/);
  // Ida e volta: o arquivo lido é o mesmo que foi gravado.
  assert.deepEqual(parseSessionFile(text, 't').sessions, [
    { ...sessions[0], baudRate: 9600 },
    { name: 'b', folder: '', type: 'serial', host: '/dev/ttyUSB0', baudRate: 115200, parity: 'odd', flowControl: 'xonxoff' },
  ]);
});

test('planLaunch recusa a sessão serial (só abre numa aba)', () => {
  const s = validateSession({ name: 'c', type: 'serial', host: 'COM3' }, 't');
  assert.throws(() => planLaunch(s, { platform: 'win32', windowsTerminal: true, home: 'C:\\', tmp: 'C:\\', fileExists: () => true }), /só numa aba/);
});

test('serialOpenOptions traduz a sessão para o serialport', () => {
  const s = validateSession({ name: 'c', type: 'serial', host: 'COM3', baudRate: 19200, parity: 'mark', flowControl: 'xonxoff' }, 't');
  assert.deepEqual(serialOpenOptions(s), {
    path: 'COM3', baudRate: 19200, dataBits: 8, stopBits: 1, parity: 'mark', rtscts: false, xon: true, xoff: true,
  });
  assert.equal(serialOpenOptions({ ...s, flowControl: 'rtscts' }).rtscts, true);
});

test('serialErrorMessage explica os erros comuns', () => {
  assert.match(serialErrorMessage('/dev/ttyUSB0', new Error('Error: Permission denied, cannot open /dev/ttyUSB0'), 'linux'), /grupo dialout/);
  assert.match(serialErrorMessage('COM3', new Error('Opening COM3: Access denied'), 'win32'), /em uso por outro programa/);
  assert.match(serialErrorMessage('/dev/ttyUSB0', new Error('Error Resource temporarily unavailable Cannot lock port'), 'linux'), /em uso/);
  assert.match(serialErrorMessage('COM9', new Error('Opening COM9: File not found'), 'win32'), /não existe/);
  assert.match(serialErrorMessage('/dev/ttyUSB1', new Error('Error: No such file or directory, cannot open /dev/ttyUSB1'), 'linux'), /não existe/);
  assert.equal(serialErrorMessage('COM3', new Error('algo'), 'win32'), 'não foi possível abrir COM3: algo');
  // Linux em outro idioma: o diagnóstico vem do sistema de arquivos, não do texto.
  const pt = new Error('Error: Arquivo ou diretório inexistente, cannot open /dev/ttyUSB3');
  assert.match(serialErrorMessage('/dev/ttyUSB3', pt, 'linux', 'missing'), /a porta \/dev\/ttyUSB3 não existe/);
  assert.match(serialErrorMessage('/dev/ttyUSB3', new Error('Error: Permissão negada, cannot open'), 'linux', 'denied'), /grupo dialout/);
});

test('probeSerialLine: inexistente, sem permissão ou acessível', async () => {
  assert.equal(await probeSerialLine('/dev/ttyMULTTERM-nao-existe', 'linux'), 'missing');
  assert.equal(await probeSerialLine('COM3', 'win32'), undefined);
  if (process.platform !== 'win32') {
    assert.equal(await probeSerialLine('/dev/null', 'linux'), undefined);
    if (process.getuid?.() !== 0) assert.equal(await probeSerialLine('/etc/shadow', 'linux'), 'denied');
  }
});

/** Binding simulado que guarda a porta aberta (para injetar dados e ver o que foi enviado). */
function recordingBinding() {
  const opened: MockPortBinding[] = [];
  const sets: { brk?: boolean }[] = [];
  const binding = {
    ...MockBinding,
    list: () => MockBinding.list(),
    async open(options: Parameters<typeof MockBinding.open>[0]) {
      const port = await MockBinding.open(options);
      const set = port.set.bind(port);
      port.set = async (o: SetOptions) => {
        sets.push(o);
        await set(o);
      };
      opened.push(port);
      return port;
    },
  };
  return { binding: binding as unknown as BindingInterface, opened, sets };
}

function fakeWindow(id: number) {
  const sent: { channel: string; args: unknown[] }[] = [];
  const wc = { id, isDestroyed: () => false, send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }) };
  return { wc: wc as unknown as WebContents, sent };
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('listSerialPorts lista as portas em ordem natural com o fabricante', async (t) => {
  MockBinding.reset();
  MockBinding.createPort('COM10', { manufacturer: 'Prolific' });
  MockBinding.createPort('COM2', { manufacturer: 'FTDI' });
  setSerialBinding(MockBinding as unknown as BindingInterface);
  t.after(() => setSerialBinding(undefined));
  const ports = await listSerialPorts();
  assert.deepEqual(ports.map((p) => p.path), ['COM2', 'COM10']);
  assert.match(ports[0].label, /^FTDI/);
});

test('openSerial: aba recebe o que chega, envia o que se digita, manda break e fecha', async (t) => {
  MockBinding.reset();
  MockBinding.createPort('/dev/ttyUSB0', { record: true });
  const { binding, opened, sets } = recordingBinding();
  setSerialBinding(binding);
  const win = fakeWindow(951);
  t.after(() => {
    closeTerminalsOf(win.wc);
    setSerialBinding(undefined);
  });

  const s = validateSession({ name: 'sw', type: 'serial', host: '/dev/ttyUSB0', baudRate: 115200 }, 't');
  attachTerminal(win.wc, 1, await openSerial(s));
  assert.equal(opened[0].openOptions.baudRate, 115200);

  // Acentos partidos entre dois pedaços chegam inteiros.
  const bytes = Buffer.from('Switch> configuração\r\n', 'utf8');
  const cut = bytes.indexOf(0xc3) + 1;
  opened[0].emitData(bytes.subarray(0, cut));
  opened[0].emitData(bytes.subarray(cut));
  const data = () => win.sent.filter((m) => m.channel === 'term:data').map((m) => m.args[1]).join('');
  await until(() => data().includes('configuração'));

  writeTerminal(win.wc, 1, 'show ver\r');
  await until(() => opened[0].recording.toString() === 'show ver\r');

  await breakTerminal(win.wc, 1);
  assert.deepEqual(sets.map((o) => o.brk), [true, false]);

  closeTerminalsOf(win.wc);
  await until(() => !opened[0].isOpen);
});

test('openSerial: porta em uso dá a mensagem de porta ocupada', async (t) => {
  MockBinding.reset();
  MockBinding.createPort('COM3');
  setSerialBinding(MockBinding as unknown as BindingInterface);
  t.after(() => setSerialBinding(undefined));
  const s = validateSession({ name: 'c', type: 'serial', host: 'COM3' }, 't');
  const first = await openSerial(s);
  t.after(() => first.kill());
  await assert.rejects(openSerial(s), /em uso por outro programa/);
});

test('openSerial: porta inexistente', async (t) => {
  MockBinding.reset();
  setSerialBinding(MockBinding as unknown as BindingInterface);
  t.after(() => setSerialBinding(undefined));
  await assert.rejects(openSerial(validateSession({ name: 'c', type: 'serial', host: 'COM7' }, 't')), /COM7/);
});

test('breakTerminal recusa aba que não é serial', async () => {
  const win = fakeWindow(952);
  await assert.rejects(breakTerminal(win.wc, 5), /não está aberta/);
});

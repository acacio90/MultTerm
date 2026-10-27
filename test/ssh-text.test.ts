import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshTextStream, unescapeSshText } from '../src/sessions/ssh-text.ts';
import { parseAgentList } from '../src/sessions/launch.ts';

test('mensagens do Windows em cp1252 escapadas pelo ssh voltam a ter acentos', () => {
  // Saída real do ssh.exe num Windows em português.
  assert.equal(
    unescapeSshText('ssh: Could not resolve hostname x.invalid: Este host n\\343o \\351 conhecido.\r\n'),
    'ssh: Could not resolve hostname x.invalid: Este host n\u00e3o \u00e9 conhecido.\r\n',
  );
  assert.equal(unescapeSshText('read: Uma conex\\343o existente foi for\\347ada'), 'read: Uma conex\u00e3o existente foi for\u00e7ada');
  assert.equal(unescapeSshText('\\301rea e c\\363digo'), '\u00c1rea e c\u00f3digo');
});

test('sequência UTF-8 escapada vira o caractere UTF-8', () => {
  assert.equal(unescapeSshText('caf\\303\\251'), 'caf\u00e9');
});

test('o que não é acento fica como está', () => {
  const kept = [
    'sem escapes',
    'C:\\Users\\Pedro',
    'byte de controle \\200',
    'símbolo \\327', // × não é letra
    'barra literal \\\\351',
    'octal baixo \\101',
  ];
  for (const text of kept) assert.equal(unescapeSshText(text), text, text);
});

test('escape cortado entre dois pedaços da saída também vira acento', () => {
  const message = 'Este host n\\343o \\351 conhecido. caf\\303\\251\r\n';
  // Todo ponto de corte possível, inclusive no meio de "\343" e entre os bytes UTF-8 de "é".
  for (let i = 1; i < message.length; i++) {
    const stream = sshTextStream();
    const out = stream.push(message.slice(0, i)) + stream.push(message.slice(i)) + stream.flush();
    assert.equal(out, 'Este host n\u00e3o \u00e9 conhecido. caf\u00e9\r\n', `corte em ${i}`);
    assert.equal(stream.pending, false);
  }
});

test('o stream só guarda o que pode continuar no próximo pedaço', () => {
  const stream = sshTextStream();
  assert.equal(stream.push('texto comum\r\n'), 'texto comum\r\n');
  assert.equal(stream.pending, false);
  assert.equal(stream.push('C:\\Users\\'), 'C:\\Users');
  assert.equal(stream.pending, true);
  assert.equal(stream.flush(), '\\');
  assert.equal(stream.push('barra literal \\\\'), 'barra literal \\\\');
  assert.equal(stream.pending, false);
});

test('mensagem do agente SSH (ssh-add) também volta a ter acentos', () => {
  assert.deepEqual(
    parseAgentList(2, '', 'Error connecting to agent: O sistema n\\343o pode encontrar o arquivo especificado.\r\n'),
    { available: false, message: 'Error connecting to agent: O sistema n\u00e3o pode encontrar o arquivo especificado.' },
  );
});

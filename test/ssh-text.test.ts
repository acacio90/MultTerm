import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unescapeSshText } from '../src/sessions/ssh-text.ts';
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

test('mensagem do agente SSH (ssh-add) também volta a ter acentos', () => {
  assert.deepEqual(
    parseAgentList(2, '', 'Error connecting to agent: O sistema n\\343o pode encontrar o arquivo especificado.\r\n'),
    { available: false, message: 'Error connecting to agent: O sistema n\u00e3o pode encontrar o arquivo especificado.' },
  );
});

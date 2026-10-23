// Programa de teste que liga o mouse no terminal (como o Claude Code) e mostra cada entrada recebida.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?1000h\x1b[?1006h');
process.stdout.write('PRONTO\r\n');
process.stdin.on('data', (data) => {
  const text = data.toString('utf8');
  if (text === '\x03') {
    process.stdout.write('\x1b[?1000l\x1b[?1006l');
    process.exit(0);
  }
  process.stdout.write(`RECEBIDO ${JSON.stringify(text)}\r\n`);
});

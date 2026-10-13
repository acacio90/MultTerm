import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, nextRun, parseCrontab, startCron, validateCron } from '../src/servers/cron.ts';

test('crontab: campos, intervalos, passos, nomes, atalhos e erros', () => {
  const [a, b, c, d] = parseCrontab([
    '# comentário',
    '*/15 8-18 * * mon-fri ping -n 1 10.0.0.1',
    '0 0 1,15 jan,jul * backup.cmd',
    '@hourly echo hora',
    '30 2 * * 7 echo domingo',
    '',
  ].join('\n'));
  assert.deepEqual([...a.minute], [0, 15, 30, 45]);
  assert.deepEqual([...a.hour], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual([...a.dow], [1, 2, 3, 4, 5]);
  assert.equal(a.command, 'ping -n 1 10.0.0.1');
  assert.equal(a.line, 2);
  assert.deepEqual([...b.month], [1, 7]);
  assert.deepEqual([...b.dom], [1, 15]);
  assert.equal(c.expr, '@hourly');
  assert.deepEqual([...c.minute], [0]);
  assert.deepEqual([...d.dow], [0]); // 7 = domingo
  for (const [line, re] of [
    ['* * * *', /use "minuto/], ['60 * * * * x', /fora do intervalo/], ['*/0 * * * * x', /passo/],
    ['* * * foo * x', /valor inválido/], ['@sempre x', /atalho desconhecido/], ['5-1 * * * * x', /fora do intervalo/],
  ] as const) assert.throws(() => parseCrontab(line), re, line);
  assert.throws(() => validateCron({ jobs: '# só comentário' }), /nenhuma tarefa/);
});

test('crontab: regra dia-do-mês OU dia-da-semana e próxima execução', () => {
  const [job] = parseCrontab('0 9 13 * fri relatorio');
  assert.ok(matches(job, new Date(2026, 9, 13, 9, 0))); // dia 13 (terça)
  assert.ok(matches(job, new Date(2026, 9, 16, 9, 0))); // sexta
  assert.ok(!matches(job, new Date(2026, 9, 14, 9, 0)));
  const [daily] = parseCrontab('@daily x');
  assert.deepEqual(nextRun(daily, new Date(2026, 9, 13, 15, 30)), new Date(2026, 9, 14, 0, 0));
  const [feb29] = parseCrontab('0 12 29 2 * x');
  assert.deepEqual(nextRun(feb29, new Date(2026, 9, 13)), new Date(2028, 1, 29, 12, 0));
  const [never] = parseCrontab('0 0 31 2 * x');
  assert.equal(nextRun(never, new Date(2026, 0, 1)), undefined);
});

test('agendador executa no minuto certo, registra a saída e pula se ainda estiver rodando', { timeout: 30_000 }, async () => {
  let clock = new Date(2026, 9, 13, 10, 0, 30);
  const logs: string[] = [];
  const srv = await startCron({
    jobs: '* * * * * echo tarefa-ok\n*/2 * * * * ping -n 3 127.0.0.1 >nul & echo lenta\n0 0 1 1 * echo nunca-agora',
    shell: 'cmd', now: () => clock, tickMs: 50,
  }, (l) => logs.push(l));
  try {
    assert.ok(logs.some((l) => /linha 1 .* próxima: /.test(l)));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!logs.some((l) => /linha 1: terminou/.test(l))); // não roda no minuto em que inicia
    clock = new Date(2026, 9, 13, 10, 2, 0);
    for (let i = 0; i < 100 && !logs.some((l) => /linha 1: terminou \(código 0.*\ntarefa-ok/.test(l)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(logs.some((l) => /linha 1: terminou \(código 0.*\ntarefa-ok/.test(l)), logs.join('\n'));
    clock = new Date(2026, 9, 13, 10, 4, 0); // a lenta (2 s) ainda pode estar rodando
    await new Promise((r) => setTimeout(r, 300));
    clock = new Date(2026, 9, 13, 10, 6, 0);
    for (let i = 0; i < 100 && logs.filter((l) => /linha 2: terminou/.test(l)).length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!logs.some((l) => /linha 3: terminou/.test(l)));
    assert.ok(logs.some((l) => /linha 2: terminou \(código 0.*\nlenta/.test(l)), logs.join('\n'));
  } finally {
    await srv.stop();
  }
});

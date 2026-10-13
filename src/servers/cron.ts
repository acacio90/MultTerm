import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { LogFn, RunningServer } from './common.ts';

/*
 * Agendador de comandos no formato do crontab (minuto hora dia-do-mês mês dia-da-semana comando),
 * com intervalos (1-5), passos (*\/15), listas (1,15), nomes (jan, mon) e atalhos (@hourly, @daily,
 * @weekly, @monthly, @yearly). Roda enquanto o MultTerm estiver aberto; a saída vai para o log.
 */

export interface CronJob {
  line: number;
  expr: string;
  command: string;
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Dia do mês e da semana restritos: vale qualquer um dos dois (regra do cron). */
  domStar: boolean;
  dowStar: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function field(text: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  const value = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    const n = i >= 0 ? i + (min === 1 ? 1 : 0) : Number(s);
    if (!Number.isInteger(n)) throw new Error(`valor inválido "${s}"`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`passo inválido "${part}"`);
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      [lo, hi] = [value(a), value(b)];
    } else {
      lo = value(range);
      hi = stepText === undefined ? lo : max;
    }
    // Dia da semana: domingo pode ser 0 ou 7 (ex.: "7", "5-7").
    const week = max === 6;
    if (lo < min || hi > (week ? 7 : max) || lo > hi) throw new Error(`fora do intervalo ${min}-${max}: "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(week && v === 7 ? 0 : v);
  }
  return out;
}

/** Lê as tarefas (uma por linha; "#" comenta). Erros indicam a linha. */
export function parseCrontab(text: string): CronJob[] {
  const jobs: CronJob[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let rest = line;
    let expr: string;
    const macro = /^(@\w+)\s+(.+)$/.exec(line);
    if (macro) {
      if (!MACROS[macro[1].toLowerCase()]) throw new Error(`linha ${i + 1}: atalho desconhecido "${macro[1]}"`);
      expr = MACROS[macro[1].toLowerCase()];
      rest = macro[2];
    } else {
      const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
      if (!m) throw new Error(`linha ${i + 1}: use "minuto hora dia mês dia-da-semana comando"`);
      expr = m.slice(1, 6).join(' ');
      rest = m[6];
    }
    const [mi, h, dm, mo, dw] = expr.split(' ');
    try {
      jobs.push({
        line: i + 1, expr: macro ? macro[1] : expr, command: rest.trim(),
        minute: field(mi, 0, 59), hour: field(h, 0, 23), dom: field(dm, 1, 31), month: field(mo, 1, 12, MONTHS), dow: field(dw, 0, 6, DAYS),
        domStar: dm === '*', dowStar: dw === '*',
      });
    } catch (err) {
      throw new Error(`linha ${i + 1}: ${(err as Error).message}`);
    }
  });
  return jobs;
}

export function matches(job: CronJob, d: Date): boolean {
  if (!job.minute.has(d.getMinutes()) || !job.hour.has(d.getHours()) || !job.month.has(d.getMonth() + 1)) return false;
  const dom = job.dom.has(d.getDate());
  const dow = job.dow.has(d.getDay());
  if (job.domStar && job.dowStar) return true;
  if (job.domStar) return dow;
  if (job.dowStar) return dom;
  return dom || dow;
}

/** Próxima execução depois de `from` (procura até ~4 anos à frente). */
export function nextRun(job: CronJob, from: Date): Date | undefined {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 4 * 366 * 24 * 60; i++) {
    if (matches(job, d)) return d;
    if (!job.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0);
    } else if (!job.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0);
    } else d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}

export interface CronConfig {
  jobs: string;
  shell?: 'powershell' | 'cmd';
  /** Relógio injetável (testes). */
  now?: () => Date;
  /** Intervalo de verificação (ms); padrão: a virada de cada minuto. */
  tickMs?: number;
}

export function validateCron(raw: Record<string, unknown>): CronConfig {
  const jobs = String(raw.jobs ?? '');
  if (!parseCrontab(jobs).length) throw new Error('nenhuma tarefa: escreva ao menos uma linha (ex.: */5 * * * * ping -n 1 10.0.0.1)');
  return { jobs, shell: raw.shell === 'cmd' ? 'cmd' : 'powershell' };
}

export async function startCron(cfg: CronConfig, log: LogFn): Promise<RunningServer> {
  const jobs = parseCrontab(cfg.jobs);
  const now = cfg.now ?? (() => new Date());
  const running = new Map<number, ReturnType<typeof spawn>>();
  let lastMinute = -1;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  for (const j of jobs) {
    const n = nextRun(j, now());
    log(`tarefa da linha ${j.line} (${j.expr}): ${j.command} — próxima: ${n ? n.toLocaleString('pt-BR') : 'nunca'}`);
  }

  const runJob = (j: CronJob) => {
    if (running.has(j.line)) {
      log(`linha ${j.line}: ainda rodando, esta execução foi pulada`);
      return;
    }
    const t0 = Date.now();
    const child = spawn(cfg.shell === 'cmd' ? 'cmd.exe' : 'powershell.exe',
      cfg.shell === 'cmd' ? ['/d', '/s', '/c', j.command] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', j.command],
      { cwd: homedir(), windowsHide: true });
    running.set(j.line, child);
    let out = '';
    const take = (d: Buffer) => {
      if (out.length < 4000) out += d.toString('utf8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (err) => log(`linha ${j.line}: não foi possível executar: ${err.message}`));
    child.on('close', (code) => {
      running.delete(j.line);
      const text = out.trim().replace(/\r\n/g, '\n');
      log(`linha ${j.line}: terminou (código ${code}, ${Date.now() - t0} ms)${text ? `\n${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}` : ''}`);
    });
  };

  const tick = () => {
    if (stopped) return;
    const d = now();
    const minute = Math.floor(d.getTime() / 60_000);
    if (minute !== lastMinute) {
      lastMinute = minute;
      for (const j of jobs) if (matches(j, d)) runJob(j);
    }
    const wait = cfg.tickMs ?? (60_000 - (d.getTime() % 60_000) + 50);
    timer = setTimeout(tick, wait);
  };
  // Começa no minuto seguinte (não roda na hora de iniciar).
  lastMinute = Math.floor(now().getTime() / 60_000);
  timer = setTimeout(tick, cfg.tickMs ?? (60_000 - (now().getTime() % 60_000) + 50));
  log(`agendador iniciado com ${jobs.length} tarefa(s)`);

  return {
    port: 0,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      for (const c of running.values()) c.kill();
      log('agendador parado');
    },
  };
}

/*
 * Saída de terminal → texto para o agente: tira os códigos ANSI (cor, cursor, título) e aplica
 * o efeito de \r (volta ao começo da linha) e de backspace, como o terminal mostraria.
 */

// CSI (ESC [ ... letra), OSC (ESC ] ... BEL ou ESC \), DCS/SOS/PM/APC e escapes de 2 bytes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** Aplica \r e backspace linha a linha e remove os demais caracteres de controle. */
export function terminalText(raw: string): string {
  const lines = stripAnsi(raw).replace(/\r\n/g, '\n').split('\n');
  return lines.map((line) => {
    let out: string[] = [];
    let col = 0;
    for (const ch of line) {
      if (ch === '\r') col = 0;
      else if (ch === '\b') col = Math.max(0, col - 1);
      else if (ch === '\t') {
        const next = (Math.floor(col / 8) + 1) * 8;
        while (col < next) out[col++] = ' ';
      } else if (ch >= ' ' && ch !== '\x7f') out[col++] = ch;
    }
    out = out.map((c) => c ?? ' ');
    return out.join('').replace(/\s+$/, '');
  }).join('\n');
}

/** Guarda o fim da saída de um terminal (tamanho limitado) e conta o total já recebido. */
export class OutputBuffer {
  private chunks: string[] = [];
  private size = 0;
  /** Total de caracteres recebidos desde a abertura (marca para "o que veio depois de X"). */
  total = 0;
  private readonly max: number;

  constructor(max = 256 * 1024) {
    this.max = max;
  }

  push(data: string) {
    this.chunks.push(data);
    this.size += data.length;
    this.total += data.length;
    while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }

  /** Texto bruto recebido depois da marca `since` (o que ainda estiver guardado). */
  since(mark: number): string {
    const all = this.chunks.join('');
    const start = all.length - (this.total - mark);
    return start <= 0 ? all : all.slice(start);
  }

  /** Últimas `n` linhas como texto. */
  tail(n: number): string {
    const lines = terminalText(this.chunks.join('')).split('\n');
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.slice(-n).join('\n');
  }
}

/*
 * O OpenSSH escapa em octal (\343) os bytes que não são UTF-8 válido nas próprias mensagens. No
 * Windows em português o texto do sistema vem em cp1252: "Este host n\343o \351 conhecido."
 * Aqui os escapes voltam a ser os acentos (UTF-8 quando a sequência for UTF-8 válido, senão cp1252).
 * Só vira texto o que decodifica em letras: um "\351" que não é acento fica como está.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

// Sequências de bytes altos (\200-\377) que não vêm depois de outra barra ("\\351" é uma barra literal).
const ESCAPES = /(?<!\\)(?:\\[23][0-7]{2})+/g;
// Fim de pedaço que pode continuar no próximo: escapes completos (bytes de um mesmo caractere UTF-8,
// ou um acento seguido do resto da palavra) e um escape cortado ao meio ("\", "\3", "\34").
const TAIL = /(?<!\\)(?:\\[23][0-7]{2})*(?:\\(?:[23][0-7]?)?)?$/;

export function unescapeSshText(text: string): string {
  if (!text.includes('\\')) return text;
  return text.replace(ESCAPES, (run) => {
    const bytes = Uint8Array.from(run.slice(1).split('\\'), (octal) => parseInt(octal, 8));
    let decoded: string;
    try {
      decoded = utf8.decode(bytes);
    } catch {
      decoded = cp1252.decode(bytes);
    }
    return /^[\p{L}\p{M}]+$/u.test(decoded) ? decoded : run;
  });
}

/**
 * Para a saída do terminal, que chega em pedaços: o fim de um pedaço que pode continuar no próximo
 * fica guardado e sai junto com ele (ou no `flush`), para um "\343" cortado ao meio não escapar.
 */
export function sshTextStream(): { push(chunk: string): string; flush(): string; readonly pending: boolean } {
  let held = '';
  return {
    push(chunk) {
      const text = held + chunk;
      // Sem casamento quando o texto termina numa barra literal ("\\"): nada a guardar.
      held = TAIL.exec(text)?.[0] ?? '';
      return unescapeSshText(text.slice(0, text.length - held.length));
    },
    flush() {
      const text = held;
      held = '';
      return unescapeSshText(text);
    },
    get pending() {
      return held !== '';
    },
  };
}

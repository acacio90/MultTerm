import { desktopCapturer, screen } from 'electron';
import { createRequire } from 'node:module';
import type { Frame, VncInput } from '../servers/vnc.ts';

/*
 * Tela e entrada para o servidor VNC: captura do monitor principal (BGRA, na resolução física) e,
 * com o controle ligado, mouse e teclado injetados pelo Win32 (SetCursorPos, mouse_event,
 * SendInput). A tela segura do Windows (UAC, Ctrl+Alt+Del) não é capturada nem controlada.
 */

const require = createRequire(import.meta.url);

export async function captureScreen(): Promise<Frame> {
  const d = screen.getPrimaryDisplay();
  const width = Math.round(d.size.width * d.scaleFactor);
  const height = Math.round(d.size.height * d.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
  if (!src) throw new Error('nenhuma tela para capturar');
  const size = src.thumbnail.getSize();
  return { width: size.width, height: size.height, data: src.thumbnail.toBitmap() };
}

// Teclas especiais: keysym do X11 → tecla virtual do Windows.
const KEYSYM_VK: Record<number, number> = {
  0xff08: 0x08, 0xff09: 0x09, 0xff0d: 0x0d, 0xff1b: 0x1b, 0xff13: 0x13, 0xff14: 0x91, 0xff61: 0x2c,
  0xff50: 0x24, 0xff51: 0x25, 0xff52: 0x26, 0xff53: 0x27, 0xff54: 0x28, 0xff55: 0x21, 0xff56: 0x22, 0xff57: 0x23,
  0xff63: 0x2d, 0xffff: 0x2e, 0xff67: 0x5d, 0xffe5: 0x14, 0xff7f: 0x90,
  0xffe1: 0xa0, 0xffe2: 0xa1, 0xffe3: 0xa2, 0xffe4: 0xa3, 0xffe9: 0xa4, 0xffea: 0xa5, 0xff7e: 0xa5, 0xfe03: 0xa5,
  0xffeb: 0x5b, 0xffec: 0x5c, 0xffe7: 0x5b, 0xffe8: 0x5c,
  // Teclado numérico.
  0xff8d: 0x0d, 0xffaa: 0x6a, 0xffab: 0x6b, 0xffad: 0x6d, 0xffae: 0x6e, 0xffaf: 0x6f,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [0xffb0 + i, 0x60 + i])),
  // F1–F12.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [0xffbe + i, 0x70 + i])),
};
// Teclas estendidas (setas, Insert/Delete, Home/End, PgUp/PgDn, AltGr, Ctrl direito...).
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0xa3, 0xa5, 0x6f]);

/** Caractere do keysym (Latin-1 direto; Unicode em 0x01000000+). */
export function keysymChar(keysym: number): string | undefined {
  if ((keysym >= 0x20 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff)) return String.fromCharCode(keysym);
  if (keysym >= 0x01000100 && keysym <= 0x0110ffff) return String.fromCodePoint(keysym - 0x01000000);
  return undefined;
}

type Fn = (...args: unknown[]) => unknown;

/** Mouse e teclado do Windows para o VNC com controle. */
export function windowsInput(): VncInput {
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  // INPUT de teclado (64 bits): type, alinhamento, KEYBDINPUT e o resto da união (40 bytes no total).
  const INPUT = koffi.struct('MULTTERM_KEYINPUT', {
    type: 'uint32', align: 'uint32',
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
    pad: koffi.array('uint8', 8),
  });
  const SetCursorPos = u.func('__stdcall', 'SetCursorPos', 'bool', ['int', 'int']) as Fn;
  const mouseEvent = u.func('__stdcall', 'mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'int32', 'uintptr_t']) as Fn;
  const SendInput = u.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']) as Fn;
  const VkKeyScanW = u.func('__stdcall', 'VkKeyScanW', 'int16', ['uint16']) as Fn;
  const size = koffi.sizeof(INPUT) as number;

  const key = (vk: number, scan: number, flags: number) => {
    SendInput(1, [{ type: 1, align: 0, wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0, pad: new Array(8).fill(0) }], size);
  };

  let buttons = 0;
  const origin = () => {
    const d = screen.getPrimaryDisplay();
    return { x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor) };
  };
  const MOUSE: [number, number, number][] = [[1, 0x02, 0x04], [2, 0x20, 0x40], [4, 0x08, 0x10]]; // esquerdo, meio, direito

  return {
    pointer(x, y, mask) {
      const o = origin();
      SetCursorPos(o.x + x, o.y + y);
      for (const [bit, downFlag, upFlag] of MOUSE) {
        if ((mask & bit) !== (buttons & bit)) mouseEvent(mask & bit ? downFlag : upFlag, 0, 0, 0, 0);
      }
      // Roda: botões 4 (para cima) e 5 (para baixo) chegam como cliques.
      if (mask & 8 && !(buttons & 8)) mouseEvent(0x0800, 0, 0, 120, 0);
      if (mask & 16 && !(buttons & 16)) mouseEvent(0x0800, 0, 0, -120, 0);
      buttons = mask;
    },
    key(keysym, down) {
      const up = down ? 0 : 0x0002;
      const vk = KEYSYM_VK[keysym];
      if (vk !== undefined) {
        key(vk, 0, up | (EXTENDED.has(vk) ? 0x0001 : 0));
        return;
      }
      const ch = keysymChar(keysym);
      if (ch === undefined) return;
      // Letras, números e símbolos do teclado: tecla virtual (combina com Ctrl/Alt do cliente).
      const scan = ch.length === 1 ? (VkKeyScanW(ch.charCodeAt(0)) as number) : -1;
      if (scan !== -1 && (scan & 0xff) !== 0xff) {
        key(scan & 0xff, 0, up);
        return;
      }
      // O resto (acentos de outro layout, emoji): como caractere Unicode.
      for (const unit of ch.split('')) key(0, unit.charCodeAt(0), 0x0004 | up);
    },
  };
}

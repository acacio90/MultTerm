import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import { unionRect } from './rect.ts';

/*
 * Expandir a janela para todas as telas: a janela passa a cobrir a área útil de todos os monitores
 * juntos (sem a barra de tarefas), e clicar de novo volta ao tamanho e à posição de antes. Se um
 * monitor sai ou entra enquanto a janela está expandida, ela volta ao tamanho anterior.
 */

// Janela expandida → posição e tamanho de antes.
const before = new WeakMap<BrowserWindow, { bounds: Rectangle; maximized: boolean }>();

function notify(win: BrowserWindow) {
  if (!win.isDestroyed()) win.webContents.send('window:span-changed', before.has(win));
}

function restore(win: BrowserWindow) {
  const prev = before.get(win);
  if (!prev || win.isDestroyed()) return;
  before.delete(win);
  win.setBounds(prev.bounds);
  if (prev.maximized) win.maximize();
  notify(win);
}

/** Alterna entre expandida em todas as telas e o tamanho anterior. Devolve se ficou expandida. */
export function toggleSpan(win: BrowserWindow): boolean {
  if (before.has(win)) {
    restore(win);
    return false;
  }
  const maximized = win.isMaximized();
  if (win.isFullScreen()) win.setFullScreen(false);
  if (maximized) win.unmaximize();
  before.set(win, { bounds: win.getNormalBounds(), maximized });
  win.setBounds(unionRect(screen.getAllDisplays().map((d) => d.workArea)));
  notify(win);
  return true;
}

export function registerSpanIpc(): void {
  ipcMain.handle('window:span-toggle', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? toggleSpan(win) : false;
  });
  ipcMain.handle('window:span-state', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return !!win && before.has(win);
  });
  // Monitor desconectado ou conectado: a área mudou, volta ao tamanho anterior.
  const reset = () => {
    for (const w of BrowserWindow.getAllWindows()) restore(w);
  };
  screen.on('display-removed', reset);
  screen.on('display-added', reset);
}

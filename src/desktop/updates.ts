import { app, BrowserWindow } from 'electron';
import updater from 'electron-updater';

const { autoUpdater } = updater;

/** Estado da atualização, espelhado na tela de ajuda. */
export type UpdateStatus =
  | { state: 'unsupported'; message: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; notes?: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

let status: UpdateStatus = { state: 'idle' };

function publish(next: UpdateStatus): void {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('update:status', status);
  }
}

function notesText(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => (n as { note?: string }).note ?? '').join('\n');
  return undefined;
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function initUpdates(): void {
  // MULTTERM_UPDATE_URL aponta para outro servidor (espelho interno ou teste local).
  const feed = process.env.MULTTERM_UPDATE_URL;
  if (!app.isPackaged && !feed) {
    status = { state: 'unsupported', message: 'Atualizações só funcionam no app instalado.' };
    return;
  }
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  // Baixar e instalar só quando o usuário pedir.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    publish({ state: 'available', version: info.version, notes: notesText(info.releaseNotes) }));
  autoUpdater.on('update-not-available', (info) => publish({ state: 'not-available', version: info.version }));
  autoUpdater.on('download-progress', (p) => publish({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => publish({ state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => publish({ state: 'error', message: err?.message ?? String(err) }));

  // Verificação silenciosa ao abrir.
  setTimeout(() => void checkForUpdates(), 5000);
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (status.state === 'unsupported' || status.state === 'downloading' || status.state === 'downloaded') return status;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    publish({ state: 'error', message: (err as Error).message });
  }
  return status;
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (status.state !== 'available') return status;
  publish({ state: 'downloading', percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    publish({ state: 'error', message: (err as Error).message });
  }
  return status;
}

export function installUpdate(): void {
  if (status.state === 'downloaded') autoUpdater.quitAndInstall();
}

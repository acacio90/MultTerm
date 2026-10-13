// Gera desktop/icon.png (512x512) a partir de desktop/icon.svg usando o próprio Electron.
// Uso: npm run icon
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'desktop', 'icon.svg'), 'utf8');
const html = `<!doctype html><html style="overflow:hidden;background:transparent"><body style="margin:0;overflow:hidden;background:transparent">${svg.replace("<svg ", "<svg style=\"display:block\" ")}</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = join(root, 'desktop', 'icon.png');
  writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
  console.log(`ícone gerado: ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});

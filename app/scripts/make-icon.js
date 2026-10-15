// Renders build/icon.png (512x512) from SVG using Electron itself: `npx electron scripts/make-icon.js`.
// electron-builder turns it into the Windows .ico and macOS .icns.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(path.dirname(import.meta.dirname), 'build', 'icon.png');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect x="24" y="24" width="464" height="464" rx="104" fill="#15181d"/>
  <rect x="24.5" y="24.5" width="463" height="463" rx="103.5" fill="none" stroke="#2c323d" stroke-width="3"/>
  <path d="M132 168l96 88-96 88" fill="none" stroke="#3ddc97" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M262 344h118" stroke="#3ddc97" stroke-width="44" stroke-linecap="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, frame: false, transparent: true, show: true, useContentSize: true });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
  console.log(`wrote ${out}`);
  app.quit();
});

// Renders build/icon.png (512x512) and build/icon.ico from SVG using Electron itself: `npm run icon`.
// The .ico is the Windows exe/installer icon and what a pinned taskbar button shows (see main.js).
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(path.dirname(import.meta.dirname), 'build', 'icon.png');
const outIco = out.replace(/.png$/, '.ico');

/** 32-bit bitmap image data for one .ico entry (BITMAPINFOHEADER, bottom-up BGRA, empty AND mask). */
function dib(image, size) {
  const bgra = image.resize({ width: size, height: size, quality: 'best' }).toBitmap(); // BGRA on Windows
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour image + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) bgra.copy(pixels, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // transparency comes from the alpha channel
  return Buffer.concat([header, pixels, mask]);
}

/** A Windows .ico: bitmaps for the small sizes, PNG for 256px, the standard layout every reader accepts. */
function toIco(image) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const images = sizes.map((size) => (size === 256 ? image.resize({ width: 256, height: 256, quality: 'best' }).toPNG() : dib(image, size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(images[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images]);
}
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
  const full = image.resize({ width: 512, height: 512 });
  fs.writeFileSync(out, full.toPNG());
  fs.writeFileSync(outIco, toIco(full));
  console.log(`wrote ${out} and ${outIco}`);
  app.quit();
});

// Renders site/og.png (1200x630), the preview image shown when the site is shared: `npx electron scripts/make-og.js`.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(path.dirname(import.meta.dirname), '..', 'site', 'og.png');
const html = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@500;600&family=Geist+Mono:wght@400&display=swap" rel="stylesheet">
<style>
  body { margin: 0; width: 1200px; height: 630px; background: #0e1013; color: #e7e9ec; font-family: Geist, 'Segoe UI', sans-serif; display: flex; flex-direction: column; justify-content: space-between; padding: 72px 80px; box-sizing: border-box; }
  .logo { display: flex; align-items: center; gap: 14px; font-size: 34px; font-weight: 600; }
  h1 { font-size: 76px; line-height: 1.04; letter-spacing: -2.6px; font-weight: 600; margin: 0; max-width: 900px; }
  .foot { display: flex; justify-content: space-between; align-items: flex-end; font-family: 'Geist Mono', monospace; font-size: 24px; color: #8d95a3; }
  .lanes { display: flex; flex-direction: column; gap: 9px; width: 300px; }
  .lanes i { display: block; height: 9px; border-radius: 3px; background: #3ddc97; }
</style></head><body>
  <div class="logo"><svg width="40" height="40" viewBox="0 0 24 24"><path d="M4.5 6.5L10 12l-5.5 5.5M12.5 17.5h7" fill="none" stroke="#3ddc97" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Swiftstream</div>
  <h1>Keep your SSH login. Lose the slow transfers.</h1>
  <div class="foot"><span>Files over HTTPS on 8 connections</span>
    <div class="lanes"><i style="width:94%"></i><i style="width:88%"></i><i style="width:36%;background:#24382f"></i><i style="width:97%"></i><i style="width:91%"></i></div>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 630, show: true, frame: false, useContentSize: true });
  await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 630 });
  fs.writeFileSync(out, image.resize({ width: 1200, height: 630 }).toPNG());
  console.log(`wrote ${out}`);
  app.quit();
});

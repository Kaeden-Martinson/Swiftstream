// The app runs the same client code as the CLI. Copy ../src into app/core so the packaged
// app is self-contained (electron-builder only bundles files inside this folder).
import fs from 'node:fs';
import path from 'node:path';

const appDir = path.dirname(import.meta.dirname);
const src = path.join(appDir, '..', 'src');
const dest = path.join(appDir, 'core');

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`synced ${fs.readdirSync(dest).length} core modules into app/core`);

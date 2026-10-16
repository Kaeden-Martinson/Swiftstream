// The app runs the same client code as the CLI. Copy ../src into app/core so the packaged
// app is self-contained (electron-builder only bundles files inside this folder), along with
// the single-file server bundle the app uploads when it sets up a server.
import fs from 'node:fs';
import path from 'node:path';

const appDir = path.dirname(import.meta.dirname);
const repo = path.join(appDir, '..');
const dest = path.join(appDir, 'core');
const bundle = path.join(repo, 'dist', 'swiftssh.cjs');

if (!fs.existsSync(bundle)) {
  console.error('dist/swiftssh.cjs is missing. Run "npm run build" in the repository root first.');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(repo, 'src'), dest, { recursive: true });
fs.copyFileSync(bundle, path.join(dest, 'swiftssh.cjs'));
console.log(`synced ${fs.readdirSync(dest).length} core files into app/core (including the server bundle)`);

// The app runs the same client code as the CLI. Copy ../src into app/core so the packaged
// app is self-contained (electron-builder only bundles files inside this folder), along with
// the single-file server bundle the app uploads when it sets up a server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const appDir = path.dirname(import.meta.dirname);
const repo = path.join(appDir, '..');
const dest = path.join(appDir, 'core');
const bundle = path.join(repo, 'dist', 'swiftstream.cjs');

// Running from source: rebuild the server bundle (a second or two) so the app never uploads an older
// Swiftstream than its own code, which would leave servers "updated" to the old version. The
// installer build uses the bundle and exe that "npm run build" just made instead.
if (!process.argv.includes('--for-installer')) {
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'build.mjs'), '--no-exe'], { stdio: 'inherit' });
}

if (!fs.existsSync(bundle)) {
  console.error('dist/swiftstream.cjs is missing. Run "npm run build" in the repository root first.');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(repo, 'src'), dest, { recursive: true });
fs.copyFileSync(bundle, path.join(dest, 'swiftstream.cjs'));
// The installer ships the standalone swiftstream.exe and puts its folder on PATH (see build/installer.nsh).
const exe = path.join(repo, 'dist', 'swiftstream.exe');
if (fs.existsSync(exe)) fs.copyFileSync(exe, path.join(appDir, 'build', 'cli', 'swiftstream.exe'));
else if (process.argv.includes('--for-installer')) {
  console.error('dist/swiftstream.exe is missing. Run "npm run build" in the repository root first.');
  process.exit(1);
}
console.log(`synced ${fs.readdirSync(dest).length} core files into app/core (including the server bundle)`);

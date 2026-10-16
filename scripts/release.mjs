// Build every downloadable file and put them where the website serves them:
//
//   site/downloads/Swiftstream-Setup-<version>.exe     desktop app installer (Windows)
//   site/downloads/swiftstream-<version>-win-x64.exe   standalone CLI, Node built in
//   site/downloads/swiftstream-<version>.cjs           portable CLI for any OS with Node 18+
//   site/downloads/SHA256SUMS.txt                   checksums, in sha256sum format
//   site/downloads/latest.json                      what the website reads for links and sizes
//
//   npm run release                 everything
//   npm run release -- --no-app     skip the desktop installer (much faster)
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(import.meta.dirname);
const appDir = path.join(root, 'app');
const out = path.join(root, 'site', 'downloads');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const appVersion = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const step = (text) => console.log(`\n> ${text}`);
// npm is a .cmd script on Windows, so it runs as one shell command line; node runs directly
// (its path, "C:\Program Files\nodejs\node.exe", has a space).
const run = (cmd, args, cwd = root) =>
  cmd === npm ? execSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit' }) : execFileSync(cmd, args, { cwd, stdio: 'inherit' });

fs.mkdirSync(out, { recursive: true });
const files = [];
const add = (source, name, kind, label) => {
  const target = path.join(out, name);
  fs.copyFileSync(source, target);
  const data = fs.readFileSync(target);
  files.push({ name, kind, label, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  console.log(`  ${name}  ${(data.length / 1024 / 1024).toFixed(1)} MB`);
};

step('Building the CLI (bundle and standalone executable)');
run(process.execPath, [path.join(root, 'scripts', 'build.mjs')]);
if (process.platform === 'win32') add(path.join(root, 'dist', 'swiftstream.exe'), `swiftstream-${version}-win-x64.exe`, 'cli-exe', 'Command line, Windows 64-bit');
add(path.join(root, 'dist', 'swiftstream.cjs'), `swiftstream-${version}.cjs`, 'cli-portable', 'Command line, any system with Node.js 18+');

if (!process.argv.includes('--no-app')) {
  step('Building the desktop app installer');
  run(npm, ['run', 'sync-core'], appDir);
  // Its own output folder, so a copy of the app running from app/dist doesn't lock the build.
  run(npm, ['exec', '--', 'electron-builder', '--win', '--publish', 'never', '--config.directories.output=release'], appDir);
  add(path.join(appDir, 'release', `Swiftstream-Setup-${appVersion}.exe`), `Swiftstream-Setup-${appVersion}.exe`, 'app-windows', 'Desktop app, Windows 64-bit');
}

// Keep entries for files built in an earlier run (e.g. the installer when using --no-app).
const manifestPath = path.join(out, 'latest.json');
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || [] : [];
for (const old of previous) {
  if (!files.some((f) => f.kind === old.kind) && fs.existsSync(path.join(out, old.name))) files.push(old);
}
// Remove downloads from older versions.
for (const name of fs.readdirSync(out)) {
  if (!['latest.json', 'SHA256SUMS.txt'].includes(name) && !files.some((f) => f.name === name)) fs.rmSync(path.join(out, name));
}

const manifest = { version, appVersion, released: new Date().toISOString().slice(0, 10), files };
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
step(`Done: site/downloads has ${files.length} files for version ${version}`);

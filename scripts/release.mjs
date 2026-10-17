// Build the downloads for this system and put them where the website serves them (site/downloads):
//
//   Windows   Swiftstream-Setup-<v>.exe               desktop app installer
//             swiftstream-<v>-win-x64.exe             standalone command line, Node built in
//   macOS     Swiftstream-<v>-mac.dmg                 desktop app (Apple silicon and Intel)
//             swiftstream-<v>-macos-<arch>            standalone command line
//   Linux     Swiftstream-<v>-linux-x86_64.AppImage   desktop app
//             Swiftstream-<v>-linux-amd64.deb         desktop app, Debian and Ubuntu
//             swiftstream-<v>-linux-x64               standalone command line
//   any       swiftstream-<v>.cjs                     command line for any system with Node 18+
//   and SHA256SUMS.txt plus latest.json (what the website reads for links, sizes and checksums).
//
// The desktop app's update feed (latest*.yml, .blockmap, the macOS .zip) stays in app/release, for the
// GitHub Release only.
//
//   npm run release                       everything this system can build
//   npm run release -- --no-app           skip the desktop app (much faster)
//   npm run release -- --manifest-only    just rewrite latest.json and SHA256SUMS.txt from the files in
//                                         site/downloads (how CI merges the Windows, macOS and Linux builds)
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

/** What each download is, by its file name: [pattern, kind, label]. */
const KINDS = [
  [`Swiftstream-Setup-${appVersion}.exe`, 'app-windows', 'Desktop app, Windows 64-bit'],
  [`Swiftstream-${appVersion}-mac.dmg`, 'app-mac', 'Desktop app, macOS (Apple silicon and Intel)'],
  [`Swiftstream-${appVersion}-linux-x86_64.AppImage`, 'app-linux', 'Desktop app, Linux (AppImage)'],
  [`Swiftstream-${appVersion}-linux-amd64.deb`, 'app-linux-deb', 'Desktop app, Debian and Ubuntu'],
  [`swiftstream-${version}-win-x64.exe`, 'cli-exe', 'Command line, Windows 64-bit'],
  [`swiftstream-${version}-macos-arm64`, 'cli-mac', 'Command line, macOS (Apple silicon)'],
  [`swiftstream-${version}-macos-x64`, 'cli-mac-intel', 'Command line, macOS (Intel)'],
  [`swiftstream-${version}-linux-x64`, 'cli-linux', 'Command line, Linux 64-bit'],
  [`swiftstream-${version}.cjs`, 'cli-portable', 'Command line, any system with Node.js 18+'],
];

fs.mkdirSync(out, { recursive: true });
const copyOut = (source, name) => {
  fs.copyFileSync(source, path.join(out, name));
  console.log(`  ${name}  ${(fs.statSync(source).size / 1024 / 1024).toFixed(1)} MB`);
};

if (!process.argv.includes('--manifest-only')) {
  step('Building the command line (bundle and standalone executable)');
  run(process.execPath, [path.join(root, 'scripts', 'build.mjs')]);
  const exe = path.join(root, 'dist', process.platform === 'win32' ? 'swiftstream.exe' : 'swiftstream');
  const exeName = { win32: `swiftstream-${version}-win-x64.exe`, darwin: `swiftstream-${version}-macos-${process.arch}`, linux: `swiftstream-${version}-linux-x64` }[process.platform];
  if (exeName && fs.existsSync(exe)) copyOut(exe, exeName);
  copyOut(path.join(root, 'dist', 'swiftstream.cjs'), `swiftstream-${version}.cjs`);

  if (!process.argv.includes('--no-app')) {
    step('Building the desktop app');
    // Same steps as "npm run dist" in app/: copy the CLI in, and on Windows the installer's PATH script.
    run(npm, ['run', 'sync-core', '--', process.platform === 'win32' ? '--for-installer' : ''], appDir);
    if (process.platform === 'win32') run(process.execPath, [path.join(appDir, 'scripts', 'make-installer.js')]);
    const target = { win32: '--win', darwin: '--mac', linux: '--linux' }[process.platform];
    // Its own output folder, so a copy of the app running from app/dist doesn't lock the build.
    run(npm, ['exec', '--', 'electron-builder', target, '--publish', 'never', '--config.directories.output=release'], appDir);
    for (const [name, kind] of KINDS) {
      if (kind.startsWith('app-') && fs.existsSync(path.join(appDir, 'release', name))) copyOut(path.join(appDir, 'release', name), name);
    }
  }
}

// latest.json and SHA256SUMS.txt describe every download of this version in site/downloads.
step('Writing latest.json and SHA256SUMS.txt');
const files = [];
for (const [name, kind, label] of KINDS) {
  const file = path.join(out, name);
  if (!fs.existsSync(file)) continue;
  const data = fs.readFileSync(file);
  files.push({ name, kind, label, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
}
// Remove downloads from older versions.
for (const name of fs.readdirSync(out)) {
  if (!['latest.json', 'SHA256SUMS.txt'].includes(name) && !files.some((f) => f.name === name)) fs.rmSync(path.join(out, name));
}
const manifest = { version, appVersion, released: new Date().toISOString().slice(0, 10), files };
fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
console.log(`  ${files.map((f) => f.kind).join(', ')}`);
step(`Done: site/downloads has ${files.length} files for version ${version}`);

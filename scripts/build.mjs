// Build swiftstream into:
//   dist/swiftstream.cjs  one self-contained file (runs with `node swiftstream.cjs`; this is what gets uploaded to servers)
//   dist/swiftstream(.exe) a standalone executable with Node built in (Node "single executable application")
//
//   npm run build            both
//   npm run build -- --no-exe   just the bundle
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.dirname(import.meta.dirname);
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const bundlePath = path.join(dist, 'swiftstream.cjs');
const exeName = process.platform === 'win32' ? 'swiftstream.exe' : 'swiftstream';
const exePath = path.join(dist, exeName);

fs.mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'bin', 'swiftstream.js')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  define: { __SWIFTSTREAM_VERSION__: JSON.stringify(pkg.version) },
  // Optional native add-ons: each is loaded inside a try/catch and has a pure-JS fallback.
  external: ['node-pty', 'cpu-features', 'bufferutil', 'utf-8-validate', '*.node'],
  legalComments: 'none',
  // version.js reads package.json via import.meta only when not bundled; that branch is dead here.
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'warning',
});
console.log(`bundle      ${path.relative(root, bundlePath)}  (${(fs.statSync(bundlePath).size / 1024).toFixed(0)} KB)`);

if (process.argv.includes('--no-exe')) process.exit(0);

// Single executable: copy this Node binary and inject the bundle (also embedded as an asset, so
// the exe can upload itself to servers).
const seaConfig = path.join(dist, 'sea-config.json');
const blob = path.join(dist, 'sea-prep.blob');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundlePath, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets: { 'swiftstream.cjs': bundlePath } }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
fs.copyFileSync(process.execPath, exePath);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exePath]);
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(
  process.execPath,
  [postject, exePath, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exePath]);
fs.rmSync(blob);
fs.rmSync(seaConfig);
console.log(`executable  ${path.relative(root, exePath)}  (${(fs.statSync(exePath).size / 1024 / 1024).toFixed(0)} MB, Node ${process.versions.node})`);

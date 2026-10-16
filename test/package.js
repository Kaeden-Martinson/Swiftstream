// Test the package the way users get it: `npm pack`, install the tarball globally into a
// throwaway prefix, check the commands, then run the SSH setup tests against that install.
//   npm run test:package
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work = path.join(root, '.test-home', 'package');
const prefix = path.join(work, 'prefix');
const isWin = process.platform === 'win32';

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(prefix, { recursive: true });

console.log('packing…');
const packOut = execSync(`npm pack --pack-destination "${work}" --json`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
// The prepack build prints a line before npm's JSON; parse from where the JSON starts.
const packed = JSON.parse(packOut.slice(packOut.search(/^\[/m)))[0];
const tarball = path.join(work, packed.filename);
const files = packed.files.map((f) => f.path);
for (const required of ['bin/swiftstream.js', 'dist/swiftstream.cjs', 'LICENSE', 'README.md', 'src/server.js']) {
  assert.ok(files.includes(required), `package is missing ${required}`);
}
assert.ok(!files.some((f) => f.startsWith('app/') || f.startsWith('site/') || f.startsWith('test/')), 'package contains files it should not');
console.log(`ok  package has the CLI, the server bundle and the license (${files.length} files)`);

console.log('installing into a temporary prefix…');
execSync(`npm install -g --prefix "${prefix}" --no-fund --no-audit "${tarball}"`, { stdio: 'ignore' });
const pkgDir = isWin ? path.join(prefix, 'node_modules', 'swiftstream') : path.join(prefix, 'lib', 'node_modules', 'swiftstream');
const binDir = isWin ? prefix : path.join(prefix, 'bin');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

for (const command of ['swiftstream', 'sws']) {
  const shim = path.join(binDir, isWin ? `${command}.cmd` : command);
  assert.ok(fs.existsSync(shim), `${command} was not installed`);
  // .cmd shims on Windows need a shell, so pass one quoted command line rather than an args array.
  const r = isWin ? spawnSync(`"${shim}" --version`, { encoding: 'utf8', shell: true }) : spawnSync(shim, ['--version'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), version, `${command} --version printed ${r.stdout}${r.stderr}`);
}
console.log(`ok  "swiftstream" and "sws" installed and print ${version}`);

console.log('running the SSH setup tests with the installed copy…\n');
execFileSync(process.execPath, [path.join(root, 'test', 'bootstrap.js')], {
  stdio: 'inherit',
  env: { ...process.env, SWIFTSTREAM_TEST_CLI: path.join(pkgDir, 'bin', 'swiftstream.js') },
});
console.log('\npackage tests passed');

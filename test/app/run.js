// Desktop app tests: the real app, driven by scripts, against throwaway servers.
//   npm run test:app             all of them
//   npm run test:app -- terminal  just the ones whose names contain "terminal"
// Needs a desktop session (Windows or macOS, or Linux with a display) and a POSIX sh (Git Bash on Windows).
// Each test leaves its screenshots in .test-home/app/<test>/shots.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root } from './harness.js';

if (spawnSync('sh', ['-c', 'exit 0']).status !== 0) {
  console.log('skip app tests: no POSIX sh on PATH');
  process.exit(0);
}

// The app uploads app/core/swiftstream.cjs to servers: build it and copy the shared code in first.
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--no-exe'], { stdio: 'ignore' });
execFileSync(process.execPath, [path.join(root, 'app', 'scripts', 'sync-core.js')], { stdio: 'ignore' });

const filter = process.argv[2];
const tests = fs
  .readdirSync(path.dirname(fileURLToPath(import.meta.url)))
  .filter((f) => f.endsWith('.test.js') && (!filter || f.includes(filter)))
  .sort();

let failed = 0;
for (const file of tests) {
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'test', 'app', file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (c) => {
      if (c !== 0) console.log(out.trim().split('\n').map((l) => `    ${l}`).join('\n'));
      resolve(c);
    });
  });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`${code === 0 ? 'ok ' : 'FAIL'} ${file.replace('.test.js', '')} (${secs}s)`);
  if (code !== 0) failed++;
}
console.log(failed ? `\n${failed} of ${tests.length} app tests failed` : `\nall ${tests.length} app tests passed`);
process.exit(failed ? 1 : 0);

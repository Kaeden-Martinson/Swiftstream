// End-to-end test: runs a real server and client on this machine with separate SWIFTSSH_HOME dirs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'swiftssh.js');
const work = path.join(root, '.test-home');
const serverHome = path.join(work, 'server');
const clientHome = path.join(work, 'client');
const strangerHome = path.join(work, 'stranger');
const files = path.join(work, 'files');
const port = String(17000 + Math.floor(Math.random() * 1000));

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(files, { recursive: true });

const run = (home, ...args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SWIFTSSH_HOME: home }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ok = (home, ...args) => {
  const r = run(home, ...args);
  assert.equal(r.code, 0, `swiftssh ${args.join(' ')} failed:\n${r.err}${r.out}`);
  return r.out;
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const server = spawn(process.execPath, [cli, 'serve', '--port', port, '--host', '127.0.0.1', '--root', files], {
  env: { ...process.env, SWIFTSSH_HOME: serverHome },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => d.toString().includes('SWIFTSSH_READY') && resolve());
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

try {
  const pub = ok(clientHome, 'keygen').trim();
  ok(serverHome, 'authorize', pub);
  ok(clientHome, 'add', 'local', `https://127.0.0.1:${port}`, '--yes');
  console.log('ok  keygen / authorize / add');

  const exec = ok(clientHome, 'exec', 'local', '--', 'echo', 'hello-swiftssh');
  assert.match(exec, /hello-swiftssh/);
  console.log('ok  exec');

  const src = path.join(work, 'big.bin');
  fs.writeFileSync(src, crypto.randomBytes(25 * 1024 * 1024 + 123)); // deliberately not chunk-aligned
  ok(clientHome, 'push', 'local', src, 'uploads/', '--chunk', '1MB', '--parallel', '8');
  assert.equal(sha(path.join(files, 'uploads', 'big.bin')), sha(src));
  console.log('ok  push 25MB in parallel chunks, sha256 verified');

  const back = path.join(work, 'back.bin');
  ok(clientHome, 'pull', 'local', 'uploads/big.bin', back, '--chunk', '1MB');
  assert.equal(sha(back), sha(src));
  console.log('ok  pull with parallel ranges, sha256 verified');

  const empty = path.join(work, 'empty.txt');
  fs.writeFileSync(empty, '');
  ok(clientHome, 'push', 'local', empty, 'empty.txt');
  assert.equal(fs.statSync(path.join(files, 'empty.txt')).size, 0);
  console.log('ok  empty file');

  // A key the server never authorized must be rejected.
  ok(strangerHome, 'keygen');
  fs.copyFileSync(path.join(clientHome, 'hosts.json'), path.join(strangerHome, 'hosts.json'));
  const denied = run(strangerHome, 'exec', 'local', '--', 'echo', 'nope');
  assert.notEqual(denied.code, 0);
  assert.match(denied.err, /key not authorized/);
  console.log('ok  unauthorized key rejected');

  // A pinned fingerprint that doesn't match must refuse to connect.
  const hosts = JSON.parse(fs.readFileSync(path.join(clientHome, 'hosts.json'), 'utf8'));
  hosts.local.fingerprint = hosts.local.fingerprint.replace(/^../, '00');
  fs.writeFileSync(path.join(strangerHome, 'hosts.json'), JSON.stringify(hosts));
  fs.copyFileSync(path.join(clientHome, 'id_ed25519'), path.join(strangerHome, 'id_ed25519'));
  const mitm = run(strangerHome, 'exec', 'local', '--', 'echo', 'nope');
  assert.match(mitm.err, /HOST IDENTIFICATION CHANGED/);
  console.log('ok  certificate pinning enforced');

  console.log('\nall tests passed');
} finally {
  server.kill();
}

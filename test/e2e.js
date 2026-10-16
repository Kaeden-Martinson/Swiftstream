// End-to-end test: runs a real server and client on this machine with separate SWIFTSTREAM_HOME dirs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'swiftstream.js');
const work = path.join(root, '.test-home');
const serverHome = path.join(work, 'server');
const clientHome = path.join(work, 'client');
const strangerHome = path.join(work, 'stranger');
const files = path.join(work, 'files');
const port = String(17000 + Math.floor(Math.random() * 1000));

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(files, { recursive: true });

const run = (home, ...args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SWIFTSTREAM_HOME: home }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ok = (home, ...args) => {
  const r = run(home, ...args);
  assert.equal(r.code, 0, `swiftstream ${args.join(' ')} failed:\n${r.err}${r.out}`);
  return r.out;
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const treeHashes = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(e.parentPath, e.name);
        return [path.relative(dir, full).split(path.sep).join('/'), sha(full)];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const server = spawn(process.execPath, [cli, 'serve', '--port', port, '--host', '127.0.0.1', '--root', files], {
  env: { ...process.env, SWIFTSTREAM_HOME: serverHome },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => d.toString().includes('running on port') && resolve());
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

try {
  const pub = ok(clientHome, 'keygen').trim();
  ok(serverHome, 'authorize', pub);
  ok(clientHome, 'add', 'local', `https://127.0.0.1:${port}`, '--yes');
  console.log('ok  keygen / authorize / add');

  const exec = ok(clientHome, 'exec', 'local', '--', 'echo', 'hello-swiftstream');
  assert.match(exec, /hello-swiftstream/);
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

  // Folder sync: many small files (bundled) plus files above the 1MB bundling threshold (chunked).
  const tree = path.join(work, 'site');
  for (let i = 0; i < 600; i++) {
    const file = path.join(tree, `dir${i % 7}`, `sub${i % 3}`, `file${i}.txt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(100 + (i % 50) * 37));
  }
  fs.writeFileSync(path.join(tree, 'large-a.bin'), crypto.randomBytes(3 * 1024 * 1024 + 7));
  fs.writeFileSync(path.join(tree, 'dir1', 'large-b.bin'), crypto.randomBytes(2 * 1024 * 1024));
  fs.writeFileSync(path.join(tree, 'empty.txt'), '');

  let out = ok(clientHome, 'push', 'local', tree, 'deploy/', '--chunk', '1MB');
  assert.match(out, /603 sent/);
  assert.deepEqual(treeHashes(path.join(files, 'deploy', 'site')), treeHashes(tree));
  console.log('ok  push folder: 600 small files bundled + 2 large chunked');

  out = ok(clientHome, 'push', 'local', tree, 'deploy/');
  assert.match(out, /0 sent .*603 unchanged/);
  fs.writeFileSync(path.join(tree, 'dir3', 'sub0', 'file3.txt'), 'changed');
  out = ok(clientHome, 'push', 'local', tree, 'deploy/');
  assert.match(out, /1 sent .*602 unchanged/);
  assert.deepEqual(treeHashes(path.join(files, 'deploy', 'site')), treeHashes(tree));
  console.log('ok  re-push sends only changed files');

  const pulled = path.join(work, 'pulled');
  ok(clientHome, 'pull', 'local', 'deploy/site', pulled, '--chunk', '1MB');
  assert.deepEqual(treeHashes(pulled), treeHashes(tree));
  out = ok(clientHome, 'pull', 'local', 'deploy/site', pulled);
  assert.match(out, /0 sent/);
  console.log('ok  pull folder, then re-pull is a no-op');

  // Paths inside a bundle must not escape the target folder.
  process.env.SWIFTSTREAM_HOME = clientHome;
  const { connectClient } = await import('../src/client.js');
  const { loadOrCreateIdentity } = await import('../src/keys.js');
  const { getHost } = await import('../src/config.js');
  const { encodeBundle } = await import('../src/bundle.js');
  const api = await connectClient(getHost('local'), loadOrCreateIdentity());
  for (const evil of ['../escaped.txt', 'a/../../escaped.txt', path.resolve(work, 'escaped.txt')]) {
    const body = encodeBundle([{ header: { path: evil, mtime: Date.now() }, data: Buffer.from('pwned') }]);
    await assert.rejects(
      api.request('PUT', '/v1/bundle', { query: { root: 'deploy' }, body, headers: { 'content-type': 'application/octet-stream' } }),
      (err) => err.status === 400,
    );
  }
  await assert.rejects(api.request('POST', '/v1/bundle/read', { body: { root: 'deploy', paths: ['../uploads/big.bin'] } }), (err) => err.status === 400);
  assert.ok(!fs.existsSync(path.join(files, 'escaped.txt')) && !fs.existsSync(path.join(work, 'escaped.txt')));
  console.log('ok  path traversal rejected');

  // Rename and delete (the app's right-click menu).
  await api.request('POST', '/v1/rename', { body: { from: 'empty.txt', to: 'renamed.txt' } });
  assert.ok(fs.existsSync(path.join(files, 'renamed.txt')) && !fs.existsSync(path.join(files, 'empty.txt')));
  await assert.rejects(api.request('POST', '/v1/rename', { body: { from: 'renamed.txt', to: 'uploads' } }), (err) => err.status === 409);
  await api.request('POST', '/v1/rm', { body: { path: 'deploy' } });
  assert.ok(!fs.existsSync(path.join(files, 'deploy')));
  await assert.rejects(api.request('POST', '/v1/rm', { body: { path: '.' } }), (err) => err.status === 400); // the server's root
  api.close();
  console.log('ok  rename and delete, root protected');

  // A key the server never authorized must be rejected.
  ok(strangerHome, 'keygen');
  fs.copyFileSync(path.join(clientHome, 'hosts.json'), path.join(strangerHome, 'hosts.json'));
  const denied = run(strangerHome, 'exec', 'local', '--', 'echo', 'nope');
  assert.notEqual(denied.code, 0);
  assert.match(denied.err, /isn't authorized/);
  console.log('ok  unauthorized key rejected');

  // Repeated failed logins from one address get rate limited (429), even with a valid key afterwards.
  for (let i = 0; i < 10; i++) run(strangerHome, 'exec', 'local', '--', 'echo', 'nope');
  const limited = run(strangerHome, 'exec', 'local', '--', 'echo', 'nope');
  assert.match(limited.err, /too many failed attempts/);
  const blockedGood = run(clientHome, 'exec', 'local', '--', 'echo', 'hi');
  assert.match(blockedGood.err, /too many failed attempts/);
  console.log('ok  brute-force login attempts rate limited');

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

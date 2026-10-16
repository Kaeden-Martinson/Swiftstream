// End-to-end test of first-time setup over SSH with a password: a tiny SSH server (ssh2) runs
// real shell commands, and swiftstream must log in, upload itself, start, and connect.
// Needs a POSIX `sh` on PATH (Linux, macOS, or Git Bash on Windows); skipped otherwise.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// test/package.js points this at a copy installed from the packed tarball.
const cli = process.env.SWIFTSTREAM_TEST_CLI || path.join(root, 'bin', 'swiftstream.js');
const work = path.join(root, '.test-home', 'bootstrap');
const exe = path.join(root, 'dist', process.platform === 'win32' ? 'swiftstream.exe' : 'swiftstream');

if (spawnSync('sh', ['-c', 'exit 0']).status !== 0) {
  console.log('skip bootstrap tests: no POSIX sh on PATH');
  process.exit(0);
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--no-exe'], { stdio: 'ignore' });

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// ---- a minimal SSH server: password auth, exec runs `sh -c` as that user's "home" ----
const users = { tester: { password: 's3cret', home: path.join(work, 'home-tester') }, second: { password: 'hunter2', home: path.join(work, 'home-second') } };
for (const u of Object.values(users)) fs.mkdirSync(u.home, { recursive: true });

function startSshServer(port, hostKey) {
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    let user;
    client.on('authentication', (ctx) => {
      const account = users[ctx.username];
      if (ctx.method === 'password' && account && ctx.password === account.password) {
        user = account;
        return ctx.accept();
      }
      // Key login against the account's ~/.ssh/authorized_keys, like sshd.
      if (ctx.method === 'publickey' && account) {
        const file = path.join(account.home, '.ssh', 'authorized_keys');
        const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
        const match = lines.map((l) => ssh2.utils.parseKey(l)).find((k) => !(k instanceof Error) && k.getPublicSSH().equals(ctx.key.data));
        if (match && (!ctx.signature || match.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) {
          user = account;
          return ctx.accept();
        }
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const home = user.home.split(path.sep).join('/');
        const env = { ...process.env, HOME: home, USERPROFILE: user.home, SWIFTSTREAM_HOME: path.join(user.home, '.swiftstream') };
        delete env.SSH_AUTH_SOCK;
        const child = spawn('sh', ['-c', info.command], { env, cwd: user.home });
        stream.pipe(child.stdin);
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream.stderr, { end: false });
        child.stdin.on('error', () => {});
        child.on('close', (code) => {
          stream.exit(code ?? 1);
          stream.end();
        });
      });
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const rsaKey = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const sshPort = await freePort();
let sshServer = await startSshServer(sshPort, rsaKey());

const clientHome = path.join(work, 'client');
// Async on purpose: the SSH server above runs in this same process, so a blocking spawnSync would freeze it.
const run = (args, { input = '', home = clientHome, bin = [process.execPath, cli] } = {}) =>
  new Promise((resolve) => {
    const child = spawn(bin[0], [...bin.slice(1), ...args], { env: { ...process.env, SWIFTSTREAM_HOME: home, SSH_AUTH_SOCK: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(input);
  });
const ok = async (args, opts) => {
  const r = await run(args, opts);
  assert.equal(r.code, 0, `swiftstream ${args.join(' ')} failed:\n${r.err}${r.out}`);
  return r;
};
const stopRemote = (user) =>
  spawnSync(process.execPath, [path.join(root, 'dist', 'swiftstream.cjs'), 'stop'], { env: { ...process.env, SWIFTSTREAM_HOME: path.join(user.home, '.swiftstream') } });

const swiftPort = await freePort();
const target = `tester@127.0.0.1`;
try {
  // Wrong password: refused, and nothing saved.
  let r = await run(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], { input: 'wrong\n' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /was refused/);
  console.log('ok  wrong password refused');

  // Right password: uploads the bundle, starts swiftstream, authorizes us, saves the host.
  r = await ok(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], { input: 's3cret\n' });
  assert.match(r.err, /Uploading Swiftstream/);
  assert.match(r.out, /box.*is ready/);
  assert.ok(fs.existsSync(path.join(users.tester.home, '.swiftstream', 'bin', 'swiftstream.cjs')));
  console.log('ok  password login, upload, start, authorize');

  r = await ok(['exec', 'box', '--', 'echo', 'hello-from-bootstrap']);
  assert.match(r.out, /hello-from-bootstrap/);
  const file = path.join(work, 'payload.bin');
  fs.writeFileSync(file, crypto.randomBytes(3 * 1024 * 1024));
  await ok(['push', 'box', file, 'payload.bin', '--chunk', '1MB']);
  assert.ok(fs.readFileSync(path.join(users.tester.home, 'payload.bin')).equals(fs.readFileSync(file)));
  console.log('ok  exec and push over the new connection');

  // Setup authorized this computer's key for SSH, so a restart needs no password at all.
  const authorized = fs.readFileSync(path.join(users.tester.home, '.ssh', 'authorized_keys'), 'utf8');
  assert.match(authorized, /^ssh-ed25519 \S+ swiftstream@/m);
  r = await ok(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], { input: '' });
  assert.doesNotMatch(r.err, /Uploading Swiftstream/);
  assert.equal(fs.readFileSync(path.join(users.tester.home, '.ssh', 'authorized_keys'), 'utf8'), authorized); // not added twice
  console.log('ok  restart over SSH with no password, no re-upload');

  // A stopped server comes back with the same key login (what the app's auto-restart does).
  stopRemote(users.tester);
  r = await run(['exec', 'box', '--', 'echo', 'down']);
  assert.notEqual(r.code, 0);
  r = await ok(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], { input: '' });
  r = await ok(['exec', 'box', '--', 'echo', 'back-up']);
  assert.match(r.out, /back-up/);
  console.log('ok  stopped server restarted with the key, no password');

  // The standalone executable uploads the copy embedded in itself.
  if (fs.existsSync(exe)) {
    const port2 = await freePort();
    r = await ok(['connect', 'second@127.0.0.1', '--name', 'box2', '--ssh-port', String(sshPort), '--port', String(port2), '--yes'], {
      input: 'hunter2\necho piped-after-password\nexit\n',
      bin: [exe],
    });
    assert.ok(fs.existsSync(path.join(users.second.home, '.swiftstream', 'bin', 'swiftstream.cjs')));
    assert.match(r.out, /piped-after-password/); // commands after the password reached the remote shell
    r = await ok(['exec', 'box2', '--', 'echo', 'hello-from-exe'], { bin: [exe] });
    assert.match(r.out, /hello-from-exe/);
    console.log('ok  standalone exe: password setup and exec');
  } else {
    console.log('skip standalone exe (run "npm run build" to include it)');
  }

  // A different SSH host key on the same address must be refused.
  sshServer.close();
  sshServer = await startSshServer(sshPort, rsaKey());
  r = await run(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], { input: 's3cret\n' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /SSH host key has changed/);
  console.log('ok  changed SSH host key refused');

  console.log('\nbootstrap tests passed');
} finally {
  sshServer.close();
  stopRemote(users.tester);
  stopRemote(users.second);
}

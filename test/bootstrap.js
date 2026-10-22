// End-to-end test of first-time setup over SSH with a password: a tiny SSH server (ssh2) runs
// real shell commands, and swiftstream must log in, upload itself, start, and connect.
// Needs a POSIX `sh` on PATH (Linux, macOS, or Git Bash on Windows); skipped otherwise.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import selfsigned from 'selfsigned';
import { checkServerHealth } from '../src/client.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Servers set up here don't take the real port 443 (the web port test below picks a free one).
process.env.SWIFTSTREAM_WEB_PORT ??= '0';
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
const users = { tester: { password: 's3cret', home: path.join(work, 'home-tester') }, second: { password: 'hunter2', home: path.join(work, 'home-second') }, third: { password: 'pa55', home: path.join(work, 'home-third') } };
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
const run = (args, { input = '', home = clientHome, bin = [process.execPath, cli], env = {} } = {}) =>
  new Promise((resolve) => {
    const child = spawn(bin[0], [...bin.slice(1), ...args], { env: { ...process.env, SWIFTSTREAM_HOME: home, SSH_AUTH_SOCK: '', ...env } });
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
  // Swiftstream runs with NO_COLOR=1 for plain logs; shells must not inherit it (no colors in pm2, git…).
  r = await ok(['exec', 'box', '--', 'sh', '-c', '"echo color=[$NO_COLOR] term=$TERM"']);
  assert.match(r.out, /color=\[\] term=xterm-256color/);
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

  // Web ports (443 and 8443 on real servers; free ports here): setup restarts Swiftstream to add them
  // and saves their addresses. When the main port is blocked, the client connects through one of them.
  const hostsFile = path.join(clientHome, 'hosts.json');
  const webPort = await freePort();
  const taken = await freePort();
  const squatter = net.createServer().listen(taken, '0.0.0.0'); // a web server already on this one
  r = await ok(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], { input: '', env: { SWIFTSTREAM_WEB_PORT: `${taken},${webPort}` } });
  squatter.close();
  assert.match(r.err, new RegExp(`Restarting Swiftstream to add port ${taken} and ${webPort}`));
  assert.match(r.err, new RegExp(`Also on port ${webPort}, for networks that block ${swiftPort}`));
  assert.match(r.err, new RegExp(`Port ${taken} on 127\\.0\\.0\\.1 is used by another program \\(a web server\\?\\), so Swiftstream uses ${webPort} instead`));
  const withWeb = fs.readFileSync(hostsFile, 'utf8');
  assert.deepEqual(JSON.parse(withWeb).box.webUrls, [`https://127.0.0.1:${webPort}`]);
  const blocked = JSON.parse(withWeb);
  blocked.box.url = `https://127.0.0.1:${await freePort()}`; // nothing there: refused, like 7022 at school
  blocked.box.webUrls.unshift(`https://127.0.0.1:${await freePort()}`); // and the first web port too
  fs.writeFileSync(hostsFile, JSON.stringify(blocked));
  r = await ok(['exec', 'box', '--', 'echo', 'through-the-web-port']);
  fs.writeFileSync(hostsFile, withWeb);
  assert.match(r.out, /through-the-web-port/);
  assert.doesNotMatch(r.err, /Checking it over SSH/);
  assert.equal((await checkServerHealth(blocked.box)).up, true);
  console.log('ok  web ports: a taken one skipped and explained, the next used when the main port is blocked');

  // Sharing a web port with a website: the website moves to another port, Swiftstream takes the shared
  // one, keeps the connections that name it (SNI) and passes the rest on, still encrypted.
  const site = selfsigned.generate([{ name: 'commonName', value: 'example.test' }], { keySize: 2048, days: 1, algorithm: 'sha256' });
  const sitePort = await freePort();
  const website = https.createServer({ key: site.private, cert: site.cert }, (req, res) => res.end(`website ${req.url}`)).listen(sitePort, '127.0.0.1');
  const shared = await freePort();
  const shareDeploy = (extra = []) =>
    ok(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes', ...extra], { input: '', env: { SWIFTSTREAM_WEB_PORT: String(shared) } });
  const visitSite = () =>
    new Promise((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port: shared, path: '/hello', servername: 'example.test', rejectUnauthorized: false }, (res) => {
        let body = '';
        const cert = res.socket.getPeerCertificate().subject?.CN;
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ body, cert }));
      });
      req.on('error', reject);
    });
  r = await shareDeploy(['--share-with', `127.0.0.1:${sitePort}`]);
  assert.match(r.err, new RegExp(`Also on port ${shared}`));
  assert.deepEqual(await visitSite(), { body: 'website /hello', cert: 'example.test' });
  const sharedOnly = JSON.parse(fs.readFileSync(hostsFile, 'utf8'));
  sharedOnly.box.url = `https://127.0.0.1:${await freePort()}`; // main port blocked: only the shared one left
  const savedHosts = fs.readFileSync(hostsFile, 'utf8');
  fs.writeFileSync(hostsFile, JSON.stringify(sharedOnly));
  r = await ok(['exec', 'box', '--', 'echo', 'through-the-shared-port']);
  fs.writeFileSync(hostsFile, savedHosts);
  assert.match(r.out, /through-the-shared-port/);
  assert.doesNotMatch(r.err, /Checking it over SSH/); // through the shared port itself, not a repair
  // The setting is kept on the server: a later setup (an update or repair) still shares.
  stopRemote(users.tester);
  await shareDeploy();
  assert.equal((await visitSite()).body, 'website /hello');
  r = await shareDeploy(['--share-with', 'off']);
  assert.notEqual((await visitSite()).cert, 'example.test'); // Swiftstream answers everything itself again
  website.close();
  console.log('ok  sharing a web port: the website keeps its visitors, Swiftstream gets its own, kept across restarts');

  // Reconnecting: HTTPS fails, so the CLI logs in over SSH with this computer's key (no password),
  // finds what's wrong, fixes it, says what it was, and the command goes ahead.
  const remoteDir = path.join(users.tester.home, '.swiftstream');
  const startRemote = () =>
    spawnSync(process.execPath, [path.join(remoteDir, 'bin', 'swiftstream.cjs'), 'serve', '--daemon', '--port', String(swiftPort)], {
      env: { ...process.env, SWIFTSTREAM_HOME: remoteDir, NO_COLOR: '1' },
    });

  // The public health check: answers without a login while Swiftstream runs, silent once it stops.
  const savedBox = JSON.parse(fs.readFileSync(path.join(clientHome, 'hosts.json'), 'utf8')).box;
  const health = await checkServerHealth(savedBox);
  assert.equal(health.up, true);
  assert.equal(health.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  stopRemote(users.tester);
  const afterStop = await checkServerHealth(savedBox);
  assert.equal(afterStop.up, false);
  console.log('ok  health check answers without a login, and not once stopped');

  // Swiftstream's port and SSH both silent (as on Wi-Fi that blocks them): say it's probably the network.
  const beforeUnroutable = fs.readFileSync(hostsFile, 'utf8');
  const unroutable = JSON.parse(beforeUnroutable);
  unroutable.box.ssh = 'tester@10.255.255.1'; // nothing answers there: times out, or "network unreachable"
  fs.writeFileSync(hostsFile, JSON.stringify(unroutable));
  r = await run(['exec', 'box', '--', 'echo', 'never']);
  fs.writeFileSync(hostsFile, beforeUnroutable);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Can't reach box from this network: Swiftstream \(port \d+( or \d+)?\) and SSH \(port \d+\) both don't answer/);
  console.log('ok  Swiftstream and SSH both unreachable: blames the network, not the server');

  r = await ok(['exec', 'box', '--', 'echo', 'after-stop']);
  assert.match(r.out, /after-stop/);
  assert.match(r.err, /Can't reach Swiftstream on box\. Checking it over SSH/);
  assert.match(r.err, /Swiftstream had stopped, so it was started again/);
  console.log('ok  repair: stopped server started again with the key, no password');

  stopRemote(users.tester);
  fs.rmSync(path.join(remoteDir, 'bin', 'swiftstream.cjs'));
  r = await ok(['exec', 'box', '--', 'echo', 'after-delete']);
  assert.match(r.out, /after-delete/);
  assert.match(r.err, /program file was missing, so it was installed again/);
  console.log('ok  repair: deleted program reinstalled');

  const keys = path.join(remoteDir, 'authorized_keys');
  fs.writeFileSync(keys, ''); // this computer no longer allowed (Swiftstream keeps running)
  r = await ok(['exec', 'box', '--', 'echo', 'after-revoke']);
  assert.match(r.out, /after-revoke/);
  assert.match(r.err, /didn't accept this computer's key/);
  assert.match(r.err, /key wasn't accepted, so it was authorized again/);
  console.log('ok  repair: revoked key authorized again over SSH');

  stopRemote(users.tester);
  for (const f of ['server_cert.pem', 'server_key.pem']) fs.rmSync(path.join(remoteDir, f));
  startRemote(); // a new certificate, as after reinstalling Swiftstream
  r = await ok(['exec', 'box', '--', 'echo', 'after-new-cert']);
  assert.match(r.out, /after-new-cert/);
  assert.match(r.err, /has a different certificate than before/);
  assert.match(r.err, /certificate had changed; the new one was checked over SSH and saved/);
  r = await ok(['exec', 'box', '--', 'echo', 'quiet-now']);
  assert.doesNotMatch(r.err, /Checking it over SSH/); // the new certificate was saved
  console.log('ok  repair: new certificate picked up through the SSH login');

  // A server running an older Swiftstream is updated as soon as a command logs in to it, with the key.
  const bundle = fs.readFileSync(path.join(root, 'dist', 'swiftstream.cjs'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const oldBundle = path.join(work, 'old-swiftstream.cjs');
  fs.writeFileSync(oldBundle, bundle.replace(JSON.stringify(version), JSON.stringify('0.0.1')));
  await ok(['deploy', 'box', target, '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], { env: { SWIFTSTREAM_BUNDLE: oldBundle } });
  const remoteBundle = path.join(users.tester.home, '.swiftstream', 'bin', 'swiftstream.cjs');
  assert.match(fs.readFileSync(remoteBundle, 'utf8'), /"0\.0\.1"/);
  r = await ok(['exec', 'box', '--', 'echo', 'after-update']);
  assert.ok(r.err.includes(`box runs Swiftstream 0.0.1; updating it to ${version}`), r.err);
  assert.ok(r.err.includes(`Updated Swiftstream on box from 0.0.1 to ${version}`), r.err);
  assert.match(r.out, /after-update/);
  assert.ok(fs.readFileSync(remoteBundle).equals(fs.readFileSync(path.join(root, 'dist', 'swiftstream.cjs'))), 'server was not updated');
  r = await ok(['connect', 'box'], { input: 'exit\n' });
  assert.doesNotMatch(r.err, /updating it/);
  console.log('ok  older server updated on login, with the key, and says which version');

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

  // An alias from ~/.ssh/config works like it does for ssh: connect sets it up under that name.
  const fakeHome = path.join(work, 'fake-home');
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.ssh', 'config'), `Host lab\n  HostName 127.0.0.1\n  User third\n  Port ${sshPort}\n\nHost other\n  HostName 127.0.0.1\n  User nobody\n`);
  const homeEnv = { HOME: fakeHome, USERPROFILE: fakeHome };
  const port3 = await freePort();
  r = await ok(['connect', 'lab', '--port', String(port3), '--yes'], { input: 'pa55\necho via-alias\nexit\n', env: homeEnv });
  assert.match(r.err, /Using "lab" from ~\/\.ssh\/config: third@127\.0\.0\.1/);
  assert.match(r.out, /via-alias/);
  r = await ok(['hosts']);
  assert.match(r.out, /lab\s+\S+\s+third@127\.0\.0\.1/);
  // import lists only what isn't saved yet: "lab" is, "other" isn't.
  r = await run(['import', 'lab'], { env: homeEnv });
  assert.match(r.err, /already saved: lab/);
  console.log('ok  ~/.ssh/config alias: connect sets it up; import skips saved hosts');

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
  stopRemote(users.third);
}

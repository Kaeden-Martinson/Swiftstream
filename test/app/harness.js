// Drives the real desktop app against a throwaway server, for the tests in this folder:
// an in-process SSH server (like test/bootstrap.js), Swiftstream set up on it with the CLI,
// and the app started in its development screenshot mode with a test script.
// Servers set up by the app tests don't take the real port 443.
process.env.SWIFTSTREAM_WEB_PORT ??= '0';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

export { ssh2 };
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electron = createRequire(path.join(root, 'app', 'package.json'))('electron'); // path to the binary

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

function startSshServer(port, hostKey, users) {
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    let user;
    client.on('authentication', (ctx) => {
      const account = users[ctx.username];
      if (ctx.method === 'password' && account && ctx.password === account.password) {
        user = account;
        return ctx.accept();
      }
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

/**
 * A fresh setup: server "box" (user tester) on a throwaway SSH server, saved in a fresh client home.
 * extraUsers adds SSH accounts ({ name: password }); bundle sets up a different server build.
 */
export async function startEnv(name, { settings = {}, extraUsers = {}, bundle } = {}) {
  const work = path.join(root, '.test-home', 'app', name);
  fs.rmSync(work, { recursive: true, force: true });
  const clientHome = path.join(work, 'client');
  const remoteHome = path.join(work, 'remote');
  const shots = path.join(work, 'shots');
  for (const d of [clientHome, remoteHome, shots]) fs.mkdirSync(d, { recursive: true });
  const users = { tester: { password: 's3cret', home: remoteHome } };
  for (const [user, password] of Object.entries(extraUsers)) {
    users[user] = { password, home: path.join(work, user) };
    fs.mkdirSync(path.join(users[user].home, '.ssh'), { recursive: true });
  }
  const sshPort = await freePort();
  const swiftPort = await freePort();
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const ssh = await startSshServer(sshPort, hostKey, users);

  // Async on purpose: the SSH server lives in this process and must keep answering.
  const cli = (args, input = '', env = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'bin', 'swiftstream.js'), ...args], { env: { ...process.env, SWIFTSTREAM_HOME: clientHome, SSH_AUTH_SOCK: '', ...env } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.end(input);
    });
  const dep = await cli(['deploy', 'box', 'tester@127.0.0.1', '--ssh-port', String(sshPort), '--port', String(swiftPort), '--yes'], 's3cret\n', bundle ? { SWIFTSTREAM_BUNDLE: bundle } : {});
  if (dep.code !== 0) throw new Error(`setting up the test server failed:\n${dep.out}`);
  fs.writeFileSync(path.join(clientHome, 'app-state.json'), JSON.stringify({ settings: { theme: 'dark', healthInterval: 120, ...settings } }));

  /**
   * Start the app with `script`: the body of an async function run in the window, with sleep(ms) and
   * until(fn, ms) available. Resolves to { result, error }. api.devShot(name) saves shots/<name>.png.
   */
  // If the script returns { input: [...] }, those are sent as real mouse and keyboard events
  // (Electron's sendInputEvent; { wait: ms } pauses), then `after` (a script) runs: its result is `after`.
  const runApp = (script, { timeout = 240_000, env = {}, after } = {}) =>
    new Promise((resolve) => {
      if (after) {
        const afterFile = path.join(work, 'after.js');
        fs.writeFileSync(afterFile, after);
        env = { ...env, SWIFTSTREAM_SHOT_AFTER: afterFile };
      }
      const file = path.join(work, 'script.js');
      fs.writeFileSync(
        file,
        `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timed out waiting for ' + fn); };
${script}
})()`,
      );
      const child = spawn(electron, ['.'], {
        cwd: path.join(root, 'app'),
        env: { ...process.env, SWIFTSTREAM_HOME: clientHome, SWIFTSTREAM_SHOT: path.join(shots, 'final.png'), SWIFTSTREAM_SHOT_JS: file, SWIFTSTREAM_SHOT_WAIT: '300', SWIFTSTREAM_SHOT_DIR: shots, ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill(), timeout);
      child.on('close', () => {
        clearTimeout(timer);
        const pick = (prefix) => stdout.split('\n').find((l) => l.startsWith(prefix));
        const line = pick('shot script result:');
        const after = pick('shot after result:');
        resolve({
          result: line ? JSON.parse(line.slice('shot script result:'.length)) : null,
          after: after ? JSON.parse(after.slice('shot after result:'.length)) : null,
          error: pick('shot script error:') || (!line ? stderr.split('\n').filter((l) => !/disk_cache|gpu_disk|GPU process/.test(l)).slice(-12).join('\n') || 'no result' : null),
        });
      });
    });

  const stopServer = (home) => spawnSync(process.execPath, [path.join(root, 'dist', 'swiftstream.cjs'), 'stop'], { env: { ...process.env, SWIFTSTREAM_HOME: path.join(home, '.swiftstream') } });
  const stop = () => {
    for (const u of Object.values(users)) stopServer(u.home);
    ssh.close();
  };
  return { work, clientHome, remoteHome, shots, cli, runApp, stop, users, sshPort };
}

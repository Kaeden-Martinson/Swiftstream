#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, ensureDir, getHost, loadHosts, paths, saveHost, writeJson, readJson } from '../src/config.js';
import { authorizeKey, keyFingerprint, loadOrCreateIdentity } from '../src/keys.js';
import { fetchServerCert, loadOrCreateServerCert } from '../src/tls.js';
import { connectClient } from '../src/client.js';
import { push, pull } from '../src/transfer.js';
import { openShell } from '../src/shell.js';
import { deployOverSsh, readyLine } from '../src/deploy.js';
import { formatBytes, parseSize } from '../src/util.js';

const HELP = `swiftssh - fast remote shell & file transfer over HTTPS

Your machine (client):
  swiftssh keygen                          create/show your identity key
  swiftssh deploy <name> <user@host>       start swiftssh on a host via ssh, authorize you, save it
        [--port ${DEFAULT_PORT}] [--ssh-port 22] [--remote-cmd "npx -y swiftssh"]
  swiftssh add <name> <https://host:port>  save a host you started yourself (verifies fingerprint)
  swiftssh hosts                           list saved hosts
  swiftssh connect <name>                  interactive shell
  swiftssh exec <name> -- <command...>     run one command
  swiftssh push <name> <local> [remote]    upload a file   [--parallel 8] [--chunk 4MB]
  swiftssh pull <name> <remote> [local]    download a file [--parallel 8] [--chunk 4MB]

The host (server):
  swiftssh serve [--port ${DEFAULT_PORT}] [--host 0.0.0.0] [--root ~] [--daemon]
  swiftssh authorize "<public key>"        allow a client key to log in
  swiftssh stop                            stop a daemonized server
`;

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  root: { type: 'string' },
  parallel: { type: 'string' },
  chunk: { type: 'string' },
  'ssh-port': { type: 'string' },
  'remote-cmd': { type: 'string' },
  authorize: { type: 'string' },
  daemon: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
};

async function main() {
  const { values: opts, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  const [command, ...args] = positionals;
  if (!command || opts.help) return void process.stdout.write(HELP);
  const handler = COMMANDS[command];
  if (!handler) throw new Error(`Unknown command "${command}". Run "swiftssh --help".`);
  return handler(args, opts);
}

function need(args, count, usage) {
  if (args.length < count) throw new Error(`Usage: swiftssh ${usage}`);
}

function transferOpts(opts) {
  return {
    parallel: Math.max(1, Number(opts.parallel) || 8),
    chunkSize: opts.chunk ? parseSize(opts.chunk) : 4 * 1024 * 1024,
  };
}

async function client(name, opts = {}) {
  return connectClient(getHost(name), loadOrCreateIdentity(), { parallel: transferOpts(opts).parallel });
}

const COMMANDS = {
  async keygen() {
    const id = loadOrCreateIdentity();
    console.log(id.publicKeyString);
    console.error(`fingerprint ${keyFingerprint(id.publicKeyString)}  (key at ${paths.clientKey})`);
  },

  async authorize(args) {
    need(args, 1, 'authorize "<public key>"');
    const key = args.join(' ');
    const added = authorizeKey(key);
    console.log(`${added ? 'authorized' : 'already authorized'} ${keyFingerprint(key)}`);
  },

  async serve(_args, opts) {
    const port = Number(opts.port) || DEFAULT_PORT;
    if (opts.authorize) authorizeKey(opts.authorize);
    if (opts.daemon) return daemonize(port, opts);

    const { startServer } = await import('../src/server.js');
    const srv = await startServer({ port, host: opts.host, root: opts.root });
    writeJson(paths.pid, { pid: process.pid, port: srv.port });
    console.log(`swiftssh listening on https://${opts.host || '0.0.0.0'}:${srv.port}`);
    console.log(`certificate fingerprint ${srv.fingerprint}`);
    console.log(readyLine(srv));
    const shutdown = () => {
      fs.rmSync(paths.pid, { force: true });
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },

  async stop() {
    const info = readJson(paths.pid, null);
    if (!info) return console.log('no server running');
    try {
      process.kill(info.pid);
      console.log(`stopped server (pid ${info.pid})`);
    } catch {
      console.log('server was not running');
    }
    fs.rmSync(paths.pid, { force: true });
  },

  async add(args, opts) {
    need(args, 2, 'add <name> <https://host:port>');
    const [name, rawUrl] = args;
    const url = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
    if (!url.port) url.port = String(DEFAULT_PORT);
    const { cert, fingerprint } = await fetchServerCert(url.toString());
    console.log(`Host ${url.host} presented certificate fingerprint:\n  ${fingerprint}`);
    console.log('Compare it with the fingerprint printed by "swiftssh serve" on that host.');
    if (!opts.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Trust this host? (yes/no) ');
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') throw new Error('Host not added.');
    }
    saveHost(name, { url: url.origin, fingerprint, cert });
    const id = loadOrCreateIdentity();
    console.log(`Saved "${name}". If you haven't yet, run this on the host:\n  swiftssh authorize "${id.publicKeyString}"`);
  },

  async deploy(args, opts) {
    need(args, 2, 'deploy <name> <user@host>');
    const [name, target] = args;
    const id = loadOrCreateIdentity();
    const ready = await deployOverSsh({
      target,
      sshPort: opts['ssh-port'],
      port: Number(opts.port) || DEFAULT_PORT,
      remoteCmd: opts['remote-cmd'],
      publicKey: id.publicKeyString,
    });
    const hostname = target.includes('@') ? target.split('@')[1] : target;
    saveHost(name, { url: `https://${hostname}:${ready.port}`, fingerprint: ready.fingerprint, cert: ready.cert, ssh: target });
    const c = await client(name);
    const info = await c.request('GET', '/v1/info');
    c.close();
    console.log(`"${name}" ready: swiftssh ${info.version} on ${info.hostname} (${info.platform}), pinned ${ready.fingerprint}`);
  },

  async hosts() {
    const hosts = loadHosts();
    if (!Object.keys(hosts).length) return console.log('no hosts yet');
    for (const [name, h] of Object.entries(hosts)) console.log(`${name.padEnd(16)} ${h.url}${h.ssh ? `  (via ssh ${h.ssh})` : ''}`);
  },

  async connect(args) {
    need(args, 1, 'connect <name>');
    const c = await client(args[0]);
    const code = await openShell(c);
    c.close();
    process.exitCode = code;
  },

  async exec(args) {
    need(args, 2, 'exec <name> -- <command...>');
    const [name, ...cmd] = args;
    const c = await client(name);
    const code = await openShell(c, { cmd: cmd.join(' ') });
    c.close();
    process.exitCode = code;
  },

  async push(args, opts) {
    need(args, 2, 'push <name> <local> [remote]');
    const [name, local, remote = '~/'] = args;
    const c = await client(name, opts);
    try {
      const r = await push(c, local, remote, transferOpts(opts));
      console.log(`${r.path}  ${formatBytes(r.size)}  sha256 ${r.sha256.slice(0, 16)}…`);
    } finally {
      c.close();
    }
  },

  async pull(args, opts) {
    need(args, 2, 'pull <name> <remote> [local]');
    const [name, remote, local = '.'] = args;
    const c = await client(name, opts);
    try {
      const r = await pull(c, remote, local, transferOpts(opts));
      console.log(`${r.path}  ${formatBytes(r.size)}  sha256 ${r.sha256.slice(0, 16)}…`);
    } finally {
      c.close();
    }
  },
};

/** Start the server in the background (surviving the ssh session that launched it) and print its ready line. */
async function daemonize(port, opts) {
  const { cert, fingerprint } = loadOrCreateServerCert();
  if (!(await portOpen(port))) {
    ensureDir();
    const logFd = fs.openSync(paths.log, 'a');
    const childArgs = [fileURLToPath(import.meta.url), 'serve', '--port', String(port)];
    if (opts.host) childArgs.push('--host', opts.host);
    if (opts.root) childArgs.push('--root', opts.root);
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (!(await portOpen(port))) {
      if (Date.now() > deadline) throw new Error(`server did not start; see ${paths.log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  console.log(readyLine({ port, fingerprint, cert }));
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

main().catch((err) => {
  console.error(`swiftssh: ${err.message}`);
  process.exitCode = 1;
});

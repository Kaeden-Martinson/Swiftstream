#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, ensureDir, loadHosts, paths, readJson, writeJson } from '../src/config.js';
import { authorizeKey, keyFingerprint, loadOrCreateIdentity } from '../src/keys.js';
import { loadOrCreateServerCert } from '../src/tls.js';
import { connectClient } from '../src/client.js';
import { pull, pullDir, push, pushDir, remoteBasename } from '../src/transfer.js';
import { bench, formatBench } from '../src/bench.js';
import { openShell } from '../src/shell.js';
import { readyLine } from '../src/deploy.js';
import { UserError, explainError } from '../src/errors.js';
import { closest, deployHost, getHostOrExplain, probeHost, removeHost, saveProbedHost, validateHostName } from '../src/hosts.js';
import { ask, askSecret, c, confirm, info, ok, printError, table, warn } from '../src/ui.js';
import { formatBytes, parseSize } from '../src/util.js';

import { VERSION } from '../src/version.js';
import { selfCommand } from '../src/self.js';
import { openDesktopApp } from '../src/desktop.js';

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  root: { type: 'string' },
  parallel: { type: 'string' },
  chunk: { type: 'string' },
  'ssh-port': { type: 'string' },
  name: { type: 'string' },
  authorize: { type: 'string' },
  size: { type: 'string' },
  files: { type: 'string' },
  daemon: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

// Context for turning errors into advice (which host we were talking to, our key).
const errorContext = {};

function transferOpts(opts) {
  return {
    parallel: Math.max(1, Number(opts.parallel) || 8),
    chunkSize: opts.chunk ? parseSize(opts.chunk) : 4 * 1024 * 1024,
  };
}

async function client(name, opts = {}) {
  const host = getHostOrExplain(name);
  const identity = loadOrCreateIdentity();
  Object.assign(errorContext, { name, host, publicKey: identity.publicKeyString });
  return connectClient(host, identity, { parallel: transferOpts(opts).parallel });
}

/** Ctrl+C during a transfer: finish the progress line and say how to pick up where it stopped. */
function resumableOnCancel() {
  process.once('SIGINT', () => {
    if (process.stderr.isTTY) process.stderr.write('\n');
    warn('Cancelled. Run the same command again to resume.');
    process.exit(130);
  });
}

async function withClient(name, opts, fn) {
  const conn = await client(name, opts);
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

const COMMANDS = {
  app: {
    group: 'Get started',
    usage: 'app',
    summary: 'Open the Swiftstream desktop app',
    async run() {
      openDesktopApp();
      ok('Opening the Swiftstream app');
    },
  },

  setup: {
    group: 'Get started',
    usage: 'setup',
    summary: 'Guided setup: connect this computer to a server',
    async run() {
      console.log(`\n${c.bold('Welcome to swiftstream')} ${c.dim(`v${VERSION}`)}\n`);
      const identity = loadOrCreateIdentity();
      ok(`Your key is ready ${c.dim(keyFingerprint(identity.publicKeyString))}`);
      console.log(`
How do you want to connect?
  ${c.bold('1')}  I have an SSH login (username and password, or a key) ${c.dim('(recommended: swiftstream installs itself there)')}
  ${c.bold('2')}  swiftstream is already running on the server
`);
      const choice = await ask('Choose 1 or 2', '1');
      if (choice === '2') {
        const address = await ask('Server address, e.g. 192.168.1.20 or box.example.com:7022');
        if (!address) throw new UserError('No address given.');
        const name = await ask('Name for this server', defaultName(address));
        validateHostName(name);
        await addByAddress(name, address, false);
      } else {
        const target = await ask('SSH login, e.g. ubuntu@203.0.113.7');
        if (!target) throw new UserError('No SSH login given.');
        const sshPort = await ask('SSH port', '22');
        const name = await ask('Name for this server', defaultName(target));
        await deployCommand(name, target, { 'ssh-port': sshPort === '22' ? undefined : sshPort });
      }
    },
  },

  deploy: {
    group: 'Get started',
    usage: 'deploy <name> <user@host> [--ssh-port 22] [--port 7022]',
    summary: 'Set up swiftstream on a server you can log in to, and save it',
    details: `Logs in over SSH once (your SSH key if you have one, otherwise your password),
installs Node.js for your account if the server has none, uploads swiftstream, starts it in the
background, authorizes this computer's key, and pins the server's identity.
"swiftstream connect user@host" does the same thing automatically the first time.`,
    async run([name, target], opts) {
      need(name && target, this.usage);
      await deployCommand(name, target, opts);
    },
  },

  add: {
    group: 'Get started',
    usage: 'add <name> <address>',
    summary: 'Save a server where swiftstream is already running',
    async run([name, address], opts) {
      need(name && address, this.usage);
      validateHostName(name);
      await addByAddress(name, address, opts.yes);
    },
  },

  hosts: {
    group: 'Hosts',
    usage: 'hosts',
    summary: 'List your saved servers',
    async run() {
      const hosts = Object.entries(loadHosts());
      if (!hosts.length) return info(`No servers yet. Run ${c.bold('swiftstream setup')} to add one.`);
      console.log(table([['NAME', 'ADDRESS', 'SSH LOGIN'], ...hosts.map(([n, h]) => [n, new URL(h.url).host, h.ssh || '-'])]));
    },
  },

  remove: {
    group: 'Hosts',
    usage: 'remove <name>',
    summary: 'Forget a saved server',
    async run([name], opts) {
      need(name, this.usage);
      getHostOrExplain(name);
      if (!opts.yes && !(await confirm(`Forget "${name}"? This doesn't change anything on the server.`))) return;
      removeHost(name);
      ok(`Removed "${name}"`);
    },
  },

  connect: {
    group: 'Use a server',
    usage: 'connect <name | user@host> [--ssh-port 22] [--port 7022] [--name prod]',
    summary: 'Open a shell on a server (sets it up the first time)',
    details: `Give a saved server's name, or an SSH login like ubuntu@203.0.113.7. The first time you
use a login, swiftstream signs in over SSH (asking for the password if your SSH key isn't accepted),
installs itself on the server, and saves it under --name (default: the host's short name).`,
    async run([target], opts) {
      need(target, this.usage);
      const name = await resolveOrSetUp(target, opts);
      await withServerRunning(name, opts, async () => {
        await withClient(name, {}, async (conn) => {
          process.exitCode = await openShell(conn);
        });
      });
    },
  },

  exec: {
    group: 'Use a server',
    usage: 'exec <name> -- <command...>',
    summary: 'Run one command on a server',
    async run([name, ...cmd]) {
      need(name && cmd.length, this.usage);
      await withClient(name, {}, async (conn) => {
        process.exitCode = await openShell(conn, { cmd: cmd.join(' ') });
      });
    },
  },

  push: {
    group: 'Use a server',
    usage: 'push <name> <local file or folder> [remote path]',
    summary: 'Upload files or folders (only changed files are sent)',
    details: `A remote path ending in "/" means "put it inside this folder". Default: your home folder.
Large files are split into chunks sent in parallel and resume if interrupted.
Options: --parallel 8 (connections)  --chunk 4MB (chunk size)`,
    async run([name, local, remote = '~/'], opts) {
      need(name && local, this.usage);
      resumableOnCancel();
      getHostOrExplain(name);
      const st = fs.statSync(local, { throwIfNoEntry: false });
      if (!st) throw new UserError(`There's no file or folder called "${local}" here.`);
      await withClient(name, opts, async (conn) => {
        if (st.isDirectory()) {
          const target = /[\\/]$/.test(remote) ? remote + path.basename(path.resolve(local)) : remote;
          printSync('Uploaded', await pushDir(conn, local, target, transferOpts(opts)));
        } else {
          const r = await push(conn, local, remote, transferOpts(opts));
          ok(`Uploaded ${c.bold(path.basename(local))} to ${name}:${r.path} ${c.dim(`(${formatBytes(r.size)}, verified)`)}`);
        }
      });
    },
  },

  pull: {
    group: 'Use a server',
    usage: 'pull <name> <remote file or folder> [local path]',
    summary: 'Download files or folders (only changed files are sent)',
    details: `A local path ending in "/" (or ".") means "put it inside this folder". Default: current folder.
Options: --parallel 8 (connections)  --chunk 4MB (chunk size)`,
    async run([name, remote, local = '.'], opts) {
      need(name && remote, this.usage);
      resumableOnCancel();
      await withClient(name, opts, async (conn) => {
        const st = await conn.request('GET', '/v1/stat', { query: { path: remote } });
        if (st.isDirectory) {
          const target = /[\\/]$/.test(local) || local === '.' ? path.join(local, remoteBasename(st.path)) : local;
          printSync('Downloaded', await pullDir(conn, st.path, target, transferOpts(opts)));
        } else {
          const r = await pull(conn, remote, local, transferOpts(opts));
          ok(`Downloaded ${c.bold(remoteBasename(st.path))} to ${r.path} ${c.dim(`(${formatBytes(r.size)}, verified)`)}`);
        }
      });
    },
  },

  bench: {
    group: 'Use a server',
    usage: 'bench <name> [--size 200MB] [--files 2000]',
    summary: 'Compare upload speed against scp/sftp',
    async run([name], opts) {
      need(name, this.usage);
      const host = getHostOrExplain(name);
      await withClient(name, opts, async (conn) => {
        const rows = await bench(conn, host, {
          size: opts.size ? parseSize(opts.size) : 200 * 1024 * 1024,
          files: Number(opts.files) || 2000,
          ...transferOpts(opts),
        });
        console.log(formatBench(rows));
      });
    },
  },

  key: {
    group: 'Your key',
    usage: 'key',
    summary: "Show this computer's public key (to authorize it on a server)",
    async run() {
      const id = loadOrCreateIdentity();
      console.log(id.publicKeyString);
      console.error(c.dim(`fingerprint ${keyFingerprint(id.publicKeyString)}, stored in ${paths.clientKey}`));
    },
  },

  serve: {
    group: 'On the server',
    usage: 'serve [--port 7022] [--host 0.0.0.0] [--root ~] [--daemon]',
    summary: 'Run the swiftstream server on this machine',
    async run(_args, opts) {
      const port = Number(opts.port) || DEFAULT_PORT;
      if (opts.authorize) authorizeKey(opts.authorize);
      if (opts.daemon) return daemonize(port, opts);

      const { startServer } = await import('../src/server.js');
      const srv = await startServer({ port, host: opts.host, root: opts.root });
      writeJson(paths.pid, { pid: process.pid, port: srv.port });
      const addresses = lanAddresses();
      ok(`swiftstream server running on port ${c.bold(srv.port)}`);
      console.log(`  Fingerprint: ${srv.fingerprint}`);
      console.log(`\n  To connect from another computer, run there:`);
      console.log(`    swiftstream add <name> ${addresses[0] || '<this-machine>'}:${srv.port}`);
      console.log(`  then authorize that computer's key here:`);
      console.log(`    swiftstream authorize "<key from 'swiftstream key'>"`);
      console.log(c.dim(`\n  Press Ctrl+C to stop.`));
      // runit and Ctrl+C both send a signal: finish open requests, close shells, then exit.
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return process.exit(1); // second signal: stop now
        stopping = true;
        console.log(`${new Date().toISOString()} shutting down`);
        fs.rmSync(paths.pid, { force: true });
        await srv.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },
  },

  authorize: {
    group: 'On the server',
    usage: 'authorize "<public key>"',
    summary: 'Allow a computer to log in to this server',
    async run(args) {
      need(args.length, this.usage);
      const key = args.join(' ');
      try {
        const added = authorizeKey(key);
        ok(`${added ? 'Authorized' : 'Already authorized'}: ${keyFingerprint(key)}`);
      } catch {
        throw new UserError("That isn't a swiftstream public key.", 'On your computer run "swiftstream key" and paste the whole line, in quotes.');
      }
    },
  },

  stop: {
    group: 'On the server',
    usage: 'stop',
    summary: 'Stop a background swiftstream server',
    async run() {
      const pidInfo = readJson(paths.pid, null);
      if (!pidInfo) return info('No swiftstream server is running.');
      try {
        process.kill(pidInfo.pid);
        ok(`Stopped the server (pid ${pidInfo.pid})`);
      } catch {
        info('The server had already stopped.');
      }
      fs.rmSync(paths.pid, { force: true });
    },
  },
};
// Old names keep working.
const ALIASES = { keygen: 'key', ls: 'hosts', rm: 'remove', ssh: 'connect', upload: 'push', download: 'pull' };

/**
 * "connect user@host": reuse a saved server set up with that login, or set it up now.
 * A plain name must already be saved.
 */
async function resolveOrSetUp(target, opts) {
  const hosts = loadHosts();
  if (hosts[target]) return target;
  const looksLikeLogin = target.includes('@') || /[.:]/.test(target);
  if (!looksLikeLogin) getHostOrExplain(target); // throws, with a "did you mean"
  const saved = Object.entries(hosts).find(([, h]) => h.ssh === target);
  if (saved) return saved[0];
  let name = opts.name || defaultName(target);
  for (let i = 2; !opts.name && hosts[name]; i++) name = `${defaultName(target)}-${i}`;
  await deployCommand(name, target, opts, { quiet: true });
  return name;
}

/** If a saved server isn't answering but we know its SSH login, offer to start swiftstream again. */
async function withServerRunning(name, opts, fn) {
  try {
    return await fn();
  } catch (err) {
    const host = loadHosts()[name];
    if (err.code !== 'ECONNREFUSED' || !host?.ssh || !process.stdin.isTTY) throw err;
    warn(`Swiftstream isn't running on ${name}.`);
    if (!(await confirm(`Start it again by logging in to ${host.ssh}?`, true))) throw err;
    await deployCommand(name, host.ssh, { ...opts, 'ssh-port': opts['ssh-port'] || host.sshPort }, { quiet: true });
    return fn();
  }
}

async function deployCommand(name, target, opts, { quiet = false } = {}) {
  validateHostName(name);
  const { host, info: remote } = await deployHost({
    name,
    target,
    sshPort: opts['ssh-port'],
    port: Number(opts.port) || DEFAULT_PORT,
    askPassword: (attempt) =>
      // Piped input (scripts) gets one try; a person at the keyboard gets three.
      attempt && !process.stdin.isTTY
        ? Promise.reject(new UserError('Wrong password.'))
        : askSecret(attempt ? 'Wrong password, try again:' : `Password for ${target}:`),
    confirmHostKey: async ({ host: sshHost, fingerprint }) => {
      console.error(`
  First connection to ${c.bold(sshHost)}. Its SSH key fingerprint is:
  ${fingerprint}
`);
      return opts.yes || confirm('Continue connecting?', true);
    },
    onStep: (text) => info(`${text}…`),
  });
  ok(`${c.bold(name)} is ready: ${remote.hostname} (${remote.platform}) at ${new URL(host.url).host}`);
  if (!quiet) nextSteps(name);
}

async function addByAddress(name, address, yes) {
  const probe = await probeHost(address);
  console.log(`\n  The server's fingerprint is:\n  ${c.bold(probe.fingerprint)}\n`);
  console.log(c.dim('  It should match the fingerprint "swiftstream serve" printed on the server.'));
  if (!yes && !(await confirm('Does it match?'))) throw new UserError('Server not added.', 'If the fingerprints differ, someone may be intercepting the connection.');
  saveProbedHost(name, probe);
  const id = loadOrCreateIdentity();
  ok(`Saved ${c.bold(name)}`);
  console.log(`\n  One more step: allow this computer on the server by running there:\n    swiftstream authorize "${id.publicKeyString}"`);
  nextSteps(name);
}

function nextSteps(name) {
  console.log(`
  Try it:
    swiftstream connect ${name}                ${c.dim('open a shell')}
    swiftstream push ${name} ./my-folder ~/    ${c.dim('upload')}
    swiftstream pull ${name} ~/logs ./         ${c.dim('download')}
`);
}

function defaultName(address) {
  const host = address.split('@').pop().split(':')[0];
  const base = /^[\d.]+$/.test(host) ? 'server' : host.split('.')[0];
  return base.replace(/[^\w.-]/g, '') || 'server';
}

function need(condition, usage) {
  if (!condition) throw new UserError('Missing arguments.', `Usage: swiftstream ${usage}`);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function printSync(verb, r) {
  const unchanged = r.files - r.sent;
  ok(`${verb} ${r.root}: ${r.sent} sent (${formatBytes(r.bytes)}), ${unchanged} unchanged`);
}

function help(commandName) {
  const cmd = COMMANDS[commandName];
  if (cmd) {
    console.log(`\n${c.bold(`swiftstream ${cmd.usage}`)}\n\n${cmd.summary}.${cmd.details ? `\n\n${cmd.details}` : ''}\n`);
    return;
  }
  const lines = [`\n${c.bold('swiftstream')} ${c.dim(`v${VERSION}`)}  Fast remote shell and file transfer over HTTPS\n`];
  const groups = {};
  for (const [name, cmdInfo] of Object.entries(COMMANDS)) (groups[cmdInfo.group] ||= []).push([name, cmdInfo]);
  for (const [group, cmds] of Object.entries(groups)) {
    lines.push(c.bold(group));
    for (const [name, cmdInfo] of cmds) lines.push(`  ${name.padEnd(11)} ${cmdInfo.summary}`);
    lines.push('');
  }
  lines.push(c.dim('Run "swiftstream <command> --help" for details on a command.\n'));
  console.log(lines.join('\n'));
}

/** Start the server in the background (surviving the ssh session that launched it) and print its ready line. */
async function daemonize(port, opts) {
  const { cert, fingerprint } = loadOrCreateServerCert();
  if (!(await portOpen(port))) {
    ensureDir();
    const logFd = fs.openSync(paths.log, 'a');
    const [exe, ...selfArgs] = selfCommand();
    const childArgs = [...selfArgs, 'serve', '--port', String(port)];
    if (opts.host) childArgs.push('--host', opts.host);
    if (opts.root) childArgs.push('--root', opts.root);
    const child = spawn(exe, childArgs, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (!(await portOpen(port))) {
      if (Date.now() > deadline) throw new UserError('The server did not start.', `See the log: ${paths.log}`);
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

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    const flag = /'(--?[\w-]+)'/.exec(err.message)?.[1];
    throw new UserError(flag ? `Unknown option ${flag}.` : err.message, 'Run "swiftstream --help" to see the options.');
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) return console.log(VERSION);
  let [command, ...args] = positionals;
  if (command === 'help') return help(args[0]);
  if (!command) {
    if (!Object.keys(loadHosts()).length) {
      console.log(`\n${c.bold('Welcome to swiftstream!')} Run ${c.cyan('swiftstream setup')} to connect your first server.`);
    }
    return help();
  }
  command = ALIASES[command] || command;
  const cmd = COMMANDS[command];
  if (!cmd) {
    const guess = closest(command, [...Object.keys(COMMANDS), ...Object.keys(ALIASES)]);
    throw new UserError(`"${command}" isn't a swiftstream command.`, guess ? `Did you mean "swiftstream ${ALIASES[guess] || guess}"?` : 'Run "swiftstream --help" to see all commands.');
  }
  if (opts.help) return help(command);
  return cmd.run.call(cmd, args, opts);
}

main().catch((err) => {
  printError(explainError(err, errorContext));
  if (process.env.SWIFTSTREAM_DEBUG) console.error(err);
  process.exitCode = 1;
});

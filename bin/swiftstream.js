#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, ensureDir, loadHosts, parsePortList, paths, readJson, writeJson } from '../src/config.js';
import { parseShareTarget } from '../src/sni.js';
import { authorizeKey, keyFingerprint, loadOrCreateIdentity } from '../src/keys.js';
import { loadOrCreateServerCert } from '../src/tls.js';
import { checkServerHealth, connectClient } from '../src/client.js';
import { pull, pullDir, push, pushDir, remoteBasename } from '../src/transfer.js';
import { bench, formatBench } from '../src/bench.js';
import { openShell } from '../src/shell.js';
import { readyLine } from '../src/deploy.js';
import { UserError, explainError } from '../src/errors.js';
import { closest, deployHost, getHostOrExplain, probeHost, removeHost, saveProbedHost, validateHostName } from '../src/hosts.js';
import { ask, askSecret, c, confirm, info, ok, printError, table, warn } from '../src/ui.js';
import { formatBytes, parseSize } from '../src/util.js';

import { VERSION, isOlderVersion } from '../src/version.js';
import { selfCommand } from '../src/self.js';
import { openDesktopApp } from '../src/desktop.js';
import { readSshConfig, sshConfigHost, sshTarget } from '../src/sshconfig.js';
import { describeReason, repairReason, silentReason, unreachableFromHere } from '../src/repair.js';

const OPTIONS = {
  port: { type: 'string' },
  'web-port': { type: 'string' },
  'share-with': { type: 'string' },
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
  const conn = await connectOrRepair(name, opts);
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
    usage: 'deploy <name> <user@host> [--ssh-port 22] [--port 7022] [--web-port 443,8443] [--share-with 127.0.0.1:8444]',
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

  import: {
    group: 'Hosts',
    usage: 'import [alias...] [--yes]',
    summary: 'Set up servers from your ~/.ssh/config',
    details: `Lists the hosts in ~/.ssh/config that aren't saved yet and sets up the ones you pick, using
their HostName, User, Port and IdentityFile. Name aliases to set up just those; --yes sets up all of them.`,
    async run(aliases, opts) {
      const hosts = loadHosts();
      const known = new Set(Object.values(hosts).map((h) => h.ssh));
      const fresh = readSshConfig().filter((e) => !hosts[e.alias] && !known.has(sshTarget(e)));
      if (!fresh.length) return info('Every host in ~/.ssh/config is already saved (or there is no ~/.ssh/config).');
      let chosen = fresh;
      if (aliases.length) {
        chosen = fresh.filter((e) => aliases.some((a) => a.toLowerCase() === e.alias.toLowerCase()));
        const missing = aliases.filter((a) => !fresh.some((e) => e.alias.toLowerCase() === a.toLowerCase()));
        if (missing.length) warn(`Not in ~/.ssh/config, or already saved: ${missing.join(', ')}`);
      } else if (!opts.yes) {
        console.log(table([['ALIAS', 'SSH LOGIN', 'PORT'], ...fresh.map((e) => [e.alias, sshTarget(e), String(e.port)])]));
        const answer = (await ask(`Set up which? Type aliases separated by spaces, or "all"`, 'all')).trim();
        if (!answer) return;
        if (answer.toLowerCase() !== 'all') {
          const picks = answer.split(/[\s,]+/).map((a) => a.toLowerCase());
          chosen = fresh.filter((e) => picks.includes(e.alias.toLowerCase()));
        }
      }
      let done = 0;
      for (const entry of chosen) {
        console.error('');
        info(`Setting up ${c.bold(entry.alias)} (${sshTarget(entry)})`);
        try {
          await deployCommand(entry.alias, sshTarget(entry), { ...opts, 'ssh-port': entry.port }, { quiet: true, identityFile: entry.identityFile });
          done++;
        } catch (err) {
          printError(err);
        }
      }
      if (chosen.length) console.error(`\n${done} of ${chosen.length} set up.`);
      if (done < chosen.length) process.exitCode = 1;
    },
  },

  computers: {
    group: 'Hosts',
    usage: 'computers <name>',
    summary: 'List the computers allowed to log in to a server',
    async run([name]) {
      need(name, this.usage);
      const keys = await listComputers(name);
      console.log(table([['COMPUTER', 'FINGERPRINT', ''], ...keys.map((k) => [k.label || '(no name)', k.fingerprint, k.current ? 'this computer' : ''])]));
    },
  },

  revoke: {
    group: 'Hosts',
    usage: 'revoke <name> <computer> [--yes]',
    summary: 'Stop a computer from logging in to a server',
    details: `<computer> is its name as "swiftstream computers <name>" lists it, or the start of its fingerprint.
Its open shells and transfers on that server end right away.`,
    async run([name, which], opts) {
      need(name && which, this.usage);
      const keys = await listComputers(name);
      const matches = keys.filter((k) => k.label === which || k.fingerprint === which || k.fingerprint.replace(/^SHA256:/, '').startsWith(which.replace(/^SHA256:/, '')));
      if (!matches.length) throw new UserError(`No computer called "${which}" can log in to ${name}.`, `See them with: swiftstream computers ${name}`);
      if (matches.length > 1) throw new UserError(`"${which}" matches ${matches.length} computers.`, 'Use more of the fingerprint.');
      const [target] = matches;
      const who = target.label || target.fingerprint;
      if (target.current) warn(`${who} is this computer: after this, it can only reconnect by setting ${name} up again over SSH.`);
      if (!opts.yes && !(await confirm(`Stop ${who} from logging in to ${name}?`))) return;
      await withClient(name, {}, (conn) => conn.request('POST', '/v1/keys/revoke', { body: { fingerprint: target.fingerprint } }));
      ok(`${who} can no longer log in to ${name}`);
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
      await withClient(name, opts, async (conn) => {
        process.exitCode = await openShell(conn);
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
    usage: 'serve [--port 7022] [--web-port 443,8443] [--share-with 127.0.0.1:8444|off] [--host 0.0.0.0] [--root ~] [--daemon]',
    summary: 'Run the swiftstream server on this machine',
    async run(_args, opts) {
      const port = Number(opts.port) || DEFAULT_PORT;
      if (opts.authorize) authorizeKey(opts.authorize);
      if (opts.daemon) return daemonize(port, opts);

      const { startServer } = await import('../src/server.js');
      const shareWith = shareSetting(opts);
      const srv = await startServer({ port, host: opts.host, root: opts.root, webPorts: parsePortList(opts['web-port']), shareWith });
      const sharing = shareWith ? `${shareWith.host}:${shareWith.port}` : null;
      writeJson(paths.pid, { pid: process.pid, port: srv.port, webPorts: srv.webPorts, webPortErrors: srv.webPortErrors, sharing });
      const addresses = lanAddresses();
      ok(`swiftstream server running on port ${c.bold(srv.port)}${srv.webPorts.length ? ` and ${srv.webPorts.map((p) => c.bold(p)).join(', ')}` : ''}`);
      for (const [p, why] of Object.entries(srv.webPortErrors)) warn(`Port ${p} isn't available (${why}).`);
      if (sharing && srv.webPorts.length) info(`Sharing ${srv.webPorts.join(', ')}: connections for other programs go to ${sharing}.`);
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
      startSelfUpdates(srv, port, opts);
    },
  },

  'auto-update': {
    group: 'Use a server',
    usage: 'auto-update <name> [on | off]',
    summary: 'Let a server update itself when Swiftstream is released',
    details: `With "on", the server checks GitHub Releases every 6 hours. A newer Swiftstream is downloaded,
checked against the release's checksums, and installed once nobody is using the server (no terminal
open, no transfer for 5 minutes). Without on or off, says whether it's on. Off by default.`,
    async run([name, value], opts) {
      need(name, this.usage);
      if (value !== undefined && !['on', 'off'].includes(value)) throw new UserError(`Use "on" or "off", not "${value}".`);
      await withClient(name, opts, async (conn) => {
        let settings;
        try {
          settings = value === undefined ? await conn.request('GET', '/v1/settings') : await conn.request('POST', '/v1/settings', { body: { autoUpdate: value === 'on' } });
        } catch (err) {
          if (err.status === 404) throw new UserError(`${name} runs a Swiftstream from before automatic updates.`, `Update it first: connect to it once from a network where SSH works.`);
          throw err;
        }
        ok(`Automatic updates are ${settings.autoUpdate ? 'on' : 'off'} for ${c.bold(name)}`);
      });
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
      if (await stopRunning(pidInfo)) ok(`Stopped the server (pid ${pidInfo.pid})`);
      else info('The server had already stopped.');
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
  // An alias from ~/.ssh/config means the same machine it does for ssh.
  const entry = !target.includes('@') && sshConfigHost(target);
  if (entry) {
    const login = sshTarget(entry);
    const saved = Object.entries(hosts).find(([, h]) => h.ssh === login);
    if (saved) return saved[0];
    info(`Using "${entry.alias}" from ~/.ssh/config: ${login}${entry.port !== 22 ? ` port ${entry.port}` : ''}`);
    await deployCommand(opts.name || entry.alias, login, { ...opts, 'ssh-port': opts['ssh-port'] || entry.port }, { quiet: true, identityFile: entry.identityFile });
    return opts.name || entry.alias;
  }
  const looksLikeLogin = target.includes('@') || /[.:]/.test(target);
  if (!looksLikeLogin) getHostOrExplain(target); // throws, with a "did you mean"
  const saved = Object.entries(hosts).find(([, h]) => h.ssh === target);
  if (saved) return saved[0];
  let name = opts.name || defaultName(target);
  for (let i = 2; !opts.name && hosts[name]; i++) name = `${defaultName(target)}-${i}`;
  await deployCommand(name, target, opts, { quiet: true });
  return name;
}

/** The computers allowed to log in to a server (needs a server from 0.1.2 on). */
async function listComputers(name) {
  try {
    const { keys } = await withClient(name, {}, (conn) => conn.request('GET', '/v1/keys'));
    return keys;
  } catch (err) {
    if (err.status === 404) throw new UserError(`${name} runs an older Swiftstream that can't list computers.`, `Update it by connecting once: swiftstream connect ${name}`);
    throw err;
  }
}

/**
 * Log in over HTTPS (quick), then make sure the server is current (updateIfOlder). If logging in fails
 * in a way SSH can fix and the server has an SSH login: when nothing answered, ask the server's public
 * health check once more (a passing hiccup just connects again); otherwise log in over SSH, find what's
 * wrong, fix it, say what it was, and connect again. At a keyboard the SSH password may be asked if this
 * computer's key isn't accepted; scripts use the key only.
 */
async function connectOrRepair(name, opts = {}) {
  let conn;
  try {
    conn = await client(name, opts);
  } catch (err) {
    const reason = repairReason(err);
    const host = loadHosts()[name];
    if (!reason || !host?.ssh) throw err;
    if (silentReason(reason)) {
      const health = await checkServerHealth(host);
      if (health.up) return updateIfOlder(name, await client(name, opts), opts);
    }
    warn(`${describeReason(reason, name)}. Checking it over SSH (${host.ssh})…`);
    let repairs;
    try {
      ({ repairs } = await deployHost({
        name,
        target: host.ssh,
        sshPort: opts['ssh-port'] || host.sshPort,
        port: Number(new URL(host.url).port) || DEFAULT_PORT,
        restart: reason === 'unresponsive',
        askPassword: (attempt) =>
          process.stdin.isTTY && attempt < 3 ? askSecret(attempt ? 'Wrong password, try again:' : `Password for ${host.ssh}:`) : Promise.reject(new UserError("this computer's SSH key wasn't accepted")),
        confirmHostKey: async () => false, // a server we've connected to before: its SSH key must be known
        onStep: (text) => info(`${text}…`),
      }));
    } catch (sshErr) {
      // Swiftstream's port and SSH both silent: most likely this network, not the server.
      if (sshErr.code === 'SSH_UNREACHABLE' && silentReason(reason)) throw unreachableFromHere(name, host);
      throw sshErr;
    }
    // On stderr, like the other progress lines: stdout may be piped (swiftstream exec … > file).
    if (repairs.length) for (const fix of repairs) fixed(fix);
    else fixed(`${name} looked fine over SSH and answers again`);
    return client(name, opts); // a repair installs this version, so no update check is needed
  }
  return updateIfOlder(name, conn, opts);
}

const fixed = (text) => console.error(`${c.green('✓')} ${text}`);

/**
 * Logging in tells us the server's version. One older than this CLI is updated over SSH, with this
 * computer's key only (a password prompt in the middle of a command would be a surprise), and we log
 * in again. If updating fails, the old version keeps serving and the command goes ahead.
 * SWIFTSTREAM_NO_SERVER_UPDATE=1 turns this off.
 */
// Servers whose SSH didn't answer recently (name -> when), so commands on a network that blocks SSH
// don't each spend 10 seconds finding that out again before updating.
const SSH_BLOCKED_FILE = path.join(paths.dir, 'ssh-unreachable.json');
const SSH_RETRY_MS = 15 * 60_000;
const sshRecentlyBlocked = (name) => Date.now() - (readJson(SSH_BLOCKED_FILE, {})[name] || 0) < SSH_RETRY_MS;
function noteSshBlocked(name, blocked) {
  const all = readJson(SSH_BLOCKED_FILE, {});
  if (blocked) all[name] = Date.now();
  else if (!(name in all)) return;
  else delete all[name];
  writeJson(SSH_BLOCKED_FILE, all);
}

async function updateIfOlder(name, conn, opts) {
  const host = loadHosts()[name];
  const from = conn.serverVersion;
  if (!host?.ssh || !from || !isOlderVersion(from, VERSION) || process.env.SWIFTSTREAM_NO_SERVER_UPDATE) return conn;
  if (sshRecentlyBlocked(name)) return conn; // tried in the last 15 minutes: SSH doesn't get through here
  info(`${name} runs Swiftstream ${from}; updating it to ${VERSION}…`);
  try {
    const { info: remote, webNote } = await deployHost({
      name,
      target: host.ssh,
      sshPort: opts['ssh-port'] || host.sshPort,
      port: Number(new URL(host.url).port) || DEFAULT_PORT,
      askPassword: () => Promise.reject(new UserError("this computer's SSH key wasn't accepted")),
      confirmHostKey: async () => false,
    });
    conn.close();
    noteSshBlocked(name, false);
    fixed(`Updated Swiftstream on ${name} from ${from} to ${remote?.version || VERSION}`);
    if (webNote) warn(webNote);
    return client(name, opts);
  } catch (err) {
    const blocked = err.code === 'SSH_UNREACHABLE';
    if (blocked) noteSshBlocked(name, true);
    warn(`Couldn't update Swiftstream on ${name} (${err.message.split(/\r?\n/)[0]}). Using ${from} for now${blocked ? '; trying again in 15 minutes' : ''}.`);
    return conn;
  }
}

async function deployCommand(name, target, opts, { quiet = false, keyOnly = false, identityFile } = {}) {
  validateHostName(name);
  const { host, info: remote, webNote } = await deployHost({
    name,
    target,
    sshPort: opts['ssh-port'],
    port: Number(opts.port) || DEFAULT_PORT,
    webPorts: opts['web-port'] === undefined ? undefined : parsePortList(opts['web-port']),
    shareWith: opts['share-with'],
    identityFile,
    askPassword: (attempt) =>
      keyOnly
        ? Promise.reject(new UserError("this computer's SSH key wasn't accepted"))
        : // Piped input (scripts) gets one try; a person at the keyboard gets three.
          attempt && !process.stdin.isTTY
        ? Promise.reject(new UserError('Wrong password.'))
        : askSecret(attempt ? 'Wrong password, try again:' : `Password for ${target}:`),
    // A key with a passphrase: asked for here, never stored. Enter skips it (then the password is asked).
    askPassphrase: ({ file, attempt }) => {
      // Only at a keyboard: piped input (scripts) carries the password, not passphrases.
      if (keyOnly || !process.stdin.isTTY) return Promise.resolve(null);
      const shown = file.startsWith(os.homedir()) ? `~${file.slice(os.homedir().length).replace(/\\/g, '/')}` : file;
      return askSecret(attempt ? 'Wrong passphrase, try again (Enter to skip):' : `Passphrase for ${shown} (Enter to skip):`);
    },
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
  if (host.webUrls?.length) info(`Also on port ${host.webUrls.map((u) => new URL(u).port || 443).join(' and ')}, for networks that block ${new URL(host.url).port || DEFAULT_PORT}.`);
  if (webNote) warn(webNote);
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
/**
 * Sharing the web ports (--share-with), saved in serve.json so restarts, updates and @reboot keep it:
 * an address sets it, "off" clears it, and without the option the saved one applies.
 */
function shareSetting(opts) {
  if (opts['share-with'] === undefined) return readJson(paths.serveConfig, {}).shareWith || null;
  const target = parseShareTarget(opts['share-with']);
  if (target === undefined) throw new UserError(`"${opts['share-with']}" isn't an address to share with.`, 'Use a port or host:port, like 127.0.0.1:8444, or "off".');
  writeJson(paths.serveConfig, { ...readJson(paths.serveConfig, {}), shareWith: target });
  return target;
}

/** Stop the background server and wait (up to 10s) for its port to close. False if it wasn't running. */
async function stopRunning(pidInfo) {
  let killed = true;
  try {
    process.kill(pidInfo.pid);
  } catch (err) {
    killed = false;
    if (err.code !== 'ESRCH') console.error(`Couldn't stop pid ${pidInfo.pid}: ${err.code || err.message}`);
  }
  fs.rmSync(paths.pid, { force: true });
  const deadline = Date.now() + 10_000;
  while (killed && pidInfo.port && (await portOpen(pidInfo.port)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  return killed;
}

async function daemonize(port, opts) {
  const { cert, fingerprint } = loadOrCreateServerCert();
  // Running, but asked to share differently than it does: start it again with the new setting.
  const shareWith = shareSetting(opts);
  const wanted = shareWith ? `${shareWith.host}:${shareWith.port}` : null;
  const runningNow = readJson(paths.pid, null);
  if (runningNow && (await portOpen(port)) && (runningNow.sharing || null) !== wanted) await stopRunning(runningNow);
  if (!(await portOpen(port))) {
    ensureDir();
    fs.rmSync(paths.pid, { force: true });
    const logFd = fs.openSync(paths.log, 'a');
    const [exe, ...selfArgs] = selfCommand();
    const childArgs = [...selfArgs, 'serve', '--port', String(port)];
    const webPorts = parsePortList(opts['web-port']);
    if (webPorts.length) childArgs.push('--web-port', webPorts.join(','));
    if (opts.host) childArgs.push('--host', opts.host);
    if (opts.root) childArgs.push('--root', opts.root);
    const child = spawn(exe, childArgs, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
    child.unref();
    // The pid file is written once both ports have been tried, so it also says how the web port went.
    const deadline = Date.now() + 15_000;
    while (!(await portOpen(port)) || readJson(paths.pid, null)?.pid !== child.pid) {
      if (Date.now() > deadline) throw new UserError('The server did not start.', `See the log: ${paths.log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // Already running: report the ports it was started with.
  const running = readJson(paths.pid, null) || {};
  console.log(readyLine({ port, fingerprint, cert, webPorts: running.webPorts || (running.webPort ? [running.webPort] : []), webPortErrors: running.webPortErrors || {}, sharing: running.sharing || null }));
}

/**
 * Automatic updates (opt-in; see src/selfupdate.js), for a server running as the uploaded
 * swiftstream.cjs, the one file it can swap. To restart on the new program it stops serving and starts
 * it the way setup does (serve --daemon); if that fails, the previous program goes back and starts.
 */
function startSelfUpdates(srv, port, opts) {
  const bundlePath = process.argv[1];
  if (!/\.cjs$/.test(bundlePath || '') || process.env.SWIFTSTREAM_NO_SELF_UPDATE) return;
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  import('../src/selfupdate.js').then(({ startAutoUpdater }) =>
    startAutoUpdater({
      current: VERSION,
      bundlePath,
      enabled: () => readJson(paths.serveConfig, {}).autoUpdate === true,
      isIdle: () => srv.isIdle(Number(process.env.SWIFTSTREAM_IDLE_MS) || undefined),
      log,
      restart: async (file, version) => {
        const previous = `${bundlePath}.previous`;
        fs.copyFileSync(bundlePath, previous);
        fs.renameSync(file, bundlePath);
        fs.rmSync(paths.pid, { force: true });
        await srv.close(2000);
        const args = ['serve', '--daemon', '--port', String(port)];
        const webPorts = parsePortList(opts['web-port']);
        if (webPorts.length) args.push('--web-port', webPorts.join(','));
        if (opts.host) args.push('--host', opts.host);
        if (opts.root) args.push('--root', opts.root);
        const start = () => spawnSync(process.execPath, [bundlePath, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
        if (start().status === 0) {
          log('update: now running', version);
        } else {
          log('update:', version, "didn't start; going back to", VERSION);
          fs.copyFileSync(previous, bundlePath);
          start();
        }
        process.exit(0);
      },
    }),
  );
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

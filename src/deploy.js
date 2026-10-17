import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import ssh2 from 'ssh2';
import { DEFAULT_PORT, paths, readJson, writeJson } from './config.js';
import { UserError } from './errors.js';
import { sshPrivateKeyPem, sshPublicKeyLine } from './keys.js';
import { loadServerBundle } from './self.js';

const { Client, utils } = ssh2;
const READY_PREFIX = 'SWIFTSTREAM_READY ';
const LEGACY_READY_PREFIX = 'SWIFTSSH_READY '; // printed by servers from before the rename
const LEGACY_BUNDLE = '$HOME/.swiftssh/bin/swiftssh.cjs';
const REMOTE_BUNDLE = '$HOME/.swiftstream/bin/swiftstream.cjs';
const KNOWN_HOSTS = path.join(paths.dir, 'ssh_known_hosts.json');

/**
 * Log in to a server over SSH once (key or password), make sure Node.js is there, upload
 * swiftstream, start it in the background, authorize this computer's key, and return the
 * server's certificate. The certificate arrives over the authenticated SSH session, so the
 * client can pin it without a trust-on-first-use prompt.
 *
 * Callbacks let the CLI and the desktop app ask the user in their own way:
 *   askPassword(attempt) -> Promise<string>  (reject to give up)
 *   confirmHostKey({ host, fingerprint }) -> Promise<boolean>  (first connection to a server)
 *   onStep(text)  progress messages
 */
export async function deployOverSsh({
  target,
  sshPort = 22,
  port = DEFAULT_PORT,
  publicKey,
  identityKey, // this computer's private key: tried for SSH login, and authorized for SSH so restarts need no password
  authorizeSsh = true,
  password,
  askPassword,
  askPassphrase, // ({ file, attempt }) => passphrase, or null to skip that key
  confirmHostKey = async () => true,
  onStep = () => {},
  bundlePath,
  identityFile, // a private key to try first, e.g. IdentityFile from ~/.ssh/config
}) {
  if (!/^swift(stream|ssh)-ed25519 [A-Za-z0-9+/=]+$/.test(publicKey)) throw new Error('Invalid public key');
  const { username, host } = parseTarget(target);
  const bundle = loadServerBundle(bundlePath);
  const bundleSha = crypto.createHash('sha256').update(bundle).digest('hex');

  onStep(`Connecting to ${host}`);
  const ownKey = identityKey ? sshPrivateKeyPem(identityKey) : null;
  const session = await sshConnect({ username, host, port: Number(sshPort) || 22, password, askPassword, askPassphrase, confirmHostKey, ownKey, identityFile });
  try {
    onStep('Checking the server');
    const facts = await probe(session);

    let node = facts.node;
    if (!node) node = await installNode(session, facts, onStep, session.loginPassword);

    // A server set up before the rename runs the old program on the same port: stop it first.
    if (facts.legacy) {
      onStep('Upgrading from SwiftSSH');
      await run(session, sh(`"${node}" "${LEGACY_BUNDLE}" stop`)).catch(() => {});
      await run(session, sh(`rm -f "${LEGACY_BUNDLE}"`)).catch(() => {});
    }

    if (facts.bundle_sha !== bundleSha) {
      onStep('Uploading Swiftstream');
      // A different version may be running from an older upload: stop it so the new one starts.
      if (facts.bundle_sha) await run(session, sh(`"${node}" "${REMOTE_BUNDLE}" stop`)).catch(() => {});
      const up = await run(
        session,
        sh(`umask 077 && mkdir -p "$HOME/.swiftstream/bin" && cat > "${REMOTE_BUNDLE}.tmp" && mv "${REMOTE_BUNDLE}.tmp" "${REMOTE_BUNDLE}"`),
        { stdin: bundle },
      );
      if (up.code !== 0) throw new UserError(`Uploading Swiftstream to ${host} failed.`, up.stderr.trim());
    }

    onStep('Starting Swiftstream');
    const start = await run(session, sh(`NO_COLOR=1 "${node}" "${REMOTE_BUNDLE}" serve --daemon --port ${Number(port)} --authorize "${publicKey}"`));
    const line = start.stdout.split(/\r?\n/).find((l) => l.startsWith(READY_PREFIX) || l.startsWith(LEGACY_READY_PREFIX));
    if (!line) {
      throw new UserError(`Swiftstream didn't start on ${host}.`, (start.stderr || start.stdout).trim().split('\n').slice(-6).join('\n') || 'See ~/.swiftstream/server.log on the server.');
    }
    const ready = { ...parseReadyLine(line), host };

    if (identityKey && authorizeSsh) {
      // Let this computer log in over SSH with its Swiftstream key, so a stopped server can be
      // restarted automatically without asking for a password. Same access the key already has.
      const comment = `swiftstream@${os.hostname().replace(/[^w.-]/g, '') || 'computer'}`;
      const line = sshPublicKeyLine(identityKey, comment);
      const keyData = line.split(' ')[1];
      await run(session, sh(`umask 077 && mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && (grep -qF "${keyData}" "$HOME/.ssh/authorized_keys" || printf '%s\n' "${line}" >> "$HOME/.ssh/authorized_keys")`)).catch(() => {});
    }

    // Start again after a reboot, where the server allows a user crontab.
    const cronLine = `@reboot NO_COLOR=1 "${node}" "${REMOTE_BUNDLE}" serve --daemon --port ${Number(port)} >/dev/null 2>&1`;
    const cron = await run(
      session,
      sh(`command -v crontab >/dev/null 2>&1 || exit 3; (crontab -l 2>/dev/null | grep -v -e "swiftstream.cjs\" serve" -e "swiftssh.cjs\" serve"; echo '${cronLine.replace(/'/g, `'"'"'`)}') | crontab -`),
    ).catch(() => ({ code: 1 }));
    ready.autostart = cron.code === 0;
    return ready;
  } finally {
    session.end();
  }
}

export function parseTarget(target) {
  const match = /^(?:([^@\s]+)@)?([\w.-]+|\[[0-9a-fA-F:]+\])$/.exec(String(target || '').trim());
  if (!match) throw new UserError(`"${target}" isn't a valid SSH login.`, 'Use the form user@hostname, like ubuntu@203.0.113.7.');
  return { username: match[1] || os.userInfo().username, host: match[2].replace(/^\[|\]$/g, '') };
}

// ---- SSH connection ---------------------------------------------------------

/**
 * Private keys to try before the password: the host's IdentityFile from ~/.ssh/config first, then the
 * usual ~/.ssh/id_* files. Keys with a passphrase come back separately, to ask for it only if needed.
 */
function localKeys(identityFile) {
  const dir = path.join(os.homedir(), '.ssh');
  const keys = [];
  const encrypted = [];
  const files = [identityFile, ...['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => path.join(dir, n))].filter(Boolean);
  for (const file of new Set(files)) {
    if (!fs.existsSync(file)) continue;
    const data = fs.readFileSync(file);
    const parsed = utils.parseKey(data);
    if (!(parsed instanceof Error)) keys.push(data);
    else if (/encrypted|passphrase/i.test(parsed.message)) encrypted.push({ file, data });
  }
  return { keys, encrypted };
}

function hostKeyFingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** Fail fast (15s) when nothing answers, before the SSH login, which may wait on a person typing. */
function checkReachable(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (err) => {
      socket.destroy();
      if (err.code === 'ECONNREFUSED') reject(new UserError(`No SSH server is answering on ${host}:${port}.`, 'Check the address and SSH port.'));
      else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') reject(new UserError(`Can't find a machine called "${host}".`, 'Check the spelling of the address.'));
      else reject(new UserError(`Connecting to ${host}:${port} timed out.`, 'Check the address, the SSH port, and that the server is online.'));
    };
    socket.setTimeout(15_000, () => fail({ code: 'ETIMEDOUT' }));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
  });
}

/** The running SSH agent: SSH_AUTH_SOCK, or on Windows the OpenSSH agent service's pipe. */
function sshAgent() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    try {
      if (fs.existsSync(pipe)) return pipe;
    } catch {
      /* no agent */
    }
  }
  return null;
}

async function sshConnect({ username, host, port, password, askPassword, askPassphrase, confirmHostKey, ownKey, identityFile }) {
  await checkReachable(host, port);
  const known = readJson(KNOWN_HOSTS, {});
  const hostId = port === 22 ? host : `[${host}]:${port}`;
  let hostKeyError = null;

  // Try keys first (agent, then ~/.ssh), then the password; ask for it only when needed.
  const attempts = [];
  const agent = sshAgent();
  if (agent) attempts.push({ type: 'agent', username, agent });
  if (ownKey) attempts.push({ type: 'publickey', username, key: ownKey }); // authorized by an earlier setup
  const local = localKeys(identityFile);
  for (const key of local.keys) attempts.push({ type: 'publickey', username, key });
  // Keys with a passphrase: ask for it, unless a password was given up front (then that's the plan).
  if (askPassphrase && !password) for (const k of local.encrypted) attempts.push({ type: 'passphrase-slot', ...k });
  const passwordTries = password || !askPassword ? 1 : 3;
  for (let i = 0; i < passwordTries; i++) attempts.push({ type: 'password-slot', attempt: i });
  let next = 0;
  let lastPasswordUsed = false;
  let usedPassword = null;

  /** Ask for a key's passphrase until it opens the key (checked here, before the server sees it). */
  const unlockKey = async ({ file, data }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const passphrase = await askPassphrase({ file, attempt });
      if (passphrase == null || passphrase === '') return null; // skipped
      if (!(utils.parseKey(data, passphrase) instanceof Error)) return { passphrase };
    }
    return null;
  };

  const authHandler = (methodsLeft, _partial, callback) => {
    const step = () => {
      if (next >= attempts.length) return callback(false);
      const attempt = attempts[next++];
      const allowed = (m) => !methodsLeft || methodsLeft.includes(m);
      if (attempt.type === 'passphrase-slot') {
        if (!allowed('publickey')) return step();
        return unlockKey(attempt).then((key) => (key ? callback({ type: 'publickey', username, key: attempt.data, passphrase: key.passphrase }) : step()), () => step());
      }
      if (attempt.type !== 'password-slot') return allowed('publickey') ? callback(attempt) : step();
      if (!allowed('password') && !allowed('keyboard-interactive')) return callback(false);
      const getPassword = password && attempt.attempt === 0 ? Promise.resolve(password) : askPassword ? askPassword(attempt.attempt) : Promise.reject(new Error('no password'));
      getPassword.then(
        (pw) => {
          lastPasswordUsed = true;
          usedPassword = pw;
          if (allowed('password')) callback({ type: 'password', username, password: pw });
          else callback({ type: 'keyboard-interactive', username, prompt: (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)) });
        },
        () => callback(false),
      );
    };
    step();
  };

  return await new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.loginPassword = usedPassword; // reused for sudo if Node.js must be installed
      resolve(conn);
    });
    conn.on('error', (err) => {
      if (hostKeyError) return reject(hostKeyError);
      if (err.level === 'client-authentication') {
        return reject(
          new UserError(
            `The SSH login to ${username}@${host} was refused.`,
            lastPasswordUsed ? 'Check the username and password.' : 'Enter the password for this account, or set up an SSH key for it.',
          ),
        );
      }
      if (err.level === 'client-timeout') return reject(new UserError(`Connecting to ${host} timed out.`, 'Check the address, the SSH port, and that the server is online.'));
      if (err.code === 'ECONNREFUSED') return reject(new UserError(`No SSH server is answering on ${host}:${port}.`, 'Check the address and SSH port.'));
      if (err.code === 'ENOTFOUND') return reject(new UserError(`Can't find a machine called "${host}".`, 'Check the spelling of the address.'));
      reject(err);
    });
    conn.connect({
      host,
      port,
      username,
      readyTimeout: 5 * 60_000, // includes the time someone spends typing their password
      keepaliveInterval: 15_000,
      authHandler,
      hostVerifier: (key, verify) => {
        const fingerprint = hostKeyFingerprint(key);
        const saved = known[hostId];
        if (saved === fingerprint) return verify(true);
        if (saved) {
          hostKeyError = new UserError(
            `${host}'s SSH host key has changed.`,
            `Expected ${saved}\nGot      ${fingerprint}\nIf the server was reinstalled, remove its line from ${KNOWN_HOSTS} and try again.`,
          );
          return verify(false);
        }
        Promise.resolve(confirmHostKey({ host: hostId, fingerprint })).then(
          (ok) => {
            if (!ok) {
              hostKeyError = new UserError('Connection cancelled.', "The server's SSH key wasn't trusted.");
              return verify(false);
            }
            known[hostId] = fingerprint;
            writeJson(KNOWN_HOSTS, known);
            verify(true);
          },
          () => verify(false),
        );
      },
    });
  });
}

/** Wrap a POSIX command so it runs under sh whatever the user's login shell is. */
const sh = (command) => `sh -c '${command.replace(/'/g, "'\\''")}'`;

/** Run a command on the server; resolves with { code, stdout, stderr }. */
function run(conn, command, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => (stdout += d));
      stream.stderr.on('data', (d) => (stderr += d));
      stream.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
      if (stdin !== undefined) stream.end(stdin);
      else stream.end();
    });
  });
}

// ---- server facts and Node.js -------------------------------------------------

const PROBE = `
D="$HOME/.swiftstream"
node_ok() { [ -n "$1" ] && [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ] 2>/dev/null; }
N=""
for c in "$D/runtime/bin/node" "$HOME/.swiftssh/runtime/bin/node" "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node; do
  if node_ok "$c"; then N="$c"; break; fi
done
if [ -z "$N" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; c=$(command -v node 2>/dev/null); node_ok "$c" && N="$c"; fi
echo "node=$N"
[ -f "$HOME/.swiftssh/bin/swiftssh.cjs" ] && echo "legacy=1"
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
if ls /lib/ld-musl-* >/dev/null 2>&1; then echo "libc=musl"; else echo "libc=glibc"; fi
for pm in xbps-install apt-get dnf yum apk pacman zypper brew; do command -v $pm >/dev/null 2>&1 && { echo "pm=$pm"; break; }; done
echo "uid=$(id -u)"
command -v sudo >/dev/null 2>&1 && echo "sudo=1"
if command -v curl >/dev/null 2>&1; then echo "fetch=curl"; elif command -v wget >/dev/null 2>&1; then echo "fetch=wget"; fi
if [ -f "$D/bin/swiftstream.cjs" ]; then echo "bundle_sha=$( (sha256sum "$D/bin/swiftstream.cjs" 2>/dev/null || shasum -a 256 "$D/bin/swiftstream.cjs") | cut -d' ' -f1)"; fi
`;

async function probe(conn) {
  const { stdout } = await run(conn, 'sh -s', { stdin: PROBE });
  const facts = {};
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) facts[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return facts;
}

// Official Node.js builds are glibc-only; they need no root because they unpack into ~/.swiftstream/runtime.
const NODE_DOWNLOAD = `
set -e
D="$HOME/.swiftstream"; mkdir -p "$D"
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported system $(uname -s)" >&2; exit 3 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported CPU $(uname -m)" >&2; exit 3 ;; esac
base=https://nodejs.org/dist/latest-v22.x
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }
line=$(fetch "$base/SHASUMS256.txt" | grep " node-v[0-9.]*-$os-$arch.tar.gz$")
sum=\${line%% *}; file=\${line##* }
[ -n "$file" ] || { echo "no Node.js build for $os-$arch" >&2; exit 3; }
tmp="$D/runtime.tmp"; rm -rf "$tmp"; mkdir -p "$tmp"
fetch "$base/$file" > "$tmp/node.tar.gz"
actual=$( (sha256sum "$tmp/node.tar.gz" 2>/dev/null || shasum -a 256 "$tmp/node.tar.gz") | cut -d' ' -f1)
[ "$actual" = "$sum" ] || { echo "Node.js download failed its checksum" >&2; exit 4; }
tar -xzf "$tmp/node.tar.gz" -C "$tmp" --strip-components=1
rm -f "$tmp/node.tar.gz"; rm -rf "$D/runtime"; mv "$tmp" "$D/runtime"
echo "$D/runtime/bin/node"
`;

const PACKAGE_INSTALL = {
  'xbps-install': 'xbps-install -Sy nodejs',
  'apt-get': 'apt-get update -qq && apt-get install -y -qq nodejs',
  dnf: 'dnf install -y nodejs',
  yum: 'yum install -y nodejs',
  apk: 'apk add --no-cache nodejs',
  pacman: 'pacman -Sy --noconfirm nodejs',
  zypper: 'zypper --non-interactive install nodejs',
};

async function installNode(conn, facts, onStep, sudoPassword) {
  const canDownload = facts.libc === 'glibc' && /^(Linux|Darwin)$/.test(facts.os) && /^(x86_64|amd64|aarch64|arm64)$/.test(facts.arch) && facts.fetch;
  if (canDownload) {
    onStep('Installing Node.js for your account (one time)');
    const res = await run(conn, 'sh -s', { stdin: NODE_DOWNLOAD });
    const nodePath = res.stdout.trim().split('\n').pop();
    if (res.code === 0 && nodePath) return nodePath;
  }

  const installCmd = PACKAGE_INSTALL[facts.pm];
  if (installCmd && (facts.uid === '0' || facts.sudo)) {
    onStep(`Installing Node.js with ${facts.pm}`);
    // As root run it directly; otherwise sudo, giving it the login password on stdin if we have one.
    const res =
      facts.uid === '0'
        ? await run(conn, sh(installCmd))
        : sudoPassword
          ? await run(conn, `sudo -S -p '' ${sh(installCmd)}`, { stdin: `${sudoPassword}
` })
          : await run(conn, `sudo -n ${sh(installCmd)}`);
    if (res.code === 0) {
      const again = await probe(conn);
      if (again.node) return again.node;
    }
  }

  const manual = installCmd ? `sudo ${installCmd}` : 'install Node.js 18 or newer with your package manager';
  throw new UserError(
    `Node.js 18 or newer isn't installed on the server, and Swiftstream couldn't install it automatically.`,
    `On the server run:\n  ${manual}\nthen connect again.`,
  );
}

/** One machine-readable line the server prints when it is up, so deploy can pin its cert. */
export function readyLine({ port, fingerprint, cert }) {
  return READY_PREFIX + Buffer.from(JSON.stringify({ port, fingerprint, cert })).toString('base64');
}

export function parseReadyLine(line) {
  const prefix = line.startsWith(LEGACY_READY_PREFIX) ? LEGACY_READY_PREFIX : READY_PREFIX;
  return JSON.parse(Buffer.from(line.slice(prefix.length), 'base64').toString());
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { ensureDir, paths, readJson, writeJson } from './config.js';
import { authMessage, decodePublicKey, keyFingerprint, normalizePublicKey, readAuthorizedKeys, verify } from './keys.js';
import { loadOrCreateServerCert } from './tls.js';
import { decodeBundle, encodeBundle } from './bundle.js';
import { hashFile, safeJoin, sameMtime, walk, writeFileAtomic } from './util.js';
import { VERSION } from './version.js';

const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const MAX_BUNDLE_SIZE = 64 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 32 * 1024 * 1024;
const AUTH_WINDOW_MS = 10 * 60_000;
const AUTH_MAX_FAILURES = 10; // per IP per window, then 429 until the window passes
const AUTH_MAX_CHALLENGES = 120; // per IP per window
const MAX_PENDING_CHALLENGES = 10_000;
const STALE_UPLOAD_MS = 7 * 24 * 60 * 60_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadPty() {
  try {
    return (await import('node-pty')).default;
  } catch {
    return null;
  }
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export async function startServer({ port, host = '0.0.0.0', root = os.homedir() }) {
  const { key, cert, fingerprint } = loadOrCreateServerCert();
  const pty = await loadPty();
  ensureDir(paths.uploads);

  const challenges = new Map(); // nonce -> expiry
  const sessions = new Map(); // token -> { expires, key }
  const uploads = new Map(); // id -> upload state (mirrored to disk so uploads survive restarts)
  const authAttempts = new Map(); // ip -> { windowStart, failures, challenges }

  /** Brute-force protection: count challenges and failed logins per client IP. */
  const authBudget = (req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = authAttempts.get(ip);
    if (!entry || now - entry.windowStart > AUTH_WINDOW_MS) {
      entry = { windowStart: now, failures: 0, challenges: 0 };
      authAttempts.set(ip, entry);
    }
    if (entry.failures >= AUTH_MAX_FAILURES || entry.challenges >= AUTH_MAX_CHALLENGES) {
      throw new HttpError(429, 'too many login attempts; try again in a few minutes');
    }
    return { ip, entry };
  };

  const resolvePath = (p) => {
    if (typeof p !== 'string' || !p) throw new HttpError(400, 'path is required');
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    return path.resolve(root, p);
  };

  const safePath = (base, rel) => {
    try {
      return safeJoin(base, rel);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  };

  const authenticate = (req) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const session = match && sessions.get(match[1]);
    if (!session || session.expires < Date.now()) throw new HttpError(401, 'not authenticated');
    return session;
  };

  const loadUpload = (id) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, 'bad upload id');
    let state = uploads.get(id);
    if (!state) {
      state = readJson(path.join(paths.uploads, `${id}.json`), null);
      if (!state) throw new HttpError(404, 'unknown upload');
      state.received = new Set(state.received);
      uploads.set(id, state);
    }
    return state;
  };

  const persistUpload = (id, state) =>
    writeJson(path.join(paths.uploads, `${id}.json`), { ...state, received: [...state.received] });

  const routes = {
    'POST /v1/auth/challenge': async (req) => {
      authBudget(req).entry.challenges++;
      if (challenges.size >= MAX_PENDING_CHALLENGES) throw new HttpError(503, 'server busy; try again shortly');
      const nonce = crypto.randomBytes(32).toString('base64url');
      challenges.set(nonce, Date.now() + CHALLENGE_TTL_MS);
      return { nonce, fingerprint };
    },

    'POST /v1/auth/verify': async (req) => {
      const { ip, entry } = authBudget(req);
      const fail = (message) => {
        entry.failures++;
        log('auth failed', ip, message);
        return new HttpError(401, message);
      };
      const { publicKey, nonce, signature } = await readJsonBody(req);
      const expires = challenges.get(nonce);
      challenges.delete(nonce);
      if (!expires || expires < Date.now()) throw fail('challenge expired');
      const wanted = normalizePublicKey(String(publicKey || ''));
      if (!readAuthorizedKeys().some((k) => normalizePublicKey(k) === wanted)) {
        throw fail('key not authorized');
      }
      if (!verify(decodePublicKey(wanted), authMessage(nonce, fingerprint), signature)) {
        throw fail('bad signature');
      }
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { expires: Date.now() + SESSION_TTL_MS, key: wanted });
      log('auth ok', keyFingerprint(wanted), req.socket.remoteAddress);
      return { token, expiresIn: SESSION_TTL_MS / 1000 };
    },

    'GET /v1/info': async (req) => {
      authenticate(req);
      return { version: VERSION, hostname: os.hostname(), platform: process.platform, root, pty: !!pty };
    },

    'GET /v1/stat': async (req, url) => {
      authenticate(req);
      const file = resolvePath(url.searchParams.get('path'));
      const st = await fsp.stat(file).catch(() => {
        throw new HttpError(404, `no such file: ${file}`);
      });
      const result = { path: file, size: st.size, mtime: st.mtimeMs, isDirectory: st.isDirectory() };
      if (url.searchParams.get('hash') && st.isFile()) result.sha256 = await hashFile(file);
      return result;
    },

    'POST /v1/upload/init': async (req) => {
      authenticate(req);
      const body = await readJsonBody(req);
      const size = Number(body.size);
      const chunkSize = Number(body.chunkSize);
      if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'bad size');
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) throw new HttpError(400, 'bad chunkSize');
      if (!/^[a-f0-9]{64}$/.test(body.sha256)) throw new HttpError(400, 'bad sha256');

      let dest = resolvePath(body.path);
      const intoDir = /[\\/]$/.test(body.path) || fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory();
      if (intoDir) dest = path.join(dest, path.basename(body.name || 'upload'));

      // Same file to the same destination -> same id, which is what makes uploads resumable.
      const id = crypto.createHash('sha256').update(`${dest}\0${size}\0${body.sha256}\0${chunkSize}`).digest('hex').slice(0, 32);
      const statePath = path.join(paths.uploads, `${id}.json`);
      let state = uploads.get(id) || readJson(statePath, null);
      if (state && !fs.existsSync(state.partPath)) state = null;
      if (!state) {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        // The partial file lives beside the destination so the final rename never crosses filesystems.
        const partPath = `${dest}.swiftstream-part`;
        const fh = await fsp.open(partPath, 'w');
        await fh.truncate(size);
        await fh.close();
        state = { dest, partPath, size, chunkSize, sha256: body.sha256, mtime: Number(body.mtime) || null, received: [] };
        writeJson(statePath, state);
      }
      state.received = new Set(state.received);
      uploads.set(id, state);
      return { id, dest, chunks: Math.ceil(size / chunkSize), received: [...state.received] };
    },

    'POST /v1/upload/complete': async (req, url) => {
      authenticate(req);
      const id = url.searchParams.get('id');
      const state = loadUpload(id);
      const chunks = Math.ceil(state.size / state.chunkSize);
      if (state.received.size !== chunks) throw new HttpError(409, `missing ${chunks - state.received.size} chunks`);
      const actual = await hashFile(state.partPath);
      if (actual !== state.sha256) {
        // Integrity failure: throw away everything so the client starts clean.
        await fsp.rm(state.partPath, { force: true });
        await fsp.rm(path.join(paths.uploads, `${id}.json`), { force: true });
        uploads.delete(id);
        throw new HttpError(422, 'checksum mismatch; upload discarded');
      }
      await fsp.rename(state.partPath, state.dest);
      if (state.mtime) await fsp.utimes(state.dest, new Date(), state.mtime / 1000);
      await fsp.rm(path.join(paths.uploads, `${id}.json`), { force: true });
      uploads.delete(id);
      log('upload complete', state.dest, state.size);
      return { path: state.dest, size: state.size, sha256: actual };
    },

    'PUT /v1/upload/chunk': async (req, url) => {
      authenticate(req);
      const id = url.searchParams.get('id');
      const index = Number(url.searchParams.get('index'));
      const state = loadUpload(id);
      const chunks = Math.ceil(state.size / state.chunkSize);
      if (!Number.isInteger(index) || index < 0 || index >= chunks) throw new HttpError(400, 'bad chunk index');
      const offset = index * state.chunkSize;
      const expectedLength = Math.min(state.chunkSize, state.size - offset);
      const data = await readBody(req, expectedLength);
      if (data.length !== expectedLength) throw new HttpError(400, `chunk ${index} should be ${expectedLength} bytes`);
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      if (digest !== req.headers['x-chunk-sha256']) throw new HttpError(422, `chunk ${index} corrupted in transit`);
      const fh = await fsp.open(state.partPath, 'r+');
      try {
        await fh.write(data, 0, data.length, offset);
      } finally {
        await fh.close();
      }
      state.received.add(index);
      persistUpload(id, state);
      return { ok: true };
    },

    // Folder sync: the client sends its manifest, we answer with the files we don't already have.
    'POST /v1/sync/plan': async (req) => {
      authenticate(req);
      const { root: rootPath, files } = await readJsonBody(req, MAX_MANIFEST_SIZE);
      if (!Array.isArray(files)) throw new HttpError(400, 'files must be an array');
      const base = resolvePath(rootPath);
      const need = [];
      for (const f of files) {
        const st = await fsp.stat(safePath(base, f.path)).catch(() => null);
        if (!st?.isFile() || st.size !== f.size || !sameMtime(st.mtimeMs, f.mtime)) need.push(f.path);
      }
      return { root: base, need };
    },

    'PUT /v1/bundle': async (req, url) => {
      authenticate(req);
      const base = resolvePath(url.searchParams.get('root'));
      let entries;
      try {
        entries = decodeBundle(await readBody(req, MAX_BUNDLE_SIZE));
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(422, err.message);
      }
      const targets = entries.map((e) => safePath(base, e.header.path)); // validate all before writing any
      for (let i = 0; i < entries.length; i++) {
        await writeFileAtomic(targets[i], entries[i].data, entries[i].header.mtime);
      }
      return { written: entries.length };
    },

    // One directory level, for file browsers.
    'GET /v1/ls': async (req, url) => {
      authenticate(req);
      const dir = resolvePath(url.searchParams.get('path') || '.'); // default: the server's root, where shells start
      const ents = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => {
        throw new HttpError(err.code === 'ENOENT' ? 404 : 400, `can't open folder: ${dir}`);
      });
      const entries = [];
      for (const ent of ents) {
        if (/\.swift(stream|ssh)-part$/.test(ent.name)) continue;
        const st = await fsp.stat(path.join(dir, ent.name)).catch(() => null);
        if (!st) continue; // broken symlink or vanished file
        entries.push({ name: ent.name, isDirectory: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      }
      entries.sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      return { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), entries };
    },

    'POST /v1/rename': async (req) => {
      authenticate(req);
      const { from, to } = await readJsonBody(req);
      const src = resolvePath(from);
      const dest = resolvePath(to);
      if (!(await fsp.stat(src).catch(() => null))) throw new HttpError(404, `no such file or folder: ${src}`);
      if (await fsp.stat(dest).catch(() => null)) throw new HttpError(409, `something called ${path.basename(dest)} is already there`);
      await fsp.rename(src, dest);
      log('renamed', src, '->', dest);
      return { path: dest };
    },

    'POST /v1/rm': async (req) => {
      authenticate(req);
      const { path: p } = await readJsonBody(req);
      const target = resolvePath(p);
      // Refuse the obviously catastrophic: the filesystem root, the server's root, a home folder.
      const protectedPaths = [path.parse(target).root, root, os.homedir()].map((x) => path.resolve(x));
      if (protectedPaths.includes(path.resolve(target))) throw new HttpError(400, `refusing to delete ${target}`);
      const st = await fsp.lstat(target).catch(() => null);
      if (!st) throw new HttpError(404, `no such file or folder: ${target}`);
      await fsp.rm(target, { recursive: st.isDirectory(), force: false });
      log('deleted', target);
      return { path: target };
    },

    'POST /v1/mkdir': async (req) => {
      authenticate(req);
      const { path: p } = await readJsonBody(req);
      const dir = resolvePath(p);
      await fsp.mkdir(dir, { recursive: true });
      return { path: dir };
    },

    'GET /v1/list': async (req, url) => {
      authenticate(req);
      const base = resolvePath(url.searchParams.get('path'));
      const st = await fsp.stat(base).catch(() => null);
      if (!st?.isDirectory()) throw new HttpError(400, `not a directory: ${base}`);
      return { root: base, files: await walk(base) };
    },

    'POST /v1/bundle/read': async (req, url, res) => {
      authenticate(req);
      const { root: rootPath, paths: wanted } = await readJsonBody(req, MAX_MANIFEST_SIZE);
      if (!Array.isArray(wanted)) throw new HttpError(400, 'paths must be an array');
      const base = resolvePath(rootPath);
      const entries = [];
      let total = 0;
      for (const rel of wanted) {
        const file = safePath(base, rel);
        const st = await fsp.stat(file).catch(() => null);
        if (!st?.isFile()) throw new HttpError(404, `no such file: ${rel}`);
        total += st.size;
        if (total > MAX_BUNDLE_SIZE) throw new HttpError(413, 'bundle too large');
        entries.push({ header: { path: rel, mtime: st.mtimeMs }, data: await fsp.readFile(file) });
      }
      const body = encodeBundle(entries);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      res.end(body);
      return undefined; // response handled
    },

    'GET /v1/file': async (req, url, res) => {
      authenticate(req);
      const file = resolvePath(url.searchParams.get('path'));
      const st = await fsp.stat(file).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, `no such file: ${file}`);
      let start = 0;
      let end = st.size - 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        if (start > end) throw new HttpError(416, 'range not satisfiable');
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${st.size}`,
        });
      } else {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'accept-ranges': 'bytes' });
      }
      if (st.size === 0) return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return undefined; // response handled
    },
  };

  const server = https.createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    // API responses are private and never meant to be rendered by a browser.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (!route) throw new HttpError(404, 'not found');
      const result = await route(req, url, res);
      if (result !== undefined) sendJson(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) log('error', req.method, url.pathname, err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 30_000; // slow-loris protection
  server.requestTimeout = 10 * 60_000; // generous: a 64 MB chunk over a slow link

  // Interactive shell / remote exec over WebSocket on the same port.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'https://localhost');
    try {
      if (url.pathname !== '/v1/shell') throw new HttpError(404, 'not found');
      authenticate(req);
    } catch (err) {
      socket.end(`HTTP/1.1 ${err.status || 400} ${err.message}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => runShell(ws, url, { root, pty }));
  });

  // Expire stale challenges/sessions/rate-limit windows so memory doesn't grow forever.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of challenges) if (exp < now) challenges.delete(k);
    for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
    for (const [ip, a] of authAttempts) if (now - a.windowStart > AUTH_WINDOW_MS) authAttempts.delete(ip);
  }, 60_000);
  sweeper.unref();

  // Abandoned uploads (never completed) leave a .swiftstream-part file and state; clear them after a week.
  const cleanStaleUploads = async () => {
    for (const name of await fsp.readdir(paths.uploads).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const statePath = path.join(paths.uploads, name);
      const st = await fsp.stat(statePath).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < STALE_UPLOAD_MS) continue;
      const state = readJson(statePath, null);
      if (state?.partPath) await fsp.rm(state.partPath, { force: true });
      await fsp.rm(statePath, { force: true });
      uploads.delete(name.slice(0, -5));
      log('removed stale upload', state?.dest || name);
    }
  };
  cleanStaleUploads();
  const janitor = setInterval(cleanStaleUploads, 6 * 60 * 60_000);
  janitor.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  /** Stop accepting connections, end open shells, and resolve once the server is closed. */
  const close = (graceMs = 5000) =>
    new Promise((resolve) => {
      clearInterval(sweeper);
      clearInterval(janitor);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      server.close(() => resolve());
      server.closeIdleConnections?.();
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, graceMs).unref();
    });

  return { server, fingerprint, cert, port: server.address().port, close };
}

let scriptFlavor; // 'linux' (util-linux/busybox), 'bsd' (macOS/BSD), or null
function detectScript() {
  if (scriptFlavor !== undefined) return scriptFlavor;
  scriptFlavor = null;
  if (process.platform === 'win32') return scriptFlavor;
  const found = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' });
  if (found.status === 0 && found.stdout.trim()) scriptFlavor = process.platform === 'linux' ? 'linux' : 'bsd';
  return scriptFlavor;
}

/**
 * [file, args] that run the shell (or cmd) inside a pseudo-terminal using script(1).
 * The size is set once at start; later window resizes aren't passed through (install node-pty for that).
 */
function scriptCommand(shell, cmd, cols, rows) {
  const flavor = detectScript();
  if (!flavor) return null;
  const quote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const inner = `stty rows ${Number(rows)} cols ${Number(cols)} 2>/dev/null; ${cmd ? `exec sh -c ${quote(cmd)}` : `exec ${quote(shell)} -l`}`;
  return flavor === 'linux' ? ['script', ['-qfc', inner, '/dev/null']] : ['script', ['-q', '/dev/null', 'sh', '-c', inner]];
}

function runShell(ws, url, { root, pty }) {
  const cmd = url.searchParams.get('cmd');
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;
  const ptyRequested = url.searchParams.get('pty') === '1';
  const wantPty = ptyRequested && !!pty;
  const isWin = process.platform === 'win32';
  const shell = isWin ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  // Without node-pty, the system "script" command still gives a real terminal on Linux and macOS.
  const viaScript = ptyRequested && !wantPty && !!scriptCommand(shell, cmd, cols, rows);
  const control = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  // Binary frames carry a 1-byte stream id: 0 = stdin, 1 = stdout, 2 = stderr.
  const out = (streamId, data) => ws.readyState === ws.OPEN && ws.send(Buffer.concat([Buffer.from([streamId]), Buffer.from(data)]));
  let exited = false;
  const onExit = (code) => {
    if (exited) return;
    exited = true;
    control({ type: 'exit', code: code ?? 1 });
    ws.close();
  };

  control({ type: 'hello', pty: wantPty || viaScript, platform: process.platform });

  if (wantPty) {
    const args = cmd ? (isWin ? ['/c', cmd] : ['-c', cmd]) : [];
    const term = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd: root, env: process.env });
    term.onData((d) => out(1, d));
    term.onExit(({ exitCode }) => onExit(exitCode));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return term.write(data.subarray(1).toString());
      const msg = JSON.parse(data.toString());
      if (msg.type === 'resize') term.resize(msg.cols, msg.rows);
    });
    ws.on('close', () => !exited && term.kill());
    return;
  }

  let child;
  if (viaScript) {
    const [file, args] = scriptCommand(shell, cmd, cols, rows);
    child = spawn(file, args, { cwd: root, env: { ...process.env, TERM: 'xterm-256color' } });
  } else {
    child = cmd ? spawn(cmd, { shell: true, cwd: root, env: process.env }) : spawn(shell, isWin ? [] : ['-i'], { cwd: root, env: process.env });
  }
  child.stdout.on('data', (d) => out(1, d));
  child.stderr.on('data', (d) => out(2, d));
  child.on('error', (err) => {
    out(2, `${err.message}\n`);
    onExit(127);
  });
  child.on('close', onExit);
  child.stdin.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary) return child.stdin.write(data.subarray(1));
    const msg = JSON.parse(data.toString());
    if (msg.type === 'eof') child.stdin.end();
  });
  ws.on('close', () => !exited && child.kill());
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = 64 * 1024) {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString() || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

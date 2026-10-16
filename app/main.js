import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { connectClient } from './core/client.js';
import { loadHosts, paths, readJson, writeJson } from './core/config.js';
import { explainError } from './core/errors.js';
import { deployHost, getHostOrExplain, probeHost, removeHost, saveProbedHost, updateHost, validateHostName } from './core/hosts.js';
import { keyFingerprint, loadOrCreateIdentity } from './core/keys.js';
import { openChannel } from './core/shell.js';
import { pull, pullDir, push, pushDir, remoteBasename } from './core/transfer.js';
import { walk } from './core/util.js';

const dirname = import.meta.dirname;
let win = null;
const clients = new Map(); // host name -> logged-in SwiftClient
const terminals = new Map(); // terminal id -> { channel, host }
const probes = new Map(); // url -> fetched certificate waiting for the user's "trust" click
let nextId = 1;

const send = (channel, ...args) => win && !win.isDestroyed() && win.webContents.send(channel, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getClient(name) {
  let client = clients.get(name);
  if (!client) {
    client = await connectClient(getHostOrExplain(name), loadOrCreateIdentity());
    clients.set(name, client);
  }
  return client;
}

function dropClient(name) {
  clients.get(name)?.close();
  clients.delete(name);
}

/** Run fn with a logged-in client, logging in once more if the session went stale (e.g. server restarted). */
async function withClient(name, fn) {
  try {
    return await fn(await getClient(name));
  } catch (err) {
    const stale = err.status === 401 || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(err.code);
    if (!stale) throw err;
    dropClient(name);
    return fn(await getClient(name));
  }
}

/** IPC handler that returns { ok, value } or { ok: false, error: { message, hint, action } }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: explainForApp(err, typeof args[0] === 'string' ? args[0] : args[0]?.name) };
    }
  });
}

function explainForApp(err, name) {
  let host;
  try {
    host = name ? loadHosts()[name] : undefined;
  } catch {
    /* hosts file unreadable; explain without it */
  }
  if (process.env.SWIFTSTREAM_DEBUG) console.error(err);
  return explainError(err, { name, host, publicKey: loadOrCreateIdentity().publicKeyString });
}

// ---- identity & hosts -------------------------------------------------------

handle('identity', () => {
  const { publicKeyString } = loadOrCreateIdentity();
  return { publicKey: publicKeyString, fingerprint: keyFingerprint(publicKeyString) };
});

handle('hosts:list', () =>
  Object.entries(loadHosts()).map(([name, h]) => ({
    name,
    address: new URL(h.url).host,
    ssh: h.ssh || null,
    sshPort: h.sshPort || null,
    group: h.group || null,
  })),
);

handle('hosts:probe', async (address) => {
  const probe = await probeHost(address);
  probes.set(probe.url, probe);
  return { url: probe.url, fingerprint: probe.fingerprint };
});

handle('hosts:trust', (name, url) => {
  validateHostName(name);
  const probe = probes.get(url);
  if (!probe) throw new Error('Connect to the server again before trusting it.');
  saveProbedHost(name, probe);
  probes.delete(url);
  dropClient(name);
});

const savedPort = (name) => {
  const host = loadHosts()[name];
  return host ? Number(new URL(host.url).port) || undefined : undefined;
};

handle('hosts:deploy', async ({ name, target, sshPort, password }) => {
  dropClient(name);
  const { info } = await deployHost({
    name,
    target,
    sshPort: sshPort || undefined,
    port: savedPort(name),
    // Used for this one login (and sudo, if Node.js must be installed). Never stored.
    password: password || undefined,
    bundlePath: path.join(dirname, 'core', 'swiftstream.cjs'),
    // The SSH host key is remembered on first use; a changed key is refused (see core/deploy.js).
    confirmHostKey: async () => true,
    onStep: (text) => send('deploy:step', { name, text }),
  });
  return info;
});

handle('hosts:update', (name, changes) => {
  const newName = updateHost(name, changes);
  if (newName !== name) {
    dropClient(name);
    renameInState(name, newName);
  }
  dropClient(newName); // the address may have changed
  return newName;
});

handle('hosts:remove', (name) => {
  dropClient(name);
  for (const [id, t] of terminals) if (t.host === name) t.channel.close(), terminals.delete(id);
  removeHost(name);
});

handle('hosts:info', (name) => withClient(name, (c) => c.request('GET', '/v1/info')));

// ---- files ------------------------------------------------------------------

handle('fs:ls', (name, dir) => withClient(name, (c) => c.request('GET', '/v1/ls', { query: { path: dir || '.' } })));
handle('fs:mkdir', (name, dir) => withClient(name, (c) => c.request('POST', '/v1/mkdir', { body: { path: dir } })));
handle('fs:rename', (name, from, to) => withClient(name, (c) => c.request('POST', '/v1/rename', { body: { from, to } })));
handle('fs:rm', (name, p) => withClient(name, (c) => c.request('POST', '/v1/rm', { body: { path: p } })));

// ---- this computer's files (the left pane) -----------------------------------

const DRIVES = '::drives'; // Windows "This PC": the list of drive letters

function listDrives() {
  const entries = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(root)) entries.push({ name: root, path: root, isDirectory: true, size: 0, mtime: 0 });
  }
  return { path: DRIVES, label: 'This PC', parent: null, entries };
}

handle('local:ls', async (dir) => {
  if (dir === DRIVES) return listDrives();
  const target = path.resolve(dir || app.getPath('home'));
  const names = await fsp.readdir(target, { withFileTypes: true }).catch((err) => {
    throw Object.assign(new Error(`Can't open ${target}`), { code: err.code, path: target });
  });
  const entries = [];
  for (const ent of names) {
    const full = path.join(target, ent.name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) continue; // unreadable or broken link
    entries.push({ name: ent.name, path: full, isDirectory: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(target);
  return { path: target, parent: parent !== target ? parent : process.platform === 'win32' ? DRIVES : null, entries };
});

handle('local:open', (p) => shell.openPath(p));
handle('local:rename', async (from, to) => {
  if (await fsp.stat(to).catch(() => null)) throw new Error(`Something called ${path.basename(to)} is already there.`);
  await fsp.rename(from, to);
});
handle('local:trash', (p) => shell.trashItem(p)); // Recycle Bin, so a local delete can be undone
handle('local:mkdir', (p) => fsp.mkdir(p, { recursive: true }));
handle('local:special', () => ({ home: app.getPath('home'), downloads: app.getPath('downloads'), desktop: app.getPath('desktop'), drives: process.platform === 'win32' ? DRIVES : null }));

// ---- remembered app state: open tabs, last folders, upload destinations ------

const STATE_FILE = path.join(paths.dir, 'app-state.json');
const loadState = () => readJson(STATE_FILE, {});
function renameInState(from, to) {
  const st = loadState();
  st.tabs = (st.tabs || []).map((t) => (t.host === from ? { ...t, host: to } : t));
  if (st.remoteCwd?.[from]) (st.remoteCwd[to] = st.remoteCwd[from]), delete st.remoteCwd[from];
  if (st.uploadSpots?.[from]) (st.uploadSpots[to] = st.uploadSpots[from]), delete st.uploadSpots[from];
  writeJson(STATE_FILE, st);
}
handle('state:get', () => loadState());
handle('state:set', (patch) => {
  const st = { ...loadState(), ...patch };
  writeJson(STATE_FILE, st);
  return st;
});

handle('dialog:pick', async (kind) => {
  const result = await dialog.showOpenDialog(win, {
    title: kind === 'folder' ? 'Choose a folder to upload' : 'Choose files to upload',
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

handle('shell:reveal', (p) => shell.showItemInFolder(p));
handle('clipboard:write', (text) => clipboard.writeText(text));

// ---- transfers --------------------------------------------------------------

/** Progress meter compatible with core/transfer.js that reports to the window (throttled). */
function jobMeter(id, total) {
  let done = 0;
  let last = 0;
  const report = () => send('transfer:progress', { id, done, total });
  return {
    add(n) {
      done += n;
      if (Date.now() - last > 120) {
        last = Date.now();
        report();
      }
    },
    finish: report,
    stop() {},
  };
}

function startJob({ name, label, direction, total, run }) {
  const id = nextId++;
  send('transfer:start', { id, host: name, label, direction, total });
  (async () => {
    try {
      const meter = jobMeter(id, total);
      const revealPath = await withClient(name, (c) => run(c, meter));
      meter.finish();
      send('transfer:done', { id, revealPath });
    } catch (err) {
      send('transfer:done', { id, error: explainForApp(err, name) });
    }
  })();
  return id;
}

const sizeOf = (files) => files.reduce((sum, f) => sum + f.size, 0);
const describe = (names) => (names.length === 1 ? names[0] : `${names.length} items`);

handle('transfer:upload', async (name, localPaths, remoteDir) => {
  getHostOrExplain(name);
  const items = [];
  for (const p of localPaths) {
    const st = await fsp.stat(p);
    items.push({ path: p, isDirectory: st.isDirectory(), size: st.isDirectory() ? sizeOf(await walk(p)) : st.size });
  }
  return startJob({
    name,
    direction: 'up',
    label: describe(items.map((i) => path.basename(i.path))),
    total: sizeOf(items),
    run: async (client, meter) => {
      for (const item of items) {
        if (item.isDirectory) await pushDir(client, item.path, `${remoteDir}/${path.basename(item.path)}`, { meter });
        else await push(client, item.path, `${remoteDir}/`, { meter });
      }
    },
  });
});

handle('transfer:download', async (name, remoteItems, targetDir) => {
  getHostOrExplain(name);
  // SWIFTSTREAM_DOWNLOAD_DIR skips the folder picker (used by automated UI checks).
  const choice = targetDir
    ? { canceled: false, filePaths: [targetDir] }
    : !app.isPackaged && process.env.SWIFTSTREAM_DOWNLOAD_DIR
    ? { canceled: false, filePaths: [process.env.SWIFTSTREAM_DOWNLOAD_DIR] }
    : await dialog.showOpenDialog(win, {
        title: 'Download to…',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      });
  if (choice.canceled) return null;
  const localDir = choice.filePaths[0];
  let total = 0;
  for (const item of remoteItems) {
    total += item.isDirectory
      ? sizeOf((await withClient(name, (c) => c.request('GET', '/v1/list', { query: { path: item.path } }))).files)
      : item.size;
  }
  return startJob({
    name,
    direction: 'down',
    label: describe(remoteItems.map((i) => i.name)),
    total,
    run: async (client, meter) => {
      for (const item of remoteItems) {
        if (item.isDirectory) await pullDir(client, item.path, path.join(localDir, remoteBasename(item.path)), { meter });
        else await pull(client, item.path, localDir, { meter });
      }
      return path.join(localDir, remoteBasename(remoteItems[0].path));
    },
  });
});

// ---- open a server file in a local app, upload it back when saved -------------

const editRoot = path.join(app.getPath('temp'), 'Swiftstream', 'open');
const watched = new Map(); // local path -> { host, remotePath, watcher, timer, mtime }

function findEditors() {
  const editors = [];
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const vscode = [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), ...programFiles.map((p) => path.join(p, 'Microsoft VS Code', 'Code.exe'))].find((p) => fs.existsSync(p));
  if (vscode) editors.push({ id: 'vscode', label: 'VS Code', path: vscode });
  const notepadpp = programFiles.map((p) => path.join(p, 'Notepad++', 'notepad++.exe')).find((p) => fs.existsSync(p));
  if (notepadpp) editors.push({ id: 'notepadpp', label: 'Notepad++', path: notepadpp });
  if (process.platform === 'win32') editors.push({ id: 'notepad', label: 'Notepad', path: 'notepad.exe' });
  return editors;
}

function watchForSaves(localPath, host, remotePath) {
  watched.get(localPath)?.watcher.close();
  const entry = { host, remotePath, timer: null, mtime: fs.statSync(localPath).mtimeMs };
  // Editors save in bursts (truncate, write, rename): wait for the file to settle, then upload once.
  entry.watcher = fs.watch(path.dirname(localPath), (_event, file) => {
    if (file !== path.basename(localPath)) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      const st = await fsp.stat(localPath).catch(() => null);
      if (!st || st.mtimeMs === entry.mtime || !(loadState().settings?.uploadOnSave ?? true)) return;
      entry.mtime = st.mtimeMs;
      send('edit', { status: 'saving', host, path: remotePath });
      try {
        await withClient(host, (c) => push(c, localPath, remotePath, { meter: { add() {}, finish() {}, stop() {} } }));
        send('edit', { status: 'saved', host, path: remotePath });
      } catch (err) {
        send('edit', { status: 'error', host, path: remotePath, error: explainForApp(err, host) });
      }
    }, 700);
  });
  watched.set(localPath, entry);
}

handle('edit:apps', () => findEditors().map(({ id, label }) => ({ id, label })));

/** Download a server file to a temp copy, open it, and watch it so saves go back to the server. */
handle('edit:open', async (name, remotePath, appId = 'default') => {
  getHostOrExplain(name);
  const dir = path.join(editRoot, name.replace(/[^\w.-]/g, '_'), crypto.createHash('sha1').update(remotePath).digest('hex').slice(0, 10));
  await fsp.mkdir(dir, { recursive: true });
  const localPath = path.join(dir, remoteBasename(remotePath));
  watched.get(localPath)?.watcher.close(); // don't upload our own download
  await withClient(name, (c) => pull(c, remotePath, localPath, { meter: { add() {}, finish() {}, stop() {} } }));
  if (!app.isPackaged && process.env.SWIFTSTREAM_NO_LAUNCH) {
    // Automated UI checks: download and watch, but don't open an app on the desktop.
  } else if (appId === 'choose' && process.platform === 'win32') {
    spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', localPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (appId !== 'default') {
    const editor = findEditors().find((e) => e.id === appId);
    if (!editor) throw new Error('That app was not found on this computer.');
    spawn(editor.path, [localPath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const failure = await shell.openPath(localPath);
    if (failure) throw new Error(`Windows couldn't open ${remoteBasename(remotePath)}: ${failure}`);
  }
  watchForSaves(localPath, name, remotePath);
  return { localPath };
});

app.on('will-quit', () => {
  for (const entry of watched.values()) entry.watcher.close();
});

// ---- health: notice a stopped Swiftstream and restart it over SSH ---------------

const DEFAULT_SETTINGS = { autoHeal: true, healthInterval: 30 };
const settings = () => ({ ...DEFAULT_SETTINGS, ...(loadState().settings || {}) });
const healing = new Map(); // name -> { busy, last }
const HEAL_COOLDOWN_MS = 120_000;

async function checkHealth(name) {
  try {
    const info = await withClient(name, (c) => c.request('GET', '/v1/info', { timeout: 8000 }));
    send('health', { name, status: 'up', info });
    return true;
  } catch (err) {
    const host = loadHosts()[name];
    const stopped = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code) || /timed out/.test(err.message);
    send('health', { name, status: 'down', error: explainForApp(err, name) });
    if (stopped && host?.ssh && settings().autoHeal) heal(name);
    return false;
  }
}

/** Log in with this computer's key (authorized at setup) and start Swiftstream again. Never asks for a password. */
async function heal(name) {
  const st = healing.get(name) || { busy: false, last: 0 };
  if (st.busy || Date.now() - st.last < HEAL_COOLDOWN_MS) return;
  st.busy = true;
  st.last = Date.now();
  healing.set(name, st);
  send('health', { name, status: 'healing' });
  try {
    const host = loadHosts()[name];
    dropClient(name);
    const { info } = await deployHost({
      name,
      target: host.ssh,
      sshPort: host.sshPort,
      port: savedPort(name),
      bundlePath: path.join(dirname, 'core', 'swiftstream.cjs'),
      confirmHostKey: async () => false, // unattended: only servers whose SSH key we already know
    });
    send('health', { name, status: 'healed', info });
  } catch (err) {
    send('health', { name, status: 'heal-failed', error: explainForApp(err, name) });
  } finally {
    st.busy = false;
  }
}

let healthTimer = null;
let healthRound = 0;
function scheduleHealth() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(async () => {
    healthRound++;
    const hosts = Object.keys(loadHosts());
    const open = new Set((loadState().tabs || []).map((t) => t.host));
    // Open servers every round; the rest every fifth round.
    const due = hosts.filter((n) => open.has(n) || healthRound % 5 === 0);
    await Promise.all(due.map((n) => checkHealth(n).catch(() => {})));
    scheduleHealth();
  }, Math.max(10, Number(settings().healthInterval) || 30) * 1000);
}
handle('health:check', (name) => checkHealth(name));
handle('health:heal', async (name) => {
  healing.delete(name); // a manual request skips the cooldown
  await heal(name);
});

// ---- terminals --------------------------------------------------------------

handle('term:open', async (name, cols, rows) => {
  const client = await withClient(name, async (c) => {
    await c.request('GET', '/v1/info'); // fail fast with a clear error before opening the socket
    return c;
  });
  const id = nextId++;
  const channel = openChannel(client, { pty: true, cols, rows });
  const decoder = new StringDecoder('utf8'); // don't split multi-byte characters across frames
  terminals.set(id, { channel, host: name });
  channel.on('hello', (msg) => send('term:hello', id, { pty: msg.pty, platform: msg.platform }));
  channel.on('data', (_stream, data) => send('term:data', id, decoder.write(data)));
  channel.on('exit', (code) => {
    terminals.delete(id);
    send('term:exit', id, code);
  });
  channel.on('error', (err) => send('term:error', id, explainForApp(err, name)));
  return id;
});

ipcMain.on('term:write', (_e, id, data) => terminals.get(id)?.channel.write(data));
ipcMain.on('term:resize', (_e, id, cols, rows) => terminals.get(id)?.channel.resize(cols, rows));
ipcMain.on('term:close', (_e, id) => terminals.get(id)?.channel.close());

// ---- window -----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 520,
    title: 'Swiftstream',
    backgroundColor: '#0e1013',
    autoHideMenuBar: true,
    icon: path.join(dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('app-command', (_e, command) => {
    if (command === 'browser-backward') send('nav', 'back');
    if (command === 'browser-forward') send('nav', 'forward');
  });
  win.loadFile(path.join(dirname, 'renderer', 'index.html'));

  // Headless screenshot mode, used to check the UI during development:
  // SWIFTSTREAM_SHOT=out.png [SWIFTSTREAM_SHOT_JS=script.js] [SWIFTSTREAM_SHOT_WAIT=ms]. Disabled in packaged builds.
  if (!app.isPackaged && process.env.SWIFTSTREAM_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      await sleep(600);
      if (process.env.SWIFTSTREAM_SHOT_JS) {
        const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.SWIFTSTREAM_SHOT_JS, 'utf8'));
        if (result !== undefined) console.log('shot script result:', JSON.stringify(result));
      }
      await sleep(Number(process.env.SWIFTSTREAM_SHOT_WAIT) || 1200);
      fs.writeFileSync(process.env.SWIFTSTREAM_SHOT, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  scheduleHealth();
});
app.on('window-all-closed', () => {
  for (const c of clients.values()) c.close();
  app.quit();
});

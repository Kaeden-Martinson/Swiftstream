import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import updater from 'electron-updater';
import { connectClient } from './core/client.js';
import { loadHosts, paths, readJson, writeJson } from './core/config.js';
import { explainError } from './core/errors.js';
import { deployHost, getHostOrExplain, probeHost, removeHost, saveProbedHost, updateHost, validateHostName } from './core/hosts.js';
import { keyFingerprint, loadOrCreateIdentity } from './core/keys.js';
import { openChannel } from './core/shell.js';
import { pull, pullDir, push, pushDir, remoteBasename } from './core/transfer.js';
import { walk } from './core/util.js';
import { VERSION, isOlderVersion } from './core/version.js';
import { readSshConfig, sshTarget } from './core/sshconfig.js';
import { createLog } from './log.js';

const dirname = import.meta.dirname;
// In Swiftstream's data folder (~/.swiftstream/logs), beside the servers and keys it describes.
const log = createLog(() => path.join(paths.dir, 'logs'));
// Crashes and stray promise rejections go in the log; Electron still handles them as usual.
process.on('uncaughtExceptionMonitor', (err) => log.error('uncaught exception', err?.stack || String(err)));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason?.stack || String(reason)));
let win = null;

// Windows groups and pins taskbar buttons by this ID. It matches build.appId in package.json, which the
// installer gives its Start menu shortcut, so a pinned button keeps the Swiftstream name and logo.
const APP_ID = 'dev.swiftstream.desktop';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

/** Name, icon and launch command Windows uses for a pinned taskbar button. */
function setTaskbarDetails() {
  if (process.platform !== 'win32') return;
  win.setAppDetails({
    appId: APP_ID,
    // The installed exe carries the icon; a source checkout (electron.exe) points at the .ico instead.
    appIconPath: app.isPackaged ? process.execPath : path.join(dirname, 'build', 'icon.ico'),
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
    relaunchDisplayName: 'Swiftstream',
  });
}
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
      log.warn(`${channel} failed`, { message: err.message, code: err.code, status: err.status });
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

/** Hosts in ~/.ssh/config that aren't saved yet, for "From your SSH config" on the Servers page. */
handle('sshconfig:list', () => {
  const hosts = loadHosts();
  const known = new Set(Object.values(hosts).map((h) => h.ssh));
  return readSshConfig()
    .filter((e) => !hosts[e.alias] && !known.has(sshTarget(e)))
    .map((e) => ({ alias: e.alias, target: sshTarget(e), port: e.port, identityFile: e.identityFile }));
});

// Questions for the person at the window during setup (a key's passphrase). Answers aren't stored.
const pendingAsks = new Map();
let askSeq = 0;
function askWindow(kind, payload) {
  return new Promise((resolve) => {
    const id = ++askSeq;
    pendingAsks.set(id, resolve);
    send('ask', { id, kind, ...payload });
  });
}
ipcMain.on('ask:answer', (_e, id, value) => {
  pendingAsks.get(id)?.(typeof value === 'string' ? value : null);
  pendingAsks.delete(id);
});

handle('hosts:deploy', async ({ name, target, sshPort, password, identityFile }) => {
  dropClient(name);
  const { info } = await deployHost({
    name,
    target,
    sshPort: sshPort || undefined,
    port: savedPort(name),
    // Used for this one login (and sudo, if Node.js must be installed). Never stored.
    password: password || undefined,
    identityFile: identityFile || undefined, // IdentityFile from ~/.ssh/config, tried first
    askPassphrase: ({ file, attempt }) => askWindow('passphrase', { file, attempt, target }),
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

handle('hosts:info', async (name) => {
  const info = await withClient(name, (c) => c.request('GET', '/v1/info'));
  noteHealth(name, 'up', { version: info?.version });
  return info;
});
// The computers allowed to log in to a server, and revoking one (servers from 0.1.2 on).
handle('hosts:computers', async (name) => {
  try {
    return (await withClient(name, (c) => c.request('GET', '/v1/keys'))).keys;
  } catch (err) {
    if (err.status === 404) return null; // an older server: the app offers to update it
    throw err;
  }
});
handle('hosts:revoke', (name, fingerprint) => withClient(name, (c) => c.request('POST', '/v1/keys/revoke', { body: { fingerprint } })));

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
  if (patch.settings) applyTheme();
  return st;
});

// Light or dark: 'system' follows Windows. Setting it here also themes the title bar, menus and
// scrollbars, and the page picks it up through prefers-color-scheme (see renderer/js/theme.js).
function applyTheme() {
  const theme = loadState().settings?.theme;
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
  updateWindowColors();
}
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#0e1013' : '#f7f8fa');
// The minimize / maximize / close buttons sit on the tab bar, so they take its colors (--bg-deep, --text-2).
const TAB_BAR_HEIGHT = 45; // the 46px bar minus its bottom border
const titleBarOverlay = () => ({
  color: nativeTheme.shouldUseDarkColors ? '#0b0d10' : '#eceef2',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#a3aab6' : '#434a56',
  height: TAB_BAR_HEIGHT,
});
function updateWindowColors() {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(windowBackground());
  if (process.platform !== 'darwin') win.setTitleBarOverlay(titleBarOverlay());
}
// With "System", Windows switching between light and dark changes the buttons too.
nativeTheme.on('updated', updateWindowColors);

handle('dialog:pick', async (kind) => {
  const result = await dialog.showOpenDialog(win, {
    title: kind === 'folder' ? 'Choose a folder to upload' : 'Choose files to upload',
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

handle('shell:reveal', (p) => shell.showItemInFolder(p));
handle('clipboard:write', (text) => clipboard.writeText(text));
handle('clipboard:read', () => clipboard.readText()); // terminal right-click › Paste

// ---- transfers --------------------------------------------------------------

// A job is one upload or download the user started. It can be paused (its partial files stay, so
// resuming continues), canceled (partial files are removed), and retried after it fails or is canceled.
// Finished jobs are kept in a short history (transfers.json) for the Recent transfers list.
const jobs = new Map(); // id -> job, for this run of the app
const HISTORY_FILE = path.join(paths.dir, 'transfers.json');
const HISTORY_MAX = 50;
let history = readJson(HISTORY_FILE, []);

const ENDED = ['done', 'failed', 'canceled'];
function snapshot(job) {
  return {
    id: job.id,
    host: job.name,
    label: job.label,
    direction: job.direction,
    total: job.total,
    done: job.done,
    state: job.state, // running | paused | canceling | done | failed | canceled
    error: job.error || null,
    revealPath: job.revealPath || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    canRetry: job.state === 'failed' || job.state === 'canceled',
  };
}
const publish = (job) => send('transfer:update', snapshot(job));

function remember(job) {
  const { canRetry: _retry, ...entry } = snapshot(job);
  history = [entry, ...history.filter((h) => h.id !== job.id)].slice(0, HISTORY_MAX);
  writeJson(HISTORY_FILE, history);
}

/** Progress meter compatible with core/transfer.js that reports to the window (throttled). */
function jobMeter(job) {
  job.done = 0;
  let last = 0;
  const report = () => send('transfer:progress', { id: job.id, done: job.done, total: job.total });
  return {
    add(n) {
      job.done += n;
      if (Date.now() - last > 120) {
        last = Date.now();
        report();
      }
    },
    finish: report,
    stop() {},
  };
}

/** Run (or resume) a job. A controller that's already canceled just cleans up an earlier run's files. */
async function runJob(job, controller = new AbortController()) {
  job.controller = controller;
  job.state = controller.signal.aborted ? 'canceling' : 'running';
  job.error = null;
  publish(job);
  log.info(`transfer ${job.state}`, { id: job.id, host: job.name, direction: job.direction, label: job.label, bytes: job.total });
  const meter = jobMeter(job);
  try {
    job.revealPath = await withClient(job.name, (c) => job.run(c, meter, controller.signal));
    meter.finish();
    job.state = 'done';
  } catch (err) {
    const reason = controller.signal.aborted ? controller.signal.reason : null;
    if (reason === 'pause') job.state = 'paused';
    else if (reason === 'cancel') job.state = 'canceled';
    else {
      job.state = 'failed';
      job.error = explainForApp(err, job.name);
    }
  }
  if (ENDED.includes(job.state)) {
    job.finishedAt = Date.now();
    remember(job);
  }
  log[job.state === 'failed' ? 'warn' : 'info'](`transfer ${job.state}`, { id: job.id, host: job.name, done: job.done, error: job.error?.message });
  publish(job);
}

function startJob({ name, label, direction, total, run }) {
  const job = { id: `${Date.now().toString(36)}-${nextId++}`, name, label, direction, total, run, done: 0, startedAt: Date.now() };
  jobs.set(job.id, job);
  runJob(job);
  return job.id;
}

handle('transfer:pause', (id) => {
  const job = jobs.get(id);
  if (job?.state === 'running') job.controller.abort('pause');
});
handle('transfer:resume', (id) => {
  const job = jobs.get(id);
  if (job?.state === 'paused') runJob(job);
});
handle('transfer:cancel', (id) => {
  const job = jobs.get(id);
  if (job?.state === 'running') job.controller.abort('cancel');
  else if (job?.state === 'paused') {
    const controller = new AbortController();
    controller.abort('cancel');
    runJob(job, controller); // removes what the paused run left behind
  }
});
// Retry starts over from what's already there: completed files are skipped, partial ones resume.
handle('transfer:retry', (id) => {
  const job = jobs.get(id);
  if (job?.state === 'failed' || job?.state === 'canceled') {
    job.finishedAt = null;
    runJob(job);
  }
});
handle('transfer:list', () => {
  const live = [...jobs.values()].map(snapshot);
  const liveIds = new Set(live.map((j) => j.id));
  return [...live.filter((j) => !ENDED.includes(j.state)), ...history.filter((h) => !liveIds.has(h.id)).map((h) => ({ ...h, canRetry: false })), ...live.filter((j) => ENDED.includes(j.state))]
    .sort((a, b) => (b.finishedAt || Infinity) - (a.finishedAt || Infinity) || b.startedAt - a.startedAt)
    .slice(0, HISTORY_MAX);
});
handle('transfer:clear', () => {
  history = [];
  writeJson(HISTORY_FILE, history);
  for (const [id, job] of jobs) if (ENDED.includes(job.state)) jobs.delete(id);
});

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
    run: async (client, meter, signal) => {
      for (const item of items) {
        if (item.isDirectory) await pushDir(client, item.path, `${remoteDir}/${path.basename(item.path)}`, { meter, signal });
        else await push(client, item.path, `${remoteDir}/`, { meter, signal });
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
    run: async (client, meter, signal) => {
      for (const item of remoteItems) {
        if (item.isDirectory) await pullDir(client, item.path, path.join(localDir, remoteBasename(item.path)), { meter, signal });
        else await pull(client, item.path, localDir, { meter, signal });
      }
      return path.join(localDir, remoteBasename(remoteItems[0].path));
    },
  });
});

// ---- open a server file in a local app, upload it back when saved -------------

const editRoot = path.join(app.getPath('temp'), 'Swiftstream', 'open');
const watched = new Map(); // local path -> { host, remotePath, watcher, timer, mtime }

/** Editors for "Open with": [{ id, label, path, args }] (spawned as path ...args file). */
function findEditors() {
  if (process.platform === 'darwin') {
    const apps = [['vscode', 'VS Code', 'Visual Studio Code'], ['sublime', 'Sublime Text', 'Sublime Text'], ['textedit', 'TextEdit', 'TextEdit']];
    const has = (name) => name === 'TextEdit' || ['/Applications', path.join(os.homedir(), 'Applications')].some((d) => fs.existsSync(path.join(d, `${name}.app`)));
    return apps.filter(([, , name]) => has(name)).map(([id, label, name]) => ({ id, label, path: 'open', args: ['-a', name] }));
  }
  if (process.platform !== 'win32') {
    const onPath = (cmd) => (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, cmd)));
    return [['vscode', 'VS Code', 'code'], ['sublime', 'Sublime Text', 'subl'], ['gedit', 'Text Editor', 'gedit'], ['kate', 'Kate', 'kate']]
      .filter(([, , cmd]) => onPath(cmd))
      .map(([id, label, cmd]) => ({ id, label, path: cmd, args: [] }));
  }
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
    spawn(editor.path, [...(editor.args || []), localPath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const failure = await shell.openPath(localPath);
    if (failure) throw new Error(`Couldn't open ${remoteBasename(remotePath)}: ${failure}`);
  }
  watchForSaves(localPath, name, remotePath);
  return { localPath };
});

app.on('will-quit', () => {
  for (const entry of watched.values()) entry.watcher.close();
});

// ---- health: notice a stopped Swiftstream and restart it over SSH ---------------

const DEFAULT_SETTINGS = { autoHeal: true, healthInterval: 30, autoUpdate: true, updateServers: true };
const settings = () => ({ ...DEFAULT_SETTINGS, ...(loadState().settings || {}) });
const healing = new Map(); // name -> { busy, last }
const HEAL_COOLDOWN_MS = 120_000;

const lastHealth = new Map(); // name -> 'up' | 'down', to log changes rather than every check
function noteHealth(name, status, details) {
  if (lastHealth.get(name) === status) return;
  lastHealth.set(name, status);
  log[status === 'up' ? 'info' : 'warn'](`server ${name} ${status}`, details);
}

async function checkHealth(name) {
  try {
    const info = await withClient(name, (c) => c.request('GET', '/v1/info', { timeout: 8000 }));
    send('health', { name, status: 'up', info });
    noteHealth(name, 'up', { version: info?.version });
    maybeUpdateServer(name, info);
    return true;
  } catch (err) {
    const host = loadHosts()[name];
    const stopped = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(err.code) || /timed out/.test(err.message);
    send('health', { name, status: 'down', error: explainForApp(err, name) });
    noteHealth(name, 'down', { message: err.message, code: err.code });
    if (stopped && host?.ssh && settings().autoHeal) heal(name);
    return false;
  }
}

/** Log in with this computer's key (authorized at setup) and start Swiftstream again. Never asks for a password. */
const heal = (name) => redeployUnattended(name, { cooldown: HEAL_COOLDOWN_MS, statuses: ['healing', 'healed', 'heal-failed'] });

// ---- servers running an older Swiftstream than this app are updated the same way ----------------
// Updating restarts the server, which ends its open terminals, so it waits until none are open.
const UPDATE_RETRY_MS = 30 * 60 * 1000;
const updateNoticeShown = new Set();
function maybeUpdateServer(name, info) {
  const host = loadHosts()[name];
  if (!host?.ssh || !info?.version || !isOlderVersion(info.version, VERSION) || settings().updateServers === false) return;
  const terminalOpen = [...terminals.values()].some((t) => t.host === name);
  if (!terminalOpen) {
    redeployUnattended(name, { cooldown: UPDATE_RETRY_MS, statuses: ['updating', 'updated', 'update-failed'], extra: { from: info.version, to: VERSION } });
  } else if (!updateNoticeShown.has(name)) {
    updateNoticeShown.add(name);
    send('health', { name, status: 'outdated', from: info.version, to: VERSION });
  }
}

async function redeployUnattended(name, { cooldown, statuses: [busy, done, failed], extra = {} }) {
  const st = healing.get(name) || { busy: false, last: 0 };
  if (st.busy || Date.now() - st.last < cooldown) return;
  st.busy = true;
  st.last = Date.now();
  healing.set(name, st);
  send('health', { name, status: busy, ...extra });
  log.info(`server ${name} ${busy}`, extra);
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
    send('health', { name, status: done, info, ...extra });
    log.info(`server ${name} ${done}`, { version: info?.version });
  } catch (err) {
    send('health', { name, status: failed, error: explainForApp(err, name), ...extra });
    log.warn(`server ${name} ${failed}`, { message: err.message, code: err.code });
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
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    // No system title bar: the tab bar is the title bar, with the window buttons drawn on it.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: titleBarOverlay() }),
    icon: path.join(dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Screenshot runs during development: keep painting even when the window is in the background.
      backgroundThrottling: app.isPackaged || !process.env.SWIFTSTREAM_SHOT,
    },
  });
  setTaskbarDetails();
  win.webContents.on('render-process-gone', (_e, details) => log.error('window crashed', details));
  win.webContents.on('console-message', (e, ...legacy) => {
    // Electron passes an event with the details; older versions passed (level, message, line, source).
    const level = e.level ?? legacy[0];
    if (level === 'error' || level === 3) log.error('page error', { message: e.message ?? legacy[1], source: e.sourceId ?? legacy[3], line: e.lineNumber ?? legacy[2] });
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
  // If the script returns { input: [...] }, those are sent as real mouse events (sendInputEvent, plus
  // { wait: ms } pauses), then SWIFTSTREAM_SHOT_AFTER (a script) runs and its result is printed.
  if (!app.isPackaged && process.env.SWIFTSTREAM_SHOT) {
    // Mid-script screenshots: api.devShot(name) saves <SWIFTSTREAM_SHOT_DIR>/<name>.png.
    ipcMain.handle('dev:shot', async (_e, name) => {
      const dir = process.env.SWIFTSTREAM_SHOT_DIR || path.dirname(process.env.SWIFTSTREAM_SHOT);
      fs.writeFileSync(path.join(dir, `${String(name).replace(/[^\w-]/g, '')}.png`), (await win.webContents.capturePage()).toPNG());
      return { ok: true };
    });
    win.webContents.once('did-finish-load', async () => {
      await sleep(600);
      if (process.env.SWIFTSTREAM_SHOT_JS) {
        const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.SWIFTSTREAM_SHOT_JS, 'utf8')).catch((err) => {
          console.log('shot script error:', err.message); // still take the screenshot and quit
        });
        if (result !== undefined) console.log('shot script result:', JSON.stringify(result));
        for (const step of result?.input || []) {
          if (step.wait) await sleep(step.wait);
          else win.webContents.sendInputEvent(step);
          await sleep(16);
        }
        if (process.env.SWIFTSTREAM_SHOT_AFTER) {
          const after = await win.webContents.executeJavaScript(fs.readFileSync(process.env.SWIFTSTREAM_SHOT_AFTER, 'utf8'));
          console.log('shot after result:', JSON.stringify(after));
        }
      }
      await sleep(Number(process.env.SWIFTSTREAM_SHOT_WAIT) || 1200);
      fs.writeFileSync(process.env.SWIFTSTREAM_SHOT, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
}

// ---- updates: download new versions from GitHub Releases in the background --------

const { autoUpdater } = updater;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
let updateState = { state: app.isPackaged ? 'idle' : 'dev', current: app.getVersion(), version: null, percent: 0, error: null };
const setUpdateState = (patch) => {
  updateState = { ...updateState, ...patch };
  send('update', updateState);
};

function checkForUpdates({ quiet = true } = {}) {
  if (!app.isPackaged) return setUpdateState({ state: 'dev' });
  if (['checking', 'downloading', 'ready'].includes(updateState.state)) return;
  autoUpdater.checkForUpdates().catch((err) => {
    // Offline or GitHub unreachable: say so only when the user asked.
    setUpdateState({ state: quiet ? 'idle' : 'error', error: quiet ? null : err.message });
  });
}

function setUpUpdates() {
  if (!app.isPackaged) return;
  // macOS only installs updates for a signed app; until the Mac build is signed, updates are manual.
  if (process.platform === 'darwin') return setUpdateState({ state: 'manual' });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // a downloaded update also installs when you quit
  autoUpdater.on('checking-for-update', () => setUpdateState({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setUpdateState({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdateState({ state: 'current' }));
  autoUpdater.on('download-progress', (p) => setUpdateState({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    log.info('update downloaded', info.version);
    setUpdateState({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    log.warn('update check failed', err.message);
    setUpdateState({ state: updateState.state === 'checking' ? 'idle' : 'error', error: err.message });
  });
  const auto = () => settings().autoUpdate !== false && checkForUpdates();
  setTimeout(auto, 10_000);
  setInterval(auto, UPDATE_CHECK_MS).unref();
}

handle('update:state', () => updateState);
handle('update:check', () => checkForUpdates({ quiet: false }));
handle('update:install', () => {
  if (updateState.state === 'ready') setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silent, then relaunch
});

// One app at a time: opening it again (Start menu, taskbar, "swiftstream app") brings the window back.
// Screenshot runs during development are exempt so they can run beside your open app.
const isShot = !app.isPackaged && !!process.env.SWIFTSTREAM_SHOT;
const firstInstance = isShot || app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// ---- diagnostics: the log, and a summary to paste into a bug report -------------

handle('diag:openLogs', () => shell.openPath(log.dir()));
handle('diag:summary', async () => {
  const hosts = loadHosts();
  const lines = await Promise.all(
    Object.entries(hosts).map(async ([name, h]) => {
      let server = '';
      try {
        const info = await withClient(name, (c) => c.request('GET', '/v1/info', { timeout: 5000 }));
        server = `up, Swiftstream ${info.version} on ${info.platform}${info.pty ? '' : ', basic terminal'}`;
      } catch (err) {
        server = `not reachable (${err.code || err.message})`;
      }
      return `  ${name}: ${new URL(h.url).host}${h.ssh ? ` (SSH ${h.ssh})` : ''}, ${server}`;
    }),
  );
  const s = settings();
  return [
    'Swiftstream diagnostics',
    `App ${app.getVersion()} (Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node})`,
    `System ${os.type()} ${os.release()} ${process.arch}, ${app.getLocale()}`,
    `Installed ${app.isPackaged ? 'from the installer' : 'from source'}; updates ${updateState.state}`,
    `Settings: theme ${s.theme || 'system'}, auto-restart ${s.autoHeal}, keep servers updated ${s.updateServers}, check every ${s.healthInterval}s`,
    `Servers (${lines.length}):`,
    ...(lines.length ? lines : ['  none']),
    '',
    'Recent log:',
    ...log.tail(120).map((l) => `  ${l}`),
  ].join('\n');
});

app.whenReady().then(() => {
  if (!firstInstance) return;
  // macOS needs an app menu: without an Edit menu, Cmd+C / Cmd+V / Cmd+A don't work in text fields.
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  log.info('Swiftstream started', { version: app.getVersion(), electron: process.versions.electron, system: `${os.type()} ${os.release()} ${process.arch}`, packaged: app.isPackaged });
  applyTheme();
  createWindow();
  setUpUpdates();
  scheduleHealth();
});
app.on('window-all-closed', () => {
  for (const c of clients.values()) c.close();
  app.quit();
});

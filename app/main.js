import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { connectClient } from './core/client.js';
import { loadHosts } from './core/config.js';
import { explainError } from './core/errors.js';
import { deployHost, getHostOrExplain, probeHost, removeHost, saveProbedHost, validateHostName } from './core/hosts.js';
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
  if (process.env.SWIFTSSH_DEBUG) console.error(err);
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

handle('hosts:deploy', async ({ name, target, sshPort }) => {
  dropClient(name);
  const { info } = await deployHost({ name, target, sshPort: sshPort || undefined, batch: true });
  return info;
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

handle('transfer:download', async (name, remoteItems) => {
  getHostOrExplain(name);
  // SWIFTSSH_DOWNLOAD_DIR skips the folder picker (used by automated UI checks).
  const choice = !app.isPackaged && process.env.SWIFTSSH_DOWNLOAD_DIR
    ? { canceled: false, filePaths: [process.env.SWIFTSSH_DOWNLOAD_DIR] }
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
    title: 'SwiftSSH',
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
  win.loadFile(path.join(dirname, 'renderer', 'index.html'));

  // Headless screenshot mode, used to check the UI during development:
  // SWIFTSSH_SHOT=out.png [SWIFTSSH_SHOT_JS=script.js] [SWIFTSSH_SHOT_WAIT=ms]. Disabled in packaged builds.
  if (!app.isPackaged && process.env.SWIFTSSH_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      await sleep(600);
      if (process.env.SWIFTSSH_SHOT_JS) {
        const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.SWIFTSSH_SHOT_JS, 'utf8'));
        if (result !== undefined) console.log('shot script result:', JSON.stringify(result));
      }
      await sleep(Number(process.env.SWIFTSSH_SHOT_WAIT) || 1200);
      fs.writeFileSync(process.env.SWIFTSSH_SHOT, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const c of clients.values()) c.close();
  app.quit();
});

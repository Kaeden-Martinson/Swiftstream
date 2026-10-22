// Bridge between the sandboxed UI and the main process. The UI gets this narrow API and no Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args); // resolves to { ok, value } | { ok: false, error }
const on = (channel) => (callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('swift', {
  platform: process.platform, // 'win32' | 'darwin' | 'linux': wording, shortcuts, window layout
  identity: () => call('identity'),
  hosts: {
    list: () => call('hosts:list'),
    probe: (address) => call('hosts:probe', address),
    trust: (name, url) => call('hosts:trust', name, url),
    deploy: (opts) => call('hosts:deploy', opts),
    onDeployStep: on('deploy:step'),
    remove: (name) => call('hosts:remove', name),
    update: (name, changes) => call('hosts:update', name, changes),
    info: (name) => call('hosts:info', name),
    autoUpdate: (name, on) => call('hosts:autoUpdate', name, on),
    sshConfig: () => call('sshconfig:list'),
    computers: (name) => call('hosts:computers', name),
    revoke: (name, fingerprint) => call('hosts:revoke', name, fingerprint),
  },
  files: {
    ls: (name, dir) => call('fs:ls', name, dir),
    mkdir: (name, dir) => call('fs:mkdir', name, dir),
    rename: (name, from, to) => call('fs:rename', name, from, to),
    rm: (name, p) => call('fs:rm', name, p),
    localRename: (from, to) => call('local:rename', from, to),
    localTrash: (p) => call('local:trash', p),
    localMkdir: (p) => call('local:mkdir', p),
    pick: (kind) => call('dialog:pick', kind),
    pathFor: (file) => webUtils.getPathForFile(file),
    reveal: (p) => call('shell:reveal', p),
    localLs: (dir) => call('local:ls', dir),
    localOpen: (p) => call('local:open', p),
    localSpecial: () => call('local:special'),
  },
  transfers: {
    upload: (name, localPaths, remoteDir) => call('transfer:upload', name, localPaths, remoteDir),
    download: (name, items, targetDir) => call('transfer:download', name, items, targetDir),
    pause: (id) => call('transfer:pause', id),
    resume: (id) => call('transfer:resume', id),
    cancel: (id) => call('transfer:cancel', id),
    retry: (id) => call('transfer:retry', id),
    list: () => call('transfer:list'),
    clear: () => call('transfer:clear'),
    onUpdate: on('transfer:update'),
    onProgress: on('transfer:progress'),
  },
  term: {
    open: (name, cols, rows) => call('term:open', name, cols, rows),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    close: (id) => ipcRenderer.send('term:close', id),
    onHello: on('term:hello'),
    onData: on('term:data'),
    onExit: on('term:exit'),
    onError: on('term:error'),
  },
  copy: (text) => call('clipboard:write', text),
  readClipboard: () => call('clipboard:read'),
  diagnostics: { summary: () => call('diag:summary'), openLogs: () => call('diag:openLogs') },
  onAsk: on('ask'),
  answer: (id, value) => ipcRenderer.send('ask:answer', id, value),
  state: { get: () => call('state:get'), set: (patch) => call('state:set', patch) },
  onNav: on('nav'),
  devShot: (name) => call('dev:shot', name), // development screenshot runs only (see main.js)
  edit: { open: (name, remotePath, appId) => call('edit:open', name, remotePath, appId), apps: () => call('edit:apps'), onEvent: on('edit') },
  health: { check: (name) => call('health:check', name), heal: (name) => call('health:heal', name), onEvent: on('health') },
  updates: { state: () => call('update:state'), check: () => call('update:check'), install: () => call('update:install'), onState: on('update') },
});

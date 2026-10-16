// Bridge between the sandboxed UI and the main process. The UI gets this narrow API and no Node access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args); // resolves to { ok, value } | { ok: false, error }
const on = (channel) => (callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('swift', {
  identity: () => call('identity'),
  hosts: {
    list: () => call('hosts:list'),
    probe: (address) => call('hosts:probe', address),
    trust: (name, url) => call('hosts:trust', name, url),
    deploy: (opts) => call('hosts:deploy', opts),
    onDeployStep: on('deploy:step'),
    remove: (name) => call('hosts:remove', name),
    info: (name) => call('hosts:info', name),
  },
  files: {
    ls: (name, dir) => call('fs:ls', name, dir),
    mkdir: (name, dir) => call('fs:mkdir', name, dir),
    pick: (kind) => call('dialog:pick', kind),
    pathFor: (file) => webUtils.getPathForFile(file),
    reveal: (p) => call('shell:reveal', p),
  },
  transfers: {
    upload: (name, localPaths, remoteDir) => call('transfer:upload', name, localPaths, remoteDir),
    download: (name, items) => call('transfer:download', name, items),
    onStart: on('transfer:start'),
    onProgress: on('transfer:progress'),
    onDone: on('transfer:done'),
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
});

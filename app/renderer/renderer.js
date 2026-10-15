/* global Terminal, FitAddon */
'use strict';

const api = window.swift;
const $ = (id) => document.getElementById(id);

/** Unwrap an IPC result, throwing an Error that keeps the friendly message, hint and action. */
async function call(promise) {
  const result = await promise;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), result.error);
}

const state = {
  hosts: [],
  selected: null,
  views: new Map(), // host name -> { tab, cwd, listing, selection, term, status, info }
};

function view(name) {
  if (!state.views.has(name)) {
    state.views.set(name, { tab: 'terminal', cwd: null, listing: null, selection: new Set(), term: null, status: 'unknown', info: null });
  }
  return state.views.get(name);
}

// ---------- formatting ----------

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 100 ? 1 : 0)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};
const icon = (pathData) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = pathData;
  return svg;
};
const FOLDER_ICON = '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor" opacity=".85"/>';
const FILE_ICON = '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/>';

// ---------- host list ----------

async function loadHosts(selectName) {
  state.hosts = await call(api.hosts.list());
  renderHostList();
  if (selectName) selectHost(selectName);
  else if (state.selected && !state.hosts.some((h) => h.name === state.selected)) selectHost(null);
  else if (!state.selected && state.hosts.length) selectHost(state.hosts[0].name);
  else renderMain();
}

function renderHostList() {
  const list = $('host-list');
  list.replaceChildren(
    ...state.hosts.map((h) => {
      const v = view(h.name);
      const item = el(
        'li',
        { className: `host-item${h.name === state.selected ? ' active' : ''}`, tabIndex: 0, title: h.ssh ? `${h.address}, set up via ${h.ssh}` : h.address },
        el('span', { className: `dot ${v.status === 'up' ? 'up' : v.status === 'down' ? 'down' : ''}` }),
        el('div', { className: 'meta' }, el('div', { className: 'name', textContent: h.name }), el('div', { className: 'addr', textContent: h.address })),
      );
      item.addEventListener('click', () => selectHost(h.name));
      item.addEventListener('keydown', (e) => e.key === 'Enter' && selectHost(h.name));
      return item;
    }),
  );
}

function currentHost() {
  return state.hosts.find((h) => h.name === state.selected) || null;
}

async function selectHost(name) {
  state.selected = name;
  renderHostList();
  renderMain();
  if (name) await checkHost(name);
}

async function checkHost(name) {
  const v = view(name);
  hideBanner();
  try {
    v.info = await call(api.hosts.info(name));
    v.status = 'up';
  } catch (err) {
    v.status = 'down';
    if (state.selected === name) showBanner(err);
  }
  renderHostList();
  if (state.selected !== name) return;
  renderHeader();
  if (v.status === 'up') showTab(v.tab);
}

// ---------- main area ----------

function renderMain() {
  const host = currentHost();
  $('empty').hidden = !!host;
  $('host-view').hidden = !host;
  if (!host) return;
  renderHeader();
  const v = view(host.name);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === v.tab);
  $('terminal-pane').hidden = v.tab !== 'terminal';
  $('files-pane').hidden = v.tab !== 'files';
  for (const termEl of document.querySelectorAll('#terminal-pane > .term')) termEl.hidden = termEl.dataset.host !== host.name;
}

function renderHeader() {
  const host = currentHost();
  if (!host) return;
  const v = view(host.name);
  $('host-name').textContent = host.name;
  const parts = [host.address];
  if (v.info) parts.push(`${v.info.hostname} · ${platformName(v.info.platform)} · swiftssh ${v.info.version}`);
  $('host-sub').textContent = parts.join('  ·  ');
}

const platformName = (p) => ({ linux: 'Linux', darwin: 'macOS', win32: 'Windows', freebsd: 'FreeBSD' })[p] || p;

function showTab(tab) {
  const host = currentHost();
  if (!host) return;
  const v = view(host.name);
  v.tab = tab;
  renderMain();
  if (v.status !== 'up') return;
  if (tab === 'terminal') ensureTerminal(host.name);
  else if (!v.listing) openDir(host.name, v.cwd || '');
  else renderFiles();
}

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));

// ---------- error banner ----------

let bannerAction = null;
function showBanner(err) {
  $('banner').hidden = false;
  $('banner-message').textContent = err.message;
  const host = currentHost();
  bannerAction = err.action === 'redeploy' && host?.ssh ? () => redeploy(host) : null;
  // The CLI hint names a command; in the app the button does it.
  $('banner-hint').textContent = bannerAction ? `SwiftSSH can log in to ${host.ssh} over SSH and start it again.` : err.hint || '';
  $('banner-action').hidden = !bannerAction;
  $('banner-action').textContent = 'Start server again';
}

function hideBanner() {
  $('banner').hidden = true;
}

$('banner-retry').addEventListener('click', () => state.selected && checkHost(state.selected));
$('banner-action').addEventListener('click', () => bannerAction?.());

async function redeploy(host) {
  const button = $('banner-action');
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    await call(api.hosts.deploy({ name: host.name, target: host.ssh, sshPort: host.sshPort }));
    await checkHost(host.name);
  } catch (err) {
    showBanner(err);
  } finally {
    button.disabled = false;
  }
}

// ---------- terminal ----------

const terminals = new Map(); // terminal id -> host name

function ensureTerminal(name) {
  const v = view(name);
  if (v.term) {
    requestAnimationFrame(() => fitTerminal(v.term));
    v.term.xterm.focus();
    return;
  }
  const container = el('div', { className: 'term' });
  container.dataset.host = name;
  $('terminal-pane').append(container);
  const xterm = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, Menlo, monospace",
    fontSize: 13.5,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: {
      background: '#0e1013',
      foreground: '#e7e9ec',
      cursor: '#3ddc97',
      cursorAccent: '#0e1013',
      selectionBackground: '#2b4a3d',
      black: '#1b1f26', brightBlack: '#5d6574',
      red: '#ff7a7a', brightRed: '#ff9c9c',
      green: '#3ddc97', brightGreen: '#6fe8b4',
      yellow: '#f5c35b', brightYellow: '#f8d488',
      blue: '#6aa8ff', brightBlue: '#94c0ff',
      magenta: '#d68cff', brightMagenta: '#e3adff',
      cyan: '#4fd6e0', brightCyan: '#82e4eb',
      white: '#c9ced6', brightWhite: '#ffffff',
    },
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(container);
  v.term = { xterm, fit, id: null, pty: true, line: '', container };
  // Ctrl+Shift+C / Ctrl+Shift+V copy and paste, like other terminals on Windows and Linux.
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const text = xterm.getSelection();
      if (text) api.copy(text);
      return false;
    }
    return true;
  });
  xterm.onData((data) => onTerminalInput(v.term, data));
  xterm.onResize(({ cols, rows }) => v.term.id && api.term.resize(v.term.id, cols, rows));
  requestAnimationFrame(() => {
    fitTerminal(v.term);
    startSession(name);
    xterm.focus();
  });
}

function fitTerminal(term) {
  try {
    term.fit.fit();
  } catch {
    /* container hidden; fit again when shown */
  }
}

async function startSession(name) {
  const term = view(name).term;
  term.xterm.write('\x1b[2mConnecting…\x1b[0m\r\n');
  try {
    term.id = await call(api.term.open(name, term.xterm.cols, term.xterm.rows));
    terminals.set(term.id, name);
  } catch (err) {
    term.xterm.write(`\x1b[31m${err.message}\x1b[0m\r\n${err.hint ? `\x1b[2m${err.hint.replace(/\n/g, '\r\n')}\x1b[0m\r\n` : ''}`);
    term.ended = true;
    term.xterm.write('\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n');
  }
}

function onTerminalInput(term, data) {
  if (term.ended) {
    if (data === '\r') {
      term.ended = false;
      term.xterm.reset();
      startSession(term.container.dataset.host);
    }
    return;
  }
  if (!term.id) return;
  if (term.pty) return api.term.write(term.id, data);

  // The server has no PTY (node-pty not installed there), so do simple line editing here.
  for (const ch of data) {
    if (ch === '\r') {
      term.xterm.write('\r\n');
      api.term.write(term.id, `${term.line}\n`);
      term.line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (term.line) {
        term.line = term.line.slice(0, -1);
        term.xterm.write('\b \b');
      }
    } else if (ch >= ' ') {
      term.line += ch;
      term.xterm.write(ch);
    }
  }
}

api.term.onHello((id, { pty }) => {
  const name = terminals.get(id);
  if (!name) return;
  const term = view(name).term;
  term.pty = pty;
  term.xterm.reset();
  if (!pty) {
    term.xterm.options.convertEol = true;
    term.xterm.write('\x1b[2mBasic terminal: full-screen programs like vim won\'t work. Install node-pty on the server for a full terminal.\x1b[0m\r\n');
  }
});
api.term.onData((id, data) => {
  const name = terminals.get(id);
  if (name) view(name).term.xterm.write(data);
});
api.term.onExit((id, code) => {
  const name = terminals.get(id);
  if (!name) return;
  terminals.delete(id);
  const term = view(name).term;
  term.id = null;
  term.ended = true;
  term.xterm.write(`\r\n\x1b[2mSession ended${code ? ` (exit ${code})` : ''}. Press Enter to start a new one.\x1b[0m\r\n`);
});
api.term.onError((id, err) => {
  const name = terminals.get(id);
  if (name) view(name).term.xterm.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`);
});

new ResizeObserver(() => {
  const host = currentHost();
  const term = host && view(host.name).term;
  if (term && !$('terminal-pane').hidden) fitTerminal(term);
}).observe($('terminal-pane'));

// ---------- files ----------

async function openDir(name, dir) {
  const v = view(name);
  try {
    v.listing = await call(api.files.ls(name, dir));
    v.cwd = v.listing.path;
    v.selection.clear();
    hideBanner();
  } catch (err) {
    showBanner(err);
  }
  if (state.selected === name) renderFiles();
}

function renderFiles() {
  const host = currentHost();
  if (!host) return;
  const v = view(host.name);
  const listing = v.listing;
  if (!listing) return;
  renderCrumbs(host.name, listing.path);
  $('files-up').disabled = !listing.parent;
  $('files-empty').hidden = listing.entries.length > 0;
  $('drop-target').textContent = listing.path;
  $('files-download').disabled = v.selection.size === 0;
  $('files-download').textContent = v.selection.size > 1 ? `Download ${v.selection.size}` : 'Download';

  $('file-rows').replaceChildren(
    ...listing.entries.map((entry) => {
      const row = el(
        'tr',
        { className: v.selection.has(entry.name) ? 'selected' : '' },
        el('td', {}, el('span', { className: `file-name${entry.isDirectory ? ' dir' : ''}` }, icon(entry.isDirectory ? FOLDER_ICON : FILE_ICON), entry.name)),
        el('td', { className: 'num muted', textContent: entry.isDirectory ? '' : formatBytes(entry.size) }),
        el('td', { className: 'muted', textContent: dateFmt.format(entry.mtime) }),
      );
      row.addEventListener('click', (e) => {
        if (!(e.ctrlKey || e.metaKey)) v.selection.clear();
        if (v.selection.has(entry.name) && (e.ctrlKey || e.metaKey)) v.selection.delete(entry.name);
        else v.selection.add(entry.name);
        renderFiles();
      });
      row.addEventListener('dblclick', () => {
        if (entry.isDirectory) openDir(host.name, joinRemote(listing.path, entry.name));
        else download(host.name, [entry]);
      });
      return row;
    }),
  );
}

/** Join onto a path the server gave us, using its separator style. */
function joinRemote(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function renderCrumbs(name, fullPath) {
  const windows = /^[A-Za-z]:/.test(fullPath);
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  const crumbs = [];
  let acc = windows ? '' : '/';
  if (!windows) crumbs.push(['/', '/']);
  parts.forEach((part, i) => {
    acc = windows ? (i === 0 ? `${part}\\` : joinRemote(acc, part)) : joinRemote(acc, part);
    crumbs.push([part, acc]);
  });
  // Long paths: keep the last few levels visible.
  const shown = crumbs.length > 5 ? [crumbs[0], ['…', null], ...crumbs.slice(-3)] : crumbs;
  $('crumbs').replaceChildren(
    ...shown.flatMap(([label, target], i) => {
      const btn = el('button', { textContent: label, disabled: !target });
      if (target) btn.addEventListener('click', () => openDir(name, target));
      return i === 0 ? [btn] : [el('span', { className: 'sep', textContent: '›' }), btn];
    }),
  );
}

function selectedEntries(name) {
  const v = view(name);
  return v.listing.entries.filter((e) => v.selection.has(e.name));
}

async function download(name, entries) {
  const v = view(name);
  const items = entries.map((e) => ({ name: e.name, path: joinRemote(v.listing.path, e.name), isDirectory: e.isDirectory, size: e.size }));
  try {
    await call(api.transfers.download(name, items));
  } catch (err) {
    showBanner(err);
  }
}

async function upload(name, localPaths) {
  const v = view(name);
  if (!localPaths.length || !v.listing) return;
  try {
    await call(api.transfers.upload(name, localPaths, v.listing.path));
  } catch (err) {
    showBanner(err);
  }
}

$('files-up').addEventListener('click', () => {
  const host = currentHost();
  const listing = host && view(host.name).listing;
  if (listing?.parent) openDir(host.name, listing.parent);
});
$('files-home').addEventListener('click', () => currentHost() && openDir(currentHost().name, '~'));
$('files-refresh').addEventListener('click', () => {
  const host = currentHost();
  if (host) openDir(host.name, view(host.name).cwd || '');
});
$('files-download').addEventListener('click', () => {
  const host = currentHost();
  if (host) download(host.name, selectedEntries(host.name));
});
$('files-upload').addEventListener('click', async () => {
  const host = currentHost();
  if (host) upload(host.name, await call(api.files.pick('files')));
});
$('files-upload-dir').addEventListener('click', async () => {
  const host = currentHost();
  if (host) upload(host.name, await call(api.files.pick('folder')));
});
$('files-mkdir').addEventListener('click', async () => {
  const host = currentHost();
  if (!host) return;
  const folder = await prompt({ title: 'New folder', text: `Create a folder in ${view(host.name).cwd}`, value: '', ok: 'Create' });
  if (!folder) return;
  try {
    await call(api.files.mkdir(host.name, joinRemote(view(host.name).cwd, folder)));
    openDir(host.name, view(host.name).cwd);
  } catch (err) {
    showBanner(err);
  }
});

// Drag and drop from the desktop into the file list uploads to the open folder.
let dragDepth = 0;
const fileArea = $('file-area');
fileArea.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
fileArea.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
fileArea.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop-overlay').hidden = true;
  }
});
fileArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const host = currentHost();
  if (host) upload(host.name, [...e.dataTransfer.files].map((f) => api.files.pathFor(f)).filter(Boolean));
});
// Dropping anywhere else must not navigate the window to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- transfers ----------

const jobs = new Map();

api.transfers.onStart(({ id, host, label, direction, total }) => {
  const bar = el('div');
  const status = el('div', { className: 'job-status' }, el('span', { textContent: 'Starting…' }), el('span'));
  const close = el('button', { className: 'job-close', title: 'Dismiss', textContent: '×' });
  const card = el(
    'div',
    { className: 'job' },
    el('div', { className: 'job-top' }, el('span', { className: 'job-dir', textContent: direction === 'up' ? '↑' : '↓' }), el('span', { className: 'job-label', textContent: label }), close),
    el('div', { className: 'job-bar' }, bar),
    status,
  );
  close.addEventListener('click', () => {
    card.remove();
    jobs.delete(id);
  });
  $('transfers').prepend(card);
  jobs.set(id, { card, bar, status, total, host, direction, started: performance.now() });
});

api.transfers.onProgress(({ id, done, total }) => {
  const job = jobs.get(id);
  if (!job) return;
  const secs = Math.max((performance.now() - job.started) / 1000, 0.001);
  job.bar.style.width = `${total ? Math.min(100, (done / total) * 100) : 100}%`;
  job.status.firstChild.textContent = `${formatBytes(done)} of ${formatBytes(total)}`;
  job.status.lastChild.textContent = `${formatBytes(done / secs)}/s`;
});

api.transfers.onDone(({ id, error, revealPath }) => {
  const job = jobs.get(id);
  if (!job) return;
  const secs = (performance.now() - job.started) / 1000;
  if (error) {
    job.card.classList.add('failed');
    job.status.firstChild.textContent = 'Failed';
    job.status.lastChild.textContent = '';
    job.card.append(el('div', { className: 'job-error', textContent: `${error.message}${error.hint ? ` ${error.hint}` : ''}` }));
    return;
  }
  job.bar.style.width = '100%';
  job.status.firstChild.textContent = `Done in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
  job.status.lastChild.textContent = '';
  if (revealPath) {
    const show = el('button', { textContent: 'Show in folder' });
    show.addEventListener('click', () => api.files.reveal(revealPath));
    job.status.lastChild.append(show);
  } else if (state.selected === job.host) {
    openDir(job.host, view(job.host).cwd); // refresh so the upload appears
  }
  setTimeout(() => {
    if (!revealPath && jobs.has(id)) {
      job.card.remove();
      jobs.delete(id);
    }
  }, 6000);
});

// ---------- dialogs ----------

function prompt({ title, text, value, ok, input = true }) {
  const dialog = $('prompt-dialog');
  $('prompt-title').textContent = title;
  $('prompt-text').textContent = text || '';
  $('prompt-field').hidden = !input;
  $('prompt-input').value = value || '';
  $('prompt-ok').textContent = ok || 'OK';
  dialog.showModal();
  if (input) $('prompt-input').focus();
  return new Promise((resolve) => {
    const finish = (result) => {
      $('prompt-form').removeEventListener('submit', onSubmit);
      $('prompt-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      finish(input ? $('prompt-input').value.trim() : true);
    };
    const onCancel = (e) => {
      e?.preventDefault();
      finish(null);
    };
    $('prompt-form').addEventListener('submit', onSubmit);
    $('prompt-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
  });
}

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    await api.copy($(btn.dataset.copy).textContent);
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = old), 1200);
  });
}

$('show-key').addEventListener('click', async () => {
  const id = await call(api.identity());
  $('key-text').textContent = id.publicKey;
  $('key-fingerprint').textContent = id.fingerprint;
  $('key-dialog').showModal();
});

$('remove-host').addEventListener('click', async () => {
  const host = currentHost();
  if (!host) return;
  const yes = await prompt({
    title: `Remove ${host.name}?`,
    text: 'SwiftSSH forgets this server. Nothing on the server is changed, and you can add it again later.',
    ok: 'Remove',
    input: false,
  });
  if (!yes) return;
  await call(api.hosts.remove(host.name));
  const v = state.views.get(host.name);
  v?.term?.xterm.dispose();
  v?.term?.container.remove();
  state.views.delete(host.name);
  state.selected = null;
  await loadHosts();
});

// ---------- add server ----------

const addForm = $('add-form');
let addStep = 'form'; // form -> trust -> authorize (direct mode only)
let probed = null;

function addMode() {
  return addForm.elements.mode.value;
}

function resetAddDialog() {
  addForm.reset();
  addStep = 'form';
  probed = null;
  syncAddDialog();
  setAddBusy(null);
  setAddError(null);
}

function syncAddDialog() {
  const mode = addMode();
  for (const section of addForm.querySelectorAll('[data-mode]')) section.hidden = section.dataset.mode !== mode || addStep !== 'form';
  addForm.querySelector('.segmented').hidden = addStep !== 'form';
  $('add-trust').hidden = addStep !== 'trust';
  $('add-authorize').hidden = addStep !== 'authorize';
  $('add-submit').textContent = { form: mode === 'ssh' ? 'Set up server' : 'Connect', trust: 'It matches, trust it', authorize: 'Done' }[addStep];
  $('add-cancel').hidden = addStep === 'authorize';
}

function setAddError(err) {
  const box = $('add-error');
  box.hidden = !err;
  if (err) box.replaceChildren(el('b', { textContent: err.message }), ...(err.hint ? [el('div', { className: 'hint', textContent: err.hint })] : []));
}

function setAddBusy(text) {
  $('add-progress').hidden = !text;
  $('add-progress-text').textContent = text || '';
  $('add-submit').disabled = !!text;
  for (const input of addForm.querySelectorAll('input')) input.disabled = !!text;
}

function suggestName(address) {
  const host = address.split('@').pop().split(':')[0];
  return /^[\d.]+$/.test(host) ? 'server' : host.split('.')[0].replace(/[^\w.-]/g, '');
}

addForm.addEventListener('change', (e) => {
  if (e.target.name === 'mode') {
    setAddError(null);
    syncAddDialog();
  }
});
addForm.elements.target.addEventListener('input', (e) => (addForm.elements.name.placeholder = suggestName(e.target.value) || 'prod'));
addForm.elements.address.addEventListener('input', (e) => (addForm.elements.directName.placeholder = suggestName(e.target.value) || 'home-server'));

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setAddError(null);
  const f = addForm.elements;
  try {
    if (addMode() === 'ssh') {
      const target = f.target.value.trim();
      const name = f.name.value.trim() || suggestName(target);
      if (!target) throw { message: 'Enter the SSH login you use for this server.', hint: 'For example ubuntu@203.0.113.7' };
      setAddBusy(`Logging in to ${target} and starting SwiftSSH. The first time can take a minute while npm downloads it.`);
      await call(api.hosts.deploy({ name, target, sshPort: f.sshPort.value.trim() || null }));
      $('add-dialog').close();
      await loadHosts(name);
    } else if (addStep === 'form') {
      const address = f.address.value.trim();
      if (!address) throw { message: "Enter the server's address." };
      setAddBusy(`Connecting to ${address}…`);
      probed = { ...(await call(api.hosts.probe(address))), name: f.directName.value.trim() || suggestName(address) };
      $('add-fingerprint').textContent = probed.fingerprint;
      addStep = 'trust';
    } else if (addStep === 'trust') {
      await call(api.hosts.trust(probed.name, probed.url));
      const id = await call(api.identity());
      $('add-authorize-cmd').textContent = `swiftssh authorize "${id.publicKey}"`;
      addStep = 'authorize';
    } else {
      $('add-dialog').close();
      await loadHosts(probed.name);
    }
  } catch (err) {
    setAddError(err);
  } finally {
    setAddBusy(null);
    syncAddDialog();
  }
});

$('add-cancel').addEventListener('click', () => $('add-dialog').close());
for (const id of ['add-host', 'empty-add']) {
  $(id).addEventListener('click', () => {
    resetAddDialog();
    $('add-dialog').showModal();
    addForm.elements.target.focus();
  });
}

// ---------- start ----------

loadHosts().catch((err) => showBanner(err));

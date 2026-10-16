'use strict';
// Shared helpers and app state. The renderer is split into plain scripts that share one
// global scope, loaded in order by index.html (util, dialogs, transfers, terminal, files,
// home, workspace, start).

const api = window.swift;
const $ = (id) => document.getElementById(id);

/** Unwrap an IPC result, throwing an Error that keeps the friendly message, hint and action. */
async function call(promise) {
  const result = await promise;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), result.error);
}

const state = {
  hosts: [], // [{ name, address, ssh, sshPort, group }]
  status: new Map(), // name -> 'checking' | 'up' | 'down'
  info: new Map(), // name -> server info from /v1/info
  tabs: [], // session ids, in tab order
  sessions: new Map(), // id -> { id, host, kind: 'terminal' | 'files', term, remote pane }
  activeTab: null, // the session shown when page is 'session'
  page: 'home', // 'home' | 'settings' | 'session'
  saved: {}, // persisted app state (see main.js "state:*")
};

const hostByName = (name) => state.hosts.find((h) => h.name === name) || null;



/** Persist part of the app state (debounced so rapid navigation doesn't write constantly). */
let saveTimer;
function saveState(patch) {
  Object.assign(state.saved, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => call(api.state.set(state.saved)).catch(() => {}), 250);
}

// ---------- DOM ----------

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child != null && child !== false) node.append(child);
  return node;
};

/** An icon from the sprite in index.html. */
function icon(id, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.append(use);
  return svg;
}

/** A shimmering placeholder bar, shown while something loads. */
const skeleton = (width, className = '') => el('span', { className: `sk ${className}`.trim(), style: `width:${width}` });

/** Restart a one-shot CSS animation class on an element. */
function replayAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.replaceChildren(icon('check'), el('span', { textContent: text }));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
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
const platformName = (p) => ({ linux: 'Linux', darwin: 'macOS', win32: 'Windows', freebsd: 'FreeBSD' })[p] || p;

// ---------- paths (local Windows/POSIX and remote) ----------

const DRIVES = '::drives';
const isWinPath = (p) => /^[A-Za-z]:/.test(p);

/** Join onto a path, using that path's separator style. */
function joinPath(dir, name) {
  const sep = isWinPath(dir) || (dir.includes('\\') && !dir.includes('/')) ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function dirnameOf(p) {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return p;
  const dir = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(dir)) return `${dir}\\`;
  return dir || '/';
}

const basenameOf = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** Windows paths compare case-insensitively. */
const pathKey = (p) => (isWinPath(p) ? p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '') : p.replace(/\/+$/, '') || '/');

/** Breadcrumbs: [{ label, target }], with "This PC" first for Windows local paths. */
function crumbsFor(fullPath, { local = false } = {}) {
  if (fullPath === DRIVES) return [{ label: 'This PC', target: DRIVES }];
  const crumbs = [];
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  if (isWinPath(fullPath)) {
    if (local) crumbs.push({ label: 'This PC', target: DRIVES });
    let acc = '';
    parts.forEach((part, i) => {
      acc = i === 0 ? `${part}\\` : joinPath(acc, part);
      crumbs.push({ label: part, target: acc });
    });
  } else {
    crumbs.push({ label: '/', target: '/' });
    let acc = '/';
    for (const part of parts) {
      acc = joinPath(acc, part);
      crumbs.push({ label: part, target: acc });
    }
  }
  return crumbs;
}

'use strict';
// Files view: this computer on the left, the server on the right. Each pane has its own
// back/forward history. Drag between panes (or in from Explorer) to transfer.

function newPane(side, host = null) {
  return { side, host, cwd: null, listing: null, selection: new Set(), anchor: null, history: [], hIndex: -1, request: 0, loading: false, animate: false, error: null, filter: '' };
}

const localPane = newPane('local');
let lastPaneSide = 'remote'; // which pane mouse back/forward and Alt+arrows act on
let drag = null; // a drag that started on one of our rows: { side, host, items, fromDir }

const paneRoot = (side) => $(`${side}-pane`);
const part = (side, name) => paneRoot(side).querySelector(`[data-part="${name}"]`);
const action = (side, name) => paneRoot(side).querySelector(`[data-act="${name}"]`);
const activeRemote = () => {
  const session = activeSession();
  return session?.kind === 'files' ? session.remote : null;
};
const paneFor = (side) => (side === 'local' ? localPane : activeRemote());
const filesShown = () => !!activeRemote();
const isShown = (pane) => filesShown() && (pane.side === 'local' || pane === activeRemote());

// ---------- navigation ----------

async function navigate(pane, dir, { push = true } = {}) {
  const request = ++pane.request;
  // Only show the skeleton if the folder takes a moment; fast loads shouldn't flicker.
  const skeletonTimer = setTimeout(() => {
    if (pane.request !== request) return;
    pane.loading = true;
    renderPane(pane);
  }, 120);
  try {
    const listing = pane.side === 'local' ? await call(api.files.localLs(dir)) : await call(api.files.ls(pane.host, dir));
    if (pane.request !== request) return; // navigated elsewhere meanwhile
    const sameFolder = pane.cwd && pathKey(pane.cwd) === pathKey(listing.path);
    pane.listing = listing;
    pane.cwd = listing.path;
    pane.error = null;
    if (!sameFolder) {
      pane.selection.clear();
      pane.anchor = null;
      pane.animate = true;
    }
    if (push && pane.history[pane.hIndex] !== listing.path) {
      pane.history = pane.history.slice(0, pane.hIndex + 1);
      pane.history.push(listing.path);
      pane.hIndex = pane.history.length - 1;
    }
    if (pane.side === 'local') saveState({ localCwd: listing.path });
    else {
      saveState({ remoteCwd: { ...(state.saved.remoteCwd || {}), [pane.host]: listing.path } });
      hideBanner();
    }
  } catch (err) {
    if (pane.request !== request) return;
    if (pane.side === 'remote') showBanner(err);
    else toast(err.message);
    pane.error = err.message;
  } finally {
    clearTimeout(skeletonTimer);
    if (pane.request === request) pane.loading = false;
  }
  renderPane(pane);
  updateSpotHint();
}

function goBack(pane) {
  if (!pane || pane.hIndex <= 0) return;
  pane.hIndex--;
  navigate(pane, pane.history[pane.hIndex], { push: false });
}

function goForward(pane) {
  if (!pane || pane.hIndex >= pane.history.length - 1) return;
  pane.hIndex++;
  navigate(pane, pane.history[pane.hIndex], { push: false });
}

function goUp(pane) {
  if (pane?.listing?.parent) navigate(pane, pane.listing.parent);
}

const refreshPane = (pane) => pane?.cwd && navigate(pane, pane.cwd, { push: false });

/** Called when a files tab is shown: open the server's last folder (or home). */
function openFilesFor(session) {
  const name = session.host;
  const remote = session.remote;
  if (!localPane.listing && !localPane.loading) navigate(localPane, state.saved.localCwd || '');
  else renderPane(localPane);
  if (!remote.listing) {
    const last = state.saved.remoteCwd?.[name];
    navigate(remote, last || '').then(() => {
      if (!remote.listing && last) navigate(remote, ''); // the remembered folder is gone
    });
  } else renderPane(remote);
  updateSpotHint();
}

// ---------- rendering ----------

/** Entries after the "show hidden files" setting and the pane's filter box. */
function visibleEntries(pane) {
  const showHidden = settings().showHidden;
  const q = pane.filter.trim().toLowerCase();
  return (pane.listing?.entries || []).filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
}

function selectedEntries(pane) {
  return visibleEntries(pane).filter((e) => pane.selection.has(e.name));
}

function entryPath(pane, entry) {
  return entry.path || joinPath(pane.cwd, entry.name);
}

function renderPane(pane) {
  if (!pane || !isShown(pane)) return;
  const { side } = pane;
  const root = paneRoot(side);
  action(side, 'back').disabled = pane.hIndex <= 0;
  action(side, 'forward').disabled = pane.hIndex >= pane.history.length - 1;
  action(side, 'up').disabled = !pane.listing?.parent;
  if (side === 'remote') part(side, 'title').textContent = pane.host;
  if (part(side, 'filter') !== document.activeElement) part(side, 'filter').value = pane.filter;
  renderCrumbs(pane);

  const tbody = root.querySelector('tbody');
  const empty = part(side, 'empty');
  if (pane.loading) {
    empty.hidden = true;
    tbody.replaceChildren(
      ...['170px', '120px', '210px', '140px', '186px', '100px'].map((w) =>
        el('tr', { className: 'sk-tr' }, el('td', {}, el('span', { className: 'file-name' }, skeleton('15px', 'sk-icon'), skeleton(w))), el('td', { className: 'num' }, skeleton('44px')), el('td', {}, skeleton('104px'))),
      ),
    );
    return;
  }

  const listing = pane.listing;
  const entries = visibleEntries(pane);
  const total = listing?.entries.length || 0;
  const animate = pane.animate;
  pane.animate = false;
  const rows = [];
  if (listing?.parent) {
    // ".." row: double-click to go up; drop onto it to send items to the parent folder.
    const up = el('tr', { className: `parent-row${animate ? ' row-in' : ''}` }, el('td', { colSpan: 3 }, el('span', { className: 'file-name dir' }, icon('folder'), '..')));
    up.dataset.dir = '1';
    up.dataset.path = listing.parent === DRIVES ? '' : listing.parent;
    up.addEventListener('dblclick', () => goUp(pane));
    rows.push(up);
  }
  entries.forEach((entry, index) => {
    const row = el(
      'tr',
      {
        className: `${pane.selection.has(entry.name) ? 'selected' : ''}${animate ? ' row-in' : ''}`,
        draggable: listing.path !== DRIVES,
        style: animate ? `--r:${Math.min(index + 1, 14)}` : '',
      },
      el('td', {}, el('span', { className: `file-name${entry.isDirectory ? ' dir' : ''}` }, icon(listing.path === DRIVES ? 'drive' : entry.isDirectory ? 'folder' : 'file'), entry.name)),
      el('td', { className: 'num muted', textContent: entry.isDirectory ? '' : formatBytes(entry.size) }),
      el('td', { className: 'muted', textContent: entry.mtime ? dateFmt.format(entry.mtime) : '' }),
    );
    if (entry.isDirectory) {
      row.dataset.dir = '1';
      row.dataset.path = entryPath(pane, entry);
    }
    row.addEventListener('click', (e) => selectRow(pane, entry, e));
    row.addEventListener('dblclick', () => openEntry(pane, entry));
    row.addEventListener('dragstart', (e) => startDrag(pane, entry, e));
    row.addEventListener('dragend', endDrag);
    onContextMenu(row, () => {
      if (!pane.selection.has(entry.name)) selectRow(pane, entry, {});
      return rowMenu(pane, entry);
    });
    rows.push(row);
  });
  tbody.replaceChildren(...rows);

  empty.hidden = entries.length > 0 || pane.loading;
  empty.textContent = pane.error && !listing
    ? pane.error
    : total && pane.filter
      ? `Nothing here matches "${pane.filter}".`
      : side === 'remote' ? 'This folder is empty. Drop files here to upload them.' : 'This folder is empty.';

  const selected = selectedEntries(pane);
  const bytes = selected.filter((e) => !e.isDirectory).reduce((sum, e) => sum + e.size, 0);
  part(side, 'foot').textContent = selected.length
    ? `${selected.length} selected${bytes ? ` · ${formatBytes(bytes)}` : ''}`
    : listing ? (entries.length === total ? `${total} item${total === 1 ? '' : 's'}` : `${entries.length} of ${total} items`) : '';
  if (side === 'local') action('local', 'upload').disabled = !selected.length || !activeRemote()?.cwd;
  else action('remote', 'download').disabled = !selected.length;
}

/** Click the empty part of the breadcrumb bar (or Ctrl+L) to type or paste a path. */
function editPath(pane) {
  if (!pane) return;
  const bar = part(pane.side, 'crumbs');
  const input = el('input', { className: 'path-input', value: pane.cwd === DRIVES ? '' : pane.cwd || '', spellcheck: false, ariaLabel: 'Folder path' });
  let done = false;
  const finish = (go) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (go && value) navigate(pane, value);
    else renderCrumbs(pane);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(false));
  bar.replaceChildren(input);
  bar.classList.add('editing');
  input.focus();
  input.select();
}

function renderCrumbs(pane) {
  part(pane.side, 'crumbs').classList.remove('editing');
  const crumbs = pane.cwd ? crumbsFor(pane.cwd, { local: pane.side === 'local' }) : [];
  const shown = crumbs.length > 5 ? [crumbs[0], { label: '…', target: null }, ...crumbs.slice(-3)] : crumbs;
  part(pane.side, 'crumbs').replaceChildren(
    ...shown.flatMap(({ label, target }, i) => {
      const btn = el('button', { type: 'button', textContent: label, disabled: !target, title: target || '' });
      if (target) btn.addEventListener('click', () => navigate(pane, target));
      return i === 0 ? [btn] : [icon('right', 'sep'), btn];
    }),
  );
}

// ---------- selection and opening ----------

function selectRow(pane, entry, e) {
  lastPaneSide = pane.side;
  const names = visibleEntries(pane).map((x) => x.name);
  if (e.shiftKey && pane.anchor && names.includes(pane.anchor)) {
    const [a, b] = [names.indexOf(pane.anchor), names.indexOf(entry.name)].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) pane.selection.clear();
    for (const name of names.slice(a, b + 1)) pane.selection.add(name);
  } else if (e.ctrlKey || e.metaKey) {
    if (pane.selection.has(entry.name)) pane.selection.delete(entry.name);
    else pane.selection.add(entry.name);
    pane.anchor = entry.name;
  } else {
    pane.selection.clear();
    pane.selection.add(entry.name);
    pane.anchor = entry.name;
  }
  renderPane(pane);
}

function openEntry(pane, entry) {
  if (entry.isDirectory) return navigate(pane, entryPath(pane, entry));
  if (pane.side === 'local') return call(api.files.localOpen(entry.path)).catch((err) => toast(err.message));
  return openRemoteFile(pane.host, entryPath(pane, entry));
}

// ---------- open server files in local apps ----------

let editorApps = [];
call(api.edit.apps()).then((apps) => (editorApps = apps)).catch(() => {});

/** Download a server file and open it (default app, a named editor, or the Windows chooser). Saves upload back. */
async function openRemoteFile(host, remotePath, appId = 'default') {
  toast(`Opening ${basenameOf(remotePath)}…`);
  try {
    await call(api.edit.open(host, remotePath, appId));
  } catch (err) {
    showBanner(err);
  }
}

api.edit.onEvent(({ status, host, path, error }) => {
  const name = basenameOf(path);
  if (status === 'saved') toast(`Saved ${name} to ${host}`);
  else if (status === 'error') toast(`Couldn't save ${name} to ${host}: ${error.message}`);
});

// ---------- rename, delete, new folder ----------

function paneError(pane, err) {
  if (pane.side === 'remote') showBanner(err);
  else toast(err.message);
}

async function renameEntry(pane, entry) {
  const name = await prompt({ title: `Rename ${entry.name}`, value: entry.name, ok: 'Rename' });
  if (!name || name === entry.name) return;
  if (/[\\/]/.test(name)) return toast("Names can't contain slashes");
  const from = entryPath(pane, entry);
  const to = joinPath(pane.cwd, name);
  try {
    await call(pane.side === 'local' ? api.files.localRename(from, to) : api.files.rename(pane.host, from, to));
    await refreshPane(pane);
    pane.selection = new Set([name]);
    pane.anchor = name;
    renderPane(pane);
  } catch (err) {
    paneError(pane, err);
  }
}

async function deleteEntries(pane, entries) {
  if (!entries.length) return;
  const what = entries.length === 1 ? entries[0].name : `${entries.length} items`;
  if (pane.side === 'remote') {
    // Server deletes are permanent, so always ask.
    if (!(await confirmDialog(`Delete ${what}?`, `This permanently deletes ${what} from ${pane.host}. It can't be undone.`, 'Delete', true))) return;
  } else if (settings().confirmDelete && !(await confirmDialog(`Move ${what} to the Recycle Bin?`, 'You can restore it from the Recycle Bin.', 'Move to Recycle Bin', true))) {
    return;
  }
  try {
    for (const entry of entries) {
      const p = entryPath(pane, entry);
      await call(pane.side === 'local' ? api.files.localTrash(p) : api.files.rm(pane.host, p));
    }
    toast(pane.side === 'local' ? `Moved ${what} to the Recycle Bin` : `Deleted ${what}`);
  } catch (err) {
    paneError(pane, err);
  }
  await refreshPane(pane);
}

async function newFolder(pane) {
  if (!pane?.cwd || pane.cwd === DRIVES) return;
  const name = await prompt({ title: 'New folder', text: `Create a folder in ${pane.cwd}`, ok: 'Create' });
  if (!name) return;
  try {
    const dir = joinPath(pane.cwd, name);
    await call(pane.side === 'local' ? api.files.localMkdir(dir) : api.files.mkdir(pane.host, dir));
    await refreshPane(pane);
  } catch (err) {
    paneError(pane, err);
  }
}

async function pickAndUpload(kind) {
  const remote = activeRemote();
  if (!remote?.cwd) return;
  const paths = await call(api.files.pick(kind));
  if (paths.length) uploadItems(remote.host, paths, dirnameOf(paths[0]), remote.cwd);
}

// ---------- right-click menus ----------

function rowMenu(pane, entry) {
  const selected = selectedEntries(pane);
  const many = selected.length > 1;
  const path = entryPath(pane, entry);
  const otherFolder = pane.side === 'remote' ? localPane.cwd : activeRemote()?.cwd;
  const items = [];
  if (!many) {
    if (entry.isDirectory) items.push({ label: 'Open', icon: 'folder', hint: 'Enter', run: () => navigate(pane, path) });
    else if (pane.side === 'local') items.push({ label: 'Open', icon: 'file', hint: 'Enter', run: () => openEntry(pane, entry) });
    else {
      items.push({ label: 'Open', icon: 'file', hint: 'Enter', run: () => openRemoteFile(pane.host, path) });
      for (const app of editorApps) items.push({ label: `Open with ${app.label}`, icon: 'external', run: () => openRemoteFile(pane.host, path, app.id) });
      items.push({ label: 'Open with…', icon: 'external', run: () => openRemoteFile(pane.host, path, 'choose') });
      items.push('separator');
    }
  }
  if (pane.side === 'remote') {
    items.push({ label: many ? `Download ${selected.length} items` : 'Download', icon: 'arrow-left', disabled: !otherFolder || otherFolder === DRIVES, run: () => downloadItems(pane.host, selected, localPane.cwd, pane) });
  } else {
    items.push({ label: many ? `Upload ${selected.length} items` : 'Upload', icon: 'arrow-right', disabled: !otherFolder, run: () => uploadItems(activeRemote().host, selected.map((e) => e.path), pane.cwd, activeRemote().cwd) });
  }
  items.push('separator');
  if (!many) items.push({ label: 'Rename…', icon: 'pencil', hint: 'F2', run: () => renameEntry(pane, entry) });
  items.push({ label: pane.side === 'local' ? 'Move to Recycle Bin' : many ? `Delete ${selected.length} items…` : 'Delete…', icon: 'trash', hint: 'Del', danger: true, run: () => deleteEntries(pane, selected) });
  items.push('separator');
  items.push({ label: 'Copy path', icon: 'copy', run: () => (api.copy(path), toast('Path copied')) });
  if (pane.side === 'local') items.push({ label: 'Show in Explorer', icon: 'external', run: () => api.files.reveal(path) });
  if (pane.side === 'remote' && !many) {
    items.push(...actionMenuItems(entry.isDirectory ? 'folder' : 'file', { host: pane.host, path, name: entry.name, dir: pane.cwd }));
  }
  return items;
}

function backgroundMenu(pane) {
  if (!pane?.cwd || pane.cwd === DRIVES) return null;
  const items = [
    { label: 'New folder…', icon: 'folder-plus', run: () => newFolder(pane) },
    { label: 'Refresh', icon: 'refresh', run: () => refreshPane(pane) },
    { label: 'Copy folder path', icon: 'copy', run: () => (api.copy(pane.cwd), toast('Path copied')) },
  ];
  if (pane.side === 'remote') {
    items.push('separator', { label: 'Upload files…', icon: 'up', run: () => pickAndUpload('files') }, { label: 'Upload a folder…', icon: 'up', run: () => pickAndUpload('folder') });
    items.push(...actionMenuItems('folder', { host: pane.host, path: pane.cwd, name: basenameOf(pane.cwd), dir: pane.cwd }));
  } else {
    items.push({ label: 'Open in Explorer', icon: 'external', run: () => api.files.localOpen(pane.cwd) });
  }
  return items;
}

// ---------- transfers ----------

/** Upload local paths, offering the remembered destination for this source folder if it differs. */
async function uploadItems(host, paths, sourceDir, targetDir) {
  if (!paths.length || !targetDir) return;
  const remembered = state.saved.uploadSpots?.[host]?.[pathKey(sourceDir)];
  let dest = targetDir;
  if (remembered && pathKey(remembered) !== pathKey(targetDir)) {
    dest = await chooseDestination({ count: paths.length, sourceDir, remembered, current: targetDir });
    if (!dest) return;
  }
  rememberSpot(host, sourceDir, dest);
  try {
    await call(api.transfers.upload(host, paths, dest));
  } catch (err) {
    showBanner(err);
  }
}

function rememberSpot(host, sourceDir, dest) {
  const all = { ...(state.saved.uploadSpots || {}) };
  all[host] = { ...(all[host] || {}), [pathKey(sourceDir)]: dest };
  saveState({ uploadSpots: all });
  updateSpotHint();
}

async function downloadItems(host, entries, targetDir, fromPane) {
  if (!entries.length) return;
  if (!targetDir || targetDir === DRIVES) return toast('Open a folder on the left first');
  const items = entries.map((e) => ({ name: e.name, path: e.path || joinPath(fromPane.cwd, e.name), isDirectory: e.isDirectory, size: e.size }));
  try {
    await call(api.transfers.download(host, items, targetDir));
  } catch (err) {
    showBanner(err);
  }
}

/** transfers.js calls this when a job finishes, so the pane that changed shows the result. */
function onTransferFinished(job) {
  if (job.direction === 'up' && activeRemote()?.host === job.host) refreshPane(activeRemote());
  if (job.direction === 'down') refreshPane(localPane);
}

/** When the left pane is in a folder with a remembered upload spot, offer to jump the right pane there. */
function updateSpotHint() {
  const hint = part('remote', 'hint');
  const remote = activeRemote();
  const spot = remote && localPane.cwd && localPane.cwd !== DRIVES && state.saved.uploadSpots?.[remote.host]?.[pathKey(localPane.cwd)];
  if (!spot || (remote.cwd && pathKey(spot) === pathKey(remote.cwd))) {
    hint.hidden = true;
    return;
  }
  const go = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Go there' });
  go.addEventListener('click', () => navigate(remote, spot));
  hint.replaceChildren(icon('pin'), el('span', {}, 'Files from ', el('b', { textContent: basenameOf(localPane.cwd) }), ' last went to ', el('code', { textContent: spot })), go);
  if (hint.hidden) {
    hint.hidden = false;
    replayAnimation(hint, 'fade-in');
  }
}

// ---------- drag and drop ----------

function startDrag(pane, entry, e) {
  if (!pane.selection.has(entry.name)) {
    pane.selection.clear();
    pane.selection.add(entry.name);
    pane.anchor = entry.name;
    renderPane(pane);
  }
  drag = { side: pane.side, host: pane.host, items: selectedEntries(pane).map((x) => ({ ...x, path: entryPath(pane, x) })), fromDir: pane.cwd };
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('application/x-swiftstream', pane.side);
  const label = el('div', { className: 'drag-ghost', textContent: drag.items.length === 1 ? drag.items[0].name : `${drag.items.length} items` });
  document.body.append(label);
  e.dataTransfer.setDragImage(label, 12, 12);
  setTimeout(() => label.remove());
}

function endDrag() {
  drag = null;
  clearDropUI();
}

/** Which drops a pane accepts: the other pane's rows, or (server pane only) files from Explorer. */
function canDrop(side, e) {
  const pane = paneFor(side);
  if (!pane?.cwd || pane.cwd === DRIVES) return false;
  if (drag) return drag.side !== side;
  return side === 'remote' && e.dataTransfer.types.includes('Files');
}

function clearDropUI() {
  for (const side of ['local', 'remote']) {
    part(side, 'list').classList.remove('dropping');
    part(side, 'drop').hidden = true;
    for (const row of paneRoot(side).querySelectorAll('tr.drop-into')) row.classList.remove('drop-into');
  }
}

function showDropTarget(side) {
  const pane = paneFor(side);
  const target = pane.cwd;
  const label = part(side, 'drop');
  label.replaceChildren(icon(side === 'remote' ? 'up' : 'down'), el('span', {}, side === 'remote' ? 'Upload to ' : 'Download to ', el('b', { textContent: target })));
  label.hidden = false;
  part(side, 'list').classList.add('dropping');
}

for (const side of ['local', 'remote']) {
  const list = part(side, 'list');
  list.addEventListener('dragover', (e) => {
    if (!canDrop(side, e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    showDropTarget(side);
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clearDropUI();
  });
  list.addEventListener('drop', (e) => {
    if (!canDrop(side, e)) return;
    e.preventDefault();
    const pane = paneFor(side);
    const targetDir = pane.cwd;
    const from = drag;
    clearDropUI();
    lastPaneSide = side;
    if (side === 'remote') {
      const paths = from ? from.items.map((i) => i.path) : [...e.dataTransfer.files].map((f) => api.files.pathFor(f)).filter(Boolean);
      const sourceDir = from ? from.fromDir : dirnameOf(paths[0] || '');
      uploadItems(pane.host, paths, sourceDir, targetDir);
    } else if (from) {
      downloadItems(from.host, from.items, targetDir, activeRemote());
    }
    drag = null;
  });
  // Track which pane the pointer is over, for mouse back/forward and keyboard shortcuts.
  paneRoot(side).addEventListener('pointerenter', () => (lastPaneSide = side));
  paneRoot(side).addEventListener('pointerdown', () => (lastPaneSide = side));

  action(side, 'back').addEventListener('click', () => goBack(paneFor(side)));
  action(side, 'forward').addEventListener('click', () => goForward(paneFor(side)));
  action(side, 'up').addEventListener('click', () => goUp(paneFor(side)));
  action(side, 'refresh').addEventListener('click', () => refreshPane(paneFor(side)));

  list.addEventListener('keydown', (e) => onListKey(paneFor(side), e));
  onContextMenu(list, (e) => (e.target.closest('tbody tr') ? null : backgroundMenu(paneFor(side))));

  const filter = part(side, 'filter');
  filter.addEventListener('input', () => {
    const pane = paneFor(side);
    if (!pane) return;
    pane.filter = filter.value;
    renderPane(pane);
  });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filter.value) {
      filter.value = '';
      filter.dispatchEvent(new Event('input'));
      e.stopPropagation();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      part(side, 'list').focus();
    }
  });
  part(side, 'crumbs').addEventListener('click', (e) => {
    if (!e.target.closest('button, input') && paneFor(side)?.cwd) editPath(paneFor(side));
  });
}

window.addEventListener('keydown', (e) => {
  if (!filesShown() || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'f') {
    e.preventDefault();
    part(lastPaneSide, 'filter').focus();
  } else if (key === 'l') {
    e.preventDefault();
    editPath(paneFor(lastPaneSide));
  }
});

action('remote', 'home').addEventListener('click', () => activeRemote() && navigate(activeRemote(), '~'));
action('remote', 'download').addEventListener('click', () => {
  const remote = activeRemote();
  if (remote) downloadItems(remote.host, selectedEntries(remote), localPane.cwd, remote);
});
action('local', 'upload').addEventListener('click', () => {
  const remote = activeRemote();
  if (remote) uploadItems(remote.host, selectedEntries(localPane).map((e) => e.path), localPane.cwd, remote.cwd);
});
action('remote', 'mkdir').addEventListener('click', () => newFolder(activeRemote()));

// ---------- keyboard and mouse navigation ----------

function onListKey(pane, e) {
  if (!pane?.listing) return;
  const entries = visibleEntries(pane);
  const current = entries.findIndex((x) => x.name === pane.anchor);
  if (e.key === 'Delete') return e.preventDefault(), deleteEntries(pane, selectedEntries(pane));
  if (e.key === 'F2' && entries[current]) return e.preventDefault(), renameEntry(pane, entries[current]);
  if (e.key === 'Backspace') return e.preventDefault(), goUp(pane);
  if (e.key === 'Enter') {
    const entry = entries[current];
    if (entry) openEntry(pane, entry);
    return e.preventDefault();
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = entries[Math.max(0, Math.min(entries.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) selectRow(pane, next, { shiftKey: e.shiftKey, ctrlKey: false });
    paneRoot(pane.side).querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    for (const x of entries) pane.selection.add(x.name);
    renderPane(pane);
  }
}

let lastMouseNav = 0;
function navHistory(direction) {
  if (!filesShown()) return;
  const pane = paneFor(lastPaneSide);
  if (direction === 'back') goBack(pane);
  else goForward(pane);
}

// Mouse side buttons (button 3 = back, 4 = forward). The pane under the pointer is the one that moves.
window.addEventListener('mousedown', (e) => (e.button === 3 || e.button === 4) && e.preventDefault());
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  lastMouseNav = Date.now();
  const paneEl = e.target.closest?.('.fpane');
  if (paneEl) lastPaneSide = paneEl.dataset.side;
  navHistory(e.button === 3 ? 'back' : 'forward');
});
// On Windows the same buttons can also arrive as app commands; ignore the duplicate.
api.onNav((direction) => Date.now() - lastMouseNav > 400 && navHistory(direction));
window.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  if (!filesShown()) return;
  e.preventDefault();
  navHistory(e.key === 'ArrowLeft' ? 'back' : 'forward');
});

// Dropping files anywhere else must not navigate the window to them.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

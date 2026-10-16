'use strict';
// Tabs (one per open server), the server workspace header, the error banner, and the editor.

// ---------- tabs ----------

function renderTabs() {
  $('tab-home').classList.toggle('active', state.page === 'home');
  $('tab-settings').classList.toggle('active', state.page === 'settings');
  $('open-tabs').replaceChildren(
    ...state.openTabs.map((name) => {
      const dot = el('span', { className: `dot ${state.status.get(name) || 'unknown'}` });
      dot.dataset.statusFor = name;
      const close = el('span', { className: 'tab-close', title: `Close ${name}`, role: 'button', ariaLabel: `Close ${name}` }, icon('x'));
      const tab = el('button', { type: 'button', role: 'tab', className: `srv-tab${name === state.active ? ' active' : ''}`, ariaSelected: String(name === state.active) }, dot, el('span', { className: 'tab-name', textContent: name }), close);
      tab.addEventListener('click', (e) => (e.target.closest('.tab-close') ? closeTab(name) : activate(name)));
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeTab(name)); // middle-click closes
      onContextMenu(tab, () => [
        { label: 'Terminal', icon: 'terminal', run: () => (activate(name), showView('terminal')) },
        { label: 'Files', icon: 'files', run: () => (activate(name), showView('files')) },
        'separator',
        { label: 'Edit server…', icon: 'pencil', run: () => openEditor(name) },
        { label: 'Restart SwiftSSH', icon: 'refresh', disabled: !hostByName(name)?.ssh, run: () => restartServer(name) },
        'separator',
        { label: 'Close tab', icon: 'x', hint: 'Ctrl+W', run: () => closeTab(name) },
        { label: 'Close other tabs', disabled: state.openTabs.length < 2, run: () => state.openTabs.filter((n) => n !== name).forEach(closeTab) },
      ]);
      return tab;
    }),
  );
}

function openTab(name) {
  if (!hostByName(name)) return;
  if (!state.openTabs.includes(name)) state.openTabs.push(name);
  activate(name);
}

function closeTab(name) {
  const i = state.openTabs.indexOf(name);
  if (i < 0) return;
  state.openTabs.splice(i, 1);
  disposeTerminal(name);
  if (state.active === name) activate(state.openTabs[Math.min(i, state.openTabs.length - 1)] ?? null);
  else persistTabs();
  renderTabs();
}

function persistTabs() {
  saveState({ openTabs: state.openTabs, activeTab: state.active });
}

/** Show a server tab, the servers home (null), or the settings page (SETTINGS_PAGE). */
async function activate(name) {
  const page = name === null ? 'home' : name === SETTINGS_PAGE ? 'settings' : 'server';
  if (page === 'server' && !state.openTabs.includes(name)) state.openTabs.push(name); // a shown server always has a tab
  state.page = page;
  state.active = page === 'server' ? name : null;
  persistTabs();
  renderTabs();
  $('home').hidden = page !== 'home';
  $('settings').hidden = page !== 'settings';
  $('workspace').hidden = page !== 'server';
  for (const t of document.querySelectorAll('#terminal-pane > .term')) t.hidden = t.dataset.host !== name;
  if (page === 'settings') {
    renderSettings();
    replayAnimation($('settings'), 'pane-enter');
    return;
  }
  if (page === 'home') {
    refreshStatuses();
    renderHome();
    replayAnimation($('home'), 'pane-enter');
    return;
  }
  replayAnimation($('workspace'), 'pane-enter');
  hideBanner();
  renderWorkspaceHeader();
  showView(viewOf(name).view, { animate: false });
  if (state.status.get(name) !== 'up') {
    const status = await checkStatus(name);
    if (state.active !== name) return;
    if (status === 'down' && state.lastError?.name === name) showBanner(state.lastError.err);
    else showView(viewOf(name).view, { animate: false });
  }
}

$('tab-home').addEventListener('click', () => activate(null));

// Ctrl+Tab / Ctrl+Shift+Tab cycle through the servers home and open tabs; Ctrl+W closes a tab.
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const order = [null, ...state.openTabs];
    const i = order.indexOf(state.page === 'server' ? state.active : null);
    activate(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
  } else if (e.key.toLowerCase() === 'w' && state.active) {
    e.preventDefault();
    closeTab(state.active);
  }
});

// ---------- workspace ----------

function renderWorkspaceHeader() {
  const name = state.active;
  const host = hostByName(name);
  if (!host) return;
  const info = state.info.get(name);
  const status = state.status.get(name) || 'unknown';
  $('ws-dot').className = `dot ${status}`;
  $('ws-dot').dataset.statusFor = name;
  $('ws-name').textContent = name;
  const sub = $('ws-sub');
  if (info) sub.replaceChildren(`${host.address}  ·  ${info.hostname} · ${platformName(info.platform)} · swiftssh ${info.version}`);
  else if (status === 'checking') sub.replaceChildren(`${host.address}  ·  `, skeleton('180px', 'sk-inline'));
  else sub.replaceChildren(host.address);
}

function showView(viewName, { animate = true } = {}) {
  const name = state.active;
  if (!name) return;
  const v = viewOf(name);
  const changed = v.view !== viewName;
  v.view = viewName;
  for (const b of document.querySelectorAll('.seg [data-view]')) {
    const on = b.dataset.view === viewName;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('terminal-pane').hidden = viewName !== 'terminal';
  $('files-pane').hidden = viewName !== 'files';
  if (animate && changed) replayAnimation($(viewName === 'terminal' ? 'terminal-pane' : 'files-pane'), 'pane-enter');
  if (state.status.get(name) !== 'up') return;
  if (viewName === 'terminal') ensureTerminal(name);
  else openFilesFor(name);
}

for (const b of document.querySelectorAll('.seg [data-view]')) b.addEventListener('click', () => showView(b.dataset.view));

// ---------- error banner ----------

let bannerAction = null;
function showBanner(err) {
  $('banner').hidden = false;
  $('banner-message').textContent = err.message;
  const host = hostByName(state.active);
  bannerAction = err.action === 'redeploy' && host?.ssh ? () => redeploy(host) : null;
  // The CLI hint names a command; in the app the button does it.
  $('banner-hint').textContent = bannerAction ? `SwiftSSH can log in to ${host.ssh} over SSH and start it again.` : err.hint || '';
  $('banner-action').hidden = !bannerAction;
  $('banner-action').textContent = 'Start server again';
}

function hideBanner() {
  $('banner').hidden = true;
}

$('banner-retry').addEventListener('click', async () => {
  const name = state.active;
  if (!name) return;
  hideBanner();
  const status = await checkStatus(name);
  if (state.active !== name) return;
  if (status === 'down') showBanner(state.lastError.err);
  else showView(viewOf(name).view, { animate: false });
});
$('banner-action').addEventListener('click', () => bannerAction?.());

/** Restart SwiftSSH on a server over SSH (menus); asks for a password only if its key isn't accepted. */
async function restartServer(name) {
  const host = hostByName(name);
  if (!host?.ssh) return toast('Add an SSH login for this server first (Edit server)');
  toast(`Restarting SwiftSSH on ${name}…`);
  state.status.set(name, 'healing');
  paintStatus(name);
  if (state.active !== name) openTab(name);
  await redeploy(host);
}

async function redeploy(host) {
  const button = $('banner-action');
  button.disabled = true;
  button.textContent = 'Starting…';
  const deploy = (password) => call(api.hosts.deploy({ name: host.name, target: host.ssh, sshPort: host.sshPort, password }));
  try {
    try {
      await deploy(); // an SSH key may be enough
    } catch (err) {
      if (!/was refused/.test(err.message)) throw err;
      const password = await prompt({ title: `Log in to ${host.ssh}`, text: 'Enter the SSH password to start SwiftSSH again. It is used once and not saved.', ok: 'Start server', secret: true });
      if (!password) return;
      await deploy(password);
    }
    hideBanner();
    await checkStatus(host.name);
    toast(`SwiftSSH is running on ${host.name}`);
    afterRecovered(host.name);
    if (state.active === host.name) showView(viewOf(host.name).view, { animate: false });
  } catch (err) {
    showBanner(err);
  } finally {
    button.disabled = false;
    button.textContent = 'Start server again';
  }
}

// ---------- edit a server ----------

const editForm = $('edit-form');
let editing = null;

function openEditor(name) {
  const host = hostByName(name);
  if (!host) return;
  editing = name;
  const f = editForm.elements;
  $('edit-title').textContent = `Edit ${name}`;
  f.name.value = host.name;
  f.group.value = host.group || '';
  f.address.value = host.address;
  f.ssh.value = host.ssh || '';
  f.sshPort.value = host.sshPort || '';
  $('edit-error').hidden = true;
  $('edit-dialog').showModal();
  f.name.focus();
  f.name.select();
}

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = editForm.elements;
  const oldName = editing;
  try {
    const newName = await call(
      api.hosts.update(oldName, { name: f.name.value, group: f.group.value, address: f.address.value, ssh: f.ssh.value, sshPort: f.sshPort.value }),
    );
    $('edit-dialog').close();
    if (newName !== oldName) renameEverywhere(oldName, newName);
    state.saved = await call(api.state.get());
    await loadHosts();
    if (state.active === newName) {
      renderWorkspaceHeader();
      checkStatus(newName);
    }
    toast(`Saved ${newName}`);
  } catch (err) {
    const box = $('edit-error');
    box.hidden = false;
    box.replaceChildren(el('b', { textContent: err.message }), ...(err.hint ? [el('div', { className: 'hint', textContent: err.hint })] : []));
  }
});

/** Move all in-memory state for a renamed server to its new name. */
function renameEverywhere(from, to) {
  const v = state.views.get(from);
  if (v) {
    state.views.delete(from);
    state.views.set(to, v);
    v.remote.host = to;
    if (v.term) v.term.container.dataset.host = to;
  }
  for (const [id, name] of terminals) if (name === from) terminals.set(id, to);
  for (const map of [state.status, state.info]) {
    if (map.has(from)) {
      map.set(to, map.get(from));
      map.delete(from);
    }
  }
  state.openTabs = state.openTabs.map((n) => (n === from ? to : n));
  if (state.active === from) state.active = to;
}

$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());
$('edit-remove').addEventListener('click', () => {
  $('edit-dialog').close();
  removeServer(editing);
});

async function removeServer(name) {
  const yes = await confirmDialog(`Remove ${name}?`, 'SwiftSSH forgets this server. Nothing on the server is changed, and you can add it again later.', 'Remove', true);
  if (!yes) return;
  await call(api.hosts.remove(name));
  closeTab(name);
  state.views.delete(name);
  state.status.delete(name);
  state.info.delete(name);
  await loadHosts();
  toast(`Removed ${name}`);
}
$('ws-edit').addEventListener('click', () => state.active && openEditor(state.active));

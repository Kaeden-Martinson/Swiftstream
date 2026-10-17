'use strict';
// Tabs are sessions: each is a terminal or a file browser for one server, and a server can have
// several of each. Also here: the new-tab menu, the error banner, restarts, and the server editor.

// ---------- sessions and tabs ----------

let nextSessionId = 1;

function createSession(host, kind) {
  const session = { id: `s${nextSessionId++}`, host, kind, term: null, remote: kind === 'files' ? newPane('remote', host) : null };
  state.sessions.set(session.id, session);
  state.tabs.push(session.id);
  return session;
}

const sessionsOf = (host) => [...state.sessions.values()].filter((s) => s.host === host);

/** Open a terminal or files tab for a server. With reuse, focus an existing one of that kind instead. */
function openSession(host, kind, { reuse = false } = {}) {
  if (!hostByName(host)) return null;
  const existing = reuse && state.tabs.map((id) => state.sessions.get(id)).find((s) => s.host === host && s.kind === kind);
  const session = existing || createSession(host, kind);
  activate(session.id);
  return session;
}

function tabLabel(session) {
  const same = state.tabs.map((id) => state.sessions.get(id)).filter((s) => s.host === session.host && s.kind === session.kind);
  const n = same.indexOf(session) + 1;
  return same.length > 1 ? `${session.host} ${n}` : session.host;
}

function renderTabs() {
  $('tab-home').classList.toggle('active', state.page === 'home');
  $('tab-settings').classList.toggle('active', state.page === 'settings');
  $('open-tabs').replaceChildren(
    ...state.tabs.map((id) => {
      const session = state.sessions.get(id);
      const active = state.page === 'session' && state.activeTab === id;
      const dot = el('span', { className: `dot ${state.status.get(session.host) || 'unknown'}` });
      dot.dataset.statusFor = session.host;
      const close = el('span', { className: 'tab-close', title: 'Close tab', role: 'button', ariaLabel: 'Close tab' }, icon('x'));
      const tab = el(
        'button',
        { type: 'button', role: 'tab', className: `srv-tab${active ? ' active' : ''}`, ariaSelected: String(active), title: tabTitle(session) },
        el('span', { className: 'tab-kind' }, icon(session.kind === 'files' ? 'files' : 'terminal'), dot),
        el('span', { className: 'tab-name', textContent: tabLabel(session) }),
        close,
      );
      tab.addEventListener('click', (e) => (e.target.closest('.tab-close') ? closeTab(id) : activate(id)));
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeTab(id)); // middle-click closes
      onContextMenu(tab, () => [
        { label: 'New terminal', icon: 'terminal', run: () => openSession(session.host, 'terminal') },
        { label: 'New file browser', icon: 'files', run: () => openSession(session.host, 'files') },
        'separator',
        { label: 'Edit server…', icon: 'pencil', run: () => openEditor(session.host) },
        { label: 'Restart Swiftstream', icon: 'refresh', disabled: !hostByName(session.host)?.ssh, run: () => restartServer(session.host) },
        { label: 'Authorized computers…', icon: 'pc', run: () => showComputers(session.host) },
        'separator',
        { label: 'Close tab', icon: 'x', hint: 'Ctrl+W', run: () => closeTab(id) },
        { label: 'Close other tabs', disabled: state.tabs.length < 2, run: () => state.tabs.filter((t) => t !== id).forEach(closeTab) },
      ]);
      return tab;
    }),
  );
}

function tabTitle(session) {
  const host = hostByName(session.host);
  const info = state.info.get(session.host);
  const kind = session.kind === 'files' ? 'Files' : 'Terminal';
  return [`${kind} · ${session.host}`, host?.address, info && `${info.hostname} · ${platformName(info.platform)}`].filter(Boolean).join('\n');
}

function closeTab(id) {
  const i = state.tabs.indexOf(id);
  if (i < 0) return;
  const session = state.sessions.get(id);
  state.tabs.splice(i, 1);
  disposeTerminal(session);
  state.sessions.delete(id);
  if (state.page === 'session' && state.activeTab === id) activate(state.tabs[Math.min(i, state.tabs.length - 1)] ?? null);
  else persistTabs();
  renderTabs();
}

function persistTabs() {
  const tabs = state.tabs.map((id) => state.sessions.get(id)).map(({ host, kind }) => ({ host, kind }));
  saveState({ tabs, activeIndex: state.page === 'session' ? state.tabs.indexOf(state.activeTab) : -1 });
}

const activeSession = () => (state.page === 'session' ? state.sessions.get(state.activeTab) || null : null);

/** Show a session tab (by id), the servers home (null), or the settings page (SETTINGS_PAGE). */
async function activate(target) {
  const page = target === null ? 'home' : target === SETTINGS_PAGE ? 'settings' : 'session';
  if (page !== 'settings') state.returnTo = target; // where the settings close button goes back to
  state.page = page;
  if (page === 'session') state.activeTab = target;
  closeNewTabMenu();
  persistTabs();
  renderTabs();
  $('home').hidden = page !== 'home';
  $('settings').hidden = page !== 'settings';
  $('workspace').hidden = page !== 'session';
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
  const session = activeSession();
  replayAnimation($('workspace'), 'pane-enter');
  hideBanner();
  showSession(session);
  if (state.status.get(session.host) !== 'up') {
    const status = await checkStatus(session.host);
    if (activeSession() !== session) return;
    if (status === 'down' && state.lastError?.name === session.host) showBanner(state.lastError.err);
    else showSession(session);
  }
}

/** Show the active session's terminal or file browser, starting it if the server is up. */
function showSession(session) {
  if (!session) return;
  $('terminal-pane').hidden = session.kind !== 'terminal';
  $('files-pane').hidden = session.kind !== 'files';
  for (const g of document.querySelectorAll('#terminal-pane > .term-group')) g.hidden = g.dataset.session !== session.id;
  if (state.status.get(session.host) !== 'up') return;
  if (session.kind === 'terminal') ensureTerminal(session);
  else openFilesFor(session);
}

$('tab-home').addEventListener('click', () => activate(null));

// Ctrl+Tab / Ctrl+Shift+Tab cycle through the servers home and open tabs; Ctrl+W closes a tab.
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const order = [null, ...state.tabs];
    const i = order.indexOf(state.page === 'session' ? state.activeTab : null);
    activate(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
  } else if (e.key.toLowerCase() === 'w' && e.shiftKey && activeSession()?.panes?.length > 1) {
    e.preventDefault();
    closePane(activeSession()); // Ctrl+Shift+W: just the terminal you're in
  } else if (e.key.toLowerCase() === 'w' && activeSession()) {
    e.preventDefault();
    closeTab(state.activeTab);
  } else if (e.key.toLowerCase() === 't') {
    e.preventDefault();
    showNewTabMenu();
  }
});

// ---------- the + menu: a terminal or file browser for any server ----------

let newTabMenu = null;

function closeNewTabMenu() {
  newTabMenu?.remove();
  newTabMenu = null;
  window.removeEventListener('pointerdown', onNewTabOutside, true);
}

function onNewTabOutside(e) {
  if (newTabMenu && !newTabMenu.contains(e.target) && !e.target.closest('#tab-new')) closeNewTabMenu();
}

function showNewTabMenu() {
  if (newTabMenu) return closeNewTabMenu();
  closeMenu();
  const search = el('input', { className: 'ntm-search', placeholder: 'Find a server', spellcheck: false, ariaLabel: 'Find a server' });
  const list = el('div', { className: 'ntm-list' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const hosts = state.hosts.filter((h) => !q || [h.name, h.address, h.group].some((v) => v && v.toLowerCase().includes(q)));
    list.replaceChildren(
      ...hosts.map((h) => {
        const dot = el('span', { className: `dot ${state.status.get(h.name) || 'unknown'}` });
        const term = el('button', { type: 'button', className: 'btn btn-small', title: `New terminal on ${h.name}` }, icon('terminal'), 'Terminal');
        const files = el('button', { type: 'button', className: 'btn btn-small', title: `Browse files on ${h.name}` }, icon('files'), 'Files');
        term.addEventListener('click', () => openSession(h.name, 'terminal'));
        files.addEventListener('click', () => openSession(h.name, 'files'));
        return el('div', { className: 'ntm-row' }, dot, el('span', { className: 'ntm-name' }, el('b', { textContent: h.name }), el('small', { textContent: h.address })), term, files);
      }),
      ...(hosts.length ? [] : [el('p', { className: 'ntm-empty muted', textContent: state.hosts.length ? 'No servers match.' : 'No servers yet.' })]),
    );
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNewTabMenu();
    if (e.key === 'Enter') list.querySelector('.ntm-row .btn')?.click(); // first server's terminal
  });
  const add = el('button', { type: 'button', className: 'ctx-item' }, icon('plus'), el('span', { className: 'ctx-label', textContent: 'Add a server…' }));
  add.addEventListener('click', () => {
    closeNewTabMenu();
    openAddDialog();
  });
  newTabMenu = el('div', { className: 'ctx-menu new-tab-menu', role: 'dialog', ariaLabel: 'New tab' }, el('div', { className: 'ntm-title', textContent: 'New tab' }), search, list, el('div', { className: 'ctx-sep' }), add);
  render();
  document.body.append(newTabMenu);
  const r = $('tab-new').getBoundingClientRect();
  newTabMenu.style.left = `${Math.min(r.left, window.innerWidth - newTabMenu.offsetWidth - 8)}px`;
  newTabMenu.style.top = `${r.bottom + 6}px`;
  search.focus();
  setTimeout(() => window.addEventListener('pointerdown', onNewTabOutside, true));
}

$('tab-new').addEventListener('click', showNewTabMenu);

// ---------- error banner ----------

let bannerAction = null;
function showBanner(err) {
  $('banner').hidden = false;
  $('banner-message').textContent = err.message;
  const host = hostByName(activeSession()?.host);
  bannerAction = err.action === 'redeploy' && host?.ssh ? () => redeploy(host) : null;
  // The CLI hint names a command; in the app the button does it.
  $('banner-hint').textContent = bannerAction ? `Swiftstream can log in to ${host.ssh} over SSH and start it again.` : err.hint || '';
  $('banner-action').hidden = !bannerAction;
  $('banner-action').textContent = 'Start server again';
}

function hideBanner() {
  $('banner').hidden = true;
}

$('banner-retry').addEventListener('click', async () => {
  const session = activeSession();
  if (!session) return;
  hideBanner();
  const status = await checkStatus(session.host);
  if (activeSession() !== session) return;
  if (status === 'down') showBanner(state.lastError.err);
  else showSession(session);
});
$('banner-action').addEventListener('click', () => bannerAction?.());

/** Restart Swiftstream on a server over SSH (menus); asks for a password only if its key isn't accepted. */
async function restartServer(name) {
  const host = hostByName(name);
  if (!host?.ssh) return toast('Add an SSH login for this server first (Edit server)');
  toast(`Restarting Swiftstream on ${name}…`);
  state.status.set(name, 'healing');
  paintStatus(name);
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
      const password = await prompt({ title: `Log in to ${host.ssh}`, text: 'Enter the SSH password to start Swiftstream again. It is used once and not saved.', ok: 'Start server', secret: true });
      if (!password) return;
      await deploy(password);
    }
    hideBanner();
    await checkStatus(host.name);
    toast(`Swiftstream is running on ${host.name}`);
    afterRecovered(host.name);
  } catch (err) {
    if (activeSession()?.host === host.name) showBanner(err);
    else toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Start server again';
  }
}

// ---------- edit a server (from the Servers page and tab menus) ----------

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
    checkStatus(newName);
    toast(`Saved ${newName}`);
  } catch (err) {
    const box = $('edit-error');
    box.hidden = false;
    box.replaceChildren(el('b', { textContent: err.message }), ...(err.hint ? [el('div', { className: 'hint', textContent: err.hint })] : []));
  }
});

/** Move all in-memory state for a renamed server to its new name. */
function renameEverywhere(from, to) {
  for (const session of sessionsOf(from)) {
    session.host = to;
    if (session.remote) session.remote.host = to;
  }
  for (const map of [state.status, state.info]) {
    if (map.has(from)) {
      map.set(to, map.get(from));
      map.delete(from);
    }
  }
  persistTabs();
}

$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());
$('edit-remove').addEventListener('click', () => {
  $('edit-dialog').close();
  removeServer(editing);
});

async function removeServer(name) {
  const yes = await confirmDialog(`Remove ${name}?`, 'Swiftstream forgets this server. Nothing on the server is changed, and you can add it again later.', 'Remove', true);
  if (!yes) return;
  await call(api.hosts.remove(name));
  for (const session of sessionsOf(name)) closeTab(session.id);
  state.status.delete(name);
  state.info.delete(name);
  await loadHosts();
  toast(`Removed ${name}`);
}

'use strict';
// Servers home: search or quick-connect, servers grouped into cards, and the add-server dialog.

async function loadHosts() {
  state.hosts = await call(api.hosts.list());
  const groups = [...new Set(state.hosts.map((h) => h.group).filter(Boolean))].sort();
  $('group-options').replaceChildren(...groups.map((g) => el('option', { value: g })));
  renderHome();
  renderTabs();
}

/** Check every server's status in parallel (for the dots on cards and tabs). */
let lastStatusSweep = 0;
function refreshStatuses(force = false) {
  if (!force && Date.now() - lastStatusSweep < 30_000) return;
  lastStatusSweep = Date.now();
  for (const h of state.hosts) checkStatus(h.name);
}

async function checkStatus(name) {
  state.status.set(name, 'checking');
  paintStatus(name);
  try {
    state.info.set(name, await call(api.hosts.info(name)));
    state.status.set(name, 'up');
  } catch (err) {
    state.status.set(name, 'down');
    state.lastError = { name, err };
  }
  paintStatus(name);
  return state.status.get(name);
}

/** Update just the status dots and details for one server, wherever they're shown. */
function paintStatus(name) {
  const status = state.status.get(name) || 'unknown';
  for (const dot of document.querySelectorAll(`[data-status-for="${CSS.escape(name)}"]`)) dot.className = `dot ${status}`;
  const info = state.info.get(name);
  const meta = document.querySelector(`.host-card[data-name="${CSS.escape(name)}"] [data-part="os"]`);
  if (meta) meta.textContent = info ? `${platformName(info.platform)} · ${info.hostname}` : status === 'down' ? 'Not reachable' : '';
}

function matches(host, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [host.name, host.address, host.ssh, host.group].some((v) => v && v.toLowerCase().includes(q));
}

function renderHome() {
  const query = $('search').value.trim();
  const visible = state.hosts.filter((h) => matches(h, query));
  $('home-empty').hidden = state.hosts.length > 0;
  $('no-results').hidden = !(state.hosts.length && !visible.length);
  if (!visible.length && state.hosts.length) {
    $('no-results').textContent = query.includes('@') || /[.:]/.test(query) ? `No saved server matches "${query}". Press Connect to set it up.` : `No servers match "${query}".`;
  }

  // Grouped servers first (alphabetical), then the rest.
  const byGroup = new Map();
  for (const h of visible) {
    const key = h.group || '';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(h);
  }
  const keys = [...byGroup.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  $('groups').replaceChildren(
    ...keys.map((key) =>
      el(
        'section',
        { className: 'group' },
        el('h2', {}, key || (keys.length > 1 ? 'Other servers' : 'Servers'), el('span', { className: 'count', textContent: String(byGroup.get(key).length) })),
        el('div', { className: 'host-grid' }, ...byGroup.get(key).map(hostCard)),
      ),
    ),
  );
}

function hostCard(host, index) {
  const info = state.info.get(host.name);
  const status = state.status.get(host.name) || 'unknown';
  const user = host.ssh?.includes('@') ? host.ssh.split('@')[0] : null;
  const edit = el('button', { type: 'button', className: 'icon-btn card-edit', title: `Edit ${host.name}`, ariaLabel: `Edit ${host.name}` }, icon('pencil'));
  const dot = el('span', { className: `dot ${status}` });
  dot.dataset.statusFor = host.name;
  const card = el(
    'div',
    { className: 'host-card', tabIndex: 0, role: 'button', style: `--i:${Math.min(index, 12)}` },
    el('span', { className: 'host-avatar' }, icon('server'), dot),
    el(
      'span',
      { className: 'host-meta' },
      el('span', { className: 'host-name', textContent: host.name }),
      el('span', { className: 'host-sub muted', textContent: [user, host.address].filter(Boolean).join(' · ') }),
      el('span', { className: 'host-os', textContent: info ? `${platformName(info.platform)} · ${info.hostname}` : status === 'down' ? 'Not reachable' : '' }),
    ),
    edit,
  );
  card.dataset.name = host.name;
  card.querySelector('.host-os').dataset.part = 'os';
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-edit')) return;
    openSession(host.name, 'terminal', { reuse: true });
  });
  card.addEventListener('keydown', (e) => e.key === 'Enter' && e.target === card && openSession(host.name, 'terminal', { reuse: true }));
  edit.addEventListener('click', () => openEditor(host.name));
  onContextMenu(card, () => [
    { label: 'New terminal', icon: 'terminal', run: () => openSession(host.name, 'terminal') },
    { label: 'Browse files', icon: 'files', run: () => openSession(host.name, 'files', { reuse: true }) },
    'separator',
    { label: 'Edit server…', icon: 'pencil', run: () => openEditor(host.name) },
    { label: 'Restart Swiftstream', icon: 'refresh', disabled: !host.ssh, run: () => restartServer(host.name) },
    { label: host.ssh ? 'Copy SSH login' : 'Copy address', icon: 'copy', run: () => (api.copy(host.ssh || host.address), toast('Copied')) },
    ...actionMenuItems('server', { host: host.name }),
    'separator',
    { label: 'Remove server…', icon: 'trash', danger: true, run: () => removeServer(host.name) },
  ]);
  return card;
}

// ---------- search and quick connect ----------

$('search').addEventListener('input', renderHome);
$('search').addEventListener('keydown', (e) => e.key === 'Escape' && (($('search').value = ''), renderHome()));
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const query = $('search').value.trim();
  if (!query) return $('search').focus();
  const visible = state.hosts.filter((h) => matches(h, query));
  const exact = state.hosts.find((h) => h.name === query || h.ssh === query);
  if (exact) return openSession(exact.name, 'terminal', { reuse: true });
  if (visible.length === 1 && !query.includes('@')) return openSession(visible[0].name, 'terminal', { reuse: true });
  // Looks like a login we haven't saved: set it up.
  if (query.includes('@') || /[.:]/.test(query)) return openAddDialog({ target: query.includes('@') ? query : `root@${query}` });
  toast(visible.length ? 'Pick a server below' : 'No matching server');
});

// ---------- add a server ----------

const addForm = $('add-form');
let addStep = 'form'; // form -> trust -> authorize (direct mode only)
let probed = null;

const addMode = () => addForm.elements.mode.value;

function openAddDialog({ target = '' } = {}) {
  addForm.reset();
  addStep = 'form';
  probed = null;
  syncAddDialog();
  setAddBusy(null);
  setAddError(null);
  addForm.elements.target.value = target;
  addForm.elements.name.placeholder = suggestName(target) || 'prod';
  $('add-dialog').showModal();
  (target ? addForm.elements.password : addForm.elements.target).focus();
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
  const host = String(address).split('@').pop().split(':')[0];
  if (!host) return '';
  return /^[\d.]+$/.test(host) ? `server-${host.split('.').pop()}` : host.split('.')[0].replace(/[^\w.-]/g, '');
}

addForm.addEventListener('change', (e) => {
  if (e.target.name === 'mode') {
    setAddError(null);
    syncAddDialog();
  }
});
addForm.elements.target.addEventListener('input', (e) => (addForm.elements.name.placeholder = suggestName(e.target.value) || 'prod'));
addForm.elements.address.addEventListener('input', (e) => (addForm.elements.directName.placeholder = suggestName(e.target.value) || 'home-server'));
api.hosts.onDeployStep(({ text }) => {
  if (!$('add-progress').hidden) $('add-progress-text').textContent = `${text}…`;
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setAddError(null);
  const f = addForm.elements;
  try {
    if (addMode() === 'ssh') {
      const target = f.target.value.trim();
      const name = f.name.value.trim() || suggestName(target);
      if (!target) throw { message: 'Enter the SSH login you use for this server.', hint: 'For example ubuntu@203.0.113.7' };
      setAddBusy(`Connecting to ${target}…`);
      const password = f.password.value;
      f.password.value = ''; // don't keep it in the form
      await call(api.hosts.deploy({ name, target, sshPort: f.sshPort.value.trim() || null, password }));
      if (f.group.value.trim()) await call(api.hosts.update(name, { group: f.group.value.trim() }));
      $('add-dialog').close();
      $('search').value = '';
      await loadHosts();
      checkStatus(name);
      openSession(name, 'terminal');
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
      $('add-authorize-cmd').textContent = `swiftstream authorize "${id.publicKey}"`;
      addStep = 'authorize';
    } else {
      $('add-dialog').close();
      await loadHosts();
      openSession(probed.name, 'terminal');
    }
  } catch (err) {
    setAddError(err);
  } finally {
    setAddBusy(null);
    syncAddDialog();
  }
});

$('add-cancel').addEventListener('click', () => $('add-dialog').close());
for (const id of ['new-host', 'empty-add']) $(id).addEventListener('click', () => openAddDialog());

'use strict';
// Settings page, and custom right-click actions that run commands in a server's terminal.

const SETTINGS_PAGE = '::settings';

const DEFAULT_ACTIONS = [
  { id: 'disk', name: 'Show disk usage', command: 'df -h', scope: 'server' },
  { id: 'follow', name: 'Follow this file', command: 'tail -f {path}', scope: 'file' },
  { id: 'cdhere', name: 'Open a terminal here', command: 'cd {path}', scope: 'folder' },
];

function settings() {
  return { theme: 'system', terminalFontSize: 13.5, copyOnSelect: false, autoUpdate: true, updateServers: true, autoHeal: true, healthInterval: 30, confirmDelete: true, showHidden: true, uploadOnSave: true, actions: DEFAULT_ACTIONS, ...(state.saved.settings || {}) };
}

function updateSettings(patch) {
  saveState({ settings: { ...settings(), ...patch } });
}

// ---------- running actions ----------

/** Quote a value for the server's shell (cmd.exe on Windows servers, POSIX sh elsewhere). */
function shellQuote(value, platform) {
  if (platform === 'win32') return `"${String(value).replace(/"/g, '""')}"`;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Fill {path} {name} {dir} {host} into a command template. */
function fillCommand(template, ctx) {
  const platform = state.info.get(ctx.host)?.platform;
  return template.replace(/\{(path|name|dir|host)\}/g, (_m, key) => {
    if (key === 'host') return ctx.host;
    const value = ctx[key];
    return value == null ? '' : shellQuote(value, platform);
  });
}

/** Switch to a server's terminal and type a command into it (queued until the session is ready). */
function runInTerminal(name, command) {
  const v = openSession(name, 'terminal', { reuse: true });
  if (!v) return;
  const send = () => {
    if (v.term?.id && !v.term.container.classList.contains('connecting')) {
      api.term.write(v.term.id, `${command}\r`);
      v.term.xterm.focus();
      return true;
    }
    return false;
  };
  if (send()) return;
  // Wait for the session to open (up to 20s).
  const started = Date.now();
  const timer = setInterval(() => {
    if (send() || Date.now() - started > 20_000) clearInterval(timer);
  }, 150);
}

/** Menu items for the user's actions that apply to a scope ('server', 'file' or 'folder'). */
function actionMenuItems(scope, ctx) {
  const actions = settings().actions.filter((a) => a.scope === scope && a.name && a.command);
  if (!actions.length) return [];
  return ['separator', ...actions.map((a) => ({ label: a.name, icon: 'play', hint: a.command.length > 22 ? `${a.command.slice(0, 21)}…` : a.command, run: () => runInTerminal(ctx.host, fillCommand(a.command, ctx)) }))];
}

// ---------- the settings page ----------

function renderSettings() {
  const s = settings();
  for (const radio of document.querySelectorAll('#set-theme input')) radio.checked = radio.value === s.theme;
  $('set-confirm-delete-label').textContent = `Ask before moving files to the ${TRASH}`;
  $('set-font-hint').textContent = keyName('Also Ctrl+= and Ctrl+− in a terminal, and Ctrl+0 to reset.');
  $('set-autoupdate').checked = s.autoUpdate;
  $('set-font-size').textContent = String(s.terminalFontSize);
  $('set-copy-select').checked = s.copyOnSelect;
  $('set-autoheal').checked = s.autoHeal;
  $('set-update-servers').checked = s.updateServers;
  for (const radio of document.querySelectorAll('#set-interval input')) radio.checked = Number(radio.value) === s.healthInterval;
  $('set-confirm-delete').checked = s.confirmDelete;
  $('set-hidden').checked = s.showHidden;
  $('set-upload-save').checked = s.uploadOnSave;
  renderActionList();
  call(api.identity()).then((id) => ($('set-fingerprint').textContent = id.fingerprint)).catch(() => {});
}

function renderActionList() {
  const list = $('action-list');
  const actions = settings().actions;
  list.replaceChildren(
    ...actions.map((action, index) => {
      const scope = el(
        'select',
        { ariaLabel: 'Applies to' },
        ...[
          ['server', 'Server'],
          ['folder', 'Folder'],
          ['file', 'File'],
        ].map(([value, label]) => el('option', { value, textContent: label, selected: action.scope === value })),
      );
      const name = el('input', { value: action.name, placeholder: 'Restart nginx', ariaLabel: 'Action name' });
      const command = el('input', { value: action.command, placeholder: 'sudo systemctl restart nginx', className: 'mono', ariaLabel: 'Command', spellcheck: false });
      const remove = el('button', { type: 'button', className: 'icon-btn', title: 'Delete this action', ariaLabel: 'Delete this action' }, icon('trash'));
      const save = () => {
        const next = settings().actions.map((a, i) => (i === index ? { ...a, name: name.value.trim(), command: command.value, scope: scope.value } : a));
        updateSettings({ actions: next });
      };
      for (const input of [name, command]) input.addEventListener('input', save);
      scope.addEventListener('change', save);
      remove.addEventListener('click', () => {
        updateSettings({ actions: settings().actions.filter((_, i) => i !== index) });
        renderActionList();
      });
      return el('div', { className: 'action-row' }, name, scope, command, remove);
    }),
  );
  $('action-empty').hidden = actions.length > 0;
}

$('add-action').addEventListener('click', () => {
  updateSettings({ actions: [...settings().actions, { id: `a${Date.now()}`, name: '', command: '', scope: 'server' }] });
  renderActionList();
  $('action-list').lastElementChild?.querySelector('input')?.focus();
});
$('reset-actions').addEventListener('click', async () => {
  if (!(await confirmDialog('Restore the example actions?', 'Your own actions are replaced by the three examples.', 'Restore'))) return;
  updateSettings({ actions: DEFAULT_ACTIONS });
  renderActionList();
});
// Saving the setting is enough: the main process switches Electron's theme, and js/theme.js follows.
$('set-theme').addEventListener('change', (e) => updateSettings({ theme: e.target.value }));
$('set-font-down').addEventListener('click', () => setTerminalFontSize(termFontSize() - 1));
$('set-font-up').addEventListener('click', () => setTerminalFontSize(termFontSize() + 1));
$('set-copy-select').addEventListener('change', (e) => updateSettings({ copyOnSelect: e.target.checked }));
$('set-autoupdate').addEventListener('change', (e) => updateSettings({ autoUpdate: e.target.checked }));
$('set-update-servers').addEventListener('change', (e) => updateSettings({ updateServers: e.target.checked }));
$('set-autoheal').addEventListener('change', (e) => updateSettings({ autoHeal: e.target.checked }));
$('set-interval').addEventListener('change', (e) => updateSettings({ healthInterval: Number(e.target.value) }));
$('set-confirm-delete').addEventListener('change', (e) => updateSettings({ confirmDelete: e.target.checked }));
$('set-upload-save').addEventListener('change', (e) => updateSettings({ uploadOnSave: e.target.checked }));
$('set-hidden').addEventListener('change', (e) => {
  updateSettings({ showHidden: e.target.checked });
  renderPane(localPane);
  renderPane(activeRemote());
});
$('set-show-key').addEventListener('click', async () => {
  const id = await call(api.identity());
  $('key-text').textContent = id.publicKey;
  $('key-fingerprint').textContent = id.fingerprint;
  $('key-dialog').showModal();
});
$('tab-settings').addEventListener('click', () => (activate(SETTINGS_PAGE), refocusTab(SETTINGS_PAGE)));

// Help: diagnostics for bug reports
$('diag-copy').addEventListener('click', async () => {
  const button = $('diag-copy');
  button.disabled = true;
  try {
    await call(api.copy(await call(api.diagnostics.summary())));
    toast('Diagnostics copied. Paste them into your bug report.');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});
$('diag-logs').addEventListener('click', () => call(api.diagnostics.openLogs()).catch((err) => toast(err.message)));
$('diag-report').addEventListener('click', () => window.open('https://github.com/Kaeden-Martinson/Swiftstream/issues/new', '_blank'));

// Close settings: back to the tab (or the servers page) you came from.
function closeSettings() {
  const back = state.returnTo;
  activate(back && state.sessions.has(back) ? back : null);
}
$('settings-close').addEventListener('click', closeSettings);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.page === 'settings' && !document.querySelector('dialog[open]')) closeSettings();
});

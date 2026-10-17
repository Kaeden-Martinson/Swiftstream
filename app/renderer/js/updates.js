'use strict';
// Shows what the background updater is doing: the "Restart to update" button on the tab bar, and the
// Updates section in Settings. The main process downloads updates; see setUpUpdates() in main.js.

function describeUpdate(u) {
  switch (u.state) {
    case 'dev':
      return { text: 'Updates are off when running from source.', action: null };
    case 'checking':
      return { text: 'Checking for updates…', action: null };
    case 'downloading':
      return { text: `Downloading version ${u.version}${u.percent ? ` (${u.percent}%)` : ''}…`, action: null };
    case 'ready':
      return { text: `Version ${u.version} is ready to install.`, action: 'Restart to update' };
    case 'current':
      return { text: "You're on the latest version.", action: 'Check now' };
    case 'error':
      return { text: `Couldn't check for updates${u.error ? `: ${u.error.split(/\r?\n/)[0]}` : '.'}`, action: 'Try again' };
    default:
      return { text: 'Updates are checked a few times a day.', action: 'Check now' };
  }
}

function renderUpdate(u) {
  state.update = u;
  $('update-btn').hidden = u.state !== 'ready';
  $('update-current').textContent = u.current || '';
  const { text, action } = describeUpdate(u);
  $('update-status').textContent = text;
  $('update-action').hidden = !action;
  if (action) $('update-action').textContent = action;
}

$('update-btn').addEventListener('click', () => call(api.updates.install()));
$('update-action').addEventListener('click', () => {
  if (state.update?.state === 'ready') call(api.updates.install());
  else call(api.updates.check());
});
api.updates.onState(renderUpdate);
call(api.updates.state()).then(renderUpdate).catch(() => {});

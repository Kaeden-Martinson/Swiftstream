'use strict';
// Server health from the main process: status dots, banners, and automatic restarts (see main.js).

api.health.onEvent(({ name, status, info, error }) => {
  if (!hostByName(name)) return;
  const wasHealing = state.status.get(name) === 'healing';
  if (status === 'up' || status === 'healed') {
    state.status.set(name, 'up');
    if (info) state.info.set(name, info);
  } else if (status === 'healing') {
    state.status.set(name, 'healing');
  } else {
    // A failed check during a restart shouldn't flip the dot back to red mid-heal.
    if (status === 'down' && wasHealing) return;
    state.status.set(name, 'down');
    if (error) state.lastError = { name, err: Object.assign(new Error(error.message), error) };
  }
  paintStatus(name);

  if (status === 'healing') {
    toast(`Restarting SwiftSSH on ${name}…`);
    if (state.active === name) showBanner({ message: `SwiftSSH stopped on ${name}. Restarting it over SSH…`, hint: 'Your terminal reconnects when it is back.' });
  } else if (status === 'healed') {
    toast(`SwiftSSH is running again on ${name}`);
    afterRecovered(name);
  } else if (status === 'up' && wasHealing) {
    afterRecovered(name);
  } else if (status === 'heal-failed' && state.active === name) {
    showBanner(state.lastError?.err || { message: `Couldn't restart SwiftSSH on ${name}.` });
  }
});

/** Server is back: clear the banner, reconnect an ended terminal, refresh its files. */
function afterRecovered(name) {
  if (state.active === name) {
    hideBanner();
    renderWorkspaceHeader();
  }
  const v = state.views.get(name);
  if (v?.term?.ended) {
    v.term.ended = false;
    v.term.xterm.write('\r\n\x1b[2mReconnecting…\x1b[0m\r\n');
    startSession(name);
  }
  // If this tab was opened while the server was down, its terminal or files never loaded: load them now.
  if (state.active === name) {
    if (v?.view === 'files') refreshPane(v.remote);
    showView(viewOf(name).view, { animate: false });
  }
}

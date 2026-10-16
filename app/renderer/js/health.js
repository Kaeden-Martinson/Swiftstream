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
    toast(`Restarting Swiftstream on ${name}…`);
    if (activeSession()?.host === name) showBanner({ message: `Swiftstream stopped on ${name}. Restarting it over SSH…`, hint: 'Your terminal reconnects when it is back.' });
  } else if (status === 'healed') {
    toast(`Swiftstream is running again on ${name}`);
    afterRecovered(name);
  } else if (status === 'up' && wasHealing) {
    afterRecovered(name);
  } else if (status === 'heal-failed' && activeSession()?.host === name) {
    showBanner(state.lastError?.err || { message: `Couldn't restart Swiftstream on ${name}.` });
  }
});

/** Server is back: clear the banner, reconnect an ended terminal, refresh its files. */
function afterRecovered(name) {
  for (const session of sessionsOf(name)) {
    if (session.term?.ended) {
      session.term.ended = false;
      session.term.xterm.write('\r\n\x1b[2mReconnecting…\x1b[0m\r\n');
      startSession(session);
    }
  }
  // If the visible tab was opened while the server was down, it never loaded: load it now.
  const active = activeSession();
  if (active?.host === name) {
    hideBanner();
    if (active.kind === 'files' && active.remote.listing) refreshPane(active.remote);
    showSession(active);
  }
  renderTabs();
}

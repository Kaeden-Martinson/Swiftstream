'use strict';
// Startup: load remembered state and servers, reopen the tabs that were open last time.

(async () => {
  try {
    state.saved = (await call(api.state.get())) || {};
    await loadHosts();
    // Reopen last time's tabs (older versions saved just server names: those become terminals).
    const saved = state.saved.tabs || (state.saved.openTabs || []).map((host) => ({ host, kind: 'terminal' }));
    const restored = saved.filter((t) => hostByName(t.host)).map((t) => createSession(t.host, t.kind === 'files' ? 'files' : 'terminal'));
    refreshStatuses(true);
    const active = restored[state.saved.activeIndex ?? -1];
    await activate(active ? active.id : null);
  } catch (err) {
    toast(err.message);
  }
})();

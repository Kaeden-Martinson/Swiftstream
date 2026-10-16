'use strict';
// Startup: load remembered state and servers, reopen the tabs that were open last time.

(async () => {
  try {
    state.saved = (await call(api.state.get())) || {};
    await loadHosts();
    state.openTabs = (state.saved.openTabs || []).filter((n) => hostByName(n));
    renderTabs();
    refreshStatuses(true);
    const last = state.saved.activeTab;
    state.page = 'home';
    await activate(last && hostByName(last) ? last : null);
  } catch (err) {
    toast(err.message);
  }
})();

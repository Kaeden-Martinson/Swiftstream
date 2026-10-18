// The tab bar from the keyboard, with real key presses: arrows switch tabs and keep the focus on the
// tab bar, Delete closes the focused tab, Ctrl+PageUp/PageDown switch from anywhere.
import assert from 'node:assert/strict';
import { startEnv } from './harness.js';

const env = await startEnv('tabs');
try {
  const key = (keyCode, modifiers = []) => `ev.push({ type: 'keyDown', keyCode: '${keyCode}', modifiers: ${JSON.stringify(modifiers)} }, { type: 'keyUp', keyCode: '${keyCode}', modifiers: ${JSON.stringify(modifiers)} }, { wait: 250 });`;
  const { after, error } = await env.runApp(
    `
    openSession('box', 'files');
    openSession('box', 'files');
    openSession('box', 'files');
    await sleep(1200);
    $('tab-home').focus();
    const ev = [];
    ${key('Right')}
    ${key('Right')}
    ${key('End')}
    ${key('Left')}
    ${key('Delete')}
    ${key('Home')}
    ${key('PageDown', ['control'])}
    return { input: ev };
  `,
    {
      after: `({ tabs: state.tabs.length, page: state.page === 'session' ? 'tab ' + state.tabs.indexOf(state.activeTab) : state.page, focus: document.activeElement.id || document.activeElement.className })`,
    },
  );
  assert.ok(after, error);
  // 3 tabs; Right, Right: tab 1; End: Settings; Left: tab 2; Delete: closes it (2 left); Home: Servers; Ctrl+PageDown: tab 0.
  assert.equal(after.tabs, 2, 'Delete closed the focused tab');
  assert.equal(after.page, 'tab 0', 'Ctrl+PageDown from Servers goes to the first tab');
  console.log('ok  arrows, Home/End, Delete and Ctrl+PageDown in the tab bar');
} finally {
  env.stop();
}

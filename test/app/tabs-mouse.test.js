// The tab bar with a real mouse: clicking a tab keeps the keyboard there (arrows switch tabs, even from a
// terminal tab), typing on a terminal's tab types in the terminal, and tabs can be dragged into a new order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv } from './harness.js';

const env = await startEnv('tabs-mouse');
try {
  const setup = `
    for (const id of [...state.tabs]) closeTab(id); // start from no tabs (an earlier run's are reopened)
    openSession('box', 'terminal');
    openSession('box', 'files');
    openSession('box', 'files');
    await until(() => state.sessions.get(state.tabs[0]).term?.id, 30000); // the terminal is connected
    await sleep(500);
    window.__screen = () => { const b = [...state.sessions.values()].find((x) => x.kind === 'terminal').term.xterm.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true) + '\\n'; return t.trimEnd(); };
    window.__order = () => state.tabs.map((id) => state.sessions.get(id).kind);
    const tabs = [...document.querySelectorAll('#open-tabs .srv-tab')];
    const at = (i, dx = 0) => { const r = tabs[i].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2 + dx), y: Math.round(r.top + r.height / 2) }; };
    const ev = [];
    const click = (p) => ev.push({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }, { type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 }, { wait: 400 });
    const key = (keyCode) => ev.push({ type: 'keyDown', keyCode }, { type: 'keyUp', keyCode }, { wait: 300 });
  `;

  // 1. Click the terminal tab, press Right: the next tab shows and the terminal got no keys.
  let run = await env.runApp(
    `${setup}
    window.__before = __screen();
    click(at(0));
    key('Right');
    return { input: ev };`,
    { after: `({ page: state.tabs.indexOf(state.activeTab), focus: document.activeElement.className, unchanged: __screen() === __before })` },
  );
  assert.ok(run.after, run.error);
  assert.equal(run.after.page, 1, 'Right after clicking the first tab shows the second');
  assert.match(run.after.focus, /srv-tab/, 'the keyboard stays on the tab bar');
  assert.equal(run.after.unchanged, true, 'nothing went to the terminal');
  console.log('ok  click a terminal tab, then arrows switch tabs');

  // 2. Drag the first tab past the third: the order changes and is saved.
  run = await env.runApp(
    `${setup}
    const a = at(0), b = at(2, 20);
    ev.push({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 12; k++) ev.push({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * k) / 12), y: a.y, button: 'left', modifiers: ['leftButtonDown'] });
    ev.push({ wait: 200 }, { type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 }, { wait: 600 });
    return { input: ev };`,
    { after: `({ order: __order() })` },
  );
  assert.ok(run.after, run.error);
  assert.deepEqual(run.after.order, ['files', 'files', 'terminal'], 'the terminal tab moved to the end');
  const saved = JSON.parse(fs.readFileSync(path.join(env.clientHome, 'app-state.json'), 'utf8')).tabs.map((t) => t.kind);
  assert.deepEqual(saved, ['files', 'files', 'terminal'], 'the new order is saved');
  console.log('ok  drag a tab to a new place; the order is saved');

  // 3. Enter on the terminal tab, then type: the keys reach the terminal.
  run = await env.runApp(
    `${setup}
    const terminalTab = __order().indexOf('terminal');
    click(at(terminalTab));
    key('Enter');
    ev.push({ type: 'keyDown', keyCode: 'X' }, { type: 'char', keyCode: 'x' }, { type: 'keyUp', keyCode: 'X' }, { wait: 300 });
    return { input: ev };`,
    { after: `({ focus: document.activeElement.className, screen: __screen() })` },
  );
  assert.ok(run.after, run.error);
  assert.match(run.after.focus, /xterm-helper-textarea/, 'Enter moves the keyboard into the terminal');
  assert.match(run.after.screen, /x$/, 'the typed x shows at the prompt');
  console.log('ok  Enter on a terminal tab, then typing goes to the terminal');
} finally {
  env.stop();
}

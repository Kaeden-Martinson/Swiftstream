// File browser with real mouse input: click, double-click, drag toward the other pane to move,
// drag the other way (or down) to draw a selection box.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv } from './harness.js';

const env = await startEnv('files');
const pc = path.join(env.work, 'pc');
for (let i = 1; i <= 12; i++) {
  if (i <= 4) fs.mkdirSync(path.join(pc, `folder-0${i}`), { recursive: true });
  else fs.writeFileSync(path.join(pc, `file-${String(i).padStart(2, '0')}.bin`), Buffer.alloc(1000 * i));
}

// Each case: open the folder, send real input, then read what happened.
const run = (gesture) =>
  env.runApp(
    `
    openSession('box', 'files');
    await sleep(1200);
    await navigate(localPane, ${JSON.stringify(pc.split(path.sep).join('/'))});
    await sleep(400);
    window.__log = [];
    const origStart = startDrag;
    window.startDrag = (...a) => { origStart(...a); __log.push('MOVE:' + drag.items.map((i) => i.name).join(',')); };
    const rows = [...document.querySelectorAll('#local-pane .fp-list tbody tr[data-name]')];
    const mid = (i) => { const r = rows[i].children[0].getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; };
    const ev = [];
    const down = (p, clickCount = 1) => ev.push({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount });
    const up = (p, clickCount = 1) => ev.push({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount });
    const path = (a, b, n = 10) => { for (let k = 1; k <= n; k++) ev.push({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * k) / n), y: Math.round(a.y + ((b.y - a.y) * k) / n), button: 'left', modifiers: ['leftButtonDown'] }); };
    ${gesture}
    return { input: ev };
  `,
    { after: `({ log: __log, selection: [...localPane.selection], folder: localPane.cwd.split(/[\\\\/]/).pop() })` },
  );

try {
  const cases = {
    click: [`const a = mid(6); down(a); up(a); ev.push({ wait: 200 });`, (r) => assert.deepEqual(r.selection, ['file-07.bin'])],
    'double-click opens a folder': [`const a = mid(1); down(a, 1); up(a, 1); ev.push({ wait: 60 }); down(a, 2); up(a, 2); ev.push({ wait: 400 });`, (r) => assert.equal(r.folder, 'folder-02')],
    'drag toward the server pane moves': [`const a = mid(4); down(a); path(a, { x: a.x + 300, y: a.y + 5 }); ev.push({ wait: 200 }); up({ x: a.x + 300, y: a.y + 5 });`, (r) => assert.deepEqual(r.log, ['MOVE:file-05.bin'])],
    'drag away draws a box': [`const a = mid(4), b = mid(7); down(a); path(a, { x: a.x - 40, y: b.y }); ev.push({ wait: 200 }); up({ x: a.x - 40, y: b.y });`, (r) => assert.deepEqual(r.selection, ['file-05.bin', 'file-06.bin', 'file-07.bin', 'file-08.bin'])],
    'drag down draws a box': [`const a = mid(4), b = mid(7); down(a); path(a, { x: a.x + 3, y: b.y }); ev.push({ wait: 200 }); up({ x: a.x + 3, y: b.y });`, (r) => assert.equal(r.selection.length, 4)],
  };
  for (const [name, [gesture, check]] of Object.entries(cases)) {
    const { after, error } = await run(gesture);
    assert.ok(after, `${name}: ${error}`);
    check(after);
    console.log(`ok  ${name}`);
  }
} finally {
  env.stop();
}

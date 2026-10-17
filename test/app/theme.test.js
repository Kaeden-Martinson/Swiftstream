// Settings › Appearance: switching theme recolors the app and its terminals straight away, and is kept.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv } from './harness.js';

const env = await startEnv('theme');
try {
  const { result, error } = await env.runApp(`
    openSession('box', 'terminal');
    const pane = await until(() => activeSession()?.panes?.[0]);
    activate(SETTINGS_PAGE);
    await sleep(300);
    const seen = [document.documentElement.dataset.theme];
    document.querySelector('#set-theme input[value="light"]').click();
    await until(() => document.documentElement.dataset.theme === 'light', 5000);
    await sleep(400); // let the color fade finish
    seen.push('light', getComputedStyle(document.body).backgroundColor, pane.xterm.options.theme.background);
    await api.devShot('light');
    document.querySelector('#set-theme input[value="dark"]').click();
    await until(() => document.documentElement.dataset.theme === 'dark', 5000);
    await sleep(400);
    seen.push('dark', getComputedStyle(document.body).backgroundColor, pane.xterm.options.theme.background);
    document.querySelector('#set-theme input[value="light"]').click();
    await until(() => document.documentElement.dataset.theme === 'light', 5000);
    await sleep(600); // saved after a short pause
    return { seen };
  `);
  assert.ok(result, error);
  assert.deepEqual(result.seen, ['dark', 'light', 'rgb(247, 248, 250)', '#f7f8fa', 'dark', 'rgb(14, 16, 19)', '#0e1013']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.clientHome, 'app-state.json'), 'utf8')).settings.theme, 'light');
  console.log('ok  light and dark switch live (app and terminal), and the choice is saved');
} finally {
  env.stop();
}

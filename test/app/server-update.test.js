// A server running an older Swiftstream: the app updates it when none of its terminals are open,
// and only says so (no update) while a terminal is open.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, startEnv } from './harness.js';

const current = fs.readFileSync(path.join(root, 'app', 'core', 'swiftstream.cjs'));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

for (const [kind, expectUpdate] of [['terminal', false], ['files', true]]) {
  const env0 = path.join(root, '.test-home', 'app', `old-bundle-${kind}.cjs`);
  fs.mkdirSync(path.dirname(env0), { recursive: true });
  fs.writeFileSync(env0, current.toString('utf8').replace(JSON.stringify(version), JSON.stringify('0.0.1')));
  const env = await startEnv(`server-update-${kind}`, { bundle: env0, settings: { healthInterval: 10 } });
  try {
    const remoteBundle = path.join(env.remoteHome, '.swiftstream', 'bin', 'swiftstream.cjs');
    assert.match(fs.readFileSync(remoteBundle, 'utf8'), /"0\.0\.1"/);
    const { result, error } = await env.runApp(`
      const toasts = [];
      const original = toast;
      window.toast = (t) => { toasts.push(t); original(t); };
      openSession('box', ${JSON.stringify(kind)});
      await sleep(${expectUpdate ? 45000 : 25000});
      return { toasts };
    `);
    assert.ok(result, error);
    const updated = fs.readFileSync(remoteBundle).equals(current);
    if (expectUpdate) {
      assert.ok(updated, 'the server was not updated');
      assert.ok(result.toasts.some((t) => t === `box is up to date (Swiftstream ${version})`), result.toasts.join(' | '));
      console.log('ok  updated while only a file browser was open');
    } else {
      assert.ok(!updated, 'updated while a terminal was open');
      assert.ok(result.toasts.some((t) => /runs an older Swiftstream \(0\.0\.1\)\. It updates once its terminals are closed/.test(t)), result.toasts.join(' | '));
      console.log('ok  waited while a terminal was open, and said so');
    }
  } finally {
    env.stop();
  }
}

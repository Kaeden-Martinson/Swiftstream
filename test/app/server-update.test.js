// A server running an older Swiftstream: the app updates it as soon as it logs in, before a terminal
// or file browser opens, and says which version it updated to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, startEnv } from './harness.js';

const current = fs.readFileSync(path.join(root, 'app', 'core', 'swiftstream.cjs'));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

for (const kind of ['terminal', 'files']) {
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
      await sleep(25000);
      return { toasts };
    `);
    assert.ok(result, error);
    assert.ok(fs.readFileSync(remoteBundle).equals(current), 'the server was not updated');
    assert.ok(result.toasts.includes(`Updated Swiftstream on box from 0.0.1 to ${version}`), result.toasts.join(' | '));
    console.log(`ok  updated on login before opening a ${kind === 'files' ? 'file browser' : 'terminal'}, and said to which version`);
  } finally {
    env.stop();
  }
}

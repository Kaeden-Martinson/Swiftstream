// Reconnecting in the app: when HTTPS fails, the app repairs the server over SSH (key login, no password),
// says what was wrong and what it fixed, and the terminal or folder opens anyway.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, startEnv } from './harness.js';

const env = await startEnv('repair');
const remoteDir = path.join(env.remoteHome, '.swiftstream');
const stopRemote = () => spawnSync(process.execPath, [path.join(root, 'dist', 'swiftstream.cjs'), 'stop'], { env: { ...process.env, SWIFTSTREAM_HOME: remoteDir } });

// The app's log says why each repair started (the first one can begin at startup, when the app checks
// every server, before a test script is running).
const logText = () => fs.readFileSync(path.join(env.clientHome, 'logs', 'swiftstream.log'), 'utf8');

const openAndWatch = (kind) => `
  window.__toasts = [];
  const original = toast;
  window.toast = (t) => { __toasts.push(t); original(t); };
  const session = openSession('box', ${JSON.stringify(kind)});
  await until(() => ${kind === 'terminal' ? "session.panes?.[0]?.id && !session.panes[0].container.classList.contains('connecting')" : 'session.remote?.listing'}, 60000);
  return { toasts: __toasts, ok: true };
`;

try {
  // 1. Swiftstream stopped: opening a terminal starts it again.
  stopRemote();
  let { result, error } = await env.runApp(openAndWatch('terminal'));
  assert.ok(result, error);
  assert.match(logText(), /server box repairing over SSH \{"reason":"stopped"\}/);
  assert.ok(result.toasts.some((t) => /box: Swiftstream had stopped, so it was started again/.test(t)), result.toasts.join(' | '));
  console.log('ok  stopped server: the terminal opens after a repair, and says what it fixed');

  // 2. This computer's key removed on the server: opening a folder authorizes it again.
  fs.writeFileSync(path.join(remoteDir, 'authorized_keys'), '');
  ({ result, error } = await env.runApp(openAndWatch('files')));
  assert.ok(result, error);
  assert.match(logText(), /server box repairing over SSH \{"reason":"key"\}/);
  assert.ok(result.toasts.some((t) => /key wasn't accepted, so it was authorized again/.test(t)), result.toasts.join(' | '));
  console.log("ok  key removed on the server: the folder opens after a repair, and says what it fixed");
} finally {
  env.stop();
}

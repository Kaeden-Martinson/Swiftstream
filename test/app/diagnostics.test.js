// Diagnostics: the log records startup, health and failures; the summary has versions, servers and the log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv } from './harness.js';

const env = await startEnv('diagnostics', { settings: { healthInterval: 10 } });
try {
  const { result, error } = await env.runApp(`
    await until(() => state.status.get('box') === 'up', 30000);
    await call(api.hosts.info('no-such-server')).catch(() => {}); // a failure for the log
    activate(SETTINGS_PAGE);
    document.getElementById('diag-copy').scrollIntoView({ block: 'center' });
    await sleep(300);
    await api.devShot('help');
    const summary = await call(api.diagnostics.summary());
    return { summary };
  `);
  assert.ok(result, error);
  const { summary } = result;
  assert.match(summary, /^Swiftstream diagnostics\nApp 0\.\d+\.\d+ \(Electron /);
  assert.match(summary, /box: 127\.0\.0\.1:\d+ \(SSH tester@127\.0\.0\.1\), up, Swiftstream \d+\.\d+\.\d+ on win32/);
  assert.match(summary, /INFO  Swiftstream started/);
  assert.match(summary, /INFO  server box up/);
  assert.match(summary, /WARN  hosts:info failed/);
  assert.doesNotMatch(summary, /s3cret|BEGIN .*PRIVATE KEY/);
  const logFile = path.join(env.clientHome, 'logs', 'swiftstream.log');
  assert.ok(fs.existsSync(logFile), 'log file in ~/.swiftstream/logs');
  console.log('ok  log written; summary has versions, servers and the log, no secrets');
} finally {
  env.stop();
}

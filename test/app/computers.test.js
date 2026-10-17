// Authorized computers dialog: list, remove one, the last one can't be removed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv } from './harness.js';

const env = await startEnv('computers');
try {
  // A second computer allowed on the server.
  const other = crypto.createPublicKey(crypto.generateKeyPairSync('ed25519').privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  fs.appendFileSync(path.join(env.remoteHome, '.swiftstream', 'authorized_keys'), `swiftstream-ed25519 ${other} old-laptop\n`);

  const { result, error } = await env.runApp(`
    await sleep(800);
    showComputers('box');
    await until(() => document.querySelectorAll('.computer-row').length === 2);
    const before = [...document.querySelectorAll('.computer-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim());
    await sleep(300);
    await api.devShot('computers');
    const row = [...document.querySelectorAll('.computer-row')].find((r) => r.innerText.includes('old-laptop'));
    row.querySelector('button').click();
    await until(() => document.getElementById('prompt-dialog').open);
    const confirmTitle = document.getElementById('prompt-title').textContent;
    document.getElementById('prompt-form').requestSubmit();
    await until(() => document.querySelectorAll('.computer-row').length === 1);
    const lastRemove = document.querySelector('.computer-row button');
    return { before, confirmTitle, after: document.querySelector('.computer-row').innerText.replace(/\\s+/g, ' ').trim(), lastDisabled: lastRemove.disabled };
  `);
  assert.ok(result, error);
  assert.equal(result.before.length, 2);
  assert.ok(result.before.some((r) => /This computer/.test(r) && /@/.test(r)), 'this computer, with its user@computer name');
  assert.ok(result.before.some((r) => /old-laptop/.test(r)));
  assert.equal(result.confirmTitle, 'Remove old-laptop?');
  assert.match(result.after, /This computer/);
  assert.equal(result.lastDisabled, true);
  const left = fs.readFileSync(path.join(env.remoteHome, '.swiftstream', 'authorized_keys'), 'utf8');
  assert.ok(!left.includes('old-laptop'));
  console.log('ok  computers listed with names, one removed, the last one kept');
} finally {
  env.stop();
}

// Transfers: pause and resume an upload (it arrives intact), cancel a download (nothing left behind),
// and the Transfers list shows both.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv } from './harness.js';

const env = await startEnv('transfers');
try {
  const pc = path.join(env.work, 'pc');
  const downloads = path.join(env.work, 'downloads');
  fs.mkdirSync(pc, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  const big = path.join(pc, 'big-upload.bin');
  fs.writeFileSync(big, crypto.randomBytes(300 * 1024 * 1024)); // big enough to pause on a fast loopback
  fs.writeFileSync(path.join(env.remoteHome, 'big-download.bin'), crypto.randomBytes(300 * 1024 * 1024));
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

  const { result, error } = await env.runApp(`
    openSession('box', 'files');
    await sleep(1500);
    await navigate(localPane, ${JSON.stringify(pc.split(path.sep).join('/'))});
    const remote = activeRemote();
    await navigate(remote, ${JSON.stringify(env.remoteHome.split(path.sep).join('/'))});

    const up = await call(api.transfers.upload('box', [${JSON.stringify(big)}], remote.cwd));
    await until(() => (transferJobs.get(up)?.done || 0) > 30 * 1024 * 1024);
    await api.transfers.pause(up);
    await until(() => transferJobs.get(up)?.state === 'paused');
    const paused = cards.get(up).card.innerText.replace(/\\s+/g, ' ');
    await api.devShot('paused');
    await api.transfers.resume(up);
    await until(() => transferJobs.get(up)?.state === 'done', 60000);

    const down = await call(api.transfers.download('box', [{ path: remote.cwd + '/big-download.bin', name: 'big-download.bin', isDirectory: false, size: 300 * 1024 * 1024 }], ${JSON.stringify(downloads)}));
    await until(() => (transferJobs.get(down)?.done || 0) > 20 * 1024 * 1024);
    // The speed shows once there's a moment of progress to measure.
    const speed = await until(() => /\\/s/.test(cards.get(down).status.innerText) && cards.get(down).status.innerText, 30000);
    await api.transfers.cancel(down);
    await until(() => transferJobs.get(down)?.state === 'canceled');

    toggleTransfersPanel(true);
    await sleep(400);
    await api.devShot('list');
    const listed = [...document.querySelectorAll('#transfers-list .tp-row')].map((r) => r.innerText.replace(/\\s+/g, ' '));
    return { paused, speed, listed };
  `);
  assert.ok(result, error);
  assert.match(result.paused, /Paused at [\d.]+ MB of 300 MB/);
  assert.match(result.speed, /MB\/s/);
  assert.deepEqual(result.listed.map((r) => r.replace(/·.*/, '').trim()), ['big-download.bin box', 'big-upload.bin box']);
  assert.match(result.listed[0], /Canceled/);
  assert.equal(sha(path.join(env.remoteHome, 'big-upload.bin')), sha(big));
  assert.deepEqual(fs.readdirSync(downloads), []);
  console.log('ok  upload paused, resumed and verified; download canceled cleanly; both listed');
} finally {
  env.stop();
}

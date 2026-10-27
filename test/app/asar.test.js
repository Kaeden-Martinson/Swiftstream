// An Electron app's build folder holds resources/app.asar. Inside the desktop app (Electron), Node's file
// functions open .asar files as folders, which made uploading such a folder fail with "ENOENT, not found
// in …app.asar". Upload one and download it back: both copies must be the same plain file.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv } from './harness.js';

const env = await startEnv('asar');
try {
  const build = path.join(env.work, 'pc', 'win-unpacked');
  const downloads = path.join(env.work, 'downloads');
  fs.mkdirSync(path.join(build, 'resources'), { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  // A real archive's layout (a pickled JSON header, then the files) so Electron would read it as one.
  const header = Buffer.from(JSON.stringify({ files: { 'main.js': { size: 5, offset: '0' } } }));
  const pickle = Buffer.alloc(16);
  pickle.writeUInt32LE(4, 0);
  pickle.writeUInt32LE(header.length + 8, 4);
  pickle.writeUInt32LE(header.length + 4, 8);
  pickle.writeUInt32LE(header.length, 12);
  const asar = Buffer.concat([pickle, header, Buffer.alloc((4 - (header.length % 4)) % 4), Buffer.from('hello'), crypto.randomBytes(64 * 1024)]);
  fs.writeFileSync(path.join(build, 'resources', 'app.asar'), asar);
  fs.writeFileSync(path.join(build, 'Swiftstream.exe'), crypto.randomBytes(32 * 1024));
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

  const { result, error } = await env.runApp(`
    openSession('box', 'files');
    await sleep(1500);
    const remote = activeRemote();
    await navigate(remote, ${JSON.stringify(env.remoteHome.split(path.sep).join('/'))});
    const up = await call(api.transfers.upload('box', [${JSON.stringify(build)}], remote.cwd));
    await until(() => ['done', 'failed'].includes(transferJobs.get(up)?.state), 60000);
    const upState = transferJobs.get(up).state + ' ' + (transferJobs.get(up).error?.message || '');
    const down = await call(api.transfers.download('box', [{ path: remote.cwd + '/win-unpacked', name: 'win-unpacked', isDirectory: true, size: 0 }], ${JSON.stringify(downloads)}));
    await until(() => ['done', 'failed'].includes(transferJobs.get(down)?.state), 60000);
    const downState = transferJobs.get(down).state + ' ' + (transferJobs.get(down).error?.message || '');
    return { upState, downState };
  `);
  assert.ok(result, error);
  assert.equal(result.upState.trim(), 'done', result.upState);
  assert.equal(result.downState.trim(), 'done', result.downState);
  const uploaded = path.join(env.remoteHome, 'win-unpacked', 'resources', 'app.asar');
  const downloaded = path.join(downloads, 'win-unpacked', 'resources', 'app.asar');
  assert.ok(fs.statSync(uploaded).isFile() && fs.statSync(downloaded).isFile());
  assert.equal(sha(uploaded), sha(path.join(build, 'resources', 'app.asar')));
  assert.equal(sha(downloaded), sha(uploaded));
  console.log('ok  a folder with an .asar file uploads and downloads as plain files');
} finally {
  env.stop();
}

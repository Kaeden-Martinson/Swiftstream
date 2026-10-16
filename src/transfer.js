import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { decodeBundle, encodeBundle } from './bundle.js';
import { hashFile, progressMeter, safeJoin, sameMtime, sleep, walk, writeFileAtomic } from './util.js';

const MAX_ATTEMPTS = 6;
// Files at or under this size travel packed in bundles; bigger ones get chunked parallel transfer.
const SMALL_FILE = 1024 * 1024;
const BUNDLE_BYTES = 8 * 1024 * 1024;
const BUNDLE_FILES = 1000;

/** Retries transient failures (network errors, 5xx) with exponential backoff; 4xx errors are final. */
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const fatal = err.status && err.status < 500 && err.status !== 408 && err.status !== 429;
      if (fatal || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(Math.min(250 * 2 ** attempt, 8000));
    }
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    }),
  );
}

/** Use the caller's progress meter if given, otherwise own one for the duration of `fn`. */
async function withMeter(opts, label, total, fn) {
  if (opts.meter) return fn(opts.meter);
  const meter = progressMeter(label, total);
  try {
    const result = await fn(meter);
    meter.finish();
    return result;
  } catch (err) {
    meter.stop();
    process.stderr.write('\n');
    throw err;
  }
}

function groupBundles(files) {
  const groups = [];
  let current = [];
  let bytes = 0;
  for (const f of files) {
    if (current.length && (bytes + f.size > BUNDLE_BYTES || current.length >= BUNDLE_FILES)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += f.size;
  }
  if (current.length) groups.push(current);
  return groups;
}

const totalSize = (files) => files.reduce((sum, f) => sum + f.size, 0);

/**
 * Upload a file as fixed-size chunks sent in parallel. Each chunk is hashed and
 * individually retried; the server tracks received chunks so a rerun resumes.
 */
export async function push(client, localPath, remotePath, opts = {}) {
  const { parallel = 8, chunkSize = 4 * 1024 * 1024 } = opts;
  const st = await fsp.stat(localPath);
  if (!st.isFile()) throw new Error(`${localPath} is not a file`);
  const sha256 = await hashFile(localPath);
  const init = await client.request('POST', '/v1/upload/init', {
    body: { path: remotePath, name: path.basename(localPath), size: st.size, sha256, chunkSize, mtime: st.mtimeMs },
  });
  const received = new Set(init.received);
  const pending = [...Array(init.chunks).keys()].filter((i) => !received.has(i));
  if (received.size) process.stderr.write(`resuming: ${received.size}/${init.chunks} chunks already on server\n`);

  return withMeter(opts, `push ${path.basename(localPath)}`, st.size, async (meter) => {
    meter.add(st.size - pending.reduce((sum, i) => sum + Math.min(chunkSize, st.size - i * chunkSize), 0));
    const fh = await fsp.open(localPath, 'r');
    try {
      await pool(pending, parallel, async (index) => {
        const offset = index * chunkSize;
        const length = Math.min(chunkSize, st.size - offset);
        const buf = Buffer.allocUnsafe(length);
        await fh.read(buf, 0, length, offset);
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        await withRetry(() =>
          client.request('PUT', '/v1/upload/chunk', {
            query: { id: init.id, index },
            body: buf,
            headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': digest },
          }),
        );
        meter.add(length);
      });
    } finally {
      await fh.close();
    }
    return withRetry(() => client.request('POST', '/v1/upload/complete', { query: { id: init.id }, timeout: 600_000 }));
  });
}

/** Download a file with parallel HTTP range requests, then verify its sha256. */
export async function pull(client, remotePath, localPath, opts = {}) {
  const { parallel = 8, chunkSize = 4 * 1024 * 1024 } = opts;
  const info = await client.request('GET', '/v1/stat', { query: { path: remotePath, hash: 1 }, timeout: 600_000 });
  if (info.isDirectory) throw new Error(`${info.path} is a directory`);
  if (fs.statSync(localPath, { throwIfNoEntry: false })?.isDirectory()) {
    localPath = path.join(localPath, remoteBasename(info.path));
  }
  const partPath = `${localPath}.swiftstream-part`;
  await fsp.mkdir(path.dirname(path.resolve(localPath)), { recursive: true });

  await withMeter(opts, `pull ${remoteBasename(info.path)}`, info.size, async (meter) => {
    const fh = await fsp.open(partPath, 'w');
    try {
      await fh.truncate(info.size);
      const chunks = [...Array(Math.ceil(info.size / chunkSize)).keys()];
      await pool(chunks, parallel, async (index) => {
        const start = index * chunkSize;
        const end = Math.min(start + chunkSize, info.size) - 1;
        const data = await withRetry(async () => {
          const res = await client.request('GET', '/v1/file', {
            query: { path: info.path },
            headers: { range: `bytes=${start}-${end}` },
            stream: true,
          });
          const parts = [];
          for await (const c of res) parts.push(c);
          const buf = Buffer.concat(parts);
          if (buf.length !== end - start + 1) throw new Error(`short read on chunk ${index}`);
          return buf;
        });
        await fh.write(data, 0, data.length, start);
        meter.add(data.length);
      });
    } finally {
      await fh.close();
    }
    const actual = await hashFile(partPath);
    if (actual !== info.sha256) {
      await fsp.rm(partPath, { force: true });
      throw new Error('checksum mismatch after download; file discarded');
    }
    await fsp.rename(partPath, localPath);
    await fsp.utimes(localPath, new Date(), info.mtime / 1000);
  });
  return { path: path.resolve(localPath), size: info.size, sha256: info.sha256 };
}

/**
 * Sync a local folder up to the host. Only files whose size or mtime differ are sent:
 * small ones packed into parallel bundles, large ones through chunked `push`.
 */
export async function pushDir(client, localDir, remoteDir, opts = {}) {
  const { parallel = 8 } = opts;
  const files = await walk(localDir);
  const plan = await client.request('POST', '/v1/sync/plan', {
    body: { root: remoteDir, files: files.map(({ path: p, size, mtime }) => ({ path: p, size, mtime })) },
    timeout: 600_000,
  });
  const need = new Set(plan.need);
  const todo = files.filter((f) => need.has(f.path));
  const small = todo.filter((f) => f.size <= SMALL_FILE);
  const large = todo.filter((f) => f.size > SMALL_FILE);

  await withMeter(opts, `push ${path.basename(path.resolve(localDir))}/`, totalSize(todo), async (meter) => {
    await pool(groupBundles(small), parallel, async (group) => {
      const entries = await Promise.all(
        group.map(async (f) => ({
          header: { path: f.path, mtime: f.mtime },
          data: await fsp.readFile(path.join(localDir, f.path)),
        })),
      );
      const body = encodeBundle(entries);
      await withRetry(() =>
        client.request('PUT', '/v1/bundle', {
          query: { root: plan.root },
          body,
          headers: { 'content-type': 'application/octet-stream' },
          timeout: 600_000,
        }),
      );
      meter.add(totalSize(group));
    });
    for (const f of large) await push(client, path.join(localDir, f.path), `${plan.root}/${f.path}`, { ...opts, meter });
  });
  return { root: plan.root, files: files.length, sent: todo.length, bytes: totalSize(todo) };
}

/** Mirror of pushDir: fetch a remote folder, skipping files we already have unchanged. */
export async function pullDir(client, remoteDir, localDir, opts = {}) {
  const { parallel = 8 } = opts;
  const listing = await client.request('GET', '/v1/list', { query: { path: remoteDir }, timeout: 600_000 });
  // The server's paths are untrusted too: safeJoin keeps every write inside localDir.
  const todo = listing.files
    .map((f) => ({ ...f, local: safeJoin(path.resolve(localDir), f.path) }))
    .filter((f) => {
      const st = fs.statSync(f.local, { throwIfNoEntry: false });
      return !st?.isFile() || st.size !== f.size || !sameMtime(st.mtimeMs, f.mtime);
    });
  const small = todo.filter((f) => f.size <= SMALL_FILE);
  const large = todo.filter((f) => f.size > SMALL_FILE);

  await withMeter(opts, `pull ${remoteBasename(listing.root)}/`, totalSize(todo), async (meter) => {
    await pool(groupBundles(small), parallel, async (group) => {
      const body = await withRetry(() =>
        client.request('POST', '/v1/bundle/read', {
          body: { root: listing.root, paths: group.map((f) => f.path) },
          timeout: 600_000,
        }),
      );
      for (const { header, data } of decodeBundle(body)) {
        await writeFileAtomic(safeJoin(path.resolve(localDir), header.path), data, header.mtime);
      }
      meter.add(totalSize(group));
    });
    for (const f of large) await pull(client, `${listing.root}/${f.path}`, f.local, { ...opts, meter });
  });
  return { root: path.resolve(localDir), files: listing.files.length, sent: todo.length, bytes: totalSize(todo) };
}

/** Basename of a path from the server, which may use either separator. */
export const remoteBasename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

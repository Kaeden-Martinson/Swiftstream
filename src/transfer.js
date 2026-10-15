import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashFile, progressMeter, sleep } from './util.js';

const MAX_ATTEMPTS = 6;

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

/**
 * Upload a file as fixed-size chunks sent in parallel. Each chunk is hashed and
 * individually retried; the server tracks received chunks so a rerun resumes.
 */
export async function push(client, localPath, remotePath, { parallel = 8, chunkSize = 4 * 1024 * 1024 } = {}) {
  const st = await fsp.stat(localPath);
  if (!st.isFile()) throw new Error(`${localPath} is not a file`);
  const sha256 = await hashFile(localPath);
  const init = await client.request('POST', '/v1/upload/init', {
    body: { path: remotePath, name: path.basename(localPath), size: st.size, sha256, chunkSize },
  });
  const received = new Set(init.received);
  const pending = [...Array(init.chunks).keys()].filter((i) => !received.has(i));
  if (received.size) process.stderr.write(`resuming: ${received.size}/${init.chunks} chunks already on server\n`);
  const meter = progressMeter(`push ${path.basename(localPath)}`, st.size);
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
    const result = await withRetry(() =>
      client.request('POST', '/v1/upload/complete', { query: { id: init.id }, timeout: 600_000 }),
    );
    meter.finish();
    return result;
  } catch (err) {
    meter.stop();
    process.stderr.write('\n');
    throw err;
  } finally {
    await fh.close();
  }
}

/** Download a file with parallel HTTP range requests, then verify its sha256. */
export async function pull(client, remotePath, localPath, { parallel = 8, chunkSize = 4 * 1024 * 1024 } = {}) {
  const info = await client.request('GET', '/v1/stat', { query: { path: remotePath, hash: 1 }, timeout: 600_000 });
  if (info.isDirectory) throw new Error(`${info.path} is a directory (directory transfer is not supported yet)`);
  if (fs.statSync(localPath, { throwIfNoEntry: false })?.isDirectory()) {
    localPath = path.join(localPath, path.basename(info.path));
  }
  const partPath = `${localPath}.swiftssh-part`;
  await fsp.mkdir(path.dirname(path.resolve(localPath)), { recursive: true });
  const fh = await fsp.open(partPath, 'w');
  const meter = progressMeter(`pull ${path.basename(info.path)}`, info.size);
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
  } catch (err) {
    meter.stop();
    process.stderr.write('\n');
    throw err;
  } finally {
    await fh.close();
  }
  const actual = await hashFile(partPath);
  if (actual !== info.sha256) {
    await fsp.rm(partPath, { force: true });
    throw new Error('checksum mismatch after download; file discarded');
  }
  await fsp.rename(partPath, localPath);
  meter.finish();
  return { path: path.resolve(localPath), size: info.size, sha256: actual };
}

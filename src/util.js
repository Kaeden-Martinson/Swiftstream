import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './errors.js';

/**
 * Join a relative path from the other side onto a local root, refusing anything that
 * would land outside it ("../x", "/etc/x", "C:\x"). Never trust the peer's paths.
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\')) {
    throw new Error(`unsafe path: ${rel}`);
  }
  const full = path.resolve(root, rel);
  const inside = path.relative(root, full);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`unsafe path: ${rel}`);
  }
  return full;
}

/** All regular files under `dir`, with '/'-separated relative paths. Symlinks are skipped. */
export async function walk(dir, base = dir, out = []) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, base, out);
    } else if (ent.isFile() && !/\.swift(stream|ssh)-part$/.test(ent.name)) {
      const st = await fsp.stat(full);
      out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

/** mtimes match to the second (filesystems differ in sub-second precision). */
export const sameMtime = (a, b) => Math.floor(a / 1000) === Math.floor(b / 1000);

/** Write via a temp file + rename so a reader never sees a half-written file. */
export async function writeFileAtomic(file, data, mtime) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.swiftstream-part`;
  await fsp.writeFile(part, data);
  await fsp.rename(part, file);
  if (mtime) await fsp.utimes(file, new Date(), mtime / 1000);
}

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(text).trim());
  if (!m) throw new UserError(`"${text}" isn't a size.`, 'Use a number with an optional unit, like 512KB, 4MB or 1GB.');
  return Math.round(Number(m[1]) * 1024 ** ' kmg'.indexOf(m[2].toLowerCase() || ' '));
}

export function formatDuration(secs) {
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m}m ${Math.round(secs % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Single-line progress bar on stderr; silent when stderr isn't a terminal. */
export function progressMeter(label, total) {
  const started = Date.now();
  let done = 0;
  const render = (final = false) => {
    if (!process.stderr.isTTY) return;
    const secs = Math.max((Date.now() - started) / 1000, 0.001);
    const rate = done / secs;
    const frac = total ? Math.min(done / total, 1) : 1;
    const width = Math.max(10, Math.min(30, (process.stderr.columns || 80) - label.length - 55));
    const filled = Math.round(frac * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const tail = final
      ? `${formatBytes(total)} in ${formatDuration(secs)} (${formatBytes(total / secs)}/s)`
      : `${formatBytes(done)} / ${formatBytes(total)}  ${formatBytes(rate)}/s  ${rate > 0 ? `${formatDuration((total - done) / rate)} left` : ''}`;
    process.stderr.write(`\r${label} ${bar} ${String(Math.floor(frac * 100)).padStart(3)}%  ${tail}\x1b[K`);
    if (final) process.stderr.write('\n');
  };
  const timer = setInterval(render, 200);
  return {
    add(n) {
      done += n;
    },
    finish() {
      clearInterval(timer);
      render(true);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The error a paused or canceled transfer stops with (signal.reason is 'pause' or 'cancel'). */
export function abortError(signal) {
  const err = new Error(signal?.reason === 'cancel' ? 'Transfer canceled' : 'Transfer paused');
  err.name = 'AbortError';
  err.reason = signal?.reason;
  return err;
}

export function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}

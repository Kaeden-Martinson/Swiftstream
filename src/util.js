import crypto from 'node:crypto';
import fs from 'node:fs';

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
  if (!m) throw new Error(`Invalid size: ${text}`);
  return Math.round(Number(m[1]) * 1024 ** ' kmg'.indexOf(m[2].toLowerCase() || ' '));
}

/** Single-line progress meter on stderr; silent when stderr isn't a terminal. */
export function progressMeter(label, total) {
  const started = Date.now();
  let done = 0;
  const render = (final = false) => {
    if (!process.stderr.isTTY && !final) return;
    const secs = Math.max((Date.now() - started) / 1000, 0.001);
    const rate = done / secs;
    const pct = total ? Math.floor((done / total) * 100) : 100;
    const eta = rate > 0 && !final ? ` ETA ${Math.ceil((total - done) / rate)}s` : ` in ${secs.toFixed(1)}s`;
    process.stderr.write(`\r${label}  ${pct}%  ${formatBytes(done)}/${formatBytes(total)}  ${formatBytes(rate)}/s${eta}\x1b[K`);
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

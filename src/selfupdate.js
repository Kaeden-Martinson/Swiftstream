import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isOlderVersion } from './version.js';

// Servers that opt in (swiftstream auto-update <name> on) update themselves from GitHub Releases:
// a few minutes after starting and then every 6 hours, a server asks for the latest release. A newer
// one's swiftstream-<v>.cjs is downloaded, checked against the release's SHA256SUMS.txt, and run once
// to make sure it starts and reports the new version. Swiftstream then waits until nobody is using it
// (no terminal open, no transfer for a while) and restarts on the new program; if that doesn't start,
// the previous program is put back.
//
// The download is trusted because it comes from this project's GitHub Releases over verified HTTPS;
// the checksum catches a broken download, not a compromised release.

export const RELEASES_API = process.env.SWIFTSTREAM_RELEASES_API || 'https://api.github.com/repos/Kaeden-Martinson/Swiftstream/releases/latest';
const CHECK_EVERY_MS = Number(process.env.SWIFTSTREAM_UPDATE_CHECK_MS) || 6 * 60 * 60_000;
const FIRST_CHECK_MS = Number(process.env.SWIFTSTREAM_UPDATE_CHECK_MS) || 5 * 60_000;
const IDLE_POLL_MS = Math.min(60_000, CHECK_EVERY_MS);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'swiftstream-server', accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function getBytes(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'swiftstream-server' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The latest release if it's newer than `current`: { version, bundleUrl, sumsUrl, name }, else null. */
export async function findUpdate(current) {
  const release = await getJson(RELEASES_API);
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!version || release.draft || release.prerelease || !isOlderVersion(current, version)) return null;
  const name = `swiftstream-${version}.cjs`;
  const asset = (n) => release.assets?.find((a) => a.name === n)?.browser_download_url;
  const bundleUrl = asset(name);
  const sumsUrl = asset('SHA256SUMS.txt');
  if (!bundleUrl || !sumsUrl) throw new Error(`release ${version} has no ${bundleUrl ? 'SHA256SUMS.txt' : name}`);
  return { version, name, bundleUrl, sumsUrl };
}

/**
 * Download the update next to `bundlePath` (as swiftstream.next.cjs: Node picks how to run a file by its
 * extension), check its SHA-256 against the release's list and that it runs and reports the expected
 * version. Returns the downloaded file's path.
 */
export async function downloadVerified(update, bundlePath) {
  const [bundle, sums] = await Promise.all([getBytes(update.bundleUrl), getBytes(update.sumsUrl)]);
  const expected = sums
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === update.name)?.[0];
  const actual = crypto.createHash('sha256').update(bundle).digest('hex');
  if (!expected) throw new Error(`SHA256SUMS.txt doesn't list ${update.name}`);
  if (expected.toLowerCase() !== actual) throw new Error(`${update.name} doesn't match its checksum (expected ${expected}, got ${actual})`);
  const next = bundlePath.replace(/(\.cjs)?$/, '.next.cjs');
  fs.writeFileSync(next, bundle, { mode: 0o700 });
  const ran = spawnSync(process.execPath, [next, '--version'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } });
  if (ran.status !== 0 || ran.stdout.trim() !== update.version) {
    fs.rmSync(next, { force: true });
    const output = (ran.stderr || ran.stdout || String(ran.error || '')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    throw new Error(`the downloaded ${update.version} didn't run here: ${output.find((l) => /error/i.test(l)) || output[0] || `exit code ${ran.status}`}`);
  }
  return next;
}

/**
 * Check for updates while `enabled()` (the server's setting), and once one is downloaded, call
 * `restart(file, version)` as soon as `isIdle()`. Returns a function that stops checking.
 */
export function startAutoUpdater({ current, bundlePath, enabled, isIdle, restart, log }) {
  let pending = null; // { file, version } downloaded and checked, waiting for a quiet moment
  let busy = false;
  let timer;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!enabled()) {
        if (pending) fs.rmSync(pending.file, { force: true });
        pending = null;
        return;
      }
      if (!pending) {
        const update = await findUpdate(current);
        if (!update) return;
        log('update', update.version, 'found; downloading');
        pending = { file: await downloadVerified(update, bundlePath), version: update.version };
        log('update', update.version, 'downloaded and checked; restarting when nobody is using Swiftstream');
      }
      if (isIdle()) {
        log('update', 'restarting on', pending.version);
        await restart(pending.file, pending.version);
      }
    } catch (err) {
      log('update check failed:', err.message);
    } finally {
      busy = false;
    }
  };

  const schedule = (ms) => {
    timer = setTimeout(async () => {
      await tick();
      // While an update waits for a quiet moment, look again every minute.
      schedule(pending ? IDLE_POLL_MS : CHECK_EVERY_MS);
    }, ms);
    timer.unref();
  };
  schedule(FIRST_CHECK_MS);
  return () => clearTimeout(timer);
}

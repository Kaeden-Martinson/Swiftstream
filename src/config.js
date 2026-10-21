import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// SWIFTSTREAM_HOME lets one machine act as both client and server (handy for tests).
// SWIFTSSH_HOME is the same setting from before the rename.
const HOME_OVERRIDE = process.env.SWIFTSTREAM_HOME || process.env.SWIFTSSH_HOME;
export const HOME_DIR = HOME_OVERRIDE || path.join(os.homedir(), '.swiftstream');

// The app was called SwiftSSH and kept its data in ~/.swiftssh. Copy it over once so keys, saved
// servers, pinned certificates and settings carry across. The old folder is left alone (an older
// copy of the app may still be running), apart from the old program and its pid file.
export const LEGACY_DIR = path.join(os.homedir(), '.swiftssh');
if (!HOME_OVERRIDE && !fs.existsSync(HOME_DIR) && fs.existsSync(LEGACY_DIR)) {
  try {
    fs.cpSync(LEGACY_DIR, HOME_DIR, { recursive: true, filter: (src) => !/[\\/](server\.pid|bin|uploads)$/.test(src) });
  } catch {
    /* start fresh rather than fail */
  }
}

export const paths = {
  dir: HOME_DIR,
  clientKey: path.join(HOME_DIR, 'id_ed25519'),
  serverKey: path.join(HOME_DIR, 'server_key.pem'),
  serverCert: path.join(HOME_DIR, 'server_cert.pem'),
  authorizedKeys: path.join(HOME_DIR, 'authorized_keys'),
  hosts: path.join(HOME_DIR, 'hosts.json'),
  uploads: path.join(HOME_DIR, 'uploads'),
  pid: path.join(HOME_DIR, 'server.pid'),
  log: path.join(HOME_DIR, 'server.log'),
};

export const DEFAULT_PORT = 7022;
// Also served on 443 where possible: networks that only let web traffic out (school, work) allow it.
// SWIFTSTREAM_WEB_PORT changes it (0 for none), e.g. for tests, which must not take the real 443.
export const DEFAULT_WEB_PORT = process.env.SWIFTSTREAM_WEB_PORT !== undefined ? Number(process.env.SWIFTSTREAM_WEB_PORT) || 0 : 443;

export function ensureDir(dir = HOME_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function loadHosts() {
  return readJson(paths.hosts, {});
}

export function getHost(name) {
  const host = loadHosts()[name];
  if (!host) throw new Error(`Unknown host "${name}". Add it with "swiftstream add" or "swiftstream deploy".`);
  return host;
}

export function saveHost(name, entry) {
  const hosts = loadHosts();
  hosts[name] = entry;
  writeJson(paths.hosts, hosts);
}

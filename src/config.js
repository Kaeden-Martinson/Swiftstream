import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// SWIFTSSH_HOME lets one machine act as both client and server (handy for tests).
export const HOME_DIR = process.env.SWIFTSSH_HOME || path.join(os.homedir(), '.swiftssh');

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
  if (!host) throw new Error(`Unknown host "${name}". Add it with "swiftssh add" or "swiftssh deploy".`);
  return host;
}

export function saveHost(name, entry) {
  const hosts = loadHosts();
  hosts[name] = entry;
  writeJson(paths.hosts, hosts);
}

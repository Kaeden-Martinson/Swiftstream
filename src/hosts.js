import { DEFAULT_PORT, loadHosts, saveHost, writeJson, paths } from './config.js';
import { UserError } from './errors.js';
import { connectClient } from './client.js';
import { deployOverSsh } from './deploy.js';
import { loadOrCreateIdentity } from './keys.js';
import { fetchServerCert } from './tls.js';

// Host management shared by the CLI and the desktop app.

export function validateHostName(name) {
  if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(name || '')) {
    throw new UserError(`"${name}" isn't a valid name.`, 'Use letters, numbers, dots, dashes or underscores, like "prod" or "web-1".');
  }
}

export function getHostOrExplain(name) {
  const hosts = loadHosts();
  if (hosts[name]) return hosts[name];
  const names = Object.keys(hosts);
  const guess = closest(name, names);
  throw new UserError(
    `There's no saved host called "${name}".`,
    guess ? `Did you mean "${guess}"?` : names.length ? `Your hosts: ${names.join(', ')}` : 'Add one with "swiftstream setup".',
  );
}

export function removeHost(name) {
  const hosts = loadHosts();
  if (!hosts[name]) return false;
  delete hosts[name];
  writeJson(paths.hosts, hosts);
  return true;
}

/**
 * Change a saved server: rename it, move it to a group, or update its address or SSH login.
 * The pinned certificate stays, so a new address must still be the same Swiftstream server.
 * Returns the (possibly new) name.
 */
export function updateHost(name, changes) {
  const hosts = loadHosts();
  const host = hosts[name];
  if (!host) throw new UserError(`There's no saved host called "${name}".`);
  const newName = (changes.name ?? name).trim();
  validateHostName(newName);
  if (newName !== name && hosts[newName]) throw new UserError(`A server called "${newName}" already exists.`, 'Pick a different name.');

  const updated = { ...host };
  if (changes.address !== undefined) updated.url = normalizeUrl(changes.address).origin;
  if (changes.group !== undefined) {
    const group = String(changes.group || '').trim();
    if (group.length > 40) throw new UserError('Group names can be at most 40 characters.');
    if (group) updated.group = group;
    else delete updated.group;
  }
  if (changes.ssh !== undefined) {
    const ssh = String(changes.ssh || '').trim();
    if (ssh && !/^(?:[^@\s]+@)?[\w.-]+$/.test(ssh)) throw new UserError(`"${ssh}" isn't a valid SSH login.`, 'Use the form user@hostname.');
    if (ssh) updated.ssh = ssh;
    else delete updated.ssh;
  }
  if (changes.sshPort !== undefined) {
    const port = Number(changes.sshPort) || 22;
    if (port < 1 || port > 65535) throw new UserError('The SSH port must be between 1 and 65535.');
    if (port === 22) delete updated.sshPort;
    else updated.sshPort = port;
  }

  // Rebuild the object so a rename keeps the server's position in the list.
  const next = {};
  for (const [key, value] of Object.entries(hosts)) next[key === name ? newName : key] = key === name ? updated : value;
  writeJson(paths.hosts, next);
  return newName;
}

/** "1.2.3.4", "box:7022" or "https://box:7022" -> URL with the default port filled in. */
export function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new UserError(`"${raw}" doesn't look like an address.`, 'Use a hostname or IP, optionally with a port, like 192.168.1.20:7022.');
  }
  url.protocol = 'https:';
  if (!url.port) url.port = String(DEFAULT_PORT);
  return url;
}

/** First step of adding a host by address: fetch its certificate so the user can check the fingerprint. */
export async function probeHost(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const { cert, fingerprint } = await fetchServerCert(url.toString());
  return { url: url.origin, cert, fingerprint };
}

export function saveProbedHost(name, probe) {
  validateHostName(name);
  saveHost(name, { url: probe.url, fingerprint: probe.fingerprint, cert: probe.cert });
}

/**
 * Log in to a server over SSH (key or password), start swiftstream there, authorize this computer,
 * and save it. See deployOverSsh for the callbacks (askPassword, confirmHostKey, onStep).
 */
export async function deployHost({ name, target, sshPort, port = DEFAULT_PORT, ...sshOptions }) {
  validateHostName(name);
  const identity = loadOrCreateIdentity();
  const ready = await deployOverSsh({ target, sshPort, port, publicKey: identity.publicKeyString, identityKey: identity.privateKey, ...sshOptions });
  const address = ready.host.includes(':') ? `[${ready.host}]` : ready.host;
  const existing = loadHosts()[name];
  // Restarting a saved server keeps its group, and its address if the identity is unchanged
  // (the user may have edited it, e.g. to a DNS name).
  const sameServer = existing && existing.fingerprint === ready.fingerprint;
  const host = {
    ...(existing || {}),
    url: sameServer ? existing.url : `https://${address}:${ready.port}`,
    fingerprint: ready.fingerprint,
    cert: ready.cert,
    ssh: target,
  };
  if (sshPort && Number(sshPort) !== 22) host.sshPort = Number(sshPort);
  else delete host.sshPort;
  saveHost(name, host);
  sshOptions.onStep?.('Connecting to Swiftstream');
  let client;
  try {
    client = await connectClient(host, identity);
    return { host, info: await client.request('GET', '/v1/info'), autostart: ready.autostart };
  } catch (err) {
    if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'].includes(err.code) || /timed out/.test(err.message)) {
      throw new UserError(
        `Swiftstream is running on ${ready.host}, but port ${ready.port} can't be reached from here.`,
        `Open ${ready.port}/tcp in the server's firewall (for example "sudo ufw allow ${ready.port}/tcp", or your cloud provider's security group), then run "swiftstream connect ${name}".`,
      );
    }
    throw err;
  } finally {
    client?.close();
  }
}

/** Closest name by edit distance, for "did you mean" suggestions. */
export function closest(input, candidates, maxDistance = 2) {
  let best = null;
  let bestDist = maxDistance + 1;
  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reads ~/.ssh/config so servers people already use with ssh can be set up in one step, and so
// "swiftstream connect myalias" means the same machine as "ssh myalias".
// Supported: Host (exact aliases; patterns like * are skipped), HostName, User, Port,
// IdentityFile (the first one) and Include (with * in file names). Match blocks are skipped.

const sshDir = () => path.join(os.homedir(), '.ssh');

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Files named by an Include line: relative paths are under ~/.ssh, and * matches within a file name. */
function includeFiles(pattern) {
  const full = path.resolve(sshDir(), expandHome(pattern));
  if (!full.includes('*')) return fs.existsSync(full) ? [full] : [];
  const dir = path.dirname(full);
  const re = new RegExp(`^${path.basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Split "Key value", "Key=value" and quoted values. */
function parseLine(line) {
  const m = line.match(/^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$/);
  if (!m) return null;
  const values = [...m[2].matchAll(/"([^"]*)"|(\S+)/g)].map((v) => v[1] ?? v[2]);
  return { key: m[1].toLowerCase(), values };
}

/**
 * Hosts from an ssh config text: [{ alias, hostname, user, port, identityFile }]. Settings from a
 * "Host *" block fill in what a host leaves out, as ssh does (the first value found wins).
 */
export function parseSshConfig(text, { readInclude = includeFiles, readFile = (f) => fs.readFileSync(f, 'utf8'), depth = 0 } = {}) {
  const blocks = []; // { patterns, settings }
  let current = { patterns: ['*'], settings: {}, global: true };
  blocks.push(current);
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { key, values } = parsed;
    if (key === 'host') {
      current = { patterns: values, settings: {} };
      blocks.push(current);
    } else if (key === 'match') {
      current = { patterns: [], settings: {} }; // not supported: its settings apply to nothing
      blocks.push(current);
    } else if (key === 'include' && depth < 8) {
      for (const file of values.flatMap((v) => readInclude(v))) {
        try {
          const inner = parseSshConfig(readFile(file), { readInclude, readFile, depth: depth + 1 });
          blocks.push(...inner.blocks);
        } catch {
          /* unreadable include: skip it, like a missing one */
        }
      }
    } else if (!(key in current.settings)) {
      current.settings[key] = values[0];
    }
  }

  const matches = (pattern, alias) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(alias);
  const settingsFor = (alias) => {
    const merged = {};
    for (const block of blocks) {
      const negated = block.patterns.some((p) => p.startsWith('!') && matches(p.slice(1), alias));
      if (negated || !block.patterns.some((p) => !p.startsWith('!') && matches(p, alias))) continue;
      for (const [k, v] of Object.entries(block.settings)) if (!(k in merged)) merged[k] = v;
    }
    return merged;
  };

  const seen = new Set();
  const hosts = [];
  for (const block of blocks) {
    for (const alias of block.patterns) {
      if (/[*?!]/.test(alias) || seen.has(alias.toLowerCase())) continue;
      seen.add(alias.toLowerCase());
      const s = settingsFor(alias);
      hosts.push({
        alias,
        hostname: s.hostname || alias,
        user: s.user || null,
        port: Number(s.port) || 22,
        identityFile: s.identityfile ? path.resolve(expandHome(s.identityfile.replace(/%d/g, os.homedir()))) : null,
      });
    }
  }
  return Object.assign(hosts, { blocks });
}

/** Hosts from ~/.ssh/config (or the file in SWIFTSTREAM_SSH_CONFIG, like ssh -F), or [] if there isn't one. */
export function readSshConfig() {
  const file = process.env.SWIFTSTREAM_SSH_CONFIG || path.join(sshDir(), 'config');
  try {
    return [...parseSshConfig(fs.readFileSync(file, 'utf8'))];
  } catch {
    return [];
  }
}

/** The ssh config entry for an alias (case-insensitive), or null. */
export function sshConfigHost(alias) {
  return readSshConfig().find((h) => h.alias.toLowerCase() === String(alias).toLowerCase()) || null;
}

/** "user@hostname" for setup; without a User line, the local user name, as ssh does. */
export function sshTarget(entry) {
  return `${entry.user || os.userInfo().username}@${entry.hostname}`;
}

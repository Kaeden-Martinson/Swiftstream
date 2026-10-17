import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { ensureDir, paths } from './config.js';

const KEY_TYPE = 'swiftstream-ed25519';
// Keys written before the rename say "swiftssh-ed25519"; they are the same keys.
const LEGACY_KEY_TYPE = 'swiftssh-ed25519';

export function loadOrCreateIdentity() {
  ensureDir();
  if (!fs.existsSync(paths.clientKey)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(paths.clientKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(paths.clientKey));
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyString: encodePublicKey(publicKey) };
}

export function encodePublicKey(publicKey) {
  return `${KEY_TYPE} ${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`;
}

/** Parses "swiftstream-ed25519 <base64> [comment]" into a KeyObject. */
export function decodePublicKey(line) {
  const [type, b64] = line.trim().split(/\s+/);
  if ((type !== KEY_TYPE && type !== LEGACY_KEY_TYPE) || !b64) throw new Error('Not a swiftstream public key');
  const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Only ed25519 keys are supported');
  return key;
}

/** Canonical "type base64" form, without any trailing comment (old-name keys compare equal to new). */
export function normalizePublicKey(line) {
  const [type, b64] = line.trim().split(/\s+/);
  return `${type === LEGACY_KEY_TYPE ? KEY_TYPE : type} ${b64}`;
}

// ---- the same Ed25519 key in OpenSSH formats (for logging in over SSH without a password) ----

const sshString = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};

const rawKeyParts = (privateKey) => {
  const jwk = privateKey.export({ format: 'jwk' });
  return { seed: Buffer.from(jwk.d, 'base64url'), pub: Buffer.from(jwk.x, 'base64url') };
};

/** "ssh-ed25519 AAAA... comment", for a server's ~/.ssh/authorized_keys. */
export function sshPublicKeyLine(privateKey, comment = 'swiftstream') {
  const { pub } = rawKeyParts(privateKey);
  return `ssh-ed25519 ${Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]).toString('base64')} ${comment}`;
}

/** The private key as an unencrypted "OPENSSH PRIVATE KEY" block (openssh-key-v1), which ssh2 can read. */
export function sshPrivateKeyPem(privateKey, comment = 'swiftstream') {
  const { seed, pub } = rawKeyParts(privateKey);
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = crypto.randomBytes(4);
  let secret = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad = [];
  for (let i = 1; (secret.length + pad.length) % 8 !== 0; i++) pad.push(i);
  secret = Buffer.concat([secret, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(secret),
  ]);
  const b64 = body.toString('base64').match(/.{1,70}/g).join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export function keyFingerprint(line) {
  const b64 = normalizePublicKey(line).split(' ')[1];
  const digest = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * The signed auth message is bound to the server's TLS certificate fingerprint,
 * so a signature captured by one server can't be replayed against another.
 */
export function authMessage(nonce, certFingerprint) {
  return Buffer.from(`swiftssh-auth-v1\n${nonce}\n${certFingerprint}`);
}

export function sign(privateKey, message) {
  return crypto.sign(null, message, privateKey).toString('base64');
}

export function verify(publicKey, message, signature) {
  try {
    return crypto.verify(null, message, publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function readAuthorizedKeys() {
  let text = '';
  try {
    text = fs.readFileSync(paths.authorizedKeys, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Adds a key to authorized_keys. Returns false if it was already present (a label given now is
 * added to an unlabeled entry, so servers set up earlier learn which computer a key belongs to).
 */
export function authorizeKey(line) {
  decodePublicKey(line); // validate before writing
  const normalized = normalizePublicKey(line);
  const label = keyLabel(line);
  const existing = readAuthorizedKeys().find((k) => normalizePublicKey(k) === normalized);
  if (existing) {
    if (label && !keyLabel(existing)) rewriteAuthorizedKeys((l) => (l.trim() === existing ? line.trim() : l));
    return false;
  }
  ensureDir();
  fs.appendFileSync(paths.authorizedKeys, line.trim() + '\n', { mode: 0o600 });
  return true;
}

/** The label after the key ("kaede@laptop"), or null. */
const keyLabel = (line) => line.trim().split(/\s+/).slice(2).join(' ') || null;

/** "user@computer" for this machine: saved with its key on a server, to tell computers apart there. */
export function computerLabel() {
  let user = 'user';
  try {
    user = os.userInfo().username;
  } catch {
    /* no user name available */
  }
  return `${user}@${os.hostname()}`.replace(/[^\w.@-]/g, '-').slice(0, 64);
}

/** The computers allowed to log in: [{ key, fingerprint, label }]. */
export function authorizedKeyEntries() {
  return readAuthorizedKeys().flatMap((line) => {
    try {
      decodePublicKey(line);
      return [{ key: normalizePublicKey(line), fingerprint: keyFingerprint(line), label: keyLabel(line) }];
    } catch {
      return []; // not a Swiftstream key line
    }
  });
}

/** Remove the key with this fingerprint. Returns how many lines were removed. */
export function removeAuthorizedKey(fingerprint) {
  let removed = 0;
  rewriteAuthorizedKeys((line) => {
    try {
      if (line.trim() && !line.trim().startsWith('#') && keyFingerprint(line) === fingerprint) {
        removed++;
        return null;
      }
    } catch {
      /* keep lines we can't read */
    }
    return line;
  });
  return removed;
}

/** Rewrite authorized_keys line by line (map to null to drop a line), atomically. */
function rewriteAuthorizedKeys(mapLine) {
  let text = '';
  try {
    text = fs.readFileSync(paths.authorizedKeys, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const lines = text.split(/\r?\n/).filter((l, i, all) => l || i < all.length - 1);
  const next = lines.map(mapLine).filter((l) => l !== null);
  const tmp = `${paths.authorizedKeys}.tmp`;
  fs.writeFileSync(tmp, next.length ? next.join('\n') + '\n' : '', { mode: 0o600 });
  fs.renameSync(tmp, paths.authorizedKeys);
}

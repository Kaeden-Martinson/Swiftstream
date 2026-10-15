import crypto from 'node:crypto';
import fs from 'node:fs';
import { ensureDir, paths } from './config.js';

const KEY_TYPE = 'swiftssh-ed25519';

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

/** Parses "swiftssh-ed25519 <base64> [comment]" into a KeyObject. */
export function decodePublicKey(line) {
  const [type, b64] = line.trim().split(/\s+/);
  if (type !== KEY_TYPE || !b64) throw new Error('Not a swiftssh public key');
  const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Only ed25519 keys are supported');
  return key;
}

/** Canonical "type base64" form, without any trailing comment. */
export function normalizePublicKey(line) {
  return line.trim().split(/\s+/).slice(0, 2).join(' ');
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

/** Adds a key to authorized_keys. Returns false if it was already present. */
export function authorizeKey(line) {
  decodePublicKey(line); // validate before writing
  const normalized = normalizePublicKey(line);
  if (readAuthorizedKeys().some((k) => normalizePublicKey(k) === normalized)) return false;
  ensureDir();
  fs.appendFileSync(paths.authorizedKeys, line.trim() + '\n', { mode: 0o600 });
  return true;
}

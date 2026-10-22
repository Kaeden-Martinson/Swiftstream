import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import selfsigned from 'selfsigned';
import { ensureDir, paths } from './config.js';
import { SWIFTSTREAM_SNI } from './sni.js';

/** The server's long-lived identity: a self-signed cert, pinned by clients like an SSH host key. */
export function loadOrCreateServerCert() {
  ensureDir();
  if (!fs.existsSync(paths.serverKey) || !fs.existsSync(paths.serverCert)) {
    const pems = selfsigned.generate([{ name: 'commonName', value: `swiftstream@${os.hostname()}` }], {
      keySize: 2048,
      days: 3650,
      algorithm: 'sha256',
    });
    fs.writeFileSync(paths.serverKey, pems.private, { mode: 0o600 });
    fs.writeFileSync(paths.serverCert, pems.cert, { mode: 0o644 });
  }
  const key = fs.readFileSync(paths.serverKey, 'utf8');
  const cert = fs.readFileSync(paths.serverCert, 'utf8');
  return { key, cert, fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
}

/**
 * TLS options that trust exactly one pinned certificate and nothing else.
 * The cert is its own CA, and checkServerIdentity replaces hostname checks with a fingerprint match.
 */
export function pinnedTlsOptions(host) {
  return {
    // Names Swiftstream in the TLS hello, so a port it shares with a website can tell its connections
    // apart without decrypting anything (see sni.js). Swiftstream itself doesn't check it.
    servername: SWIFTSTREAM_SNI,
    ca: host.cert,
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) =>
      cert.fingerprint256 === host.fingerprint
        ? undefined
        : new Error(
            `HOST IDENTIFICATION CHANGED for ${host.url}\n  expected ${host.fingerprint}\n  got      ${cert.fingerprint256}\n` +
              'Someone could be intercepting the connection. Re-add the host only if you know why it changed.',
          ),
  };
}

/** Trust-on-first-use: fetch a server's certificate without verifying it, so the user can confirm the fingerprint. */
export function fetchServerCert(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hostname, port: Number(port) || 443, rejectUnauthorized: false, servername: '' }, () => {
      const peer = socket.getPeerCertificate();
      socket.end();
      if (!peer?.raw) return reject(new Error('Server did not present a certificate'));
      const b64 = peer.raw.toString('base64').match(/.{1,64}/g).join('\n');
      resolve({ cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, fingerprint: peer.fingerprint256 });
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => socket.destroy(new Error('Timed out connecting to server')));
  });
}

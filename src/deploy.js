import { spawn } from 'node:child_process';
import { DEFAULT_PORT } from './config.js';

const READY_PREFIX = 'SWIFTSSH_READY ';

/**
 * Use the user's existing SSH access once to install/start swiftssh on a host, authorize
 * our key there, and learn its certificate. The cert arrives over the already-authenticated
 * SSH channel, so no trust-on-first-use prompt is needed.
 */
export function deployOverSsh({ target, sshPort, port = DEFAULT_PORT, remoteCmd = 'npx -y swiftssh', publicKey }) {
  if (!/^[\w.@-]+$/.test(target)) throw new Error(`Invalid ssh target: ${target}`);
  if (!/^swiftssh-ed25519 [A-Za-z0-9+/=]+$/.test(publicKey)) throw new Error('Invalid public key');
  const command = `${remoteCmd} serve --daemon --port ${Number(port)} --authorize "${publicKey}"`;
  const args = [...(sshPort ? ['-p', String(sshPort)] : []), target, command];
  process.stderr.write(`running on ${target}: ${command}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['inherit', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('error', (err) => reject(new Error(`could not run ssh: ${err.message}`)));
    child.on('close', (code) => {
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(READY_PREFIX));
      if (!line) return reject(new Error(`remote start failed (ssh exit ${code})\n${stdout.trim()}`));
      resolve(parseReadyLine(line));
    });
  });
}

/** One machine-readable line the server prints when it is up, so deploy can pin its cert. */
export function readyLine({ port, fingerprint, cert }) {
  return READY_PREFIX + Buffer.from(JSON.stringify({ port, fingerprint, cert })).toString('base64');
}

export function parseReadyLine(line) {
  return JSON.parse(Buffer.from(line.slice(READY_PREFIX.length), 'base64').toString());
}

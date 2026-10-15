import { spawn } from 'node:child_process';
import { DEFAULT_PORT } from './config.js';
import { UserError } from './errors.js';

const READY_PREFIX = 'SWIFTSSH_READY ';

/**
 * Use the user's existing SSH access once to install/start swiftssh on a host, authorize
 * our key there, and learn its certificate. The cert arrives over the already-authenticated
 * SSH channel, so no trust-on-first-use prompt is needed.
 *
 * batch: no terminal to ask for passwords (desktop app), so key-based ssh login is required.
 */
export function deployOverSsh({ target, sshPort, port = DEFAULT_PORT, remoteCmd = 'npx -y swiftssh', publicKey, batch = false }) {
  if (!/^swiftssh-ed25519 [A-Za-z0-9+/=]+$/.test(publicKey)) throw new Error('Invalid public key');
  const command = `${remoteCmd} serve --daemon --port ${Number(port)} --authorize "${publicKey}"`;
  const args = [
    ...(batch ? ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'] : []),
    ...(sshPort ? ['-p', String(sshPort)] : []),
    target,
    command,
  ];

  return new Promise((resolve, reject) => {
    // Password prompts go to the tty directly, so stderr can be captured for diagnosis.
    const child = spawn('ssh', args, { stdio: [batch ? 'ignore' : 'inherit', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!batch) process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(READY_PREFIX));
      if (line) return resolve(parseReadyLine(line));
      reject(explainSshFailure(target, code, `${stderr}\n${stdout}`, batch));
    });
  });
}

function explainSshFailure(target, code, output, batch) {
  const host = target.split('@').pop();
  if (/Permission denied|Too many authentication failures/i.test(output)) {
    return new UserError(
      `The SSH login to ${target} was refused.`,
      batch
        ? `The app logs in with your SSH key (it can't type passwords). Set one up with:\n  ssh-copy-id ${target}\nor use "swiftssh setup" in a terminal.`
        : 'Check the username and your SSH key or password.',
    );
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output)) {
    return new UserError(`SSH doesn't trust ${host}'s host key.`, `Connect once with "ssh ${target}" to check and accept it, then try again.`);
  }
  if (/Connection refused/i.test(output)) return new UserError(`No SSH server is answering on ${host}.`, 'Check the address and SSH port.');
  if (/Could not resolve hostname/i.test(output)) return new UserError(`Can't find a machine called "${host}".`, 'Check the spelling of the address.');
  if (/timed out/i.test(output)) return new UserError(`Connecting to ${host} timed out.`, 'Check the machine is online and reachable from here.');
  if (/(npx|node|npm)[^\n]*(not found|not recognized)/i.test(output)) {
    return new UserError(`Node.js isn't installed on ${host}.`, 'Install Node.js 18 or newer on the server (https://nodejs.org), then try again.');
  }
  return new UserError(`Starting swiftssh on ${host} failed (ssh exited with ${code}).`, output.trim().split('\n').slice(-5).join('\n'));
}

/** One machine-readable line the server prints when it is up, so deploy can pin its cert. */
export function readyLine({ port, fingerprint, cert }) {
  return READY_PREFIX + Buffer.from(JSON.stringify({ port, fingerprint, cert })).toString('base64');
}

export function parseReadyLine(line) {
  return JSON.parse(Buffer.from(line.slice(READY_PREFIX.length), 'base64').toString());
}

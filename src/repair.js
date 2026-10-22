// Reconnecting: HTTPS with this computer's key is tried first (fast). When that fails in a way SSH can
// fix, the app and the CLI log in over SSH, look at what's wrong (see deployOverSsh) and fix just that:
// restart a stopped or stuck Swiftstream, reinstall missing files or Node.js, update an older version,
// authorize this computer's key again, or pick up a new certificate from the authenticated SSH login.
// Before logging in over SSH for a server that didn't answer, its public health check is asked once
// more (checkServerHealth): a passing hiccup reconnects normally instead.

import { UserError } from './errors.js';

const UNREACHABLE = ['ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'];

/**
 * Why an HTTPS attempt failed, if logging in over SSH could fix it:
 *   'stopped'      nothing answers on the port
 *   'unresponsive' it doesn't answer in time, or drops the connection
 *   'key'          Swiftstream answers but doesn't accept this computer's key
 *   'certificate'  the server presents a different certificate than the one saved
 * null for anything else (a typo'd address, a server that refuses for other reasons, ...).
 */
export function repairReason(err) {
  if (!err) return null;
  const code = String(err.code || '');
  const message = String(err.message || '');
  if (code === 'ECONNREFUSED') return 'stopped';
  if (UNREACHABLE.includes(code) || /timed out|socket hang up/i.test(message)) return 'unresponsive';
  if (err.status === 401 && /not authorized/i.test(message)) return 'key';
  if (/HOST IDENTIFICATION CHANGED/.test(message) || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'certificate';
  return null;
}

/** "Can't reach Swiftstream on prod": what the HTTPS failure looked like, in plain words. */
export function describeReason(reason, name) {
  return {
    stopped: `Can't reach Swiftstream on ${name}`,
    unresponsive: `Swiftstream on ${name} isn't answering`,
    key: `${name} didn't accept this computer's key`,
    certificate: `${name} has a different certificate than before`,
  }[reason];
}

/** True for the reasons where the server didn't answer at all, so its health check is worth asking. */
export const silentReason = (reason) => reason === 'stopped' || reason === 'unresponsive';

/**
 * Neither Swiftstream's port nor SSH answers. Swiftstream may be running fine and this network blocks
 * both (school and work Wi-Fi often refuse every port but the web's), so say that rather than "stopped".
 */
export function unreachableFromHere(name, host) {
  const ports = [host.url, ...(host.webUrls || []), host.webUrl].filter(Boolean).map((u) => new URL(u).port || 443);
  const sshPort = host.sshPort || 22;
  const err = new UserError(
    `Can't reach ${name} from this network: Swiftstream (port ${ports.join(' or ')}) and SSH (port ${sshPort}) both don't answer.`,
    `If ${name} works from other networks, this one blocks those ports (common on school, work and public Wi-Fi) and Swiftstream is probably still running. A phone hotspot or VPN gets through.` +
      (host.webUrls || host.webUrl ? '' : ` Connecting once from a network where SSH works also opens ports 443 and 8443, which most networks allow.`),
  );
  err.code = 'NETWORK_BLOCKED';
  return err;
}

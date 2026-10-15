/** An error whose message is already written for the user, optionally with a "here's how to fix it" hint. */
export class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

/**
 * Turn low-level errors (socket codes, HTTP statuses) into a plain-English message and
 * a concrete next step. Shared by the CLI and the desktop app.
 * ctx: { name, host, publicKey }
 */
export function explainError(err, ctx = {}) {
  if (err instanceof UserError) return { message: err.message, hint: err.hint };
  const where = ctx.host?.url ? new URL(ctx.host.url).host : 'the host';
  const name = ctx.name || '<name>';
  const code = err.code || err.cause?.code;
  const restartHint = ctx.host?.ssh
    ? `Start it again with:  swiftssh deploy ${name} ${ctx.host.ssh}`
    : 'Make sure "swiftssh serve" is running on that machine and its firewall allows the port.';

  switch (code) {
    case 'ECONNREFUSED':
      // `action` lets the desktop app offer a one-click restart over ssh.
      return { message: `Couldn't connect to ${where}: swiftssh isn't running there.`, hint: restartHint, action: ctx.host?.ssh ? 'redeploy' : undefined };
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return {
        message: `The connection to ${where} timed out or was cut off.`,
        hint: 'Check that the machine is online and that a firewall isn\'t blocking the port.',
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { message: `Can't find a machine called "${err.hostname || where}".`, hint: 'Check the spelling of the address.' };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { message: `${where} is unreachable from this network.`, hint: 'Are you on the right network or VPN?' };
    case 'ENOENT':
      if (err.syscall === 'spawn ssh') {
        return { message: 'The "ssh" command isn\'t installed on this computer.', hint: 'Install the OpenSSH client, then try again.' };
      }
      if (err.path) return { message: `No such file or folder: ${err.path}` };
      break;
    case 'EACCES':
    case 'EPERM':
      return { message: `Permission denied${err.path ? `: ${err.path}` : ''}.` };
    case 'EADDRINUSE':
      return { message: `Port ${err.port} is already in use.`, hint: 'Is swiftssh already running? Stop it with "swiftssh stop", or pick another --port.' };
    default:
      break;
  }

  if (/HOST IDENTIFICATION CHANGED/.test(err.message)) {
    return {
      message: err.message,
      hint: `If you reinstalled swiftssh on that machine, this is expected. Forget the old identity and add it again:\n  swiftssh remove ${name}\n  ${ctx.host?.ssh ? `swiftssh deploy ${name} ${ctx.host.ssh}` : `swiftssh add ${name} ${where}`}`,
    };
  }
  if (err.status === 401 && /not authorized/.test(err.message)) {
    return {
      message: `This computer's key isn't authorized on ${where}.`,
      hint: ctx.publicKey ? `On ${where}, run:\n  swiftssh authorize "${ctx.publicKey}"` : 'Authorize your key on the host with "swiftssh authorize".',
    };
  }
  if (err.status === 401) return { message: `${where} rejected the login (${err.message}).`, hint: 'Try again; if it keeps failing, re-run "swiftssh deploy".' };
  if (/timed out/i.test(err.message)) return { message: `${where} stopped responding (${err.message}).`, hint: 'Check your connection and try again. Transfers resume where they left off.' };
  return { message: err.message };
}

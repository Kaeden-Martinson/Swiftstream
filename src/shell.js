import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * A remote shell (or single command when `cmd` is set) over WebSocket, independent of any
 * terminal, so both the CLI and the desktop app can drive it.
 * Events: 'open', 'hello' ({ pty }), 'data' (streamId, Buffer), 'exit' (code), 'close', 'error' (err).
 */
export function openChannel(client, { cmd, pty = true, cols = 80, rows = 24 } = {}) {
  const query = { pty: pty ? 1 : 0, cols, rows };
  if (cmd) query.cmd = cmd;
  const ws = new WebSocket(client.wsUrl('/v1/shell', query), {
    ...client.tls,
    headers: { authorization: `Bearer ${client.token}` },
    perMessageDeflate: false,
  });
  const channel = new EventEmitter();
  let exitCode = null;
  const send = (data) => ws.readyState === ws.OPEN && ws.send(data);

  // Binary frames carry a 1-byte stream id: 0 = stdin, 1 = stdout, 2 = stderr.
  channel.write = (data) => send(Buffer.concat([Buffer.from([0]), Buffer.from(data)]));
  channel.resize = (c, r) => send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
  channel.eof = () => send(JSON.stringify({ type: 'eof' }));
  channel.close = () => ws.close();

  ws.on('open', () => channel.emit('open'));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return channel.emit('data', data[0], data.subarray(1));
    const msg = JSON.parse(data.toString());
    if (msg.type === 'hello') channel.emit('hello', msg);
    else if (msg.type === 'exit') exitCode = msg.code;
  });
  ws.on('close', () => {
    channel.emit('exit', exitCode ?? 255);
    channel.emit('close');
  });
  ws.on('error', (err) => channel.emit('error', err));
  return channel;
}

/** Attach the local terminal to a remote shell or command. Resolves with the remote exit code. */
export function openShell(client, { cmd } = {}) {
  const stdin = process.stdin;
  const interactive = !!(stdin.isTTY && process.stdout.isTTY);
  const channel = openChannel(client, {
    cmd,
    pty: interactive,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  let rawMode = false;

  const onStdin = (chunk) => channel.write(chunk);
  const onStdinEnd = () => channel.eof();
  const onResize = () => channel.resize(process.stdout.columns, process.stdout.rows);
  const cleanup = () => {
    if (rawMode) stdin.setRawMode(false);
    stdin.removeListener('data', onStdin);
    stdin.removeListener('end', onStdinEnd);
    stdin.pause();
    process.stdout.removeListener('resize', onResize);
  };

  return new Promise((resolve, reject) => {
    channel.on('open', () => {
      stdin.on('data', onStdin);
      stdin.on('end', onStdinEnd);
      stdin.resume();
    });
    channel.on('hello', (msg) => {
      if (msg.pty && interactive) {
        // Only go raw when the far end has a real PTY to do echo and line editing.
        stdin.setRawMode(true);
        rawMode = true;
        process.stdout.on('resize', onResize);
      }
    });
    channel.on('data', (streamId, data) => (streamId === 2 ? process.stderr : process.stdout).write(data));
    channel.on('exit', (code) => {
      cleanup();
      resolve(code);
    });
    channel.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

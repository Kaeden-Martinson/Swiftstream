import WebSocket from 'ws';

/**
 * Attach the local terminal to a remote shell (or a single command when `cmd` is set).
 * Resolves with the remote exit code.
 */
export function openShell(client, { cmd } = {}) {
  const stdin = process.stdin;
  const interactive = !!(stdin.isTTY && process.stdout.isTTY);
  const query = { pty: interactive ? 1 : 0, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
  if (cmd) query.cmd = cmd;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(client.wsUrl('/v1/shell', query), {
      ...client.tls,
      headers: { authorization: `Bearer ${client.token}` },
      perMessageDeflate: false,
    });
    let exitCode = null;
    let rawMode = false;

    // Binary frames carry a 1-byte stream id: 0 = stdin, 1 = stdout, 2 = stderr.
    const onStdin = (chunk) => ws.readyState === ws.OPEN && ws.send(Buffer.concat([Buffer.from([0]), chunk]));
    const onStdinEnd = () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'eof' }));
    const onResize = () =>
      ws.readyState === ws.OPEN &&
      ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
    const cleanup = () => {
      if (rawMode) stdin.setRawMode(false);
      stdin.removeListener('data', onStdin);
      stdin.removeListener('end', onStdinEnd);
      stdin.pause();
      process.stdout.removeListener('resize', onResize);
    };

    ws.on('open', () => {
      stdin.on('data', onStdin);
      stdin.on('end', onStdinEnd);
      stdin.resume();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        (data[0] === 2 ? process.stderr : process.stdout).write(data.subarray(1));
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello' && msg.pty && interactive) {
        // Only go raw when the far end has a real PTY to do echo and line editing.
        stdin.setRawMode(true);
        rawMode = true;
        process.stdout.on('resize', onResize);
      } else if (msg.type === 'exit') {
        exitCode = msg.code;
      }
    });
    ws.on('close', () => {
      cleanup();
      resolve(exitCode ?? 255);
    });
    ws.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

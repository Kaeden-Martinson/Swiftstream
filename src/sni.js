import net from 'node:net';
import { Duplex } from 'node:stream';

// Sharing a port (normally 443) with another program, such as a website, without decrypting anything:
// every TLS connection starts with a ClientHello naming the server it wants (SNI). Swiftstream's clients
// ask for SWIFTSTREAM_SNI, so those connections are Swiftstream's; every other connection is passed on,
// byte for byte and still encrypted, to the program that used to own the port (moved to another port).

export const SWIFTSTREAM_SNI = 'swiftstream';

const MAX_HELLO = 16 * 1024 + 5; // one TLS record
const HELLO_TIMEOUT_MS = 10_000;

/**
 * The server name in a TLS ClientHello, read from the first bytes of a connection.
 * { done: false } while more bytes are needed; { done: true, name } once known (name is null when the
 * connection isn't TLS or names no server).
 */
export function readSni(buf) {
  if (buf.length < 5) return { done: false };
  if (buf[0] !== 0x16) return { done: true, name: null }; // not a TLS handshake
  const recordEnd = 5 + buf.readUInt16BE(3);
  if (buf.length < recordEnd) return buf.length >= MAX_HELLO ? { done: true, name: null } : { done: false };
  try {
    let i = 5;
    if (buf[i] !== 0x01) return { done: true, name: null }; // not a ClientHello
    i += 4; // handshake type and length
    i += 2 + 32; // client version, random
    i += 1 + buf[i]; // session id
    i += 2 + buf.readUInt16BE(i); // cipher suites
    i += 1 + buf[i]; // compression methods
    if (i + 2 > recordEnd) return { done: true, name: null };
    const extensionsEnd = Math.min(i + 2 + buf.readUInt16BE(i), recordEnd);
    i += 2;
    while (i + 4 <= extensionsEnd) {
      const type = buf.readUInt16BE(i);
      const length = buf.readUInt16BE(i + 2);
      i += 4;
      if (type === 0x0000) {
        // server_name: list length (2), then entries of type (1), length (2), name
        let j = i + 2;
        while (j + 3 <= i + length) {
          const nameType = buf[j];
          const nameLength = buf.readUInt16BE(j + 1);
          if (nameType === 0) return { done: true, name: buf.toString('ascii', j + 3, j + 3 + nameLength).toLowerCase() };
          j += 3 + nameLength;
        }
        return { done: true, name: null };
      }
      i += length;
    }
  } catch {
    /* malformed: treat as not ours */
  }
  return { done: true, name: null };
}

/**
 * A listener for a shared port: connections asking for SWIFTSTREAM_SNI go to `own(socket)` (the HTTPS
 * server), everything else to `forwardTo` ({ host, port }). `log` notes forwarding failures.
 */
export function createSniRouter({ own, forwardTo, log = () => {} }) {
  return net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.setTimeout(HELLO_TIMEOUT_MS, () => socket.destroy());
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { done, name } = readSni(buf);
      if (!done) return;
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      socket.pause();
      if (name === SWIFTSTREAM_SNI) {
        own(replaying(socket, buf));
        return;
      }
      const upstream = net.connect(forwardTo.port, forwardTo.host);
      upstream.setNoDelay(true);
      upstream.once('connect', () => {
        upstream.write(buf);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
      const close = () => {
        socket.destroy();
        upstream.destroy();
      };
      upstream.on('error', (err) => {
        log('share: forwarding to', `${forwardTo.host}:${forwardTo.port}`, 'failed:', err.code || err.message);
        close();
      });
      socket.on('error', close);
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });
}

/**
 * The connection as a stream that starts with the bytes already read (the ClientHello), then carries
 * the rest. Node's TLS reads a plain socket straight from its native handle, which would skip bytes
 * handed back with unshift(); a JavaScript stream is read through JavaScript, so nothing is lost.
 * The client's address is kept for the server's per-address login limits.
 */
function replaying(socket, head) {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end(callback);
    },
    destroy(err, callback) {
      socket.destroy();
      callback(err);
    },
  });
  stream.remoteAddress = socket.remoteAddress;
  stream.remotePort = socket.remotePort;
  stream.push(head);
  socket.on('data', (chunk) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on('end', () => stream.push(null));
  socket.on('error', (err) => stream.destroy(err));
  socket.on('close', () => stream.destroy());
  socket.resume();
  return stream;
}

/** "127.0.0.1:8444" or "8444" -> { host, port }; null for "", "off" or nothing. */
export function parseShareTarget(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'off') return null;
  const match = /^(?:(\[[0-9a-fA-F:]+\]|[\w.-]+):)?(\d{1,5})$/.exec(text);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return undefined;
  return { host: (match[1] || '127.0.0.1').replace(/^\[|\]$/g, ''), port: Number(match[2]) };
}

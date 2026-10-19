import https from 'node:https';
import { authMessage, sign } from './keys.js';
import { pinnedTlsOptions } from './tls.js';
import { abortError } from './util.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Authenticated HTTPS client for one pinned swiftstream host. */
export class SwiftClient {
  constructor(host, { parallel = 8 } = {}) {
    this.host = host;
    this.base = new URL(host.url);
    this.tls = pinnedTlsOptions(host);
    // One keep-alive socket per parallel worker: separate TCP streams so a lost packet
    // only stalls the chunk on that stream instead of the whole transfer.
    this.agent = new https.Agent({ keepAlive: true, maxSockets: parallel, maxCachedSessions: 0, ...this.tls });
    this.token = null;
  }

  async login(identity) {
    let current = false; // servers that report a version know the new key name
    const attempt = async (publicKey) => {
      const { nonce, version } = await this.request('POST', '/v1/auth/challenge');
      current = !!version;
      const signature = sign(identity.privateKey, authMessage(nonce, this.host.fingerprint));
      return this.request('POST', '/v1/auth/verify', { body: { publicKey, nonce, signature } });
    };
    let result;
    try {
      result = await attempt(identity.publicKeyString);
    } catch (err) {
      // A server from before the rename only recognises the old key type name; same key, old label.
      if (err.status !== 401 || !/not authorized/.test(err.message) || current) throw err;
      result = await attempt(identity.publicKeyString.replace(/^swiftstream-ed25519 /, 'swiftssh-ed25519 '));
    }
    this.token = result.token;
    return this;
  }

  /**
   * Plain object bodies are sent as JSON; Buffers as-is.
   * With `stream: true` a successful response is returned unread.
   * An AbortSignal (`signal`) stops the request, and a streamed response, when it fires.
   */
  request(method, pathname, { query, body, headers = {}, stream = false, timeout = 60_000, signal } = {}) {
    const url = new URL(pathname, this.base);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    headers = { ...headers };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      payload = Buffer.from(JSON.stringify(body));
      headers['content-type'] = 'application/json';
    }
    if (payload) headers['content-length'] = payload.length;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const onAbort = () => req.destroy(abortError(signal));
      const req = https.request(url, { method, headers, agent: this.agent }, (res) => {
        res.on('close', () => signal?.removeEventListener('abort', onAbort));
        if (stream && res.statusCode < 400) return resolve(res);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let data = buf;
          if ((res.headers['content-type'] || '').includes('json')) {
            try {
              data = JSON.parse(buf.toString());
            } catch {
              /* leave as buffer */
            }
          }
          if (res.statusCode >= 400) reject(new HttpError(res.statusCode, data?.error || `HTTP ${res.statusCode}`));
          else resolve(data);
        });
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.aborted ? abortError(signal) : err);
      });
      req.setTimeout(timeout, () => req.destroy(new Error(`${method} ${url.pathname} timed out`)));
      req.end(payload);
    });
  }

  wsUrl(pathname, query) {
    const url = new URL(pathname, this.base);
    url.protocol = 'wss:';
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    return url.toString();
  }

  close() {
    this.agent.destroy();
  }
}

export async function connectClient(host, identity, opts) {
  return new SwiftClient(host, opts).login(identity);
}

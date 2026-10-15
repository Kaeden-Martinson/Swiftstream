import https from 'node:https';
import { authMessage, sign } from './keys.js';
import { pinnedTlsOptions } from './tls.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Authenticated HTTPS client for one pinned swiftssh host. */
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
    const { nonce } = await this.request('POST', '/v1/auth/challenge');
    const signature = sign(identity.privateKey, authMessage(nonce, this.host.fingerprint));
    const { token } = await this.request('POST', '/v1/auth/verify', {
      body: { publicKey: identity.publicKeyString, nonce, signature },
    });
    this.token = token;
    return this;
  }

  /**
   * Plain object bodies are sent as JSON; Buffers as-is.
   * With `stream: true` a successful response is returned unread.
   */
  request(method, pathname, { query, body, headers = {}, stream = false, timeout = 60_000 } = {}) {
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
      const req = https.request(url, { method, headers, agent: this.agent }, (res) => {
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
      req.on('error', reject);
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

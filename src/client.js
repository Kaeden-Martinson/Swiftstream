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
  constructor(host, { parallel = 8, url = host.url } = {}) {
    this.host = host;
    this.base = new URL(url);
    this.tls = pinnedTlsOptions(host);
    // One keep-alive socket per parallel worker: separate TCP streams so a lost packet
    // only stalls the chunk on that stream instead of the whole transfer.
    this.agent = new https.Agent({ keepAlive: true, maxSockets: parallel, maxCachedSessions: 0, ...this.tls });
    this.token = null;
  }

  async login(identity, { timeout } = {}) {
    let current = false; // servers that report a version know the new key name
    const attempt = async (publicKey) => {
      const { nonce, version } = await this.request('POST', '/v1/auth/challenge', { timeout });
      current = !!version;
      this.serverVersion = version || null;
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

// Errors where the address itself didn't answer, so the server's other address is worth a try.
const UNANSWERED = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'];
const unanswered = (err) => UNANSWERED.includes(err?.code) || /timed out|socket hang up/i.test(err?.message || '');

// The address that last worked for each server (main URL -> URL), tried first next time.
const lastWorking = new Map();

/** A server's addresses: the main one, then the web port's (443) if it has one; the one that last worked first. */
export function serverUrls(host) {
  const urls = [host.url, host.webUrl].filter(Boolean);
  const last = lastWorking.get(host.url);
  return last && urls.includes(last) ? [last, ...urls.filter((u) => u !== last)] : urls;
}

/**
 * Log in to a server. When it has a second address on the web port and the first one doesn't answer
 * (a network that blocks it, like school Wi-Fi blocking 7022), the other one is tried. If neither
 * works, the main address's error is the one reported.
 */
export async function connectClient(host, identity, opts) {
  const urls = serverUrls(host);
  let mainErr;
  let otherErr;
  for (const url of urls) {
    const client = new SwiftClient(host, { ...opts, url });
    try {
      // With another address to fall back to, don't wait the full minute on a silent one.
      await client.login(identity, urls.length > 1 ? { timeout: 10_000 } : {});
      lastWorking.set(host.url, url);
      return client;
    } catch (err) {
      client.close();
      // The main address speaks for the server; the web port's might since have gone to another program.
      if (url === host.url) {
        if (!unanswered(err)) throw err;
        mainErr = err;
      } else otherErr ??= err;
    }
  }
  lastWorking.delete(host.url);
  throw mainErr || otherErr;
}

/**
 * Ask a server's public health check (GET /swiftstream-health, no login) whether Swiftstream answers.
 * { up: true, version } when it does; servers from before the check answer 404, which counts as up.
 * { up: false, error } when nothing answers in time: stopped, or this network can't reach the port.
 */
export async function checkServerHealth(host, { timeout = 5000 } = {}) {
  let error;
  for (const url of serverUrls(host)) {
    const probe = new SwiftClient(host, { parallel: 1, url });
    try {
      const res = await probe.request('GET', '/swiftstream-health', { timeout });
      return { up: true, version: res?.version || null, url };
    } catch (err) {
      if (err instanceof HttpError) return { up: true, version: null, url };
      error ??= err;
    } finally {
      probe.close();
    }
  }
  return { up: false, error };
}

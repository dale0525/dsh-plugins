/**
 * Header and URL rewriting for the transparent forward to the host listener.
 *
 * The plugin's listener and the host's listener are two different origins, and
 * the host judges every request by the authority it was addressed to: its
 * Host/Origin fence accepts loopback, its own bind address, or a configured
 * `trustedHosts` entry, and its browser cookie is bound to one authority. So a
 * proxied request must arrive looking like it was sent to the host's loopback
 * listener, and the plugin's own session cookie must not travel upstream.
 *
 * Everything here is a pure function over plain values, which is what makes the
 * rewrite testable without a socket.
 *
 * @module @logictan/dsh-lan-access/proxy
 */
import { Buffer } from 'node:buffer';

/** Prefix of the host's own browser cookie; those never cross the proxy. */
export const HOST_COOKIE_PREFIX = 'dsh-auth-';

/** Hop-by-hop headers dropped from a forwarded plain request. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/** Headers the proxy always recomputes. */
const RECOMPUTED = new Set(['host', 'origin', 'cookie']);

/**
 * Read one cookie value out of a `Cookie` header.
 *
 * @param headerValue - the raw header, possibly undefined.
 * @param name - the cookie to read.
 * @returns the value, or `undefined` when absent.
 */
export function cookieValue(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Name of one `Set-Cookie` value.
 *
 * @param value - one `Set-Cookie` header value.
 * @returns the cookie name.
 */
export function setCookieName(value) {
  const at = value.indexOf('=');
  return at === -1 ? value.trim() : value.slice(0, at).trim();
}

/**
 * Build the headers of a forwarded request.
 *
 * @param rawHeaders - the incoming request's headers (`node:http` lowercase form).
 * @param options.upstreamAuthority - the authority the host must see, `127.0.0.1:<port>`.
 * @param options.authCookie - the host's cookie as a `name=value` pair, when known.
 * @param options.sessionCookieName - the plugin's own session cookie, stripped upstream.
 * @param options.upgrade - keep the WebSocket handshake's hop-by-hop headers.
 * @returns a fresh header object, safe to hand to `http.request` or to serialize.
 */
export function forwardHeaders(rawHeaders, options) {
  const { upstreamAuthority, authCookie, sessionCookieName, upgrade = false } = options;
  const headers = {};

  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (RECOMPUTED.has(name)) continue;
    if (!upgrade && HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }

  headers.host = upstreamAuthority;
  // The fence compares Origin against Host, so a stale Origin would be rejected
  // as cross-origin. Browsers always send it on state-changing requests.
  if (rawHeaders.origin !== undefined) headers.origin = `http://${upstreamAuthority}`;

  const cookies = [];
  const rawCookie = rawHeaders.cookie;
  if (typeof rawCookie === 'string') {
    for (const segment of rawCookie.split(';')) {
      const trimmed = segment.trim();
      if (trimmed === '') continue;
      const name = setCookieName(trimmed);
      // The host's cookie is authority-bound and useless under this origin, and
      // re-sending the plugin's own session upstream would leak it into logs.
      if (name.startsWith(HOST_COOKIE_PREFIX)) continue;
      if (name === sessionCookieName) continue;
      cookies.push(trimmed);
    }
  }
  if (authCookie !== undefined) cookies.push(authCookie);
  if (cookies.length > 0) headers.cookie = cookies.join('; ');

  return headers;
}

/**
 * Build the headers of a forwarded response.
 *
 * @param rawHeaders - the upstream response's headers.
 * @returns a header object with the host's own cookies removed.
 */
export function responseHeaders(rawHeaders) {
  const headers = {};
  const cookies = [];
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (name === 'set-cookie') {
      for (const one of Array.isArray(value) ? value : [value]) {
        // Minted for the host's authority; the plugin injects its own copy on
        // every request, so storing it under this origin would only confuse.
        if (setCookieName(one).startsWith(HOST_COOKIE_PREFIX)) continue;
        cookies.push(one);
      }
      continue;
    }
    headers[name] = value;
  }
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  return headers;
}

/**
 * The request target to forward.
 *
 * The host's launch token is dropped: this listener has its own gate, and
 * forwarding a token would make the plugin's port a second door for anyone who
 * saw the token in `dsh web`'s output.
 *
 * @param rawUrl - the incoming request target.
 * @returns path plus query, without `token`.
 */
export function forwardedTarget(rawUrl) {
  const url = new URL(rawUrl ?? '/', 'http://dsh.invalid');
  url.searchParams.delete('token');
  const search = url.searchParams.toString();
  return `${url.pathname}${search === '' ? '' : `?${search}`}`;
}

/**
 * Serialize a WebSocket handshake request head.
 *
 * An upgrade cannot be replayed through `http.request`, so the proxy writes the
 * request text itself: the incoming `IncomingMessage` has already been parsed
 * and its bytes are gone.
 *
 * @param req - the incoming upgrade request.
 * @param headers - the forwarded headers.
 * @param target - the forwarded request target.
 * @returns the head text, ending in a blank line.
 */
export function upgradeHeadline(req, headers, target) {
  const lines = [`${req.method ?? 'GET'} ${target} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const one of value) lines.push(`${name}: ${one}`);
    else lines.push(`${name}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Whether a request is a browser navigation for a document.
 *
 * Used to decide between redirecting to the login page and answering 401: a
 * navigation must land on the form, while a fetch of `/api/...` must not be
 * answered with HTML.
 *
 * @param req - the incoming request.
 * @returns true for a GET whose Accept prefers HTML.
 */
export function wantsDocument(req) {
  if (req.method !== 'GET') return false;
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * Read a request body up to a hard cap.
 *
 * The login form is the only body this plugin reads, and an uncapped read would
 * let one client exhaust the host process's memory.
 *
 * @param req - the incoming request.
 * @param limit - maximum bytes to accept.
 * @returns the body text; rejects when the client sends more than `limit`.
 */
export function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

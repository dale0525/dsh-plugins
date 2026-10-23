/**
 * The plugin's listener: one port, the access gate, and a transparent forward.
 *
 * Why a proxy rather than a second DSH: the host's own listener can only bind
 * one concrete address (its `webserver` schema rejects a wildcard), and its
 * Host/Origin fence accepts only loopback, that one bind address, or a
 * `trustedHosts` entry fixed at load. So "reachable from the LAN *and* from
 * 127.0.0.1, on one configurable port, with no profile edits" cannot be done by
 * reconfiguring the host. This listener binds the wildcard address itself and
 * forwards every request to the host's listener with the authority rewritten to
 * the host's own bind authority, which is what makes the fence accept it.
 *
 * Two consequences shape the code:
 *
 *  - **The host's cookie is obtained server-side, never from the browser.** A
 *    proxied request arrives with `Host: <bind authority>` and a cookie the host
 *    signed for exactly that authority. The plugin asks
 *    `connection.authenticatedUrl` for the host's own launch URL and follows it
 *    once, adopting the cookie it mints. That is why nobody has to copy a token:
 *    `none` mode hands the cookie to every visitor, `password` mode hands it
 *    over after the form.
 *
 *  - **The plugin's gate is the only gate on this port.** A request never
 *    reaches the host's fence unauthenticated, because the plugin refuses it
 *    first — so a wrong password can never be answered by the host's own 401
 *    page.
 *
 * @module @logictan/dsh-lan-access/server
 */
import { request as httpRequest, createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  createFailureLimiter,
  mintSession,
  newSecret,
  passwordMatches,
  sessionCookie,
  verifySession,
} from './auth.js';
import { loginPageHtml } from './login-page.js';
import {
  cookieValue,
  forwardHeaders,
  forwardedTarget,
  readBody,
  responseHeaders,
  upgradeHeadline,
  wantsDocument,
} from './proxy.js';

/** Path prefix the plugin answers itself; everything else is forwarded. */
export const RESERVED_PREFIX = '/__dsh-lan-access/';

/** Login form target, both GET (render) and POST (submit). */
export const LOGIN_PATH = '/__dsh-lan-access/login';

/** Clears the session cookie. */
export const LOGOUT_PATH = '/__dsh-lan-access/logout';

/** How long an adopted host cookie is reused before it is fetched again. */
const COOKIE_TTL_MS = 5 * 60 * 1000;

/**
 * Normalize a socket's peer address for the failure limiter.
 *
 * @param address - `req.socket.remoteAddress`, possibly IPv4-mapped.
 * @returns the bare address.
 */
function peerKey(address) {
  if (typeof address !== 'string' || address === '') return 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * Accept only a same-origin absolute path as a post-login destination.
 *
 * @param value - the `next` query value, as received.
 * @returns the path to redirect to; `/` for anything that could leave this origin.
 */
export function safeNext(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/')) return '/';
  // `//host` and `/\host` are protocol-relative: a browser reads them as another
  // origin, which would turn the login form into an open redirect.
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * Issue one request against the host's own listener.
 *
 * A TLS host listener is reached with verification off: the hop is a loopback
 * connection to this same process, where a certificate proves nothing that the
 * socket does not already prove, and a self-signed certificate is the normal
 * shape of a host listener nobody else connects to.
 *
 * @param upstream - `{protocol, connectHost, port}`, as {@link createAccessServer}'s resolver returns.
 * @param options - `{method, path, headers}`.
 * @param onResponse - called with the upstream response.
 * @returns the client request, for error handling.
 */
export function upstreamRequest(upstream, options, onResponse) {
  const tls = upstream.protocol === 'https:';
  const transport = tls ? httpsRequest : httpRequest;
  return transport(
    {
      host: upstream.connectHost,
      port: upstream.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
      ...(tls ? { rejectUnauthorized: false } : {}),
    },
    onResponse,
  );
}

/**
 * Create the listener. Nothing binds until {@link AccessServer.start} is called.
 *
 * @param options.port - port to listen on.
 * @param options.host - bind address; defaults to every interface.
 * @param options.resolveUpstream - returns `{protocol, connectHost, port, authority}`, or `undefined` while the host listener is not bound yet.
 * @param options.getAuth - reads the current mode (`'none'` or `'password'`) per request.
 * @param options.getPassword - resolves the configured password, or `''`.
 * @param options.acquireCookie - resolves the host's `name=value` cookie, or `undefined`.
 * @param options.now - clock, injectable for tests.
 * @param options.log - `{info, warn, error}`; every field optional.
 * @returns the server handle.
 */
export function createAccessServer(options) {
  const { port, host = '0.0.0.0', resolveUpstream, getAuth, getPassword, acquireCookie, now = Date.now, log = {} } = options;

  const secret = newSecret();
  const limiter = createFailureLimiter();
  /** Adopted host cookie, with the time it was fetched. */
  let cached = { value: undefined, at: 0 };

  /**
   * The host cookie to send upstream, fetching it when the cache is cold.
   *
   * @returns `name=value`, or `undefined` when the host cannot mint one.
   */
  async function hostCookie() {
    if (cached.value !== undefined && now() - cached.at < COOKIE_TTL_MS) return cached.value;
    let value;
    try {
      value = await acquireCookie();
    } catch (error) {
      log.warn?.(`dsh-lan-access: 无法取得宿主登录态：${error instanceof Error ? error.message : String(error)}`);
      value = undefined;
    }
    cached = { value, at: now() };
    return value;
  }

  /** Forget the adopted cookie, so the next request fetches a fresh one. */
  function forgetCookie() {
    cached = { value: undefined, at: 0 };
  }

  /**
   * Whether this request carries a valid session cookie.
   *
   * @param req - the incoming request.
   * @returns true when the gate may be passed.
   */
  function hasSession(req) {
    const value = cookieValue(req.headers.cookie, SESSION_COOKIE);
    return verifySession(secret, value, now());
  }

  /**
   * Write one complete response.
   *
   * @param res - the response.
   * @param status - status code.
   * @param contentType - `content-type` value.
   * @param body - response body.
   */
  function send(res, status, contentType, body) {
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(body);
  }

  /**
   * Answer one request from the plugin itself.
   *
   * @param req - incoming request.
   * @param res - response to own.
   */
  async function handleReserved(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid');

    if (url.pathname === LOGIN_PATH && req.method === 'GET') {
      const next = safeNext(url.searchParams.get('next'));
      send(res, 200, 'text/html; charset=utf-8', loginPageHtml({ action: `${LOGIN_PATH}?next=${encodeURIComponent(next)}` }));
      return;
    }

    if (url.pathname === LOGIN_PATH && req.method === 'POST') {
      const key = peerKey(req.socket.remoteAddress);
      if (limiter.blocked(key, now())) {
        send(res, 429, 'text/html; charset=utf-8', loginPageHtml({ error: '尝试次数过多，请稍后再试。' }));
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        send(res, 413, 'text/plain; charset=utf-8', '请求过大\n');
        return;
      }
      const submitted = new URLSearchParams(body).get('password') ?? '';
      const expected = await getPassword();
      if (expected === '' || !passwordMatches(expected, submitted)) {
        limiter.record(key, now());
        send(res, 200, 'text/html; charset=utf-8', loginPageHtml({ error: '密码不正确。' }));
        return;
      }
      limiter.clear(key);
      const session = mintSession(secret, now());
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: safeNext(url.searchParams.get('next')),
        'set-cookie': sessionCookie(SESSION_COOKIE, session.value, session.expiresAt, SESSION_MAX_AGE_MS),
      });
      res.end();
      return;
    }

    if (url.pathname === LOGOUT_PATH) {
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: '/',
        'set-cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end();
      return;
    }

    send(res, 404, 'text/plain; charset=utf-8', '未找到\n');
  }

  /**
   * Decide whether one request may be forwarded, answering it when it may not.
   *
   * @param req - incoming request.
   * @param res - response to own when refusing.
   * @returns true when the caller should forward.
   */
  async function admitted(req, res) {
    if (getAuth() === 'none') return true;
    if (hasSession(req)) return true;
    const url = new URL(req.url ?? '/', 'http://dsh.invalid');
    if (wantsDocument(req)) {
      res.writeHead(302, {
        'cache-control': 'no-store',
        location: `${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`,
      });
      res.end();
      return false;
    }
    // A fetch must not be answered with HTML: the app would parse the form as
    // JSON and report a parse error instead of an authentication failure.
    send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ error: 'unauthorized' }));
    return false;
  }

  /**
   * Answer when the host's own listener is not reachable yet or any more.
   *
   * @param res - response to own.
   * @param upstream - the resolved upstream, or `undefined`.
   * @returns true when the request was answered here.
   */
  function unavailable(res, upstream) {
    if (upstream !== undefined) return false;
    send(res, 503, 'text/plain; charset=utf-8', 'DSH 宿主尚未开始监听，请稍后刷新。\n');
    return true;
  }

  /**
   * Forward one plain request to the host listener.
   *
   * @param req - incoming request.
   * @param res - response to own.
   * @param upstream - the resolved upstream.
   */
  async function forward(req, res, upstream) {
    const authCookie = await hostCookie();
    if (authCookie === undefined) {
      // Without the host's cookie every forwarded request would earn a 401 from
      // the fence, which reads to the user as "the password did not work".
      send(res, 502, 'text/plain; charset=utf-8', '无法取得宿主登录态：宿主未提供 connection 服务。\n');
      return;
    }
    const headers = forwardHeaders(req.headers, {
      upstreamAuthority: upstream.authority,
      authCookie,
      sessionCookieName: SESSION_COOKIE,
    });
    const target = forwardedTarget(req.url);

    const client = upstreamRequest(upstream, { method: req.method, path: target, headers }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      // The host's own cookie is authority-bound; adopting a fresh one is this
      // plugin's job, so a stale one must not be reused indefinitely.
      if (status === 401) forgetCookie();
      res.writeHead(status, responseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });

    client.on('error', (error) => {
      log.warn?.(`dsh-lan-access: 转发失败：${error.message}`);
      if (!res.headersSent) send(res, 502, 'text/plain; charset=utf-8', 'DSH 宿主不可达\n');
      else res.destroy();
    });
    // A client that navigates away mid-upload must not leave the upstream
    // request open until its own timeout.
    res.on('close', () => {
      if (!res.writableFinished) client.destroy();
    });

    req.pipe(client);
  }

  /**
   * Forward one WebSocket handshake.
   *
   * The handshake cannot be replayed through `http.request`: the incoming
   * request's bytes are already parsed, so the head is re-serialized and the two
   * sockets are spliced once the upstream accepts.
   *
   * @param req - the upgrade request.
   * @param socket - the client socket.
   * @param head - bytes already read past the request headers.
   */
  async function forwardUpgrade(req, socket, head) {
    // A permanent handler: an unhandled 'error' on a socket reaches the process.
    socket.on('error', () => socket.destroy());

    const url = new URL(req.url ?? '/', 'http://dsh.invalid');
    if (url.pathname.startsWith(RESERVED_PREFIX)) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (getAuth() !== 'none' && !hasSession(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
      return;
    }

    const upstream = resolveUpstream();
    if (upstream === undefined) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n');
      return;
    }

    const authCookie = await hostCookie();
    const headers = forwardHeaders(req.headers, {
      upstreamAuthority: upstream.authority,
      authCookie,
      sessionCookieName: SESSION_COOKIE,
      upgrade: true,
    });
    // `forwardHeaders` keeps `connection`/`upgrade` for this path; a handshake
    // without them is rejected by the host's own upgrade router.
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';

    const peer = netConnect({ host: upstream.connectHost, port: upstream.port }, () => {
      peer.write(upgradeHeadline(req, headers, forwardedTarget(req.url)));
      if (head !== undefined && head.length > 0) peer.write(head);
      peer.setNoDelay(true);
      socket.setNoDelay(true);
      peer.pipe(socket).pipe(peer);
    });

    peer.on('error', () => socket.destroy());
    peer.on('close', () => socket.destroy());
    socket.on('close', () => peer.destroy());
  }

  const server = createServer((req, res) => {
    void (async () => {
      if (new URL(req.url ?? '/', 'http://dsh.invalid').pathname.startsWith(RESERVED_PREFIX)) {
        await handleReserved(req, res);
        return;
      }
      if (!(await admitted(req, res))) return;
      const upstream = resolveUpstream();
      if (unavailable(res, upstream)) return;
      await forward(req, res, upstream);
    })().catch((error) => {
      log.error?.(`dsh-lan-access: 请求处理失败：${error instanceof Error ? error.stack : String(error)}`);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', '内部错误\n');
      else res.destroy();
    });
  });

  /**
   * Every open socket, so {@link AccessServer.close} can actually finish.
   *
   * `server.closeAllConnections()` does not include upgraded sockets: Node hands
   * an upgraded connection off to the `upgrade` listener and stops tracking it,
   * so a WebSocket would keep `server.close()` waiting forever. That is not a
   * theoretical leak — the app holds a WebSocket open for the whole session, so
   * without this a port change or a disable would hang on the live tab.
   */
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    void forwardUpgrade(req, socket, head).catch((error) => {
      log.error?.(`dsh-lan-access: 升级失败：${error instanceof Error ? error.stack : String(error)}`);
      socket.destroy();
    });
  });

  return {
    /** The port the caller asked for; {@link boundPort} reports what was bound. */
    port,
    /**
     * Bind the listener.
     *
     * @param onError - called for every listener-level error after binding; the
     *   listener stays installed either way, because an unhandled `error` event
     *   would take the whole DSH process down.
     * @returns the bound port; rejects when the port cannot be bound.
     */
    start(onError) {
      return new Promise((resolve, reject) => {
        const onListenError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onListenError);
          server.on('error', (error) => {
            // Permanent: `once` would leave the second error of a burst
            // unhandled, and an unhandled 'error' is a fatal uncaught exception.
            log.warn?.(`dsh-lan-access: 监听出错：${error.message}`);
            onError?.(error);
          });
          resolve(server.address()?.port ?? port);
        };
        server.once('error', onListenError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    /**
     * Stop listening and drop every open connection.
     *
     * @returns resolves once the port is released.
     */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
        // Upgraded sockets are not in `closeAllConnections`' table (see `sockets`),
        // and a WebSocket never ends on its own, so they are destroyed explicitly.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
    },
    /** The adopted host cookie's current value, for tests. */
    get cookie() {
      return cached.value;
    },
  };
}

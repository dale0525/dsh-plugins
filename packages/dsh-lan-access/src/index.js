/**
 * dsh-lan-access — host half.
 *
 * Serves the Web UI on one configurable port that answers both on the LAN and on
 * 127.0.0.1, with either the plugin's own password or no authentication, and
 * without touching the profile's `webserver` row.
 *
 * Why this is a proxy and not a second listener in the host: `webserver` accepts
 * only one concrete bind address (a wildcard is rejected), and `connection`'s
 * Host/Origin fence accepts only loopback, that bind address, or a
 * `trustedHosts` entry fixed at load. One port reachable from two places is
 * therefore not expressible by host configuration — but it *is* expressible by
 * binding the wildcard address ourselves and forwarding to the host listener
 * with the authority rewritten to the host's own. That also keeps
 * `trustedHosts` out of the picture: a stale LAN entry no longer blocks access,
 * because the forwarded request never presents a LAN authority.
 *
 * Three decisions are load-bearing:
 *
 *  - **The password is a credential, not a config field.** The config row is
 *    exported verbatim by config sync, so a `role('secret')` field would put the
 *    plaintext in every snapshot; {@link PASSWORD_REF} holds it instead.
 *
 *  - **The host's cookie is minted here, never copied by the user.**
 *    `connection.authenticatedUrl` yields the host's own launch URL; following
 *    it once returns the `dsh-auth-…` cookie the host would have given a browser,
 *    and that cookie is what makes every forwarded request pass the fence.
 *
 *  - **Settings changes rebind without a restart.** The config root is
 *    `volatile()`, so the loader commits an edit into the live reference and
 *    emits `loader/volatile-update` rather than remounting the plugin; the
 *    listener is reconciled against the new values from that event.
 *
 * @module @logictan/dsh-lan-access
 */
import { networkInterfaces } from 'node:os';

import { Config, PASSWORD_REF, STATUS_PATH, normalizeSettings, sameListener } from './config.js';
import { createAccessServer } from './server.js';

export { Config, ENTRY_ID, PASSWORD_REF, STATUS_PATH } from './config.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'dsh-lan-access';

/** Delay before retrying a bind that failed, in milliseconds. */
export const RETRY_DELAY_MS = 10_000;

/**
 * Every non-loopback IPv4 address of this machine.
 *
 * Read from the OS rather than from the host's own configuration: the host
 * listener binds one interface, but the browser may reach this machine on any of
 * them, and the point of the card is to show the address to type.
 *
 * @returns addresses in interface order, link-local excluded.
 */
export function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // 169.254/16 is self-assigned: reachable by nothing but this machine.
      if (entry.address.startsWith('169.254.')) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

/**
 * Mount the listener, the settings reconcile, and the status route.
 *
 * @param ctx - the plugin context.
 * @param config - live reference over {@link Config}, when the loader supplies one.
 */
export function apply(ctx, config) {
  /** The live settings, normalized per use. */
  const settingsNow = () => normalizeSettings(config?.get());

  /** The running listener, or `undefined` while stopped. */
  let running;
  /** Settings the running listener was created from. */
  let runningSettings;
  /** Bound port of the running listener. */
  let boundPort;
  /** Port whose bind failure has already been reported, so the log does not repeat it. */
  let reportedFailure;
  /** Pending retry timer, when a bind failed. */
  let retryTimer;
  /** Tail of the reconcile chain; see {@link reconcile}. */
  let queued = Promise.resolve();

  /**
   * The host listener this plugin forwards to, as connection facts.
   *
   * Resolved per request rather than captured: the host's listener may bind
   * after this plugin activates, and its port is only known once it has.
   *
   * @returns `{protocol, connectHost, port, authority}`, or `undefined` while the host listener is not bound.
   */
  function resolveUpstream() {
    const webServer = ctx.get('webServer');
    if (webServer === undefined || webServer === null) return undefined;
    const port = webServer.port;
    const connectHost = webServer.host;
    if (port === undefined || typeof connectHost !== 'string' || connectHost === '') return undefined;
    const protocol = webServer.protocol ?? 'http:';
    // IPv6 literals need brackets in an authority; a zone id cannot be expressed
    // in a URL at all, and `getOrigin` already rejects that case.
    const hostForUrl = connectHost.includes(':') ? `[${connectHost.split('%')[0]}]` : connectHost;
    return { protocol, connectHost, port, authority: `${hostForUrl}:${String(port)}` };
  }

  /**
   * The plugin's own password, from the credential store.
   *
   * Read per request: it can be set, replaced or cleared from the Plugins page
   * while the process runs, and a captured value would keep accepting a
   * password the user just revoked.
   *
   * @returns the password, or `''` when unset or when no provider is mounted.
   */
  async function currentPassword() {
    const credentials = ctx.get('credentials');
    if (credentials === undefined || credentials === null) return '';
    try {
      const resolved = await credentials.resolve(PASSWORD_REF);
      return resolved?.value ?? '';
    } catch (error) {
      ctx.logger?.warn?.(`dsh-lan-access: 读取访问密码失败：${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  /**
   * Ask the host for its own browser cookie.
   *
   * The token in `authenticatedUrl` is only ever handled inside this process:
   * it goes to the host's loopback-facing listener and the response's cookie is
   * kept here, so the plugin's port never exposes the token to a browser.
   *
   * @returns `name=value`, or `undefined` when the host cannot mint one.
   */
  async function acquireCookie() {
    const connection = ctx.get('connection');
    if (connection === undefined || connection === null) return undefined;
    const upstream = resolveUpstream();
    if (upstream === undefined) return undefined;

    const origin = `${upstream.protocol}//${upstream.authority}`;
    const target = connection.authenticatedUrl(`${origin}/`);
    const response = await fetch(target, { redirect: 'manual', headers: { accept: 'text/html' } });
    // 303 is the mint path; a 200 means the host answered without a token, which
    // only happens when the token was rejected, so there is no cookie to adopt.
    for (const value of response.headers.getSetCookie?.() ?? []) {
      const pair = value.split(';', 1)[0].trim();
      if (pair.startsWith('dsh-auth-')) return pair;
    }
    // Consume the body so the socket can be reused rather than left dangling.
    await response.arrayBuffer().catch(() => undefined);
    return undefined;
  }

  /**
   * Create and bind a listener for one settings snapshot.
   *
   * @param settings - the snapshot to serve.
   * @returns the bound port.
   */
  async function bind(settings) {
    // The host's own listener may hold this port on 127.0.0.1. Binding
    // 0.0.0.0:P still succeeds in that case — no EADDRINUSE — but the OS answers
    // loopback requests from the more specific listener, so `127.0.0.1:P` would
    // reach the host directly and skip this plugin's gate entirely, while only
    // the LAN address would reach it. Refusing is the only honest outcome: the
    // configuration cannot deliver "one port, one gate".
    const upstream = resolveUpstream();
    if (upstream !== undefined && settings.port === upstream.port) {
      throw new Error(`端口与宿主监听端口相同（${String(settings.port)}），本机 127.0.0.1 会绕过本插件的鉴权`);
    }
    const server = createAccessServer({
      port: settings.port,
      resolveUpstream,
      getAuth: () => settingsNow().auth,
      getPassword: currentPassword,
      acquireCookie,
      log: {
        warn: (message) => ctx.logger?.warn?.(message),
        error: (message) => ctx.logger?.error?.(message),
      },
    });
    const port = await server.start((error) => {
      ctx.logger?.warn?.(`dsh-lan-access: 端口 ${String(settings.port)} 监听出错：${error.message}`);
    });
    running = server;
    runningSettings = settings;
    boundPort = port;
    reportedFailure = undefined;
    ctx.logger?.info?.(`dsh-lan-access: 已在端口 ${String(port)} 提供访问（鉴权：${settings.auth === 'none' ? '无' : '访问密码'}）`);
    return port;
  }

  /**
   * Tear the running listener down.
   *
   * Awaited before a rebind so the old port is released: two listeners on one
   * port is a `EADDRINUSE` for whichever binds second.
   */
  async function unbind() {
    if (running === undefined) return;
    const server = running;
    running = undefined;
    runningSettings = undefined;
    boundPort = undefined;
    await server.close();
  }

  /** Cancel a pending retry. */
  function cancelRetry() {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  /**
   * Bring the listener in line with the current settings.
   *
   * Serialized through {@link queue}: two settings commits can land while a bind
   * is still in flight, and without this the second would see no running
   * listener, try to bind the same port, and earn an `EADDRINUSE` against its
   * own sibling. The retry would eventually recover, but the user would see a
   * spurious failure for a configuration that is perfectly valid.
   *
   * @returns resolves once the listener matches the settings as of the call.
   */
  function reconcile() {
    queued = queued.then(() => reconcileNow()).catch((error) => {
      ctx.logger?.warn?.(`dsh-lan-access: 应用设置失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return queued;
  }

  /**
   * One reconcile pass, run exclusively.
   *
   * A failure to bind is reported once per port and retried, because the usual
   * cause — the port is taken — is fixed by an edit that arrives through this
   * very path.
   */
  async function reconcileNow() {
    const settings = settingsNow();
    cancelRetry();

    if (!settings.enabled) {
      await unbind();
      return;
    }
    if (running !== undefined && runningSettings !== undefined && sameListener(runningSettings, settings)) return;

    await unbind();
    try {
      await bind(settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (reportedFailure !== settings.port) {
        reportedFailure = settings.port;
        ctx.logger?.warn?.(
          `dsh-lan-access: 无法在端口 ${String(settings.port)} 监听（${message}）。请在「设置 → 插件 → dsh-lan-access」里换一个端口；本插件会在 ${String(
            Math.round(RETRY_DELAY_MS / 1000),
          )} 秒后重试。`,
        );
      }
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void reconcile();
      }, RETRY_DELAY_MS);
      // Never hold the process open just to retry a bind.
      retryTimer.unref?.();
    }
  }

  ctx.effect(() => {
    void reconcile();
    // Volatile-only commits land here; `ctx.on` keeps working after the fiber
    // disposes because cordis unregisters it with the effect scope.
    ctx.on('loader/volatile-update', () => {
      void reconcile();
    });
    return () => {
      cancelRetry();
      // Queued behind any in-flight reconcile: a rebind that lands after
      // teardown would leave a listener nobody owns, holding the port.
      queued = queued.then(() => unbind()).catch(() => {});
      return queued;
    };
  });

  /**
   * Answer the status route for the settings card.
   *
   * Registered on the HOST listener, not the plugin's own: the card runs in a
   * browser that reaches this process through either port, and the host's
   * listener is the one that is always up. The path is outside `/api`, so the
   * fence does not cover it and the check is done here — the same shape
   * `dsh-macos-theme` uses.
   *
   * @param req - incoming request.
   * @param res - response to own.
   */
  async function handleStatus(req, res) {
    const connection = ctx.get('connection');
    // Read per request, never injected: a missing `connection` must degrade to
    // "this route refuses", not to "the whole plugin disappears".
    const rejection = connection === undefined ? 403 : connection.requestRejection(req);
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }));
      return;
    }
    const settings = settingsNow();
    const upstream = resolveUpstream();
    const body = {
      enabled: settings.enabled,
      port: boundPort ?? settings.port,
      auth: settings.auth,
      listening: running !== undefined,
      addresses: lanAddresses(),
      // The card needs this to refuse the one port that cannot work: the host's
      // own, where loopback traffic would bypass this plugin's gate.
      hostPort: upstream?.port,
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => handleStatus(req, res),
      }),
    );
  });
}

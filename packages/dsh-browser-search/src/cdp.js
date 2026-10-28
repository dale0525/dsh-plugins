/**
 * A minimal Chrome DevTools Protocol client over the browser WebSocket.
 *
 * The plugin talks CDP directly instead of using Playwright for one reason: the
 * tabs it opens must be INVISIBLE. Playwright only exposes the browser's default
 * context, so a page it creates lands in the tab strip where the user sees it and
 * loses focus to it. The protocol itself can create a separate browser context
 * and open a background target inside it, which is neither shown nor focused —
 * verified against the user's Chrome: the tab count in the strip is unchanged and
 * `document.hasFocus()` reads false inside the page.
 *
 * Only the handful of methods this plugin needs are wrapped. `Target.createTarget`
 * with `background: true` alone is not enough; without a separate
 * `browserContextId` the target still joins the default context and appears.
 *
 * @module @logictan/dsh-browser-search/cdp
 */

/** How long to wait for the WebSocket handshake. */
const OPEN_TIMEOUT_MS = 10_000;

/**
 * One CDP connection to a browser.
 *
 * Requests are matched by numeric id, and a reply that carries a `sessionId` is
 * only accepted for the request that sent that same session id — Chrome
 * multiplexes every attached target onto one socket, so id equality alone would
 * let one page's answer settle another page's request.
 */
export class CdpConnection {
  #socket;
  #nextId = 0;
  /** Pending requests keyed by their numeric id. */
  #pending = new Map();
  #closed = false;
  #opened;

  /**
   * @param socket - a WebSocket-like object; the browser's `WebSocket` in
   *   production, a stub in tests.
   */
  constructor(socket) {
    this.#socket = socket;
    this.#opened = new Promise((resolve, reject) => {
      if (socket.readyState === 1) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error('CDP handshake timed out')), OPEN_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP handshake failed'));
      };
    });
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onclose = () => this.#failAll(new Error('CDP connection closed'));
  }

  /** Resolves once the handshake has completed. */
  opened() {
    return this.#opened;
  }

  /**
   * Issue one protocol command.
   *
   * @param method - the CDP method name.
   * @param params - its parameters.
   * @param sessionId - target session to scope the command to.
   * @returns the reply's `result`.
   */
  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('CDP connection closed'));

    const id = this.#nextId += 1;
    const message = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;

    const settled = new Promise((resolve, reject) => {
      this.#pending.set(id, { sessionId, resolve, reject });
    });
    this.#socket.send(JSON.stringify(message));
    return settled;
  }

  /** Close the socket, rejecting everything still in flight. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error('CDP connection closed'));
    this.#socket.close();
  }

  /** @param error - the reason to reject with. */
  #failAll(error) {
    this.#closed = true;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  /** @param raw - the socket's message payload. */
  #receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id === undefined) return;

    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    // A reply scoped to another session is another request's answer.
    if (pending.sessionId !== message.sessionId) return;
    this.#pending.delete(message.id);

    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message ?? 'CDP error'));
      return;
    }
    pending.resolve(message.result);
  }
}

/**
 * Open a CDP connection to a browser's debugging endpoint.
 *
 * @param endpoint - the HTTP debugging endpoint, e.g. `http://127.0.0.1:9222`.
 * @param options - `WebSocket` implementation and `fetch` override, both for tests.
 * @returns the open connection.
 */
export async function connect(endpoint, options = {}) {
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const base = endpoint.replace(/\/+$/u, '');
  let response;
  try {
    response = await fetchImpl(`${base}/json/version`);
  } catch (cause) {
    // Node's fetch reports a refused connection as the bare "fetch failed", which
    // tells neither which endpoint nor what to do about it. The endpoint is the
    // actionable part: a wrong port looks identical to Chrome not running.
    throw new Error(
      `could not reach Chrome at ${endpoint} (${cause instanceof Error ? cause.message : String(cause)}); ` +
        'is Chrome running with --remote-debugging-port=9222?',
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(`CDP endpoint ${endpoint} answered HTTP ${response.status}`);
  }
  const { webSocketDebuggerUrl } = await response.json();
  if (typeof webSocketDebuggerUrl !== 'string') {
    throw new Error(`CDP endpoint ${endpoint} reported no webSocketDebuggerUrl`);
  }

  const connection = new CdpConnection(new WebSocketImpl(webSocketDebuggerUrl));
  await connection.opened();
  return connection;
}

/**
 * Evaluate an expression in one target and return its value.
 *
 * @param connection - the open connection.
 * @param sessionId - the target session.
 * @param expression - the expression to evaluate.
 * @returns the value it produced.
 * @throws when the page threw; the page's message is preserved because it is the
 *   only description of what went wrong inside the tab.
 */
export async function evaluate(connection, sessionId, expression) {
  const reply = await connection.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  const exception = reply.exceptionDetails;
  if (exception !== undefined) {
    throw new Error(exception.exception?.description ?? exception.text ?? 'evaluation failed');
  }
  return reply.result?.value;
}

/**
 * A page opened in its own hidden browser context.
 *
 * Created as a background target in a fresh context: the context keeps the tab
 * out of the user's tab strip, and disposal of the context removes the tab and
 * its storage in one step.
 */
export class HiddenPage {
  #connection;
  #browserContextId;
  #closed = false;

  /** @type {string} target id of the page. */
  targetId;
  /** @type {string} session id used for commands scoped to this page. */
  sessionId;

  /**
   * @param connection - the connection that created it.
   * @param browserContextId - the context holding it.
   * @param targetId - the page target.
   * @param sessionId - the attached session.
   */
  constructor(connection, browserContextId, targetId, sessionId) {
    this.#connection = connection;
    this.#browserContextId = browserContextId;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  /**
   * Navigate this page and wait for the document to be ready.
   *
   * @param url - the destination.
   * @param timeoutMs - budget for the load.
   */
  async goto(url, timeoutMs) {
    await this.#connection.send('Page.navigate', { url }, this.sessionId);
    await this.waitFor('document.readyState !== "loading"', timeoutMs);
  }

  /**
   * Evaluate an expression in this page.
   *
   * @param expression - the expression.
   * @returns its value.
   */
  async evaluate(expression) {
    return await evaluate(this.#connection, this.sessionId, expression);
  }

  /**
   * Poll an expression until it is truthy.
   *
   * @param expression - the condition.
   * @param timeoutMs - budget for the wait.
   * @param intervalMs - delay between polls.
   * @returns the first truthy value.
   */
  async waitFor(expression, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** Close the target and dispose its context. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    // The context goes regardless of the target: a context left behind keeps a
    // hidden tab alive for the browser's lifetime.
    await this.#connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    await this.#connection.send('Target.disposeBrowserContext', { browserContextId: this.#browserContextId }).catch(() => {});
  }
}

/**
 * Open a page the user cannot see.
 *
 * @param connection - the open connection.
 * @param url - initial URL; `about:blank` by default.
 * @returns the page.
 */
export async function openHiddenPage(connection, url = 'about:blank') {
  const { browserContextId } = await connection.send('Target.createBrowserContext', {
    // Keep the context alive while no page is attached to it; the default would
    // drop it as soon as the creating client detaches.
    disposeOnDetach: false,
  });
  const { targetId } = await connection.send('Target.createTarget', {
    url,
    browserContextId,
    background: true,
  });
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  return new HiddenPage(connection, browserContextId, targetId, sessionId);
}

/**
 * Resolve a redirecting URL to its destination without downloading the target.
 *
 * Google wraps every result in `/goto?url=<opaque token>` whose payload is not
 * decodable offline, but the endpoint answers with a plain 302 whose `Location`
 * is the real address. `redirect: 'manual'` stops at that response.
 *
 * @param url - the redirecting URL.
 * @param options - `fetch` implementation and `signal`, both injectable for tests.
 * @returns the destination, or the original URL when there is no usable redirect.
 */
export async function resolveRedirect(url, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    redirect: 'manual',
    signal: options.signal,
    headers: { 'user-agent': USER_AGENT },
  });
  const location = response.headers.get('location');
  if (location === null || location.length === 0) return url;
  return URL.canParse(location) ? location : url;
}

/** User agent sent on plain-HTTP requests. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

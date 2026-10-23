/**
 * The host half's wiring, against a fake cordis context and a real host listener.
 *
 * The two failures this file exists for are invisible from the listener's own
 * tests:
 *
 *  - **Activation without a rebind.** Settings edits arrive as
 *    `loader/volatile-update` rather than as a remount, so a plugin that only
 *    binds in `apply` keeps serving the port and mode it started with — the card
 *    would appear to save and do nothing.
 *  - **The token never leaving this process.** The host's launch token is only
 *    used to mint the cookie server-side; if it leaked into a redirect or a
 *    forwarded URL, the plugin's port would be a second door for anyone who read
 *    the token from `dsh web`'s output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { apply, lanAddresses, name } from '../src/index.js';
import { STATUS_PATH } from '../src/config.js';

/**
 * A minimal cordis-shaped context.
 *
 * `get` returns only what a real host would provide; `inject` runs its callback
 * only when every dependency is present, and skips silently otherwise — both as
 * the real runtime does, which is what makes "a missing service degrades one
 * feature" testable.
 *
 * @param options - `{webServerPort, webServerHost, authCookie, password, connection}`.
 * @returns `{ctx, routes, logs, emitVolatile, dispose}`.
 */
function fakeContext(options = {}) {
  const routes = [];
  const logs = { info: [], warn: [], error: [] };
  const handlers = [];
  const services = {
    webServer: {
      port: options.webServerPort,
      host: options.webServerHost ?? '127.0.0.1',
      protocol: 'http:',
      register(route) {
        routes.push(route);
        return () => {
          const at = routes.indexOf(route);
          if (at !== -1) routes.splice(at, 1);
        };
      },
    },
  };
  if (options.connection !== false) {
    services.connection = {
      authenticatedUrl: (base) => {
        const url = new URL(base);
        url.searchParams.set('token', 'launch-token');
        return url.href;
      },
      requestRejection: () => options.rejection,
    };
  }
  if (options.credentials !== false) {
    services.credentials = {
      resolve: async () => (options.password === undefined ? undefined : { value: options.password, source: 'file' }),
    };
  }

  const disposers = [];
  const ctx = {
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
      error: (message) => logs.error.push(String(message)),
      debug: () => {},
    },
    get: (key) => services[key],
    on(event, callback) {
      handlers.push({ event, callback });
      return () => {};
    },
    inject(deps, callback) {
      for (const dep of deps) if (services[dep] === undefined) return;
      // The real runtime hands the callback a context where each injected
      // service is readable as a property; reading it any other way throws there.
      const scoped = Object.create(ctx);
      for (const dep of deps) Object.defineProperty(scoped, dep, { value: services[dep], enumerable: true });
      callback(scoped);
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
  };
  return {
    ctx,
    routes,
    logs,
    /** Fire the event the loader emits after committing a volatile edit. */
    emitVolatile() {
      for (const handler of handlers) if (handler.event === 'loader/volatile-update') handler.callback();
    },
    /** Run every disposer, as plugin teardown does. */
    async dispose() {
      for (const disposer of disposers.splice(0)) await disposer();
    },
  };
}

/**
 * A live config reference, as the loader hands one to `apply`.
 *
 * @param value - the initial settings.
 * @returns a reference whose value the test can change.
 */
function configRef(value) {
  let current = value;
  return {
    get: () => current,
    set(next) {
      current = next;
    },
  };
}

/**
 * Poll until a predicate holds, or fail.
 *
 * Binding and unbinding are asynchronous and driven by events; a fixed sleep
 * would either be flaky or slow.
 *
 * @param predicate - the condition.
 * @param message - what was being waited for.
 * @param timeoutMs - how long to wait.
 */
async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${message}`);
}

/**
 * Pick a free port by binding and releasing one.
 *
 * @returns the port number.
 */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Call the status route the plugin registered on the host listener.
 *
 * @param routes - the registered routes.
 * @param headers - request headers.
 * @returns `{status, body}`.
 */
async function callStatus(routes, headers = {}) {
  const route = routes.find((entry) => entry.path === STATUS_PATH);
  assert.ok(route !== undefined, 'the status route must be registered on the host listener');
  const chunks = [];
  const res = {
    status: undefined,
    headers: {},
    writeHead(status, extra) {
      this.status = status;
      Object.assign(this.headers, extra ?? {});
    },
    end(body) {
      chunks.push(body);
    },
  };
  await route.handler({ method: 'GET', url: STATUS_PATH, headers }, res);
  const text = chunks.join('');
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text) };
}

test('the plugin name is the patch row id', () => {
  assert.equal(name, 'dsh-lan-access');
});

test('the status route is registered on the host listener, outside /api', async () => {
  const harness = fakeContext({ webServerPort: await freePort() });
  const config = configRef({ enabled: false });
  apply(harness.ctx, config);
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.routes[0].kind, 'exact');
  assert.equal(harness.routes[0].path, STATUS_PATH);
  await harness.dispose();
});

test('a disabled plugin binds nothing but still reports its settings', async () => {
  const harness = fakeContext({ webServerPort: await freePort() });
  const config = configRef({ enabled: false, port: 12345, auth: 'none' });
  apply(harness.ctx, config);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = await callStatus(harness.routes);
  assert.equal(status.status, 200);
  assert.deepEqual(
    { enabled: status.body.enabled, listening: status.body.listening, auth: status.body.auth },
    { enabled: false, listening: false, auth: 'none' },
  );
  await harness.dispose();
});

test('an enabled plugin binds its port and reports it', async () => {
  const port = await freePort();
  const harness = fakeContext({ webServerPort: await freePort() });
  const config = configRef({ enabled: true, port, auth: 'password' });
  apply(harness.ctx, config);
  await waitFor(async () => (await callStatus(harness.routes)).body.listening === true, 'the listener to bind');
  const status = await callStatus(harness.routes);
  assert.equal(status.body.port, port);
  assert.equal(status.body.auth, 'password');
  assert.ok(status.body.addresses.every((address) => typeof address === 'string'));
  await harness.dispose();
});

test('a port edit rebinds without a restart', async () => {
  const first = await freePort();
  const second = await freePort();
  const harness = fakeContext({ webServerPort: await freePort() });
  const config = configRef({ enabled: true, port: first, auth: 'none' });
  apply(harness.ctx, config);
  await waitFor(async () => (await callStatus(harness.routes)).body.listening === true, 'the first bind');

  config.set({ enabled: true, port: second, auth: 'none' });
  harness.emitVolatile();
  await waitFor(async () => (await callStatus(harness.routes)).body.port === second, 'the rebind');
  // The old port must be released, or the next bind of it would collide.
  const response = await fetch(`http://127.0.0.1:${String(first)}/`).catch(() => undefined);
  assert.equal(response, undefined);
  await harness.dispose();
});

test('an auth edit does not rebind, so live sessions survive the switch', async () => {
  const port = await freePort();
  const harness = fakeContext({ webServerPort: await freePort() });
  const config = configRef({ enabled: true, port, auth: 'password' });
  apply(harness.ctx, config);
  await waitFor(async () => (await callStatus(harness.routes)).body.listening === true, 'the bind');
  const boundCount = harness.logs.info.length;

  config.set({ enabled: true, port, auth: 'none' });
  harness.emitVolatile();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A rebind logs its port again; a mode switch must not.
  assert.equal(harness.logs.info.length, boundCount);
  assert.equal((await callStatus(harness.routes)).body.auth, 'none');
  await harness.dispose();
});

test('disabling releases the port without a restart', async () => {
  const port = await freePort();
  const harness = fakeContext({ webServerPort: await freePort() });
  const config = configRef({ enabled: true, port, auth: 'none' });
  apply(harness.ctx, config);
  await waitFor(async () => (await callStatus(harness.routes)).body.listening === true, 'the bind');

  config.set({ enabled: false, port, auth: 'none' });
  harness.emitVolatile();
  await waitFor(async () => (await callStatus(harness.routes)).body.listening === false, 'the unbind');
  const response = await fetch(`http://127.0.0.1:${String(port)}/`).catch(() => undefined);
  assert.equal(response, undefined);
  await harness.dispose();
});

test('a port the OS refuses is reported once and retried rather than crashing the host', async () => {
  // The squatter must hold the same address the plugin binds: a listener on
  // 127.0.0.1 does NOT make 0.0.0.0:port fail on macOS, it merely shadows it for
  // loopback traffic (which is the separate hazard the next test covers).
  const taken = createServer((_req, res) => res.writeHead(200).end('host'));
  await new Promise((resolve) => taken.listen(0, '0.0.0.0', resolve));
  const port = taken.address().port;
  try {
    const harness = fakeContext({ webServerPort: await freePort() });
    const config = configRef({ enabled: true, port, auth: 'none' });
    apply(harness.ctx, config);
    await waitFor(() => harness.logs.warn.some((line) => line.includes('无法在端口')), 'the bind failure to be reported');
    const status = await callStatus(harness.routes);
    assert.equal(status.body.listening, false);
    // The failure names the port, because the fix is a settings edit and the
    // user has to know which number collided.
    assert.match(harness.logs.warn.join('\n'), new RegExp(String(port)));
    await harness.dispose();
  } finally {
    await new Promise((resolve) => taken.close(resolve));
  }
});

test('a port equal to the host listener port is reported, because loopback would bypass the plugin', async () => {
  // Binding 0.0.0.0:P succeeds while the host holds 127.0.0.1:P, so nothing
  // fails — but the OS then answers loopback requests from the more specific
  // listener, so `127.0.0.1:P` would reach the host directly (with its own token
  // requirement and fence) while only the LAN address reaches this plugin.
  const hostPort = await freePort();
  const harness = fakeContext({ webServerPort: hostPort });
  apply(harness.ctx, configRef({ enabled: true, port: hostPort, auth: 'none' }));
  await waitFor(
    () => harness.logs.warn.some((line) => line.includes('与宿主监听端口相同')),
    'the shadowing conflict to be reported',
  );
  await harness.dispose();
});

test('the settings card cannot read status without passing the host fence', async () => {
  const harness = fakeContext({ webServerPort: await freePort(), rejection: 403 });
  apply(harness.ctx, configRef({ enabled: false }));
  const status = await callStatus(harness.routes);
  assert.equal(status.status, 403);
  assert.equal(status.body.error, 'forbidden');
  await harness.dispose();
});

test('a 401 from the fence is passed through as 401', async () => {
  const harness = fakeContext({ webServerPort: await freePort(), rejection: 401 });
  apply(harness.ctx, configRef({ enabled: false }));
  const status = await callStatus(harness.routes);
  assert.equal(status.status, 401);
  await harness.dispose();
});

test('without a connection service the status route refuses rather than guessing', async () => {
  const harness = fakeContext({ webServerPort: await freePort(), connection: false });
  apply(harness.ctx, configRef({ enabled: false }));
  const status = await callStatus(harness.routes);
  assert.equal(status.status, 403);
  await harness.dispose();
});

test('the whole chain works: token minted server-side, cookie adopted, app served', async () => {
  // A stand-in host listener that behaves like the real one on the two points
  // that matter: the launch token mints a cookie, and everything else needs it.
  const sockets = new Set();
  const host = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid');
    if (url.searchParams.get('token') === 'launch-token') {
      res.writeHead(303, { location: './', 'set-cookie': ['dsh-auth-abc=minted; Path=/; HttpOnly', 'app=1; Path=/'] });
      res.end();
      return;
    }
    if (!String(req.headers.cookie ?? '').includes('dsh-auth-abc=minted')) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html>${req.headers.host}</html>`);
  });
  host.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const hostPort = host.address().port;

  const port = await freePort();
  const harness = fakeContext({ webServerPort: hostPort });
  const config = configRef({ enabled: true, port, auth: 'none' });
  apply(harness.ctx, config);
  try {
    await waitFor(async () => (await callStatus(harness.routes)).body.listening === true, 'the bind');
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 200);
    // The host sees its own authority, which is what its fence accepts.
    assert.equal(await response.text(), `<html>127.0.0.1:${String(hostPort)}</html>`);
    // The mint response's cookies are consumed server-side, so the browser gets
    // none of them — including the app's own, which only rode along on the 303.
    assert.deepEqual(response.headers.getSetCookie(), []);
  } finally {
    await harness.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => host.close(resolve));
  }
});

test('the launch token never reaches the browser', async () => {
  const sockets = new Set();
  const host = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid');
    if (url.searchParams.get('token') === 'launch-token') {
      res.writeHead(303, { location: './', 'set-cookie': ['dsh-auth-abc=minted; Path=/'] });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>ok</html>');
  });
  host.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const hostPort = host.address().port;

  const port = await freePort();
  const harness = fakeContext({ webServerPort: hostPort });
  apply(harness.ctx, configRef({ enabled: true, port, auth: 'none' }));
  try {
    await waitFor(async () => (await callStatus(harness.routes)).body.listening === true, 'the bind');
    // Even a request that asks for a token must not be answered with one: the
    // plugin strips it from the forwarded target, and nothing echoes it back.
    const response = await fetch(`http://127.0.0.1:${String(port)}/?token=attacker`, { redirect: 'manual' });
    assert.doesNotMatch(response.headers.get('location') ?? '', /token/);
    assert.doesNotMatch(await response.text(), /launch-token/);
  } finally {
    await harness.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => host.close(resolve));
  }
});

test('lanAddresses reports real interfaces and never loopback', () => {
  const addresses = lanAddresses();
  for (const address of addresses) {
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!address.startsWith('127.'), address);
    assert.ok(!address.startsWith('169.254.'), address);
  }
  // A machine running DSH for a LAN client has at least one; a CI box may not.
  assert.ok(Array.isArray(addresses));
});

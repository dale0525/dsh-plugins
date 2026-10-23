/**
 * Activation against a REAL cordis runtime.
 *
 * `tests/index.test.js` drives `apply` with a hand-written context stub, and a
 * stub can only reproduce the traps its author remembered. Two of this plugin's
 * shapes fail *only* on the real thing:
 *
 *  - the status route must degrade when the `connection` service is absent.
 *    `ctx.get('connection')` answers `undefined` and the route can return 403;
 *    the attribute form `ctx.connection` throws `cannot get property ...
 *    without inject`, and the host turns an escaping handler throw into an
 *    EMPTY 400 — so the card would read "读取失败" forever with no clue why.
 *    Verified against real cordis: the attribute form only throws while the
 *    service is ABSENT, which is why the case below mounts without it.
 *  - `ctx.effect` must actually dispose the listener. A teardown that only looks
 *    like a function leaves the port held, and the next activation gets
 *    `EADDRINUSE` for a port nobody appears to be using.
 *
 * So this mounts the shipped plugin into `new Context()`, provides the two host
 * services it reads, and then calls the registered route and disposes the fiber.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';

import { Context } from '@deepseek-ai/cordis';

import * as plugin from '../src/index.js';
import { STATUS_PATH } from '../src/config.js';

/** A port nothing is listening on, so a bind is guaranteed to be the plugin's. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Wait until something is listening on `port`.
 *
 * Activation is asynchronous: `ctx.effect` starts the bind and does not await
 * it, so a route call made immediately after `ctx.plugin` resolves still sees
 * `listening: false`. Waiting on the port is what makes "the listener is up" an
 * observation instead of a race.
 *
 * @param port - the port to watch.
 * @param timeoutMs - how long to wait.
 * @returns true once it accepts a connection.
 */
async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reached = await new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true) });
      socket.once('error', () => { socket.destroy(); resolve(false) });
    });
    if (reached) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** A config reference shaped like the loader's volatile one. */
function configRef(value) {
  return { get: () => value };
}

/**
 * Mount the plugin into a real cordis context.
 *
 * @param settings - the plugin's own settings.
 * @param hostPort - the port the fake host listener reports.
 * @returns `{ctx, routes, connection, host}`.
 */
async function mount(settings, hostPort) {
  const ctx = new Context();
  const routes = [];
  /** Recorded `requestRejection` calls, so the fence is provably consulted. */
  const connection = { calls: [], requestRejection: (req) => { connection.calls.push(req.url); return undefined } };

  ctx.provide('webServer', {
    port: hostPort,
    host: '127.0.0.1',
    protocol: 'http:',
    getOrigin: () => `http://127.0.0.1:${String(hostPort)}`,
    register: (route) => {
      routes.push(route);
      return () => {};
    },
    registerUpgrade: () => () => {},
  });
  ctx.provide('connection', connection);
  ctx.provide('credentials', { resolve: async () => undefined });

  const fiber = ctx.plugin({ ...plugin, Config: undefined }, configRef(settings));
  await fiber;
  return { ctx, routes, connection, fiber };
}

/**
 * Call one registered route with a minimal request, returning status and body.
 *
 * Rejects after a second if the handler never ends the response. A handler that
 * throws before touching `res` leaves the socket open, and without this the
 * failure would arrive as a hung test run rather than as an assertion — which is
 * exactly how the attribute-read bug hides in production too.
 *
 * @param route - the registered route.
 * @returns `{status, headers, body}`.
 */
function callRoute(route) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the route handler never answered')), 1000);
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers ?? {};
        return this;
      },
      end(chunk) {
        clearTimeout(timer);
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks).toString('utf8') });
      },
    };
    route.handler({ url: STATUS_PATH, method: 'GET', headers: { host: `127.0.0.1:${String(route.__port ?? 1)}` } }, res);
  });
}

test('the plugin activates on a real cordis context and registers its status route', async () => {
  const hostPort = await freePort();
  const pluginPort = await freePort();
  const mounted = await mount({ enabled: true, port: pluginPort, auth: 'none' }, hostPort);
  try {
    // The route goes on the HOST listener, because that is the one always up.
    assert.equal(mounted.routes.length, 1);
    assert.equal(mounted.routes[0].kind, 'exact');
    assert.equal(mounted.routes[0].path, STATUS_PATH);
    assert.ok(!STATUS_PATH.startsWith('/api'), 'the status path must sit outside the fence prefix');
  } finally {
    await mounted.ctx.fiber.dispose?.();
  }
});

test('the route handler reads the connection service from a real fiber and answers 200', async () => {
  const hostPort = await freePort();
  const pluginPort = await freePort();
  const mounted = await mount({ enabled: true, port: pluginPort, auth: 'none' }, hostPort);
  try {
    const route = mounted.routes[0];
    route.__port = pluginPort;
    // The bind is started by an effect and not awaited by activation.
    assert.equal(await waitForPort(pluginPort), true, 'the plugin never started listening');
    const response = await callRoute(route);

    // A 400 with an empty body is what an escaped throw looks like; a 200 with
    // the plugin's own JSON proves the handler read both services successfully.
    assert.equal(response.status, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.enabled, true);
    assert.equal(body.port, pluginPort);
    assert.equal(body.listening, true);
    assert.equal(body.hostPort, hostPort);
    assert.deepEqual(body.addresses, body.addresses.filter((a) => a !== '127.0.0.1' && a !== '::1'));
    // The fence is asked on every request, not remembered from activation.
    assert.equal(mounted.connection.calls.length, 1);
  } finally {
    await mounted.ctx.fiber.dispose?.();
  }
});

test('a missing connection service makes the route refuse instead of throwing', async () => {
  const hostPort = await freePort();
  const pluginPort = await freePort();
  const ctx = new Context();
  const routes = [];
  ctx.provide('webServer', {
    port: hostPort,
    host: '127.0.0.1',
    protocol: 'http:',
    getOrigin: () => `http://127.0.0.1:${String(hostPort)}`,
    register: (route) => { routes.push(route); return () => {} },
    registerUpgrade: () => () => {},
  });
  // Deliberately NOT provided: this is the case that separates `ctx.get()` from
  // the attribute read.
  ctx.provide('credentials', { resolve: async () => undefined });

  await ctx.plugin({ ...plugin, Config: undefined }, configRef({ enabled: true, port: pluginPort, auth: 'none' }));
  try {
    assert.equal(routes.length, 1, 'the route must still register without connection');
    const response = await callRoute(routes[0]);
    // 403 is this plugin's own answer. An escaping throw would arrive as 400
    // with an empty body, which is the symptom the host hides.
    assert.equal(response.status, 403, response.body);
    assert.equal(response.body, JSON.stringify({ error: 'forbidden' }));
  } finally {
    await ctx.fiber.dispose?.();
  }
});

test('disposing the fiber releases the port it was listening on', async () => {
  const hostPort = await freePort();
  const pluginPort = await freePort();
  const mounted = await mount({ enabled: true, port: pluginPort, auth: 'none' }, hostPort);

  // Prove the listener is really up before disposing, so a "released" result
  // cannot be confused with "never bound".
  assert.equal(await waitForPort(pluginPort), true, 'the plugin never started listening');

  await mounted.ctx.fiber.dispose?.();

  // A held port is the failure mode: the next activation would get EADDRINUSE.
  const rebind = createServer();
  const bound = await new Promise((resolve) => {
    rebind.once('error', () => resolve(false));
    rebind.listen(pluginPort, '0.0.0.0', () => resolve(true));
  });
  await new Promise((resolve) => rebind.close(resolve));
  assert.equal(bound, true, `port ${String(pluginPort)} is still held after dispose`);
});

test('a volatile settings update rebinds without a remount', async () => {
  const hostPort = await freePort();
  const first = await freePort();
  const second = await freePort();
  const settings = { enabled: true, port: first, auth: 'none' };
  const ctx = new Context();
  const routes = [];
  ctx.provide('webServer', {
    port: hostPort,
    host: '127.0.0.1',
    protocol: 'http:',
    getOrigin: () => `http://127.0.0.1:${String(hostPort)}`,
    register: (route) => { routes.push(route); return () => {} },
    registerUpgrade: () => () => {},
  });
  ctx.provide('connection', { requestRejection: () => undefined });
  ctx.provide('credentials', { resolve: async () => undefined });

  // The loader hands `apply` a live reference; editing a volatile field emits
  // this event instead of remounting the plugin.
  await ctx.plugin({ ...plugin, Config: undefined }, configRef(settings));
  try {
    assert.equal(await waitForPort(first), true, 'the first port never came up');

    settings.port = second;
    ctx.emit('loader/volatile-update', [['port']]);

    // The new port answering is the proof; the old one releasing is the part a
    // naive rebind gets wrong.
    assert.equal(await waitForPort(second), true, 'the volatile update did not rebind');
    const deadline = Date.now() + 3000;
    let released = false;
    while (Date.now() < deadline) {
      released = await new Promise((resolve) => {
        const socket = connect(first, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(false) });
        socket.once('error', () => { socket.destroy(); resolve(true) });
      });
      if (released) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(released, true, `port ${String(first)} was never released`);
  } finally {
    await ctx.fiber.dispose?.();
  }
});

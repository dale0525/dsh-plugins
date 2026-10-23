/**
 * The listener against a real upstream, over real sockets.
 *
 * A fake upstream stands in for the host listener and enforces the same two
 * rules the real one does — the Host/Origin fence and the authority-bound cookie
 * — because those are exactly what the rewrite has to satisfy. Testing the
 * rewrite in isolation (see `proxy.test.js`) proves the strings; only a real
 * round trip proves the listener wires them together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';

import { LOGIN_PATH, LOGOUT_PATH, createAccessServer, safeNext } from '../src/server.js';

/**
 * Close an HTTP server that may still hold upgraded sockets.
 *
 * `server.close()` waits for live connections, and an upgraded one is not in
 * `closeAllConnections`' table — so a fixture that leaves a tunnel open would
 * hang its own teardown and time the test out.
 *
 * @param server - the server to close.
 * @param sockets - the sockets to destroy first.
 * @returns resolves once the server is closed.
 */
async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * A stand-in for the host listener.
 *
 * @param options.cookie - the cookie value it accepts as authenticated.
 * @returns `{origin, port, close, requests}`; `requests` records what arrived.
 */
async function fakeUpstream(options = {}) {
  const cookie = options.cookie ?? 'dsh-auth-abc';
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    // The fence: a LAN authority or a cross-origin Origin is refused.
    if (req.headers.host !== `127.0.0.1:${String(port)}`) {
      res.writeHead(403).end('forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${String(req.headers.host)}`) {
      res.writeHead(403).end('forbidden origin');
      return;
    }
    if (!String(req.headers.cookie ?? '').includes(cookie)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['dsh-auth-refreshed=1; Path=/', 'app=1; Path=/'] });
    res.end('<html>ok</html>');
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    requests,
    close: () => closeServer(server, sockets),
  };
}

/**
 * Bind a plugin listener on a free port against a resolver.
 *
 * @param options - `createAccessServer` options plus `upstream`.
 * @returns `{server, port, base, close}`.
 */
async function startListener(options) {
  const server = createAccessServer({ port: 0, host: '127.0.0.1', ...options });
  const port = await server.start(() => {});
  return { server, port, base: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
}

/**
 * Resolve one `Set-Cookie` value's `name=value` pair.
 *
 * @param response - the fetch response.
 * @param name - the cookie name.
 * @returns the pair, or `undefined`.
 */
function cookiePair(response, name) {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';', 1)[0];
    if (pair.startsWith(`${name}=`)) return pair;
  }
  return undefined;
}

test('auth none forwards straight through and injects the host cookie', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'none',
    getPassword: async () => 'unused',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const response = await fetch(`${listener.base}/`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<html>ok</html>');
    // The plugin's own cookie must not reach the browser: the host's is
    // authority-bound and the plugin adopts it server-side instead.
    assert.equal(cookiePair(response, 'dsh-auth-refreshed'), undefined);
    assert.equal(cookiePair(response, 'app'), 'app=1');
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('the forwarded request carries the rewritten authority and origin', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'none',
    getPassword: async () => 'unused',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const response = await fetch(`${listener.base}/api/x?token=leaked&keep=1`, {
      headers: { accept: 'application/json', origin: listener.base },
    });
    assert.equal(response.status, 200);
    const seen = upstream.requests.at(-1);
    assert.equal(seen.url, '/api/x?keep=1');
    assert.equal(seen.headers.host, `127.0.0.1:${String(upstream.port)}`);
    assert.equal(seen.headers.origin, `http://127.0.0.1:${String(upstream.port)}`);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('auth password sends a navigation to the login form instead of the app', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'password',
    getPassword: async () => 'hunter2',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const response = await fetch(`${listener.base}/some/page?x=1`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${LOGIN_PATH}?next=%2Fsome%2Fpage%3Fx%3D1`);
    // Nothing reached the host, so an unauthenticated visitor cannot probe it.
    assert.equal(upstream.requests.length, 0);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('auth password refuses a fetch with JSON rather than the login page', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'password',
    getPassword: async () => 'hunter2',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const response = await fetch(`${listener.base}/api/x`, { headers: { accept: 'application/json' } });
    assert.equal(response.status, 401);
    // The app parses every 2xx-or-else body as JSON; HTML here would surface as
    // a parse error rather than as "you are not logged in".
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('the login form is served without touching the host', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'password',
    getPassword: async () => 'hunter2',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const response = await fetch(`${listener.base}${LOGIN_PATH}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<form method="post"/);
    assert.match(html, /type="password"/);
    // The password itself must never be rendered back into the page.
    assert.doesNotMatch(html, /hunter2/);
    assert.equal(upstream.requests.length, 0);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('a wrong password re-renders the form, and a right one mints a session that opens the app', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'password',
    getPassword: async () => 'hunter2',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const wrong = await fetch(`${listener.base}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
    });
    assert.equal(wrong.status, 200);
    assert.match(await wrong.text(), /密码不正确/);

    const right = await fetch(`${listener.base}${LOGIN_PATH}?next=%2Ftarget`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter2',
      redirect: 'manual',
    });
    assert.equal(right.status, 303);
    assert.equal(right.headers.get('location'), '/target');
    const session = cookiePair(right, 'dsh-lan-access-session');
    assert.ok(session !== undefined);

    const page = await fetch(`${listener.base}/`, { headers: { accept: 'text/html', cookie: session } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<html>ok</html>');
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('logging out clears the session so the next visit is refused again', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'password',
    getPassword: async () => 'hunter2',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const login = await fetch(`${listener.base}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter2',
      redirect: 'manual',
    });
    const session = cookiePair(login, 'dsh-lan-access-session');
    const out = await fetch(`${listener.base}${LOGOUT_PATH}`, { redirect: 'manual', headers: { cookie: session } });
    assert.equal(out.status, 303);
    assert.match(out.headers.getSetCookie().join(';'), /Max-Age=0/);
    const after = await fetch(`${listener.base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(after.status, 302);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('a login attempt with no configured password never succeeds', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'password',
    // No credential stored yet. An empty submitted password must not match.
    getPassword: async () => '',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const response = await fetch(`${listener.base}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=',
      redirect: 'manual',
    });
    assert.equal(response.status, 200);
    assert.equal(cookiePair(response, 'dsh-lan-access-session'), undefined);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('a POST login cannot be turned into an open redirect', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'password',
    getPassword: async () => 'hunter2',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    for (const next of ['//evil.example/', 'https://evil.example/', '/\\evil.example/']) {
      const response = await fetch(`${listener.base}${LOGIN_PATH}?next=${encodeURIComponent(next)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=hunter2',
        redirect: 'manual',
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/', next);
    }
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('safeNext keeps same-origin paths and refuses everything else', () => {
  assert.equal(safeNext('/a/b?c=1'), '/a/b?c=1');
  assert.equal(safeNext('//evil.example/'), '/');
  assert.equal(safeNext('/\\evil.example/'), '/');
  assert.equal(safeNext('https://evil.example/'), '/');
  assert.equal(safeNext(undefined), '/');
  assert.equal(safeNext(''), '/');
});

test('the listener answers 503 rather than crashing while the host has not bound', async () => {
  const listener = await startListener({
    resolveUpstream: () => undefined,
    getAuth: () => 'none',
    getPassword: async () => '',
    acquireCookie: async () => undefined,
  });
  try {
    const response = await fetch(`${listener.base}/`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /宿主尚未开始监听/);
  } finally {
    await listener.close();
  }
});

test('without a host cookie the listener says so instead of forwarding a doomed request', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'none',
    getPassword: async () => '',
    acquireCookie: async () => undefined,
  });
  try {
    const response = await fetch(`${listener.base}/`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 502);
    assert.equal(upstream.requests.length, 0);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test('a WebSocket handshake is tunnelled and the peer sees the rewritten authority', async () => {
  const seen = [];
  const upstream = createServer((_req, res) => res.writeHead(400).end());
  const upstreamSockets = new Set();
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });
  // Answer the upgrade by hand: echoing the request head back is enough to prove
  // the tunnel carried it, without depending on a WebSocket implementation.
  upstream.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstreamPort, authority: `127.0.0.1:${String(upstreamPort)}` }),
    getAuth: () => 'none',
    getPassword: async () => '',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(listener.port, '127.0.0.1', () => {
        socket.write(
          `GET /socket HTTP/1.1\r\nhost: 127.0.0.1:${String(listener.port)}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: abc\r\nsec-websocket-version: 13\r\n\r\n`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
    });
    assert.match(reply, /101 Switching Protocols/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/socket');
    assert.equal(seen[0].headers.host, `127.0.0.1:${String(upstreamPort)}`);
  } finally {
    await listener.close();
    await closeServer(upstream, upstreamSockets);
  }
});

test('an upgrade without a session is refused before it reaches the host', async () => {
  const seen = [];
  const upstream = createServer((_req, res) => res.writeHead(400).end());
  const upstreamSockets = new Set();
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('upgrade', (req) => seen.push(req.url));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstreamPort, authority: `127.0.0.1:${String(upstreamPort)}` }),
    getAuth: () => 'password',
    getPassword: async () => 'hunter2',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(listener.port, '127.0.0.1', () => {
        socket.write(`GET /socket HTTP/1.1\r\nhost: h\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        socket.destroy();
        resolve(data);
      });
      socket.on('error', reject);
    });
    assert.match(reply, /401 Unauthorized/);
    assert.deepEqual(seen, []);
  } finally {
    await listener.close();
    await closeServer(upstream, upstreamSockets);
  }
});

test('a peer that resets mid-connection does not reach the process as an uncaught error', async () => {
  const upstream = await fakeUpstream();
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstream.port, authority: `127.0.0.1:${String(upstream.port)}` }),
    getAuth: () => 'none',
    getPassword: async () => '',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    // Connect, send half a request head and reset: the listener's own `error`
    // handlers are the only thing between this and a dead DSH process.
    await new Promise((resolve) => {
      const socket = connect(listener.port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nhost: h\r\n');
        socket.destroy();
        resolve();
      });
      socket.on('error', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
    await listener.close();
    await upstream.close();
  }
});

test('a host that disappears mid-flight produces a 502, not a hang', async () => {
  const upstream = await fakeUpstream();
  const port = upstream.port;
  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port, authority: `127.0.0.1:${String(port)}` }),
    getAuth: () => 'none',
    getPassword: async () => '',
    acquireCookie: async () => 'dsh-auth-abc',
  });
  try {
    await upstream.close();
    const response = await fetch(`${listener.base}/`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 502);
  } finally {
    await listener.close();
  }
});

test('closing the listener resolves even while a WebSocket is still open', async () => {
  // The app holds one WebSocket open for the whole session, and Node stops
  // tracking a socket once it upgrades — so `closeAllConnections` alone leaves
  // `close()` waiting forever, which would hang a port change or a disable.
  const upstream = createServer((_req, res) => res.writeHead(400).end());
  const upstreamSockets = new Set();
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const listener = await startListener({
    resolveUpstream: () => ({ protocol: 'http:', connectHost: '127.0.0.1', port: upstreamPort, authority: `127.0.0.1:${String(upstreamPort)}` }),
    getAuth: () => 'none',
    getPassword: async () => '',
    acquireCookie: async () => 'dsh-auth-abc',
  });

  let client;
  try {
    await new Promise((resolve, reject) => {
      client = connect(listener.port, '127.0.0.1', () => {
        client.write(`GET /socket HTTP/1.1\r\nhost: h\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`);
      });
      client.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('101')) resolve();
      });
      client.on('error', reject);
    });
    // The client stays connected on purpose: this is the state that used to hang.
    const closed = await Promise.race([
      listener.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);
    assert.equal(closed, 'closed');
  } finally {
    client?.destroy();
    await closeServer(upstream, upstreamSockets);
  }
});

test('binding a taken port rejects with the underlying error', async () => {
  const first = await startListener({
    resolveUpstream: () => undefined,
    getAuth: () => 'none',
    getPassword: async () => '',
    acquireCookie: async () => undefined,
  });
  try {
    const second = createAccessServer({
      port: first.port,
      host: '127.0.0.1',
      resolveUpstream: () => undefined,
      getAuth: () => 'none',
      getPassword: async () => '',
      acquireCookie: async () => undefined,
    });
    await assert.rejects(() => second.start(() => {}), /EADDRINUSE/);
  } finally {
    await first.close();
  }
});

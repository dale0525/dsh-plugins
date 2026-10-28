import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CdpConnection, connect, evaluate, openHiddenPage, resolveRedirect } from '../src/cdp.js';

/**
 * A stand-in for the browser WebSocket that records what was sent and replays
 * scripted replies.
 *
 * The real socket is only reachable with a live Chrome, so the protocol handling
 * — request ids, session routing, event dispatch, and the close contract — is
 * exercised against this instead.
 */
class FakeSocket {
  /** Messages the client sent, parsed. */
  sent = [];
  /** Pending listeners keyed by the CDP method they answer. */
  #handlers = new Map();
  readyState = 0;

  constructor() {
    // A microtask rather than a synchronous call: the client must tolerate the
    // socket opening after it has already registered its listeners.
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  /** Answer the next request for `method` with `result`. */
  reply(method, result) {
    this.#handlers.set(method, result);
  }

  /** Answer the next request for `method` with a protocol error. */
  replyError(method, error) {
    this.#handlers.set(method, { __error: error });
  }

  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    const scripted = this.#handlers.get(message.method);
    if (scripted === undefined) return;
    this.#handlers.delete(message.method);

    const reply = scripted.__error === undefined
      ? { id: message.id, result: scripted }
      : { id: message.id, error: scripted.__error };
    if (message.sessionId !== undefined) reply.sessionId = message.sessionId;
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
  }

  /** Push an unsolicited protocol event. */
  emit(method, params, sessionId) {
    const event = { method, params };
    if (sessionId !== undefined) event.sessionId = sessionId;
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(event) }));
  }

  close() {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({}));
  }
}

test('send resolves with the matching reply and rejects a protocol error', async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection(socket);
  await connection.opened();

  socket.reply('Target.getTargets', { targetInfos: [] });
  assert.deepEqual(await connection.send('Target.getTargets'), { targetInfos: [] });

  socket.replyError('Target.closeTarget', { code: -32602, message: 'No target with given id' });
  await assert.rejects(
    () => connection.send('Target.closeTarget', { targetId: 'gone' }),
    /No target with given id/,
  );
});

test('send routes the session id onto the wire and back', async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection(socket);
  await connection.opened();

  socket.reply('Runtime.evaluate', { result: { value: 42 } });
  const result = await connection.send('Runtime.evaluate', { expression: '6*7' }, 'SESSION-1');

  assert.deepEqual(result, { result: { value: 42 } });
  assert.equal(socket.sent.at(-1).sessionId, 'SESSION-1');
});

test('a session-scoped reply never settles a request from another session', async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection(socket);
  await connection.opened();

  socket.reply('Runtime.evaluate', { result: { value: 'second' } });
  const second = connection.send('Runtime.evaluate', {}, 'SESSION-B');

  // A reply carrying the wrong session id is not this request's answer; the
  // client must keep waiting rather than settle with a foreign value.
  socket.emit('Runtime.evaluate', { result: { value: 'stray' } }, 'SESSION-A');
  assert.deepEqual(await second, { result: { value: 'second' } });
});

test('closing the connection rejects requests still in flight', async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection(socket);
  await connection.opened();

  const pending = connection.send('Runtime.evaluate', {});
  connection.close();
  await assert.rejects(pending, /closed/);
});

test('evaluate returns the value and surfaces a thrown page error', async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection(socket);
  await connection.opened();

  socket.reply('Runtime.evaluate', { result: { value: { count: 3 } } });
  assert.deepEqual(await evaluate(connection, 'SESSION-1', '({count: 3})'), { count: 3 });

  socket.reply('Runtime.evaluate', { result: {}, exceptionDetails: { text: 'ReferenceError: x is not defined' } });
  await assert.rejects(
    () => evaluate(connection, 'SESSION-1', 'x'),
    /ReferenceError: x is not defined/,
  );
});

test('openHiddenPage creates a context and a background target, and closes both', async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection(socket);
  await connection.opened();

  socket.reply('Target.createBrowserContext', { browserContextId: 'CTX-1' });
  socket.reply('Target.createTarget', { targetId: 'TARGET-1' });
  socket.reply('Target.attachToTarget', { sessionId: 'SESSION-1' });
  socket.reply('Target.closeTarget', {});
  socket.reply('Target.disposeBrowserContext', {});

  const page = await openHiddenPage(connection);
  assert.equal(page.sessionId, 'SESSION-1');
  assert.equal(page.targetId, 'TARGET-1');

  // The tab must not appear in the tab strip: a background target in a separate
  // browser context is invisible, while a foreground one would be seen by the
  // user and steal their focus.
  const create = socket.sent.find((message) => message.method === 'Target.createTarget');
  assert.equal(create.params.background, true);
  assert.equal(create.params.browserContextId, 'CTX-1');

  await page.close();
  assert.ok(socket.sent.some((message) => message.method === 'Target.closeTarget'));
  assert.ok(socket.sent.some((message) => message.method === 'Target.disposeBrowserContext'));
});

test('openHiddenPage still disposes the context when closing the target fails', async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection(socket);
  await connection.opened();

  socket.reply('Target.createBrowserContext', { browserContextId: 'CTX-1' });
  socket.reply('Target.createTarget', { targetId: 'TARGET-1' });
  socket.reply('Target.attachToTarget', { sessionId: 'SESSION-1' });
  socket.replyError('Target.closeTarget', { code: -32602, message: 'No target with given id' });
  socket.reply('Target.disposeBrowserContext', {});

  const page = await openHiddenPage(connection);
  await page.close();

  // A leaked context would keep a hidden tab alive for the life of the browser,
  // so disposal is not conditional on the target close succeeding.
  assert.ok(socket.sent.some((message) => message.method === 'Target.disposeBrowserContext'));
});

test('resolveRedirect reports the Location of a redirect without following it', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 302, headers: { location: 'https://example.com/real' } });
  };

  const resolved = await resolveRedirect('https://www.google.com/goto?url=TOKEN', { fetch: fetchImpl });

  assert.equal(resolved, 'https://example.com/real');
  assert.equal(requests[0].init.redirect, 'manual');
});

test('resolveRedirect keeps the original URL when the redirect is unhelpful', async () => {
  const original = 'https://www.google.com/goto?url=TOKEN';
  const fetchImpl = async () => new Response('<html>', { status: 200 });

  assert.equal(await resolveRedirect(original, { fetch: fetchImpl }), original);
});

test('connect names the endpoint when Chrome is unreachable', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };

  // "fetch failed" alone is indistinguishable from a wrong port, so the endpoint
  // has to reach the caller — it is the only part they can act on.
  await assert.rejects(
    () => connect('http://127.0.0.1:9999', { fetch: fetchImpl }),
    /could not reach Chrome at http:\/\/127\.0\.0\.1:9999/,
  );
});

test('connect rejects an endpoint that is not serving CDP', async () => {
  const fetchImpl = async () => new Response('nope', { status: 404 });

  await assert.rejects(
    () => connect('http://127.0.0.1:9222', { fetch: fetchImpl }),
    /answered HTTP 404/,
  );
});

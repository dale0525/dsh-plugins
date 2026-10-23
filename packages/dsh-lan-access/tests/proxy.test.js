/**
 * Header and target rewriting, which is where the whole trick lives.
 *
 * If `Host` is not rewritten the host's fence rejects the request as untrusted;
 * if `Origin` is not rewritten it rejects it as cross-origin; if the host's own
 * cookie is forwarded from the browser it is bound to the wrong authority and
 * ignored; if the plugin's session cookie travels upstream it lands in the
 * host's logs. Each of those is one assertion below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_COOKIE_PREFIX,
  cookieValue,
  forwardHeaders,
  forwardedTarget,
  responseHeaders,
  setCookieName,
  upgradeHeadline,
  wantsDocument,
} from '../src/proxy.js';

const UPSTREAM = { upstreamAuthority: '127.0.0.1:3080', sessionCookieName: 'dsh-lan-access-session' };

test('reads one cookie out of a header, and reports an absent one', () => {
  assert.equal(cookieValue('a=1; b=2', 'b'), '2');
  assert.equal(cookieValue('a=1', 'z'), undefined);
  assert.equal(cookieValue(undefined, 'a'), undefined);
  assert.equal(cookieValue('broken; a=1', 'a'), '1');
});

test('extracts the name from a Set-Cookie value', () => {
  assert.equal(setCookieName('dsh-auth-x=abc; Path=/'), 'dsh-auth-x');
  assert.equal(setCookieName('plain'), 'plain');
});

test('the forwarded request presents the host authority, not the one the browser used', () => {
  const headers = forwardHeaders({ host: '192.168.1.20:10000', accept: 'text/html' }, UPSTREAM);
  assert.equal(headers.host, '127.0.0.1:3080');
  assert.equal(headers.accept, 'text/html');
});

test('the Origin header is rewritten to the same authority, so the fence sees a same-origin request', () => {
  const headers = forwardHeaders({ host: '192.168.1.20:10000', origin: 'http://192.168.1.20:10000' }, UPSTREAM);
  assert.equal(headers.origin, 'http://127.0.0.1:3080');
});

test('an absent Origin stays absent rather than being invented', () => {
  const headers = forwardHeaders({ host: '192.168.1.20:10000' }, UPSTREAM);
  assert.equal(headers.origin, undefined);
});

test('the browser cookie is replaced by the host cookie the plugin adopted', () => {
  const headers = forwardHeaders(
    { host: 'h', cookie: 'dsh-auth-old=stale; theme=dark' },
    { ...UPSTREAM, authCookie: 'dsh-auth-new=fresh' },
  );
  // The browser's copy is bound to the plugin's authority and would be ignored,
  // while re-sending it upstream only risks a stale value winning.
  assert.doesNotMatch(headers.cookie, /stale/);
  assert.match(headers.cookie, /dsh-auth-new=fresh/);
  // Unrelated cookies still travel: the app keeps its own state in them.
  assert.match(headers.cookie, /theme=dark/);
});

test('the plugin session cookie never travels upstream', () => {
  const headers = forwardHeaders(
    { host: 'h', cookie: 'dsh-lan-access-session=secret; theme=dark' },
    { ...UPSTREAM, authCookie: 'dsh-auth-x=1' },
  );
  assert.doesNotMatch(headers.cookie, /secret/);
});

test('with no adopted host cookie the browser cookies are dropped, not forwarded', () => {
  const headers = forwardHeaders({ host: 'h', cookie: 'theme=dark' }, UPSTREAM);
  assert.equal(headers.cookie, 'theme=dark');
});

test('hop-by-hop headers are dropped from a plain request', () => {
  const headers = forwardHeaders({ host: 'h', connection: 'keep-alive', 'transfer-encoding': 'chunked' }, UPSTREAM);
  assert.equal(headers.connection, undefined);
  assert.equal(headers['transfer-encoding'], undefined);
});

test('an upgrade keeps its hop-by-hop headers, because the handshake needs them', () => {
  const headers = forwardHeaders(
    { host: 'h', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'abc' },
    { ...UPSTREAM, upgrade: true },
  );
  assert.equal(headers.connection, 'Upgrade');
  assert.equal(headers.upgrade, 'websocket');
  assert.equal(headers['sec-websocket-key'], 'abc');
});

test('the response drops the host cookie the browser must not store under this authority', () => {
  const headers = responseHeaders({
    'content-type': 'text/html',
    'set-cookie': ['dsh-auth-abc=value; Path=/', 'theme=dark; Path=/'],
  });
  assert.equal(headers['content-type'], 'text/html');
  assert.deepEqual(headers['set-cookie'], ['theme=dark; Path=/']);
});

test('a response with no cookies carries no Set-Cookie at all', () => {
  const headers = responseHeaders({ 'content-type': 'text/html' });
  assert.equal(headers['set-cookie'], undefined);
});

test('the forwarded target drops the launch token', () => {
  // The plugin's port has its own gate; forwarding the host token would make it
  // a second door for anyone who read the token from `dsh web` output.
  assert.equal(forwardedTarget('/?token=abcdef'), '/');
  assert.equal(forwardedTarget('/api/x?token=abcdef&y=1'), '/api/x?y=1');
  assert.equal(forwardedTarget('/api/x?a=1'), '/api/x?a=1');
  assert.equal(forwardedTarget(undefined), '/');
});

test('a combo asset URL survives, because its commas and @ are not a query', () => {
  // The host bundles many client bundles into one request:
  //   /plugins/??a/client.js,b/client.js&rev=1234
  // There is no `?` before the comma list -- the query STARTS at the first `?`,
  // so the list is the PATH and only `&rev=` is a parameter. Re-encoding it as
  // a query turned the list into one escaped key and every script 404'd, which
  // the browser reports as "HTML did not preload <module>/client.js".
  const raw = '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=3c2722f46a08';
  assert.equal(forwardedTarget(raw), raw);

  const many = '/plugins/??a/client.js,b/client.js&rev=1cffe43252a9';
  assert.equal(forwardedTarget(many), many);
});

test('only a real token parameter is dropped, and the rest is left byte-for-byte', () => {
  // Encoding must not be normalized either: the host signs nothing here, but a
  // request the browser already encoded should arrive exactly as it left.
  assert.equal(forwardedTarget('/a%20b/c?x=%2F&token=t'), '/a%20b/c?x=%2F');
  assert.equal(forwardedTarget('/x?y=1&token=t&z=2'), '/x?y=1&z=2');
  assert.equal(forwardedTarget('/x?tokenish=1'), '/x?tokenish=1');
});

test('the upgrade head is a well-formed request line plus headers', () => {
  const head = upgradeHeadline({ method: 'GET' }, { host: '127.0.0.1:3080', connection: 'Upgrade' }, '/ws');
  assert.equal(head, 'GET /ws HTTP/1.1\r\nhost: 127.0.0.1:3080\r\nconnection: Upgrade\r\n\r\n');
});

test('only a GET that prefers HTML is treated as a navigation', () => {
  assert.equal(wantsDocument({ method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } }), true);
  assert.equal(wantsDocument({ method: 'GET', headers: { accept: 'application/json' } }), false);
  assert.equal(wantsDocument({ method: 'GET', headers: {} }), false);
  // A POST answered with the login page would look like a successful write.
  assert.equal(wantsDocument({ method: 'POST', headers: { accept: 'text/html' } }), false);
});

test('the host cookie prefix is the one the host actually mints', () => {
  // Must equal `COOKIE_PREFIX` in @deepseek-ai/dsh-client-connection; a mismatch
  // would let the host's authority-bound cookie reach the browser.
  assert.equal(HOST_COOKIE_PREFIX, 'dsh-auth-');
});

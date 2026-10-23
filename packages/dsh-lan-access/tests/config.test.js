/**
 * The schema, and the normalization that every other module reads through.
 *
 * `normalizeSettings` is the only thing standing between a hand-edited
 * `cordis.patch.yml` (or a value that arrived through config sync) and a
 * listener that would otherwise try to bind `port: "abc"`. These cases are the
 * shapes that actually occur: absent keys, string ports, and a mode that is no
 * longer one of the two the plugin knows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Config, DEFAULT_PORT, ENTRY_ID, PASSWORD_REF, STATUS_PATH, normalizeSettings, sameListener } from '../src/config.js';

test('the schema is volatile at its root, so settings edits do not remount the plugin', () => {
  assert.equal(Config.meta?.volatile, true);
});

test('the entry id equals the host half plugin name', async () => {
  const { name } = await import('../src/index.js');
  assert.equal(ENTRY_ID, name);
});

test('the credential reference is a POSIX shell identifier', () => {
  assert.match(PASSWORD_REF, /^[A-Za-z_][A-Za-z0-9_]*$/);
});

test('the status path stays outside /api, where the host fence does not cover it', () => {
  assert.ok(STATUS_PATH.startsWith('/'));
  assert.ok(!STATUS_PATH.startsWith('/api'));
});

test('the schema documents every field for the settings form', () => {
  const json = Config.toJSON();
  const fields = Object.values(json.refs).filter((ref) => ref.meta?.comment !== undefined);
  const comments = fields.map((ref) => ref.meta.comment);
  assert.deepEqual(comments.sort(), ['启用局域网访问', '访问端口', '鉴权方式'].sort());
});

test('an empty config reads as enabled, on the default port, with a password', () => {
  assert.deepEqual(normalizeSettings({}), { enabled: true, port: DEFAULT_PORT, auth: 'password' });
});

test('a missing config reads as the defaults rather than throwing', () => {
  assert.deepEqual(normalizeSettings(undefined), { enabled: true, port: DEFAULT_PORT, auth: 'password' });
  assert.deepEqual(normalizeSettings(null), { enabled: true, port: DEFAULT_PORT, auth: 'password' });
});

test('a stored false disables the listener; anything else leaves it on', () => {
  assert.equal(normalizeSettings({ enabled: false }).enabled, false);
  assert.equal(normalizeSettings({ enabled: true }).enabled, true);
  assert.equal(normalizeSettings({ enabled: 'no' }).enabled, true);
});

test('a numeric port is kept', () => {
  assert.equal(normalizeSettings({ port: 8080 }).port, 8080);
});

test('a port that no listener could bind falls back instead of reaching listen()', () => {
  for (const port of ['abc', '', 0, -1, 65536, 1.5, Number.NaN, undefined, {}]) {
    assert.equal(normalizeSettings({ port }).port, DEFAULT_PORT, `port ${JSON.stringify(port)}`);
  }
});

test('an unknown auth mode falls back to requiring a password, never to none', () => {
  assert.equal(normalizeSettings({ auth: 'none' }).auth, 'none');
  assert.equal(normalizeSettings({ auth: 'password' }).auth, 'password');
  // Failing open would turn a corrupted settings file into an open port.
  assert.equal(normalizeSettings({ auth: 'off' }).auth, 'password');
  assert.equal(normalizeSettings({ auth: undefined }).auth, 'password');
});

test('only the port and the enabled flag decide whether the listener is rebound', () => {
  const base = { enabled: true, port: 10000, auth: 'password' };
  assert.equal(sameListener(base, { ...base }), true);
  // The gate reads `auth` per request, so switching modes must not drop live
  // connections of everyone already inside.
  assert.equal(sameListener(base, { ...base, auth: 'none' }), true);
  assert.equal(sameListener(base, { ...base, port: 10001 }), false);
  assert.equal(sameListener(base, { ...base, enabled: false }), false);
});

/**
 * The gate's two cryptographic decisions, plus the throttle.
 *
 * A session cookie that outlives a password change, or a comparison that leaks
 * the password's length, are the failures worth pinning down here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_COOKIE,
  createFailureLimiter,
  mintSession,
  newSecret,
  passwordMatches,
  sessionCookie,
  verifySession,
} from '../src/auth.js';

const NOW = 1_700_000_000_000;

test('a minted session verifies inside its lifetime', () => {
  const secret = newSecret();
  const { value } = mintSession(secret, NOW, 1000);
  assert.equal(verifySession(secret, value, NOW), true);
  assert.equal(verifySession(secret, value, NOW + 999), true);
});

test('an expired session does not verify', () => {
  const secret = newSecret();
  const { value } = mintSession(secret, NOW, 1000);
  assert.equal(verifySession(secret, value, NOW + 1000), false);
});

test('a session signed by another process does not verify', () => {
  const { value } = mintSession(newSecret(), NOW, 1000);
  // Restarting DSH mints a new secret, which is what invalidates every session
  // after a password change.
  assert.equal(verifySession(newSecret(), value, NOW), false);
});

test('a tampered expiry does not verify', () => {
  const secret = newSecret();
  const { value } = mintSession(secret, NOW, 1000);
  const parts = value.split('.');
  const forged = `${parts[0]}.${String(NOW + 10_000_000)}.${parts[2]}`;
  assert.equal(verifySession(secret, forged, NOW), false);
});

test('malformed cookie values are refused without throwing', () => {
  const secret = newSecret();
  for (const value of [undefined, null, '', 'x', 'v1', 'v1.abc.def', 'v2.1.2', 'v1.1', 'v1.1.2.3']) {
    assert.equal(verifySession(secret, value, NOW), false, String(value));
  }
});

test('the cookie is scoped, http-only and not Secure on a plain listener', () => {
  const header = sessionCookie(SESSION_COOKIE, 'value', NOW + 1000, 1000);
  assert.ok(header.startsWith(`${SESSION_COOKIE}=value;`));
  assert.match(header, /Path=\//);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=1\b/);
  // A `Secure` cookie would be dropped by the browser on this plain-HTTP
  // listener, making a successful login bounce straight back to the form.
  assert.doesNotMatch(header, /Secure/);
});

test('the password compare accepts only an exact match', () => {
  assert.equal(passwordMatches('hunter2', 'hunter2'), true);
  assert.equal(passwordMatches('hunter2', 'hunter3'), false);
  assert.equal(passwordMatches('hunter2', 'hunter'), false);
  assert.equal(passwordMatches('hunter2', 'hunter22'), false);
});

test('an empty password never matches, so an unset credential cannot log anyone in', () => {
  assert.equal(passwordMatches('', ''), false);
  assert.equal(passwordMatches('', 'anything'), false);
  assert.equal(passwordMatches('hunter2', ''), false);
  assert.equal(passwordMatches(undefined, 'hunter2'), false);
  assert.equal(passwordMatches('hunter2', undefined), false);
});

test('repeated failures block the address, and a success clears it', () => {
  const limiter = createFailureLimiter({ maxFailures: 3, windowMs: 1000 });
  assert.equal(limiter.blocked('1.2.3.4', NOW), false);
  limiter.record('1.2.3.4', NOW);
  limiter.record('1.2.3.4', NOW);
  assert.equal(limiter.blocked('1.2.3.4', NOW), false);
  limiter.record('1.2.3.4', NOW);
  assert.equal(limiter.blocked('1.2.3.4', NOW), true);
  // Another address is unaffected: one noisy client must not lock out the house.
  assert.equal(limiter.blocked('5.6.7.8', NOW), false);
  limiter.clear('1.2.3.4');
  assert.equal(limiter.blocked('1.2.3.4', NOW), false);
});

test('a block lifts once its window passes', () => {
  const limiter = createFailureLimiter({ maxFailures: 1, windowMs: 1000 });
  limiter.record('1.2.3.4', NOW);
  assert.equal(limiter.blocked('1.2.3.4', NOW), true);
  assert.equal(limiter.blocked('1.2.3.4', NOW + 1000), false);
});

test('the limiter forgets expired addresses rather than growing without bound', () => {
  const limiter = createFailureLimiter({ maxFailures: 5, windowMs: 1000 });
  // A botnet walking the address space is the growth case; the table prunes once
  // it is past its cap, so a long-running process cannot accumulate entries.
  for (let index = 0; index < 1100; index += 1) limiter.record(`10.0.${String(index)}.1`, NOW);
  assert.equal(limiter.size, 1100);
  limiter.record('192.168.1.1', NOW + 5000);
  assert.equal(limiter.size, 1);
});

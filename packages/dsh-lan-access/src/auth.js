/**
 * The plugin's own access gate: session cookie, password compare, throttling.
 *
 * Three decisions are load-bearing:
 *
 *  - **The session is stateless.** The cookie carries its own expiry and an
 *    HMAC over it, keyed by a secret minted per process. Nothing is written to
 *    disk, so a restart invalidates every session — which is the correct
 *    outcome for a password that may have just been changed, and it keeps this
 *    plugin from owning a second credential record.
 *
 *  - **The compare is length-independent.** `timingSafeEqual` throws on
 *    different lengths, and comparing the raw strings would leak the length
 *    through that throw or through an early return. Both sides are therefore
 *    hashed first, so every comparison runs over 32 bytes.
 *
 *  - **Failures are counted per client address.** The password is chosen by a
 *    human, so it is the only guessable secret in this design; the upstream
 *    host's own launch token is 32 random bytes and needs no such guard.
 *
 * @module @logictan/dsh-lan-access/auth
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Name of the plugin's own session cookie. Distinct from the host's `dsh-auth-*`. */
export const SESSION_COOKIE = 'dsh-lan-access-session';

/** Session lifetime; long enough not to nag, short enough that a changed password takes effect. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Cookie payload version, so a future change cannot be read as a valid old session. */
const VERSION = 'v1';

/** Fixed key for the password digest; the digest only needs to hide length, not the password. */
const COMPARE_KEY = 'dsh-lan-access/password-compare';

/**
 * Mint the per-process session signing secret.
 *
 * @returns 32 random bytes.
 */
export function newSecret() {
  return randomBytes(32);
}

/**
 * Sign one cookie payload.
 *
 * @param secret - the process secret.
 * @param body - the payload text being signed.
 * @returns the base64url HMAC.
 */
function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Mint a session value for one client.
 *
 * @param secret - the process secret.
 * @param now - current epoch milliseconds.
 * @param maxAgeMs - lifetime.
 * @returns `{value, expiresAt}`; `value` goes into the cookie verbatim.
 */
export function mintSession(secret, now, maxAgeMs = SESSION_MAX_AGE_MS) {
  const expiresAt = now + maxAgeMs;
  const body = `${VERSION}.${String(expiresAt)}`;
  return { value: `${body}.${sign(secret, body)}`, expiresAt };
}

/**
 * Verify one session value.
 *
 * @param secret - the process secret.
 * @param value - the cookie value, as received.
 * @param now - current epoch milliseconds.
 * @returns true only for an unexpired value signed by this process.
 */
export function verifySession(secret, value, now) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const expected = Buffer.from(sign(secret, `${VERSION}.${String(expiresAt)}`), 'utf8');
  const actual = Buffer.from(parts[2], 'utf8');
  if (actual.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Serialize the session cookie.
 *
 * `HttpOnly` keeps it out of script reach; `SameSite=Lax` still allows the
 * top-level navigation the login flow performs, and refuses cross-site form
 * posts that would otherwise let another page log a browser in.
 *
 * @param name - cookie name.
 * @param value - cookie value.
 * @param expiresAt - absolute expiry, epoch milliseconds.
 * @param maxAgeMs - lifetime, for `Max-Age`.
 * @returns the `Set-Cookie` header value.
 */
export function sessionCookie(name, value, expiresAt, maxAgeMs = SESSION_MAX_AGE_MS) {
  const attributes = `${name}=${value}; Max-Age=${String(Math.floor(maxAgeMs / 1000))}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Lax`;
  // No `Secure`: this listener speaks plain HTTP by design, and a `Secure`
  // cookie would be dropped by the browser, making the login appear to succeed
  // and then bounce straight back to the form.
  return attributes;
}

/**
 * Compare a submitted password with the configured one.
 *
 * @param expected - the configured password.
 * @param actual - what the client submitted.
 * @returns true only when both are non-empty and equal.
 */
export function passwordMatches(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  if (expected === '' || actual === '') return false;
  const a = createHmac('sha256', COMPARE_KEY).update(actual, 'utf8').digest();
  const b = createHmac('sha256', COMPARE_KEY).update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Count failed logins per client address.
 *
 * In-memory and per process on purpose: a restart is the user's own recovery
 * path, and persisting counters would need a file this plugin has no other
 * reason to own.
 *
 * @param options.maxFailures - failures allowed inside one window.
 * @param options.windowMs - window length.
 * @returns `{blocked, record, clear, size}`.
 */
export function createFailureLimiter(options = {}) {
  const maxFailures = options.maxFailures ?? 10;
  const windowMs = options.windowMs ?? 5 * 60 * 1000;
  /** address → `{count, resetAt}`. */
  const entries = new Map();

  /** Drop expired entries so a long-running process cannot grow without bound. */
  function prune(now) {
    for (const [key, entry] of entries) if (now >= entry.resetAt) entries.delete(key);
  }

  return {
    /**
     * Whether this address has used up its attempts.
     *
     * @param key - client address.
     * @param now - current epoch milliseconds.
     * @returns true when the next attempt must be refused unread.
     */
    blocked(key, now) {
      const entry = entries.get(key);
      if (entry === undefined) return false;
      if (now >= entry.resetAt) {
        entries.delete(key);
        return false;
      }
      return entry.count >= maxFailures;
    },
    /**
     * Record one failed attempt.
     *
     * @param key - client address.
     * @param now - current epoch milliseconds.
     */
    record(key, now) {
      if (entries.size > 1024) prune(now);
      const entry = entries.get(key);
      if (entry === undefined || now >= entry.resetAt) {
        entries.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },
    /**
     * Forget one address, after a successful login.
     *
     * @param key - client address.
     */
    clear(key) {
      entries.delete(key);
    },
    /** Number of tracked addresses, for tests and for bounding growth. */
    get size() {
      return entries.size;
    },
  };
}

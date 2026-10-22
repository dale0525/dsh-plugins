/**
 * Known host keys: first-use trust, then refusal on change.
 *
 * Password authentication has a failure mode key authentication does not: the
 * secret is handed to whoever answers on the address, so an impostor that wins
 * the race gets the password. ssh2 will happily skip that check — its default
 * `hostVerifier` accepts every key — which is why this module exists.
 *
 * The policy is OpenSSH's `accept-new`: the first key seen for an address is
 * recorded and accepted, and every later connection to that address must match
 * it. This cannot stop the very first connection from being intercepted; it
 * stops every one after it, and it turns a silent key change (a rebuilt host, or
 * a man in the middle) into an error that names both fingerprints instead of a
 * password leak.
 *
 * Entries are keyed by `host:port`, not by alias: the trust decision is about the
 * address that was dialled, and two aliases pointing at one machine must share
 * one entry. The file lives under `$DSH_HOME` and is deliberately NOT synced —
 * trust is per device, and a synced file would let one compromised machine vouch
 * for an impostor everywhere.
 *
 * @module @logictan/dsh-ssh/known-hosts
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Format marker, so a future shape can be told apart from this one. */
const VERSION = 1;

/**
 * Address key of one host entry.
 *
 * @param host - configured hostname or address.
 * @param port - configured port.
 * @returns the `host:port` key.
 */
export function addressKey(host, port) {
  return `${String(host).toLowerCase()}:${port}`;
}

/**
 * Fingerprint one host key in OpenSSH's display form.
 *
 * SHA-256 over the raw key blob, base64 without padding — the same string
 * `ssh-keygen -lf` prints, so a user can compare it with what the server
 * reports for itself.
 *
 * @param key - the raw public key buffer ssh2 hands the verifier.
 * @returns `SHA256:<base64>`.
 */
export function fingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Path of the known-host file for one harness home.
 *
 * @param dshHome - the resolved harness home.
 * @returns the absolute path.
 */
export function knownHostsPath(dshHome) {
  return join(dshHome, 'dsh-ssh', 'known-hosts.json');
}

/**
 * Read the recorded keys.
 *
 * A missing or unreadable file reads as empty rather than throwing: losing the
 * file must degrade to first-use trust, not to "this plugin is broken". A
 * corrupt file is treated the same way for the same reason.
 *
 * @param path - absolute path of the file.
 * @returns `{entries}` keyed by address.
 */
export async function readKnownHosts(path) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    const entries = parsed && typeof parsed.entries === 'object' && parsed.entries !== null ? parsed.entries : {};
    return { entries };
  } catch {
    return { entries: {} };
  }
}

/**
 * Record one address's key.
 *
 * Written through a temporary file and a rename so a crash cannot leave a
 * half-written file that reads as "no trust" and silently re-trusts an impostor.
 *
 * @param path - absolute path of the file.
 * @param entries - the entries to persist.
 * @returns the write's settlement.
 */
export async function writeKnownHosts(path, entries) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: VERSION, entries }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Decide one connection's host key, and say what was decided.
 *
 * Split out from the connection so the policy can be tested without a socket:
 * the caller reads the file once, then asks this function per connection.
 *
 * @param options.entries - recorded entries, keyed by address.
 * @param options.host - configured hostname.
 * @param options.port - configured port.
 * @param options.key - the raw public key ssh2 received.
 * The address comes back with the verdict so the caller never re-spells the key:
 * a second spelling of `host:port` would record one entry and check another.
 *
 * @returns `{ok, address, fingerprint, firstUse, expected}`; `ok: false` carries
 *   the recorded fingerprint the caller should show.
 */
export function judgeHostKey({ entries, host, port, key }) {
  const address = addressKey(host, port);
  const seen = fingerprint(key);
  const recorded = entries[address];
  if (recorded === undefined) return { ok: true, address, fingerprint: seen, firstUse: true };
  if (recorded === seen) return { ok: true, address, fingerprint: seen, firstUse: false };
  return { ok: false, address, fingerprint: seen, firstUse: false, expected: recorded };
}

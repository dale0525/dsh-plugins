/**
 * Tests for host-key trust: first use records, a later change is refused.
 *
 * This is the module that stops a password from being handed to an impostor, so
 * the tests assert the decision, not the plumbing: an unknown key is accepted
 * exactly once and recorded; the same key is accepted silently afterwards; a
 * different key is refused and the refusal carries the recorded fingerprint the
 * user needs to compare.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addressKey, fingerprint, judgeHostKey, knownHostsPath, readKnownHosts, writeKnownHosts } from '../src/known-hosts.js';

/** Two distinct key blobs, standing in for two servers. */
const KEY_A = Buffer.from('0000000b7373682d6564323535313900000020aaaa', 'hex');
const KEY_B = Buffer.from('0000000b7373682d6564323535313900000020bbbb', 'hex');

test('a fingerprint is the OpenSSH SHA256 form', () => {
  const seen = fingerprint(KEY_A);
  assert.match(seen, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.notEqual(seen, fingerprint(KEY_B));
  assert.equal(seen, fingerprint(KEY_A), 'the same key must fingerprint identically');
});

test('an address key folds the host case and keeps the port', () => {
  assert.equal(addressKey('NAS.lan', 22), 'nas.lan:22');
  assert.notEqual(addressKey('nas.lan', 22), addressKey('nas.lan', 2222));
});

test('the first key for an address is accepted and flagged as first use', () => {
  const verdict = judgeHostKey({ entries: {}, host: 'nas', port: 22, key: KEY_A });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.firstUse, true);
  assert.equal(verdict.fingerprint, fingerprint(KEY_A));
});

test('the recorded key is accepted without being flagged again', () => {
  const entries = { 'nas:22': fingerprint(KEY_A) };
  const verdict = judgeHostKey({ entries, host: 'nas', port: 22, key: KEY_A });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.firstUse, false);
});

test('a changed key is refused and reports what was expected', () => {
  const entries = { 'nas:22': fingerprint(KEY_A) };
  const verdict = judgeHostKey({ entries, host: 'nas', port: 22, key: KEY_B });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.firstUse, false);
  assert.equal(verdict.expected, fingerprint(KEY_A));
  assert.equal(verdict.fingerprint, fingerprint(KEY_B));
});

test('trust is per address: the same machine on another port is a new entry', () => {
  const entries = { 'nas:22': fingerprint(KEY_A) };
  const verdict = judgeHostKey({ entries, host: 'nas', port: 2222, key: KEY_B });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.firstUse, true);
});

test('the store round-trips, and a corrupt file reads as empty instead of throwing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-known-'));
  const path = knownHostsPath(home);
  assert.equal(path, join(home, 'dsh-ssh', 'known-hosts.json'));

  assert.deepEqual(await readKnownHosts(path), { entries: {} }, 'a missing file must read as empty');

  await writeKnownHosts(path, { 'nas:22': fingerprint(KEY_A) });
  assert.deepEqual(await readKnownHosts(path), { entries: { 'nas:22': fingerprint(KEY_A) } });
  const text = await readFile(path, 'utf8');
  assert.equal(JSON.parse(text).version, 1);

  await writeFile(path, 'not json');
  assert.deepEqual(await readKnownHosts(path), { entries: {} });
});

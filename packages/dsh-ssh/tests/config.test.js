/**
 * Tests for the host table: alias grammar, normalization, and the credential
 * reference derived from an alias.
 *
 * The collision case is the one worth pinning. `passwordRef` folds an alias into
 * the credential grammar `[A-Za-z_][A-Za-z0-9_]*`, which is not injective —
 * `a-b` and `a.b` both become `A_B`. If normalization accepted both, the two
 * hosts would silently share one password, and the only symptom would be "one of
 * my hosts stopped accepting its password" the first time the two differ.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { aliasError, findHost, normalizeHosts, passwordRef, PASSWORD_REF_PREFIX } from '../src/config.js';

test('a password reference is a credential-grammar name derived from the alias', () => {
  assert.equal(passwordRef('nas'), 'SSH_PASSWORD_NAS');
  assert.equal(passwordRef('personal-cloud-unraid'), 'SSH_PASSWORD_PERSONAL_CLOUD_UNRAID');
  assert.equal(passwordRef('nas.lan'), 'SSH_PASSWORD_NAS_LAN');
  for (const alias of ['nas', 'a-b', 'a.b', 'A_1']) {
    assert.match(passwordRef(alias), /^[A-Za-z_][A-Za-z0-9_]*$/, `ref for ${alias} is outside the credential grammar`);
    assert.ok(passwordRef(alias).startsWith(PASSWORD_REF_PREFIX));
  }
});

test('an alias must be typeable inside a sentence', () => {
  assert.equal(aliasError('nas'), undefined);
  assert.equal(aliasError('personal-cloud-unraid'), undefined);
  assert.equal(aliasError('nas_2.lan'), undefined);
  for (const bad of ['', ' nas', 'nas ', 'my nas', 'nas;rm', '-nas', '_nas']) {
    assert.notEqual(aliasError(bad), undefined, `alias ${JSON.stringify(bad)} should be rejected`);
  }
  assert.notEqual(aliasError('a'.repeat(65)), undefined);
});

test('normalization applies the defaults a hand-written row may omit', () => {
  const { hosts, errors } = normalizeHosts([{ alias: 'nas', host: ' 10.0.0.2 ', username: ' root ' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(hosts, [
    { alias: 'nas', host: '10.0.0.2', port: 22, username: 'root', passwordRef: 'SSH_PASSWORD_NAS' },
  ]);
});

test('two aliases that fold to one password reference are refused, not merged', () => {
  const { hosts, errors } = normalizeHosts([
    { alias: 'a-b', host: 'h1', username: 'u' },
    { alias: 'a.b', host: 'h2', username: 'u' },
  ]);
  assert.equal(hosts.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /SSH_PASSWORD_A_B/);
});

test('a duplicate alias is refused case-insensitively', () => {
  const { hosts, errors } = normalizeHosts([
    { alias: 'nas', host: 'h1', username: 'u' },
    { alias: 'NAS', host: 'h2', username: 'u' },
  ]);
  assert.deepEqual(
    hosts.map((entry) => entry.alias),
    ['nas'],
  );
  assert.match(errors[0], /重复/);
});

test('a row missing a required fact is dropped with a message naming the row', () => {
  const { hosts, errors } = normalizeHosts([
    { alias: 'a', host: '', username: 'u' },
    { alias: 'b', host: 'h', username: '' },
    { alias: 'c', host: 'h', username: 'u', port: 0 },
    { alias: 'd', host: 'h', username: 'u', port: 70000 },
    { alias: 'e', host: 'h', username: 'u', port: 'not-a-port' },
    null,
    { alias: 'ok', host: 'h', username: 'u' },
  ]);
  assert.deepEqual(
    hosts.map((entry) => entry.alias),
    ['ok'],
  );
  assert.equal(errors.length, 6);
  assert.match(errors[0], /hosts\[0\]/);
});

test('a non-array value reads as an empty table instead of throwing', () => {
  for (const value of [undefined, null, 'hosts', 42, {}]) {
    assert.deepEqual(normalizeHosts(value), { hosts: [], errors: [] });
  }
});

test('lookup ignores case and surrounding whitespace, and misses cleanly', () => {
  const { hosts } = normalizeHosts([{ alias: 'nas', host: 'h', username: 'u' }]);
  assert.equal(findHost(hosts, 'NAS')?.alias, 'nas');
  assert.equal(findHost(hosts, ' nas ')?.alias, 'nas');
  assert.equal(findHost(hosts, 'nope'), undefined);
  assert.equal(findHost(hosts, undefined), undefined);
});

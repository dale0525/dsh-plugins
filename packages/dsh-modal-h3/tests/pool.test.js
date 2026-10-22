/**
 * Tests for the account-pool seam.
 *
 * The pool is hand-pasted JSON, so the interesting cases are the malformed ones:
 * the rule that matters is that a broken pool is refused with EVERY problem
 * listed, because a one-error-at-a-time message makes a three-typo paste a
 * three-round trip. The selection rule is the other half — it is what turns N
 * accounts into N parallel generations, and the worker's `max_containers=1` is
 * why "least busy" rather than "any".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACCOUNTS_REF, accountEnvironment, parseAccountPool, selectAccount } from '../src/pool.js';

/** One well-formed account, as the DSH-Novel pool file spelled it. */
const ACCOUNT = { name: 'acc1', token_id: 'ak-abc', token_secret: 'shh', monthly_credit_usd: 30 };

test('the pool ref is a POSIX identifier, which is the only shape a credential ref may take', () => {
  assert.match(ACCOUNTS_REF, /^[A-Za-z_][A-Za-z0-9_]*$/);
});

test('a well-formed pool parses and keeps the credit annotation', () => {
  const { accounts, errors } = parseAccountPool(JSON.stringify({ tokens: [ACCOUNT] }));
  assert.deepEqual(errors, []);
  assert.deepEqual(accounts, [{ name: 'acc1', tokenId: 'ak-abc', tokenSecret: 'shh', monthlyCreditUsd: 30 }]);
});

test('a bare array is accepted, because the pool file has been hand-edited in both shapes', () => {
  const { accounts, errors } = parseAccountPool(JSON.stringify([ACCOUNT]));
  assert.deepEqual(errors, []);
  assert.equal(accounts.length, 1);
});

test('a missing monthly credit is dropped rather than defaulted', () => {
  const { accounts } = parseAccountPool(JSON.stringify({ tokens: [{ name: 'a', token_id: 'i', token_secret: 's' }] }));
  assert.deepEqual(accounts, [{ name: 'a', tokenId: 'i', tokenSecret: 's' }]);
});

test('an empty or non-string credential reports one actionable error', () => {
  for (const value of ['', '   ', undefined, null, 42]) {
    const { accounts, errors } = parseAccountPool(value);
    assert.deepEqual(accounts, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /expected \{"tokens"/);
  }
});

test('invalid JSON reports the parser message', () => {
  const { errors } = parseAccountPool('{ not json');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not valid JSON/);
});

test('every problem in one paste is reported at once, not just the first', () => {
  const { accounts, errors } = parseAccountPool(
    JSON.stringify({
      tokens: [
        { name: '', token_id: '', token_secret: '' },
        { name: 'dup', token_id: 'i', token_secret: 's' },
        { name: 'dup', token_id: 'i', token_secret: 's' },
        'not an object',
      ],
    }),
  );
  assert.deepEqual(accounts, [{ name: 'dup', tokenId: 'i', tokenSecret: 's' }]);
  assert.deepEqual(errors, [
    'tokens[0].name is missing or empty',
    'tokens[0].token_id is missing or empty',
    'tokens[0].token_secret is missing or empty',
    'tokens[2].name is duplicated: dup',
    'tokens[3] is not an object',
  ]);
});

test('a tokens array that is empty is refused instead of yielding an empty pool', () => {
  const { accounts, errors } = parseAccountPool('{"tokens": []}');
  assert.deepEqual(accounts, []);
  assert.deepEqual(errors, ['tokens is empty; at least one account is required']);
});

test('an explicit account is returned as asked, and an unknown one names the alternatives', () => {
  const accounts = parseAccountPool(JSON.stringify({ tokens: [ACCOUNT, { name: 'acc2', token_id: 'i', token_secret: 's' }] })).accounts;
  assert.equal(selectAccount(accounts, { requested: 'acc2' }).name, 'acc2');
  assert.throws(() => selectAccount(accounts, { requested: 'nope' }), /acc1, acc2/);
});

test('without a request the least busy account wins, and ties go to the least recently used', () => {
  const accounts = [
    { name: 'busy', tokenId: 'i', tokenSecret: 's' },
    { name: 'idle-old', tokenId: 'i', tokenSecret: 's' },
    { name: 'idle-new', tokenId: 'i', tokenSecret: 's' },
  ];
  const chosen = selectAccount(accounts, {
    inFlight: new Map([['busy', 1]]),
    lastUsedAt: new Map([['idle-old', 1000], ['idle-new', 5000]]),
  });
  assert.equal(chosen.name, 'idle-old');
});

test('an empty pool is refused rather than selecting nothing', () => {
  assert.throws(() => selectAccount([]), /pool is empty/);
});

test('a refusing account is skipped, and the filter is dropped when every account refuses', () => {
  const accounts = [
    { name: 'spent', tokenId: 'i', tokenSecret: 's' },
    { name: 'live', tokenId: 'i', tokenSecret: 's' },
  ];
  // `spent` would win on least-recently-used, so the refusal is the only reason
  // `live` is chosen.
  const chosen = selectAccount(accounts, { refusing: new Set(['spent']), lastUsedAt: new Map([['live', 9]]) });
  assert.equal(chosen.name, 'live');
  // Every account refusing must still yield one, or the caller would report
  // "no account available" instead of Modal's real error.
  assert.equal(selectAccount(accounts, { refusing: new Set(['spent', 'live']) }).name, 'spent');
});

test('the environment carries only the two token variables, never a profile path', () => {
  const env = accountEnvironment({ name: 'a', tokenId: 'ak-1', tokenSecret: 'sec' });
  assert.deepEqual(env, { MODAL_TOKEN_ID: 'ak-1', MODAL_TOKEN_SECRET: 'sec' });
});

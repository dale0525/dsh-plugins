/**
 * Tests for the TypeSafe response-validation seam.
 *
 * The seam is a pure function: `validateChoice(answer, ids) -> answer | throw`.
 * Each of the five assertions in the frozen contract (plan §4.6) gets its own
 * passing and rejecting case, because a single "invalid response" test cannot
 * tell which assertion is actually load-bearing — a validator that only checks
 * `choice in ids` would pass it.
 *
 * This is an external API boundary, so rejecting rather than coercing is the
 * point: a distribution whose `choice` disagrees with its own argmax would
 * drive a real browser action on a decision the model did not actually make.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChoice } from '../src/validate.js';

/** A well-formed answer over `ids`, which each case perturbs. */
function answer(overrides = {}) {
  return {
    type: 'choice',
    choice: 'CLICK',
    confidence: 0.9,
    probabilities: { CLICK: 0.85, TYPE_TEXT: 0.15 },
    ...overrides,
  };
}

const IDS = ['CLICK', 'TYPE_TEXT'];

test('accepts a well-formed answer and returns it unchanged', () => {
  const input = answer();
  assert.equal(validateChoice(input, IDS), input);
});

test('rejects a choice outside the offered ids', () => {
  assert.throws(
    () => validateChoice(answer({ choice: 'SELECT' }), IDS),
    /Invalid TypeSafe response; no action executed./,
  );
});

test('rejects a probability key set that does not equal the offered ids', () => {
  // Missing one id.
  assert.throws(
    () => validateChoice(answer({ probabilities: { CLICK: 1 } }), IDS),
    /Invalid TypeSafe response/,
  );
  // Carrying an id that was never offered.
  assert.throws(
    () => validateChoice(
      answer({ probabilities: { CLICK: 0.5, TYPE_TEXT: 0.25, SELECT: 0.25 } }),
      IDS,
    ),
    /Invalid TypeSafe response/,
  );
});

test('rejects non-finite, non-numeric and out-of-range probabilities', () => {
  for (const bad of [NaN, Infinity, -Infinity, '0.5', null, undefined]) {
    assert.throws(
      () => validateChoice(answer({ probabilities: { CLICK: bad, TYPE_TEXT: 0.15 } }), IDS),
      /Invalid TypeSafe response/,
      `probability ${String(bad)} must be rejected`,
    );
  }
  assert.throws(
    () => validateChoice(answer({ probabilities: { CLICK: 1.2, TYPE_TEXT: -0.2 } }), IDS),
    /Invalid TypeSafe response/,
  );
});

test('rejects a non-finite or out-of-range confidence', () => {
  for (const bad of [NaN, Infinity, -1, 2, '0.9', null]) {
    assert.throws(
      () => validateChoice(answer({ confidence: bad }), IDS),
      /Invalid TypeSafe response/,
      `confidence ${String(bad)} must be rejected`,
    );
  }
});

test('rejects a distribution that does not sum to one within tolerance', () => {
  // 0.03 away: outside the 0.02 tolerance.
  assert.throws(
    () => validateChoice(answer({ probabilities: { CLICK: 0.85, TYPE_TEXT: 0.18 } }), IDS),
    /Invalid TypeSafe response/,
  );
  // 0.01 away: inside the tolerance, so it stands.
  assert.doesNotThrow(
    () => validateChoice(answer({ probabilities: { CLICK: 0.86, TYPE_TEXT: 0.15 } }), IDS),
  );
});

test('rejects a choice that disagrees with the distribution argmax', () => {
  assert.throws(
    () => validateChoice(answer({ probabilities: { CLICK: 0.2, TYPE_TEXT: 0.8 } }), IDS),
    /Invalid TypeSafe response/,
  );
});

test('accepts a tie at the top of the distribution', () => {
  // The contract is `p[choice] >= max(p) - 1e-6`, so an exact tie is valid.
  assert.doesNotThrow(
    () => validateChoice(
      answer({ choice: 'CLICK', probabilities: { CLICK: 0.5, TYPE_TEXT: 0.5 } }),
      IDS,
    ),
  );
});

test('rejects malformed answers instead of throwing a raw TypeError', () => {
  for (const bad of [null, undefined, 42, 'CLICK', {}, { choice: 'CLICK' }]) {
    assert.throws(
      () => validateChoice(bad, IDS),
      /Invalid TypeSafe response/,
      `${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('rejects a probabilities map that is not a plain object', () => {
  for (const bad of [null, [], 'x', 7]) {
    assert.throws(
      () => validateChoice(answer({ probabilities: bad }), IDS),
      /Invalid TypeSafe response/,
    );
  }
});

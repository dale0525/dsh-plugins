/**
 * Acceptance contract for the resume-pass selection rules.
 *
 * The rule is "after a restart, arm every goal that was left active, except
 * ones the human archived, ones that are not real top-level sessions, and ones
 * whose round budget is spent". Each case pins one half of that sentence
 * against the two shapes the host actually hands over: the cache's wire view
 * (nested) and a live goal view (flat).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cachedGoalFacts,
  dedupeByGoalId,
  isEligible,
  isResumable,
  liveGoalFacts,
} from '../src/candidates.js';

/** A listed header for an ordinary top-level session. */
function header(overrides = {}) {
  return { id: 'session-1', cwd: '/tmp/work', isSeeded: false, createdAt: 1, version: 4, ...overrides };
}

/** A cached `cachedSnapshot` block holding one active goal. */
function snapshot(goalOverrides = {}, roundsStarted = 0) {
  return {
    asOfSeq: 10,
    values: {
      goal: {
        goal: { id: 'goal-1', revision: 3, objective: 'ship it', phase: 'active', maxGoalRounds: 8, ...goalOverrides },
        roundsStarted,
        createdAt: 1,
        updatedAt: 2,
      },
    },
  };
}

test('an ordinary session with a working directory is eligible', () => {
  assert.equal(isEligible(header(), new Set()), true);
});

test('a subagent session is never eligible', () => {
  assert.equal(isEligible(header({ origin: 'subagent' }), new Set()), false);
});

test('a session with no working directory is never eligible', () => {
  assert.equal(isEligible(header({ cwd: undefined }), new Set()), false);
});

test('an archived session is never eligible', () => {
  assert.equal(isEligible(header(), new Set(['session-1'])), false);
});

test('the cached wire view is read through its nested goal', () => {
  const facts = cachedGoalFacts(snapshot());
  assert.equal(facts.id, 'goal-1');
  assert.equal(facts.revision, 3);
  assert.equal(facts.phase, 'active');
  assert.equal(facts.maxGoalRounds, 8);
  assert.equal(facts.roundsStarted, 0);
});

test('a missing snapshot or empty cache row yields no facts', () => {
  assert.equal(cachedGoalFacts(undefined), undefined);
  assert.equal(cachedGoalFacts({ asOfSeq: 4, values: {} }), undefined);
  assert.equal(cachedGoalFacts({ asOfSeq: 4, values: { goal: null } }), undefined);
});

test('the live view is read flat and carries activation', () => {
  const facts = liveGoalFacts({
    id: 'goal-2',
    revision: 5,
    phase: 'active',
    maxGoalRounds: 8,
    roundsStarted: 2,
    activation: 'disarmed',
  });
  assert.equal(facts.id, 'goal-2');
  assert.equal(facts.roundsStarted, 2);
  assert.equal(facts.activation, 'disarmed');
});

test('no live goal yields no facts', () => {
  assert.equal(liveGoalFacts(undefined), undefined);
});

test('an active goal with budget left is resumable', () => {
  assert.equal(isResumable(cachedGoalFacts(snapshot())), true);
});

test('paused, blocked, and complete goals are not resumed', () => {
  for (const phase of ['paused', 'blocked', 'complete']) {
    assert.equal(isResumable(cachedGoalFacts(snapshot({ phase }))), false, `${phase} must not resume`);
  }
});

test('a goal whose rounds are spent is not resumed', () => {
  assert.equal(isResumable(cachedGoalFacts(snapshot({ maxGoalRounds: 3 }, 3))), false);
});

test('a goal with one round left is resumed', () => {
  assert.equal(isResumable(cachedGoalFacts(snapshot({ maxGoalRounds: 3 }, 2))), true);
});

test('no facts are never resumable', () => {
  assert.equal(isResumable(undefined), false);
});

test('a fork and its parent collapse to one entry per goal', () => {
  const parent = { header: header({ id: 'p', isSeeded: false }), goal: { id: 'goal-1' } };
  const fork = { header: header({ id: 'f', isSeeded: true }), goal: { id: 'goal-1' } };
  const other = { header: header({ id: 'o', isSeeded: false }), goal: { id: 'goal-2' } };

  const kept = dedupeByGoalId([fork, parent, other]);

  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((e) => e.header.id).sort(), ['o', 'p']);
});

test('the first of two non-seeded entries for one goal wins', () => {
  const first = { header: header({ id: 'first' }), goal: { id: 'goal-1' } };
  const second = { header: header({ id: 'second' }), goal: { id: 'goal-1' } };

  assert.deepEqual(dedupeByGoalId([first, second]).map((e) => e.header.id), ['first']);
});

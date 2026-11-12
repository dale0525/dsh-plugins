/**
 * Tests for the bounded boot-sync retry.
 *
 * The tool list this plugin registers is Stitch's own `tools/list`, so a failed
 * boot fetch is the difference between a working Stitch and a system prompt that
 * announces tools the model cannot call. These pin the failure mode that shipped
 * once (single attempt, no retry → tools missing for the whole process): a
 * transient rejection must be retried and heal, a permanent one must stop after
 * the bound rather than spin or hang, and a cancel must stop a pending retry.
 *
 * Real timers are replaced by a manual scheduler so the backoff is exercised
 * deterministically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { retryWithBackoff } from '../src/tools.js';

/**
 * A `schedule` stand-in that records the pending callback instead of waiting.
 *
 * @returns the scheduler plus a `flush` that runs the next pending callback.
 */
function manualSchedule() {
  const pending = [];
  const schedule = (fn, delay) => {
    const entry = { fn, delay };
    pending.push(entry);
    return () => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
    };
  };
  const flush = async () => {
    const entry = pending.shift();
    if (entry) entry.fn();
    // Let the microtask from the attempt().catch() settle before asserting.
    await Promise.resolve();
    await Promise.resolve();
    return entry;
  };
  return { schedule, flush, pending };
}

test('a transient failure is retried and heals on the next attempt', async () => {
  let calls = 0;
  const failures = [];
  const giveUps = [];
  const { schedule, flush } = manualSchedule();
  const cancel = retryWithBackoff(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('credential store not live yet');
    },
    [10, 20],
    { schedule, onRetry: (e, d) => failures.push([e.message, d]), onGiveUp: (e, n) => giveUps.push([e.message, n]) },
  );
  // First attempt failed; one retry is scheduled with delays[0].
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(failures, [['credential store not live yet', 10]]);
  // Run the scheduled retry: the second attempt succeeds, no further retries.
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(giveUps, []);
  cancel();
});

test('a permanent failure retries the fixed number of times then gives up', async () => {
  let calls = 0;
  const giveUps = [];
  const { schedule, flush } = manualSchedule();
  retryWithBackoff(
    async () => {
      calls += 1;
      throw new Error('bad key');
    },
    [1, 2, 3],
    { schedule, onGiveUp: (e, n) => giveUps.push([e.message, n]) },
  );
  // Let attempt 1 fail and schedule its retry before draining.
  await Promise.resolve();
  await Promise.resolve();
  // attempt 1 (fails) → retry 1, attempt 2 (fails) → retry 2, attempt 3 (fails) → retry 3, attempt 4 (fails) → give up.
  for (let i = 0; i < 3; i += 1) await flush();
  assert.equal(calls, 4);
  assert.deepEqual(giveUps, [['bad key', 4]]);
});

test('shouldStop prevents any further attempt', async () => {
  let calls = 0;
  let stopped = false;
  const { schedule, flush } = manualSchedule();
  retryWithBackoff(
    async () => {
      calls += 1;
      stopped = true; // e.g. the effect was disposed
      throw new Error('boom');
    },
    [1, 2, 3],
    { schedule, shouldStop: () => stopped },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  // No retry should have been scheduled because shouldStop() was true on the catch.
  await flush();
  assert.equal(calls, 1);
});

test('the canceller clears a pending retry', async () => {
  let calls = 0;
  const { schedule, flush } = manualSchedule();
  const cancel = retryWithBackoff(
    async () => {
      calls += 1;
      throw new Error('net');
    },
    [1, 2, 3],
    { schedule },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  cancel();
  await flush();
  assert.equal(calls, 1, 'a cancelled backoff must not fire the retry');
});

test('the default timer schedule returns a canceller (teardown mid-backoff must not throw)', async () => {
  // Regression: the default `schedule` used to be bare `setTimeout`, which
  // returns a Timeout object — calling it on teardown threw "cancelScheduled is
  // not a function". This exercises the real default path with a long delay and
  // asserts the returned canceller is callable.
  let calls = 0;
  const cancel = retryWithBackoff(
    async () => {
      calls += 1;
      throw new Error('boom');
    },
    [100_000],
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.doesNotThrow(() => cancel());
});


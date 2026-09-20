/**
 * Tests for `regionOf` — recovering a compacted region's seq range from the
 * derived LLM messages alone.
 *
 * A compaction backend's `summarize(input, agent, signal)` only receives
 * `input.messages`, never the region's seq numbers. `agent.session` is
 * reachable, so the region is recovered by mapping message object identity back
 * to seqs.
 *
 * The load-bearing property (the "A8 regression") is that `dispatchesByRoot` is
 * built from a *range* over `[startSeq, endSeq]`, never from membership in the
 * region's own seq set: `tool/ptc-dispatch` is a log-only event that derives to
 * no message, so its seq is strictly inside the region but not one of `seqs`.
 * A membership-based implementation silently reports zero PTC dispatches.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { regionOf } from '../src/region.js';

/**
 * Build an LLM-shaped message object. Only `content.length` matters to the
 * projection rules the fake session mirrors; identity is what `regionOf` uses.
 * @param {string} role - message role.
 * @param {string} text - single text block.
 * @returns {{ role: string, content: Array<{ type: string, text: string }> }}
 */
function msg(role, text) {
  return { role, content: [{ type: 'text', text }] };
}

/**
 * Projection rules mirroring the host's `deriveEventMessage`: message-producing
 * (surface) types derive to their message, every log-only type derives to null.
 * @param {{ type: string, data?: any }} event - session event.
 * @returns {object | null} the derived message, or null for log-only events.
 */
function deriveFakeMessage(event) {
  switch (event.type) {
    case 'user/message':
      return event.data;
    case 'system/message':
    case 'assistant/message':
      return event.data.message.content.length === 0 ? null : event.data.message;
    case 'tool/result':
      return event.data.message;
    default:
      // tool/call, tool/ptc-dispatch, tool/ptc-dispatch-start, turn/start,
      // step/start, request/header, compaction/start, ... — all log-only.
      return null;
  }
}

/**
 * Wrap a hand-written event array in the verified session API. The array must be
 * index-aligned with seq (`events[seq].seq === seq`), which the host guarantees.
 * `snapshotEvents` records its arguments so the half-open bound is assertable.
 * @param {Array<object>} events - index-aligned event log.
 * @returns {{ session: object, snapshotCalls: Array<[number, number]> }}
 */
function createFakeSession(events) {
  events.forEach((event, index) => {
    assert.equal(event.seq, index, `fixture event at index ${index} must carry seq ${index}`);
  });

  /** @type {Array<[number, number]>} */
  const snapshotCalls = [];

  return {
    snapshotCalls,
    session: {
      seq: events.length,
      eventAt(seq) {
        return events[seq];
      },
      snapshotEvents(fromSeq, toSeqExclusive) {
        snapshotCalls.push([fromSeq, toSeqExclusive]);
        return Object.freeze(events.slice(fromSeq, toSeqExclusive));
      },
      deriveEventMessage(event) {
        return deriveFakeMessage(event);
      },
    },
  };
}

/** Convenience builders for the event shapes this slice encounters. */
const ev = {
  user: (seq, message) => ({ type: 'user/message', seq, time: 0, data: message }),
  system: (seq, message) => ({ type: 'system/message', seq, time: 0, data: { message } }),
  assistant: (seq, message) => ({ type: 'assistant/message', seq, time: 0, data: { message } }),
  toolResult: (seq, message) => ({ type: 'tool/result', seq, time: 0, data: { turn: 0, step: 0, message } }),
  toolCall: (seq, callId) => ({
    type: 'tool/call',
    seq,
    time: 0,
    data: { turn: 0, step: 0, callId, name: 'read', arguments: '{}' },
  }),
  ptcDispatch: (seq, rootCallId, subCallId) => ({
    type: 'tool/ptc-dispatch',
    seq,
    time: 0,
    data: {
      rootCallId,
      parentCallId: rootCallId,
      subCallId,
      name: 'read',
      arguments: '{}',
      isError: false,
      content: 'ok',
    },
  }),
  ptcDispatchStart: (seq, rootCallId, subCallId) => ({
    type: 'tool/ptc-dispatch-start',
    seq,
    time: 0,
    data: { rootCallId, parentCallId: rootCallId, subCallId, name: 'read', arguments: '{}' },
  }),
  turnStart: (seq) => ({ type: 'turn/start', seq, time: 0, data: { turn: 0 } }),
};

test('A8 regression: dispatches between the region seqs are still attributed by range', () => {
  // Surface events at 0,1,2,5,6; log-only PTC dispatches at 3 and 4 — strictly
  // between the region's min and max, but NOT members of the region's own seqs.
  const m0 = msg('user', 'm0');
  const m1 = msg('assistant', 'm1');
  const m2 = msg('tool', 'm2');
  const m5 = msg('assistant', 'm5');
  const m6 = msg('tool', 'm6');

  const { session } = createFakeSession([
    ev.user(0, m0),
    ev.assistant(1, m1),
    ev.toolResult(2, m2),
    ev.ptcDispatch(3, 'root-A', 'sub-1'),
    ev.ptcDispatch(4, 'root-A', 'sub-2'),
    ev.assistant(5, m5),
    ev.toolResult(6, m6),
  ]);

  const region = regionOf(session, { messages: [m0, m1, m2, m5, m6] });

  assert.deepEqual(region.seqs, [0, 1, 2, 5, 6]);
  assert.equal(region.startSeq, 0);
  assert.equal(region.endSeq, 6);

  // The dispatches are NOT among the region's own seqs...
  assert.ok(!region.seqs.includes(3), 'seq 3 must not be a member of seqs');
  assert.ok(!region.seqs.includes(4), 'seq 4 must not be a member of seqs');

  // ...yet both must be attributed. A shadowedSeqs-membership implementation
  // returns an empty map here — a silent, total loss of PTC tool-call facts.
  assert.ok(region.dispatchesByRoot instanceof Map);
  assert.equal(region.dispatchesByRoot.size, 1);
  const dispatched = region.dispatchesByRoot.get('root-A');
  assert.ok(Array.isArray(dispatched), 'root-A must be present in dispatchesByRoot');
  assert.deepEqual(
    dispatched.map((event) => event.seq),
    [3, 4],
  );
});

test('A9 — seqs is sorted ascending and deduped; startSeq/endSeq are min/max', () => {
  const m0 = msg('user', 'm0');
  const m2 = msg('tool', 'm2');
  const m5 = msg('assistant', 'm5');

  const { session } = createFakeSession([
    ev.user(0, m0),
    ev.turnStart(1),
    ev.toolResult(2, m2),
    ev.turnStart(3),
    ev.turnStart(4),
    ev.assistant(5, m5),
  ]);

  // Deliberately out of order, and the same message object twice.
  const region = regionOf(session, { messages: [m5, m0, m5, m2] });

  assert.deepEqual(region.seqs, [0, 2, 5]);
  assert.equal(region.startSeq, 0);
  assert.equal(region.endSeq, 5);
});

test('own covers exactly [startSeq, endSeq] inclusive, including log-only events', () => {
  const m1 = msg('user', 'm1');
  const m4 = msg('assistant', 'm4');
  const m6 = msg('tool', 'm6');

  const { session } = createFakeSession([
    ev.turnStart(0),
    ev.user(1, m1),
    ev.toolCall(2, 'call-1'),
    ev.ptcDispatchStart(3, 'root-A', 'sub-1'),
    ev.assistant(4, m4),
    ev.turnStart(5),
    ev.toolResult(6, m6),
  ]);

  const region = regionOf(session, { messages: [m1, m4, m6] });

  assert.deepEqual(region.seqs, [1, 4, 6]);
  assert.equal(region.startSeq, 1);
  assert.equal(region.endSeq, 6);

  // Half-open [1, 7) → every event 1..6 inclusive.
  assert.deepEqual(
    region.own.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6],
  );
  const ownTypes = region.own.map((event) => event.type);
  assert.ok(ownTypes.includes('tool/call'), 'log-only tool/call must be inside own');
  assert.ok(ownTypes.includes('tool/ptc-dispatch-start'), 'log-only ptc-dispatch-start must be inside own');
  assert.ok(ownTypes.includes('turn/start'), 'log-only turn/start must be inside own');
  // Events outside the range are excluded.
  assert.ok(!region.own.some((event) => event.seq === 0), 'seq 0 is outside the range');
});

test('dispatchesByRoot groups by rootCallId and preserves seq order', () => {
  const m1 = msg('user', 'm1');
  const m6 = msg('assistant', 'm6');

  const { session } = createFakeSession([
    ev.turnStart(0),
    ev.user(1, m1),
    ev.ptcDispatch(2, 'root-A', 'a-1'),
    ev.ptcDispatch(3, 'root-B', 'b-1'),
    ev.ptcDispatch(4, 'root-A', 'a-2'),
    ev.ptcDispatch(5, 'root-A', 'a-3'),
    ev.assistant(6, m6),
  ]);

  const region = regionOf(session, { messages: [m1, m6] });

  assert.equal(region.dispatchesByRoot.size, 2);
  assert.deepEqual(
    region.dispatchesByRoot.get('root-A').map((event) => event.seq),
    [2, 4, 5],
  );
  assert.deepEqual(
    region.dispatchesByRoot.get('root-B').map((event) => event.seq),
    [3],
  );
  // A root with two dispatches gets an array of two — check the subCallIds too.
  assert.deepEqual(
    region.dispatchesByRoot.get('root-A').map((event) => event.data.subCallId),
    ['a-1', 'a-2', 'a-3'],
  );
});

test('a message absent from the log is skipped without corrupting the range', () => {
  const m0 = msg('user', 'm0');
  const m2 = msg('tool', 'm2');
  const alien = msg('user', 'never logged');

  const { session } = createFakeSession([
    ev.user(0, m0),
    ev.turnStart(1),
    ev.toolResult(2, m2),
  ]);

  const region = regionOf(session, { messages: [m0, alien, m2] });

  assert.deepEqual(region.seqs, [0, 2]);
  assert.equal(region.startSeq, 0);
  assert.equal(region.endSeq, 2);
});

test('empty or wholly unmatched messages yield the documented empty shape', () => {
  const m0 = msg('user', 'm0');

  const { session } = createFakeSession([ev.user(0, m0), ev.turnStart(1)]);

  const empty = regionOf(session, { messages: [] });
  assert.deepEqual(empty.seqs, []);
  assert.equal(empty.startSeq, null);
  assert.equal(empty.endSeq, null);
  assert.deepEqual(empty.own, []);
  assert.ok(empty.dispatchesByRoot instanceof Map);
  assert.equal(empty.dispatchesByRoot.size, 0);

  const unmatched = regionOf(session, { messages: [msg('user', 'a'), msg('user', 'b')] });
  assert.deepEqual(unmatched.seqs, []);
  assert.equal(unmatched.startSeq, null);
  assert.equal(unmatched.endSeq, null);
  assert.deepEqual(unmatched.own, []);
  assert.equal(unmatched.dispatchesByRoot.size, 0);
});

test('a region including the system head at seq 0 reports startSeq === 0', () => {
  // The system head legitimately widens the range: it is a real surface event
  // that projects into `input.messages`. The caller filters `own` by event type
  // when it needs only the conversational tail — `regionOf` does not.
  const mSys = msg('system', 'system prompt');
  const m9 = msg('user', 'm9');
  const m10 = msg('assistant', 'm10');

  const { session } = createFakeSession([
    ev.system(0, mSys),
    ev.turnStart(1),
    ev.turnStart(2),
    ev.turnStart(3),
    ev.turnStart(4),
    ev.turnStart(5),
    ev.turnStart(6),
    ev.turnStart(7),
    ev.turnStart(8),
    ev.user(9, m9),
    ev.assistant(10, m10),
  ]);

  const region = regionOf(session, { messages: [mSys, m9, m10] });

  assert.equal(region.startSeq, 0);
  assert.equal(region.endSeq, 10);
  assert.deepEqual(region.seqs, [0, 9, 10]);
  assert.deepEqual(
    region.own.map((event) => event.seq),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test('snapshotEvents is called with the half-open bound (startSeq, endSeq + 1)', () => {
  const m2 = msg('user', 'm2');
  const m5 = msg('assistant', 'm5');

  const { session, snapshotCalls } = createFakeSession([
    ev.turnStart(0),
    ev.turnStart(1),
    ev.user(2, m2),
    ev.ptcDispatch(3, 'root-A', 'a-1'),
    ev.turnStart(4),
    ev.assistant(5, m5),
    ev.turnStart(6),
  ]);

  const region = regionOf(session, { messages: [m2, m5] });

  assert.equal(region.startSeq, 2);
  assert.equal(region.endSeq, 5);
  assert.equal(snapshotCalls.length, 1);
  assert.deepEqual(snapshotCalls[0], [2, 6]);
  assert.notDeepEqual(snapshotCalls[0], [2, 5], 'upper bound must be endSeq + 1, not endSeq');
  assert.deepEqual(
    region.own.map((event) => event.seq),
    [2, 3, 4, 5],
  );
});

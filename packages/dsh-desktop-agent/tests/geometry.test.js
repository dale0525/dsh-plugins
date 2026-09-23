/**
 * Tests for the coordinate contract.
 *
 * These pin the two facts that a naive implementation gets wrong, both measured
 * against a live 2x window:
 *
 *  - `screenshot_scale` is not a multiplier. Clicking the screenshot pixel of a
 *    button hit that button; doubling it landed outside the window and the driver
 *    refused the point.
 *  - `max_dimension` downscales the PNG and its reported dimensions together, and
 *    a point computed from those dimensions is the point that lands.
 *
 * There is consequently no conversion step to test — the model is shown the frame
 * the driver reads, so the identity is the whole mapping. What is left to pin is
 * the frame predicate, which is what lets a coordinate be rejected with a message
 * that names the decision rather than a bare number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isFrame, within } from '../src/geometry.js';

test('a degenerate frame is not a frame', () => {
  assert.equal(isFrame({ width: 0, height: 10 }), false);
  assert.equal(isFrame({ width: 10, height: -1 }), false);
  assert.equal(isFrame({ width: Number.NaN, height: 10 }), false);
  assert.equal(isFrame({}), false);
  assert.equal(isFrame(null), false);
  assert.equal(isFrame(undefined), false);
});

test('a real frame is a frame', () => {
  assert.equal(isFrame({ width: 460, height: 816 }), true);
  assert.equal(isFrame({ width: 1, height: 1 }), true);
});

test('within rejects the point one past each edge', () => {
  const frame = { width: 460, height: 816 };
  assert.equal(within({ x: 0, y: 0 }, frame), true);
  assert.equal(within({ x: 459, y: 815 }, frame), true);
  assert.equal(within({ x: 460, y: 815 }, frame), false);
  assert.equal(within({ x: 459, y: 816 }, frame), false);
  assert.equal(within({ x: -1, y: 0 }, frame), false);
  assert.equal(within({ x: 0, y: -1 }, frame), false);
});

test('within refuses to place a point in a frame that does not exist', () => {
  assert.equal(within({ x: 1, y: 1 }, null), false);
  assert.equal(within({ x: 1, y: 1 }, { width: 0, height: 0 }), false);
});

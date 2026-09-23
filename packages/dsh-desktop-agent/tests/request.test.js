/**
 * Tests for the decision protocol's parsing half.
 *
 * A decision call is the one place untrusted text becomes an action, so parsing
 * has to be strict about what it accepts and explicit about what it rejects. The
 * one concession is the fenced code block: models routinely wrap JSON in fences
 * even when told not to, and rejecting an otherwise correct answer over its
 * punctuation would burn a step for no information.
 *
 * The rejection cases matter as much as the acceptance ones. An answer with no
 * usable `kind` must fail rather than be coerced into a default action, because
 * the loop's recovery path — record, re-observe, re-decide — is only safe if it
 * is entered on every malformed answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decisionPayload, parseDecision } from '../src/request.js';

test('a bare JSON object parses', () => {
  assert.deepEqual(parseDecision('{"kind":"click","x":1,"y":2}'), { kind: 'click', x: 1, y: 2 });
});

test('a fenced JSON block is unwrapped', () => {
  assert.deepEqual(parseDecision('\u0060\u0060\u0060json\n{"kind":"done"}\n\u0060\u0060\u0060'), { kind: 'done' });
});

test('a fenced block with no language tag is unwrapped', () => {
  assert.deepEqual(parseDecision('\u0060\u0060\u0060\n{"kind":"wait"}\n\u0060\u0060\u0060'), { kind: 'wait' });
});

test('non-JSON is rejected', () => {
  assert.throws(() => parseDecision('I will click the button.'), /did not return valid JSON/);
});

test('a JSON array is not a decision', () => {
  assert.throws(() => parseDecision('[{"kind":"click"}]'), /did not return a JSON object/);
});

test('a null is not a decision', () => {
  assert.throws(() => parseDecision('null'), /did not return a JSON object/);
});

test('an unknown kind is rejected and the vocabulary is listed', () => {
  assert.throws(() => parseDecision('{"kind":"drag"}'), /"drag"|no usable action kind/);
});

test('a missing kind is rejected', () => {
  assert.throws(() => parseDecision('{"x":1,"y":2}'), /no usable action kind/);
});

test('the vision payload states the screenshot frame and carries no elements', () => {
  const payload = decisionPayload({
    goal: 'compute 7x5',
    observation: { channel: 'vision', app: 'Calculator', title: '', frame: { width: 460, height: 816 } },
    history: [],
  });
  assert.equal(payload.screenshot.width, 460);
  assert.equal(payload.screenshot.height, 816);
  assert.equal(payload.elements, undefined);
  assert.equal(payload.window.channel, 'vision');
});

test('the ax payload carries the element table and the markdown tree', () => {
  const payload = decisionPayload({
    goal: 'compute 7x5',
    observation: {
      channel: 'ax',
      app: 'Calculator',
      title: '',
      elements: [{ index: 5, token: 's1:5', role: 'AXButton', label: '7' }],
      markdown: '- [0] AXWindow',
    },
    history: [],
  });
  assert.equal(payload.screenshot, undefined);
  assert.equal(payload.elements.length, 1);
  assert.equal(payload.accessibility_tree, '- [0] AXWindow');
});

test('history is capped so a long run cannot grow the request without bound', () => {
  const history = Array.from({ length: 50 }, (_value, index) => ({ step: index + 1, action: 'click', result: 'ok' }));
  const payload = decisionPayload({
    goal: 'g',
    observation: { channel: 'vision', app: '', title: '', frame: { width: 1, height: 1 } },
    history,
  });
  assert.equal(payload.recent_actions.length, 8);
  assert.equal(payload.recent_actions.at(-1).step, 50);
});

/**
 * Tests for the accessibility-channel capture.
 *
 * The AX channel is the fallback for a route that cannot see, and the fact these
 * pin is that a partial tree is USABLE. The driver truncates its own walk on large
 * Electron applications and says so in the markdown while stating that the element
 * indices above remain valid — so treating that warning as fatal would break the
 * fallback on exactly the applications it exists to serve.
 *
 * The other fact is that a truncated tree must be ANNOUNCED to the model. A text
 * model told nothing would read a partial listing as the whole window and either
 * pick a wrong element or report the goal unreachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { captureAx } from '../src/observe.js';
import { decisionPayload } from '../src/request.js';

const TARGET = { pid: 42, windowId: 7, app: 'Notes', title: '' };

/**
 * A dispatch seam returning one fixed AX payload.
 *
 * @param payload - the structured content to return.
 * @returns the dispatch function.
 */
function dispatchOf(payload) {
  return async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: payload });
}

const COMPLETE = {
  app_name: 'Notes',
  window_title: 'Notes',
  window_bounds: { x: 0, y: 0, width: 400, height: 300 },
  elements: [{ element_index: 1, element_token: 's1:1', role: 'AXButton', label: 'Save' }],
  tree_markdown: '- [0] AXWindow\n  - [1] AXButton "Save"',
};

const TRUNCATED = {
  ...COMPLETE,
  tree_markdown: COMPLETE.tree_markdown + '\n\n⚠️  AX tree truncated at 3 nodes. Element indices above are still valid.',
};

test('a complete tree is captured with its element table', async () => {
  const observation = await captureAx({ dispatch: dispatchOf(COMPLETE), target: TARGET, signal: undefined });
  assert.equal(observation.channel, 'ax');
  assert.equal(observation.truncated, false);
  assert.deepEqual(observation.elements, [{ index: 1, token: 's1:1', role: 'AXButton', label: 'Save', value: undefined }]);
});

test('a truncated tree is kept and flagged rather than refused', async () => {
  const observation = await captureAx({ dispatch: dispatchOf(TRUNCATED), target: TARGET, signal: undefined });
  assert.equal(observation.truncated, true);
  assert.equal(observation.elements.length, 1);
  assert.match(observation.markdown, /AXButton "Save"/);
});

test('a truncated tree is announced to the model', async () => {
  const observation = await captureAx({ dispatch: dispatchOf(TRUNCATED), target: TARGET, signal: undefined });
  const payload = decisionPayload({ goal: 'g', observation, history: [] });
  assert.match(payload.note, /only part of the window/);
});

test('a complete tree is not announced as partial', async () => {
  const observation = await captureAx({ dispatch: dispatchOf(COMPLETE), target: TARGET, signal: undefined });
  const payload = decisionPayload({ goal: 'g', observation, history: [] });
  assert.doesNotMatch(payload.note, /only part of the window/);
});

test('a tree this plugin clips itself is also flagged', async () => {
  const observation = await captureAx({
    dispatch: dispatchOf({ ...COMPLETE, tree_markdown: 'x'.repeat(50) }),
    target: TARGET,
    signal: undefined,
    maxChars: 10,
  });
  assert.equal(observation.truncated, true);
  assert.equal(observation.markdown.length, 10);
});

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

import { captureAx, captureVision } from '../src/observe.js';
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
  assert.deepEqual(observation.elements, [
    { index: 1, token: 's1:1', role: 'AXButton', label: 'Save', value: undefined, frame: undefined },
  ]);
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

/**
 * A dispatch seam that records the arguments it was called with.
 *
 * @param payload - the structured content to return.
 * @param blocks - the content blocks to return.
 * @returns the dispatch function, with the call it received on `calls`.
 */
function recordingDispatch(payload, blocks) {
  const calls = [];
  const dispatch = async (tool, args) => {
    calls.push({ tool, args });
    return { content: blocks, structuredContent: payload };
  };
  return { dispatch, calls };
}

const VISION_PAYLOAD = {
  app_name: 'Calculator',
  window_title: 'Calculator',
  screenshot_width: 460,
  screenshot_height: 816,
  snapshot_id: 's00000001',
  elements: [
    { element_index: 0, element_token: 's00000001:0', role: 'AXWindow', label: 'Calculator', frame: { x: 0, y: 0, w: 460, h: 816 } },
    { element_index: 2, element_token: 's00000001:2', role: 'AXButton', label: '5', frame: { x: 79, y: 62, w: 49, h: 49 } },
    { element_index: 3, element_token: 's00000001:3', role: 'AXButton', label: '', frame: { x: 1, y: 2, w: 3, h: 4 } },
    { element_index: 4, element_token: '', role: 'AXButton', label: 'unaddressable', frame: { x: 5, y: 6, w: 7, h: 8 } },
  ],
};

const PNG = [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }];

test('the vision capture returns the screenshot and the element anchors together', async () => {
  // The whole point of the fix: one call, so the model gets an image AND the
  // driver's own handles on the controls in it. Previously this path asked for
  // no tree at all, which left the model estimating every coordinate.
  const { dispatch, calls } = recordingDispatch(VISION_PAYLOAD, PNG);
  const observation = await captureVision({ dispatch, target: TARGET, maxImageDimension: 1568, signal: undefined });

  assert.equal(observation.channel, 'vision');
  assert.deepEqual(observation.frame, { width: 460, height: 816 });
  assert.equal(calls.length, 1, 'one capture, not two');
  assert.equal(calls[0].args.include_accessibility_tree, true);
});

test('only elements that are both addressable and nameable become anchors', async () => {
  const { dispatch } = recordingDispatch(VISION_PAYLOAD, PNG);
  const observation = await captureVision({ dispatch, target: TARGET, maxImageDimension: 1568, signal: undefined });

  // The window and the "5" button survive; a tokenless element and a label-less
  // element do not, because neither can be named in a decision.
  assert.deepEqual(observation.elements, [
    { token: 's00000001:0', role: 'AXWindow', label: 'Calculator', frame: { x: 0, y: 0, w: 460, h: 816 } },
    { token: 's00000001:2', role: 'AXButton', label: '5', frame: { x: 79, y: 62, w: 49, h: 49 } },
  ]);
});

test('the anchor cap is passed to the driver and its saturation is announced', async () => {
  const { dispatch, calls } = recordingDispatch(VISION_PAYLOAD, PNG);
  const observation = await captureVision({
    dispatch, target: TARGET, maxImageDimension: 1568, signal: undefined, maxElements: 2,
  });
  assert.equal(calls[0].args.max_elements, 2);
  assert.equal(observation.elementsTruncated, true);
});

test('the vision payload carries the anchors next to the image', async () => {
  const { dispatch } = recordingDispatch(VISION_PAYLOAD, PNG);
  const observation = await captureVision({ dispatch, target: TARGET, maxImageDimension: 1568, signal: undefined });
  const payload = decisionPayload({ goal: 'g', observation, history: [] });

  assert.equal(payload.screenshot.width, 460);
  assert.equal(payload.elements.length, 2);
  assert.match(payload.elements_note, /Prefer a "token" over x\/y/);
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

/**
 * Tests for the decision loop's contract.
 *
 * The loop's failure modes are all about how a run ENDS, so that is what these
 * pin: it must not claim success the model did not observe, it must not end
 * silently when an action failed, and it must not run past its budget.
 *
 * The retry case is the one that makes the vision channel work at all. A vision
 * model's coordinates are known to drift, so an action that fails to execute has
 * to be recorded and re-decided against a fresh capture rather than treated as
 * fatal — otherwise the first mis-aimed click ends the run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../src/loop.js';

/** A window the loop can drive. */
const TARGET = { pid: 42, windowId: 7, app: 'Calculator', title: 'Calculator' };

/**
 * A dispatch seam over a scripted driver.
 *
 * Captures and actions are scripted separately because the loop interleaves them
 * one-to-one, so a single flat sequence would silently couple the two and make a
 * retry case read as a capture case.
 *
 * @param input - the capture result, and the per-action outcomes in call order.
 * @returns the dispatch function and the recorded action calls.
 */
function seam(input) {
  const { capture: captureResult, actions = [] } = input;
  const calls = [];
  let actionIndex = 0;
  const dispatch = async (name, args) => {
    if (name === 'cua_driver_native__get_window_state') return captureResult;
    calls.push({ name, args });
    const outcome = actions[Math.min(actionIndex, actions.length - 1)];
    actionIndex += 1;
    if (outcome instanceof Error) throw outcome;
    return typeof outcome === 'function' ? outcome(name, args) : outcome;
  };
  return { dispatch, calls };
}

/** A window capture result with an image, as the driver returns it. */
function capture(width = 460, height = 816) {
  return {
    content: [{ type: 'image', data: Buffer.from('fake').toString('base64'), mimeType: 'image/png' }, { type: 'text', text: '{}' }],
    structuredContent: {
      app_name: 'Calculator',
      window_title: 'Calculator',
      window_bounds: { x: 0, y: 0, width: 230, height: 408 },
      screenshot_width: width,
      screenshot_height: height,
      screenshot_scale: 2,
    },
  };
}

/** A window capture result with no image: the AX channel's shape. */
function axCapture() {
  return {
    content: [{ type: 'text', text: '{}' }],
    structuredContent: {
      app_name: 'Calculator',
      window_title: '',
      window_bounds: { x: 0, y: 0, width: 230, height: 408 },
      elements: [{ element_index: 5, element_token: 's1:5', role: 'AXButton', label: '7' }],
      tree_markdown: '- [0] AXWindow',
    },
  };
}

/** A driver acknowledgement for one action. */
const OK = { content: [{ type: 'text', text: '{}' }], structuredContent: { delivery: { mode: 'background' }, effect: 'unverifiable' } };

/** An attachment store that records what was committed. */
function attachments() {
  const saved = [];
  return {
    saved,
    saveImages: async (inputs) => {
      for (const input of inputs) saved.push(input);
      return inputs.map((_input, index) => ({ attachmentId: 'a' + index, mediaType: 'image/png', bytes: 4, width: 1, height: 1 }));
    },
  };
}

/**
 * An llm stub that answers a scripted list of decisions.
 *
 * @param answers - raw answer texts, cycled in order.
 * @param modalities - the input modalities the resolved route declares.
 * @returns the llm stub and a call log.
 */
function llm(answers, modalities = ['text', 'image']) {
  const calls = [];
  let index = 0;
  return {
    calls,
    resolveModelInfo: async () => ({ inputModalities: modalities }),
    stream: (options) => {
      calls.push(options);
      const text = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return (async function* () {
        yield { type: 'text-delta', text };
      })();
    },
  };
}

/** The base input for a run. */
function input(overrides) {
  return {
    target: TARGET,
    goal: 'compute 7x5',
    config: { maxSteps: 5, maxImageDimension: 1568, deliveryMode: 'background', route: { provider: 'p', model: 'seer', reasoningEffort: '' } },
    ...overrides,
  };
}

test('a vision run sends a screenshot and performs the click the model chose', async () => {
  const { dispatch, calls } = seam({ capture: capture(), actions: [OK] });
  const store = attachments();
  const stub = llm(['{"kind":"click","x":176,"y":530}', '{"kind":"done","summary":"7x5=35"}']);

  const trace = await run(input({ dispatch, llm: stub, attachments: store }));

  assert.equal(trace.status, 'done');
  assert.equal(trace.channel, 'vision');
  // One commit per observation, and the loop re-observes every iteration.
  assert.equal(store.saved.length, 2);
  assert.deepEqual(calls[0].args, { pid: 42, window_id: 7, x: 176, y: 530 });
  assert.deepEqual(trace.steps.map((step) => step.operation), ['click', 'done']);
});

test('a text-only route falls back to the accessibility tree and sends no image', async () => {
  const { dispatch } = seam({ capture: axCapture(), actions: [OK] });
  const store = attachments();
  const stub = llm(['{"kind":"set_value","token":"s1:5","value":"7"}', '{"kind":"done"}'], ['text']);

  const trace = await run(input({ dispatch, llm: stub, attachments: store }));

  assert.equal(trace.channel, 'ax');
  assert.equal(store.saved.length, 0);
  const sent = stub.calls[0].messages[1].content;
  assert.equal(sent.some((block) => block.type === 'image'), false);
  assert.match(sent[0].text, /accessibility_tree/);
});

test('a failed action is recorded and the run re-decides instead of ending', async () => {
  const { dispatch } = seam({ capture: capture(), actions: [new Error('background_unavailable'), OK] });
  const stub = llm(['{"kind":"click","x":10,"y":10}', '{"kind":"click","x":20,"y":20}', '{"kind":"done"}']);

  const trace = await run(input({ dispatch, llm: stub, attachments: attachments() }));

  assert.equal(trace.status, 'done');
  assert.match(trace.steps[0].result, /failed: background_unavailable/);
  assert.match(trace.steps[1].result, /^ok/);
  assert.equal(trace.decisions, 3);
});

test('a malformed decision is recorded and the loop continues', async () => {
  const { dispatch } = seam({ capture: capture(), actions: [OK] });
  const stub = llm(['not json at all', '{"kind":"done"}']);

  const trace = await run(input({ dispatch, llm: stub, attachments: attachments() }));

  assert.equal(trace.status, 'done');
  assert.equal(trace.steps[0].operation, 'decide');
  assert.match(trace.steps[0].result, /failed: desktop_agent: the model did not return valid JSON/);
});

test('an out-of-frame point is rejected before it reaches the driver', async () => {
  const { dispatch, calls } = seam({ capture: capture(), actions: [OK] });
  const stub = llm(['{"kind":"click","x":900,"y":10}', '{"kind":"done"}']);

  const trace = await run(input({ dispatch, llm: stub, attachments: attachments() }));

  assert.equal(trace.status, 'done');
  assert.match(trace.steps[0].result, /rejected: .*lies outside the 460×816 screenshot/);
  assert.equal(calls.length, 0);
});

test('the step cap ends the run and still returns a trace', async () => {
  const { dispatch } = seam({ capture: capture(), actions: [OK] });
  const stub = llm(['{"kind":"click","x":10,"y":10}']);

  const trace = await run(
    input({
      dispatch,
      llm: stub,
      attachments: attachments(),
      config: { maxSteps: 3, maxImageDimension: 1568, deliveryMode: 'background', route: { provider: 'p', model: 'seer', reasoningEffort: '' } },
    }),
  );

  assert.equal(trace.status, 'max-steps');
  assert.equal(trace.steps.length, 3);
});

test('repeated failures stop the run as stuck rather than looping forever', async () => {
  const { dispatch } = seam({ capture: capture(), actions: [new Error('no')] });
  const stub = llm(['{"kind":"click","x":10,"y":10}']);

  const trace = await run(input({ dispatch, llm: stub, attachments: attachments() }));

  assert.equal(trace.status, 'stuck');
  assert.equal(trace.steps.length, 3);
});

test('a blocked answer ends the run with the model reason', async () => {
  const { dispatch } = seam({ capture: capture() });
  const stub = llm(['{"kind":"blocked","reason":"the dialog never appeared"}']);

  const trace = await run(input({ dispatch, llm: stub, attachments: attachments() }));

  assert.equal(trace.status, 'blocked');
  assert.match(trace.steps.at(-1).result, /the dialog never appeared/);
});

test('cancellation before the first step ends the run', async () => {
  const { dispatch } = seam({ capture: capture() });
  const controller = new AbortController();
  controller.abort();
  const trace = await run(input({ dispatch, llm: llm(['{"kind":"done"}']), attachments: attachments(), signal: controller.signal }));
  assert.equal(trace.status, 'cancelled');
});

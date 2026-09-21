/**
 * Tests for the TypeSafe request-construction seam.
 *
 * The seam is a pure function: the element table plus goal plus history become
 * one request body. It is the contract's other offline-checkable half — the
 * decision protocol's shape can be verified here without a network call or a
 * browser, which is what makes the protocol layer testable at all.
 *
 * The resolution tests deliberately use answer maps that omit the target heads
 * the chosen operation did not select: validating an unused head would let one
 * bad distribution block a run whose decision was sound.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { actionSpace } from '../src/actions.js';
import { buildRequest, operationIds, resolveDecision } from '../src/request.js';

const TABLE = actionSpace([
  { node: 1, kind: 'fill', role: 'textbox', label: 'Search', value: '' },
  { node: 1, kind: 'click', role: 'textbox', label: 'Search', value: '' },
  { node: 2, kind: 'click', role: 'button', label: 'Go', value: '' },
  { node: 3, kind: 'click', role: 'checkbox', label: 'In stock', value: '', checked: 'false' },
  {
    node: 4,
    kind: 'select',
    role: 'combobox',
    label: 'Sort',
    value: 'Relevance',
    optionLabel: 'Price',
    optionValue: 'price',
    optionDomIndex: 1,
  },
  // A click action on the dropdown element itself, so CLICK has target `4`.
  { node: 4, kind: 'click', role: 'combobox', label: 'Sort', value: 'Relevance' },
]);

const PAGE = { url: 'https://shop.test/search', title: 'Shop', text: 'Results' };

/** Build a request with the fixture table and page. */
function request(overrides = {}) {
  return buildRequest({
    goal: 'find the cheapest item',
    page: PAGE,
    elements: TABLE.elements,
    targets: TABLE.targets,
    controls: TABLE.controls,
    history: [],
    model: 'jev-latest',
    ...overrides,
  });
}

/**
 * A valid Choice answer over `ids` that selects `choice`.
 *
 * Probabilities are spread evenly over the rest so they sum to exactly 1 and
 * the selected option is the argmax, which is what the response contract
 * requires.
 */
function choice(ids, selected, confidence = 0.8) {
  if (ids.length === 1) {
    // One option: it is both the argmax and the whole distribution.
    return { type: 'choice', choice: selected, confidence: 1, probabilities: { [selected]: 1 } };
  }
  const rest = (1 - confidence) / (ids.length - 1);
  return {
    type: 'choice',
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? confidence : rest])),
  };
}

test('asks for the operation plus one target head per operation with targets', () => {
  const body = request();
  assert.deepEqual(
    Object.keys(body.questions).sort(),
    ['click_target', 'operation', 'select_target', 'type_text_target'],
  );
});

test('offers every operation, every control, DONE and BLOCKED to the operation question', () => {
  const criteria = request().questions.operation.criteria;
  for (const key of ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']) {
    assert.equal(typeof criteria[key], 'string', `operation ${key} must be offered`);
  }
});

test('offers exactly the target ids of its own operation to each target head', () => {
  const body = request();
  assert.deepEqual(Object.keys(body.questions.click_target.criteria).sort(), ['1', '2', '3', '4']);
  assert.deepEqual(Object.keys(body.questions.type_text_target.criteria), ['1']);
  assert.deepEqual(Object.keys(body.questions.select_target.criteria), ['4:1']);
});

test('describes a target with its index, label and observed state', () => {
  const body = request();
  const described = body.questions.click_target.criteria['3'];
  assert.match(described.element, /\[3\] In stock/);
  assert.equal(described.checked, 'false');
  // A SELECT option is described by the option's label plus the dropdown's
  // current selection.
  const option = body.questions.select_target.criteria['4:1'];
  assert.equal(option.element, '[4:1] Price');
  assert.equal(option.current_value, 'Relevance');
});

test('names the operation each target head assumes', () => {
  const body = request();
  assert.equal(body.questions.click_target.instructions.operation, 'CLICK');
  assert.equal(body.questions.type_text_target.instructions.operation, 'TYPE_TEXT');
  assert.equal(body.questions.operation.instructions.goal, 'find the cheapest item');
});

test('sends the page, the element table and the recent actions as state', () => {
  const body = request({
    history: Array.from({ length: 12 }, (_, i) => ({
      action: `step ${i}`,
      kind: 'CLICK',
      text: '',
      page_changed: true,
    })),
  });
  assert.deepEqual(body.state.page, { url: PAGE.url, title: PAGE.title, text: PAGE.text });
  assert.equal(body.state.elements.length, 4);
  assert.equal(body.state.recent_actions.length, 10);
  assert.equal(body.state.recent_actions[9].action, 'step 11');
});

test('carries the configured model and the goal', () => {
  const body = request();
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.operation.instructions.goal, 'find the cheapest item');
});

test('omits target heads for operations with no candidates', () => {
  const empty = actionSpace([{ node: 1, kind: 'click', role: 'button', label: 'Only', value: '' }]);
  const body = buildRequest({
    goal: 'go',
    page: PAGE,
    elements: empty.elements,
    targets: empty.targets,
    controls: empty.controls,
    history: [],
    model: 'jev-latest',
  });
  assert.deepEqual(Object.keys(body.questions).sort(), ['click_target', 'operation']);
});

test('resolves an operation without a target from the control set', () => {
  const ids = operationIds(TABLE.targets, TABLE.controls);
  const decision = resolveDecision({
    answers: { operation: choice(ids, 'WAIT', 0.7) },
    targets: TABLE.targets,
    controls: TABLE.controls,
  });
  assert.equal(decision.operation, 'WAIT');
  assert.equal(decision.kind, 'wait');
  assert.equal(decision.target, null);
});

test('resolves a target from the head matching the chosen operation', () => {
  const ids = operationIds(TABLE.targets, TABLE.controls);
  const decision = resolveDecision({
    answers: {
      operation: choice(ids, 'CLICK'),
      click_target: choice(['1', '2', '3', '4'], '2', 0.9),
    },
    targets: TABLE.targets,
    controls: TABLE.controls,
  });
  assert.equal(decision.operation, 'CLICK');
  assert.equal(decision.kind, 'click');
  assert.equal(decision.target, '2');
  assert.equal(decision.descriptor.node, 2);
  assert.equal(decision.descriptor.label, 'Go');
});

test('resolves TYPE_TEXT to the kind the executor switches on', () => {
  const ids = operationIds(TABLE.targets, TABLE.controls);
  const decision = resolveDecision({
    answers: {
      operation: choice(ids, 'TYPE_TEXT', 0.9),
      type_text_target: choice(['1'], '1', 0.9),
    },
    targets: TABLE.targets,
    controls: TABLE.controls,
  });
  assert.equal(decision.operation, 'TYPE_TEXT');
  // The executor switches on this kind. Deriving it by lowercasing the wire
  // operation yields `type_text`, which no branch matches, so every TYPE_TEXT
  // step would be reported as "unsupported operation" instead of typing.
  assert.equal(decision.kind, 'fill');
});

test('does not require the target heads the chosen operation did not select', () => {
  const ids = operationIds(TABLE.targets, TABLE.controls);
  // `click_target` is absent even though CLICK has candidates: the operation
  // answer selected SELECT, so only `select_target` is validated.
  const decision = resolveDecision({
    answers: {
      operation: choice(ids, 'SELECT', 0.6),
      select_target: choice(['4:1'], '4:1', 0.95),
    },
    targets: TABLE.targets,
    controls: TABLE.controls,
  });
  assert.equal(decision.kind, 'select');
  assert.equal(decision.descriptor.optionIndex, 1);
});

test('rejects a decision whose selected target head is missing', () => {
  const ids = operationIds(TABLE.targets, TABLE.controls);
  assert.throws(
    () => resolveDecision({
      answers: { operation: choice(ids, 'CLICK') },
      targets: TABLE.targets,
      controls: TABLE.controls,
    }),
    /Invalid TypeSafe response/,
  );
});

test('rejects a decision whose target belongs to another operation', () => {
  const ids = operationIds(TABLE.targets, TABLE.controls);
  assert.throws(
    () => resolveDecision({
      answers: {
        operation: choice(ids, 'CLICK'),
        // `1` and `2` are valid CLICK targets; `4:1` is SELECT-only.
        click_target: choice(['1', '2', '4:1'], '4:1', 0.9),
      },
      targets: TABLE.targets,
      controls: TABLE.controls,
    }),
    /Invalid TypeSafe response/,
  );
});

test('rejects a decision whose operation answer is missing', () => {
  assert.throws(
    () => resolveDecision({ answers: {}, targets: TABLE.targets, controls: TABLE.controls }),
    /Invalid TypeSafe response/,
  );
});

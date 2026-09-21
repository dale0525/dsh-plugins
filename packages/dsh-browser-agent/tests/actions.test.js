/**
 * Tests for the element-table seam.
 *
 * The seam is a pure function: `actionSpace(observed) -> {elements, targets,
 * controls}`. It is the only place that decides element numbering and which
 * targets each operation may receive, so it is tested without a browser.
 *
 * The two invariants worth pinning: one node gets one index even when it
 * supports several operations, and each operation gets its OWN target set — a
 * shared pool would let the model return a target the operation cannot execute
 * (plan §4.6's reason for validating the selected head only).
 *
 * The observer's contract is one entry per ACTION, not per node: a text field
 * that can be typed into and clicked on produces two entries carrying the same
 * `node`, which is exactly the case the shared-index rule exists for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { actionSpace, CONTROL_LABELS, OPERATION_LABELS } from '../src/actions.js';

/** A clickable control. */
function clickable(overrides = {}) {
  return { node: 1, kind: 'click', role: 'button', label: 'Sign in', value: '', ...overrides };
}

/** An editable field, which the observer offers as both `fill` and `click`. */
function editable(node, label, value = '') {
  return [
    { node, kind: 'fill', role: 'textbox', label, value },
    { node, kind: 'click', role: 'textbox', label, value },
  ];
}

test('numbers one element per node even when it supports several operations', () => {
  const { elements } = actionSpace(editable(7, 'Search'));
  assert.equal(elements.length, 1);
  assert.equal(elements[0].index, '1');
  assert.deepEqual(elements[0].operations, ['TYPE_TEXT', 'CLICK']);
});

test('gives each operation its own target set', () => {
  const { targets } = actionSpace([
    clickable({ node: 1, label: 'Submit' }),
    ...editable(2, 'Query'),
  ]);
  assert.deepEqual(Object.keys(targets).sort(), ['CLICK', 'TYPE_TEXT']);
  assert.deepEqual(Object.keys(targets.CLICK).sort(), ['1', '2']);
  assert.deepEqual(Object.keys(targets.TYPE_TEXT), ['2']);
});

test('never offers TYPE_TEXT for a control the observer did not mark fillable', () => {
  const { targets, elements } = actionSpace([
    clickable({ node: 1, role: 'checkbox', label: 'Remember me', checked: 'false' }),
  ]);
  assert.deepEqual(elements[0].operations, ['CLICK']);
  assert.equal(targets.TYPE_TEXT, undefined);
  assert.equal(elements[0].checked, 'false');
});

test('indexes each dropdown option as its own target under SELECT', () => {
  const { elements, targets } = actionSpace([
    { node: 4, kind: 'select', role: 'combobox', label: 'Country', value: 'Germany', optionLabel: 'France', optionValue: 'fr', optionDomIndex: 2 },
    { node: 4, kind: 'select', role: 'combobox', label: 'Country', value: 'Germany', optionLabel: 'Germany', optionValue: 'de', optionDomIndex: 1 },
    { node: 4, kind: 'fill', role: 'combobox', label: 'Country', value: 'Germany' },
  ]);
  assert.equal(elements.length, 1);
  // The element row shows the dropdown's CURRENT selection, not an option.
  assert.equal(elements[0].label, 'Country');
  assert.equal(elements[0].value, 'Germany');
  assert.deepEqual(elements[0].options, [
    { index: '1:1', label: 'France', value: 'fr' },
    { index: '1:2', label: 'Germany', value: 'de' },
  ]);
  assert.deepEqual(Object.keys(targets.SELECT), ['1:1', '1:2']);
  // The dropdown element itself is still clickable and fillable.
  assert.deepEqual(elements[0].operations, ['SELECT', 'TYPE_TEXT']);
});

test('keeps a target descriptor executable', () => {
  const { targets } = actionSpace([clickable({ node: 42, role: 'link', label: 'Docs' })]);
  assert.deepEqual(targets.CLICK['1'], {
    node: 42,
    operation: 'CLICK',
    role: 'link',
    label: 'Docs',
    value: '',
  });
});

test('describes a dropdown option target with its element and option index', () => {
  const { targets } = actionSpace([
    { node: 4, kind: 'select', role: 'combobox', label: 'Country', value: 'Germany', optionLabel: 'France', optionValue: 'fr', optionDomIndex: 1 },
  ]);
  assert.deepEqual(targets.SELECT['1:1'], {
    node: 4,
    operation: 'SELECT',
    role: 'combobox',
    label: 'France',
    value: 'fr',
    // The element's current selection travels with the option, because the
    // model needs it to decide and the executor needs the option to act.
    currentValue: 'Germany',
    element: 1,
    optionIndex: 1,
  });
});

test('numbers a dropdown option by its position in the live select, not in the offered list', () => {
  // The observer skips the option that is already selected, so the offered list
  // is a SUBSET of the live <select>'s options. Numbering the target by its
  // position in the offered list points the executor at the wrong option: here
  // it would re-select the already-selected Germany instead of France.
  const { targets } = actionSpace([
    { node: 4, kind: 'select', role: 'combobox', label: 'Country', value: 'Germany', optionLabel: 'France', optionValue: 'fr', optionDomIndex: 2 },
  ]);
  assert.equal(targets.SELECT['1:1'].optionIndex, 2);
});

test('carries the observed state onto both the element row and its target', () => {
  const { elements, targets } = actionSpace([
    clickable({ node: 1, role: 'checkbox', label: 'Terms', checked: 'true', selected: 'true', expanded: 'false' }),
  ]);
  assert.equal(elements[0].checked, 'true');
  assert.equal(elements[0].selected, 'true');
  assert.equal(elements[0].expanded, 'false');
  assert.equal(targets.CLICK['1'].checked, 'true');
  assert.equal(targets.CLICK['1'].expanded, 'false');
});

test('keeps the scroll and wait controls as operations without targets', () => {
  const { controls } = actionSpace([]);
  assert.deepEqual(Object.keys(controls).sort(), ['SCROLL_DOWN', 'SCROLL_UP', 'WAIT']);
  assert.equal(controls.SCROLL_UP.kind, 'scroll');
  assert.equal(controls.SCROLL_UP.delta, -560);
  assert.equal(controls.SCROLL_DOWN.delta, 560);
  assert.equal(controls.WAIT.kind, 'wait');
});

test('reports the control set the observer says is available', () => {
  const { controls } = actionSpace([], { controls: ['WAIT'] });
  assert.deepEqual(Object.keys(controls), ['WAIT']);
});

test('exposes the operation and control labels the request is built from', () => {
  for (const operation of ['CLICK', 'TYPE_TEXT', 'SELECT']) {
    assert.equal(typeof OPERATION_LABELS[operation], 'string');
  }
  for (const control of ['SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']) {
    assert.equal(typeof CONTROL_LABELS[control], 'string');
  }
});

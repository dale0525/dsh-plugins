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

import { actionSpace, CONTROL_LABELS, KEYS, OPERATION_LABELS } from '../src/actions.js';

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

test('keeps the scroll, key and wait controls as operations without targets', () => {
  const { controls } = actionSpace([]);
  assert.deepEqual(Object.keys(controls).sort(), ['PRESS_KEY', 'SCROLL_DOWN', 'SCROLL_UP', 'WAIT']);
  assert.equal(controls.SCROLL_UP.kind, 'scroll');
  assert.equal(controls.SCROLL_UP.delta, -560);
  assert.equal(controls.SCROLL_DOWN.delta, 560);
  assert.equal(controls.PRESS_KEY.kind, 'press');
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
  for (const control of ['SCROLL_UP', 'SCROLL_DOWN', 'PRESS_KEY', 'WAIT', 'DONE', 'BLOCKED']) {
    assert.equal(typeof CONTROL_LABELS[control], 'string');
  }
});

test('offers the keys PRESS_KEY may send, each with what it is for', () => {
  for (const key of ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Control+Enter']) {
    assert.equal(typeof KEYS[key], 'string', `key ${key} must be offered`);
  }
});

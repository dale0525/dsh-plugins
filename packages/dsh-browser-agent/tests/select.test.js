/**
 * Tests for the dropdown action shape.
 *
 * A `<select>` used to produce one action per selectable option, so its options
 * competed with every real control for the single `MAX_ACTIONS` budget: two
 * 160-option dropdowns consumed all 250 slots and left `CLICK` with zero
 * targets — measured on a real page as "the Search button is in the element
 * table? false". The options are also not separate actions: "select France" is
 * the dropdown being set to France, not a thing to click.
 *
 * So a dropdown is now ONE target carrying its options as data, and the value is
 * a separate question the same way `PRESS_KEY`'s key is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { actionSpace } from '../src/actions.js';

/** One observed `<select>`, as the observer now emits it. */
function dropdown(overrides = {}) {
  return {
    node: 4,
    kind: 'select',
    role: 'combobox',
    label: 'Country',
    value: 'Germany',
    options: [
      { label: 'France', value: 'fr' },
      { label: 'Germany', value: 'de' },
      { label: 'Spain', value: 'es' },
    ],
    ...overrides,
  };
}

test('offers a dropdown as one target, not one per option', () => {
  const { elements, targets } = actionSpace([dropdown()]);
  assert.equal(elements.length, 1);
  assert.deepEqual(Object.keys(targets.SELECT), ['1']);
});

test('carries the options as data on the target so the value can be chosen', () => {
  const { targets } = actionSpace([dropdown()]);
  assert.deepEqual(targets.SELECT['1'].options, [
    { label: 'France', value: 'fr' },
    { label: 'Germany', value: 'de' },
    { label: 'Spain', value: 'es' },
  ]);
  assert.equal(targets.SELECT['1'].currentValue, 'Germany');
  assert.equal(targets.SELECT['1'].label, 'Country');
  assert.equal(targets.SELECT['1'].node, 4);
});

test('keeps the dropdown options out of the element table itself', () => {
  // Options belong to the target, not to the state: sending them as their own
  // elements is what made them compete with real controls for the budget.
  const { elements } = actionSpace([dropdown()]);
  assert.deepEqual(elements[0].options, undefined);
});

test('a dropdown no longer scales the action count with its option count', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ label: `Option ${i}`, value: `v${i}` }));
  const { elements, targets } = actionSpace([dropdown({ options: many })]);
  assert.equal(elements.length, 1);
  assert.equal(Object.keys(targets.SELECT).length, 1);
});

test('a dropdown stays clickable and fillable alongside its SELECT target', () => {
  const { elements, targets } = actionSpace([
    dropdown(),
    { node: 4, kind: 'click', role: 'combobox', label: 'Country', value: 'Germany' },
    { node: 4, kind: 'fill', role: 'combobox', label: 'Country', value: 'Germany' },
  ]);
  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0].operations, ['SELECT', 'CLICK', 'TYPE_TEXT']);
  assert.deepEqual(Object.keys(targets.SELECT), ['1']);
});

test('drops a dropdown that offers no alternatives to pick from', () => {
  // Nothing to choose means nothing to ask: offering it would spend a decision
  // on a question with one answer, or on an empty criteria map the request
  // layer cannot send.
  const { elements, targets } = actionSpace([dropdown({ options: [] })]);
  assert.equal(elements.length, 0);
  assert.equal(targets.SELECT, undefined);
});

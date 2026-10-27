/**
 * Tests for the action executor.
 *
 * `execute` is the one module that touches the page, and two of its faults are
 * invisible in a trace. Assigning `element.value` directly leaves a React
 * controlled input empty: React tracks the value property, so the assignment
 * updates the tracker and the `input` event it dispatches is dropped as a
 * no-op. And with no keyboard operation at all, a search form can never be
 * submitted however well its fields are filled.
 *
 * Both are pinned here by running the real page-side functions against a
 * stand-in element whose text only changes when the keyboard inserts into it —
 * the same way a real input's value only changes when text is typed into it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { execute } from '../src/execute.js';

/**
 * A stand-in for one page element.
 *
 * `value` is write-only from the executor's side: an assignment is recorded and
 * discarded, which is how a framework-tracked input behaves once the framework
 * re-renders from its own state.
 */
function fakeElement(overrides = {}) {
  const writes = [];
  const events = [];
  const element = {
    isConnected: true,
    isContentEditable: false,
    tagName: 'INPUT',
    options: [],
    writes,
    events,
    focus() {
      globalThis.document.activeElement = element;
    },
    select() {
      element.selected = true;
    },
    click() {
      element.clicked = true;
    },
    scrollIntoView() {},
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
    get value() {
      return element.text ?? '';
    },
    set value(next) {
      writes.push(next);
    },
    ...overrides,
  };
  return element;
}

/** A page whose evaluation runs the real page-side function, plus a keyboard. */
function fakePage(nodes) {
  const keyboard = {
    inserted: [],
    pressed: [],
    async insertText(text) {
      keyboard.inserted.push(text);
      const active = globalThis.document.activeElement;
      if (active === null) throw new Error('nothing is focused');
      if (active.isContentEditable) active.textContent = text;
      else active.text = text;
    },
    async press(key) {
      keyboard.pressed.push(key);
    },
  };
  const page = {
    keyboard,
    async evaluate(fn, arg) {
      return await fn(arg);
    },
    async waitForTimeout() {},
  };
  globalThis.window = {
    __dshBrowserAgent: { nodes: new Map(nodes) },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  };
  globalThis.document = { activeElement: null, createRange: () => ({ selectNodeContents() {} }) };
  return page;
}

/** Forget the page globals a test installed. */
function cleanup(t) {
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
  });
}

/** A fill decision for one node, plus the value provider it needs. */
function fill(node, target = '1') {
  return {
    decision: {
      operation: 'TYPE_TEXT',
      kind: 'fill',
      target,
      descriptor: { node, operation: 'TYPE_TEXT', role: 'textbox', label: 'Search', value: '' },
    },
  };
}

test('types through the keyboard instead of assigning the value', async (t) => {
  const element = fakeElement();
  const page = fakePage([[7, element]]);
  cleanup(t);

  const { decision } = fill(7);
  const result = await execute({ page, decision, valueProvider: async () => 'running shoes' });

  assert.deepEqual(page.keyboard.inserted, ['running shoes']);
  // The text arrived through the keyboard, not through an assignment the next
  // render would throw away.
  assert.deepEqual(element.writes, []);
  assert.equal(element.value, 'running shoes');
  assert.equal(result, 'typed "running shoes" into Search');
});

test('selects the existing text so the insert replaces it', async (t) => {
  const element = fakeElement({ text: 'old query' });
  const page = fakePage([[7, element]]);
  cleanup(t);

  const { decision } = fill(7);
  await execute({ page, decision, valueProvider: async () => 'new query' });

  assert.equal(element.selected, true, 'the existing text must be selected before the insert');
  assert.equal(element.value, 'new query');
});

test('types into a contenteditable through the same keyboard path', async (t) => {
  const element = fakeElement({ isContentEditable: true, tagName: 'DIV', textContent: 'draft' });
  const page = fakePage([[7, element]]);
  cleanup(t);

  const { decision } = fill(7);
  await execute({ page, decision, valueProvider: async () => 'hello' });

  assert.deepEqual(page.keyboard.inserted, ['hello']);
  assert.equal(element.textContent, 'hello');
  assert.deepEqual(element.writes, []);
});

test('reports a field that refused the text instead of claiming it typed', async (t) => {
  const element = fakeElement();
  // A read-only field takes focus and silently drops the insert.
  Object.defineProperty(element, 'text', { get: () => '', set: () => {} });
  const page = fakePage([[7, element]]);
  cleanup(t);

  const { decision } = fill(7);
  await assert.rejects(execute({ page, decision, valueProvider: async () => 'shoes' }), /did not accept the text/);
});

test('accepts a field that already held the requested text', async (t) => {
  const element = fakeElement({ text: 'shoes' });
  const page = fakePage([[7, element]]);
  cleanup(t);

  const { decision } = fill(7);
  await execute({ page, decision, valueProvider: async () => 'shoes' });

  // Unchanged value, but unchanged because the field already said it: not a
  // refusal, and reporting one would make the loop retype forever.
  assert.equal(element.value, 'shoes');
});

test('presses the key of a keyboard control', async (t) => {
  const page = fakePage([]);
  cleanup(t);

  const result = await execute({
    page,
    decision: { operation: 'PRESS_ENTER', kind: 'press', key: 'Enter', target: null, descriptor: null, delta: 0 },
  });

  assert.deepEqual(page.keyboard.pressed, ['Enter']);
  assert.equal(result, 'pressed Enter');
});

test('clicks the element the observation identified', async (t) => {
  const element = fakeElement();
  const page = fakePage([[7, element]]);
  cleanup(t);

  const result = await execute({
    page,
    decision: {
      operation: 'CLICK',
      kind: 'click',
      target: '1',
      descriptor: { node: 7, operation: 'CLICK', role: 'button', label: 'Go', value: '' },
    },
  });

  assert.equal(element.clicked, true);
  assert.equal(result, 'clicked Go');
});

test('sets a dropdown to the value its value question chose', async (t) => {
  const element = fakeElement({
    tagName: 'SELECT',
    options: [{ value: 'relevance' }, { value: 'price' }],
  });
  const page = fakePage([[7, element]]);
  cleanup(t);

  const result = await execute({
    page,
    decision: {
      operation: 'SELECT',
      kind: 'select',
      target: '1',
      descriptor: {
        node: 7,
        operation: 'SELECT',
        role: 'combobox',
        label: 'Sort',
        value: 'Relevance',
        option: 'price',
        optionLabel: 'Price',
      },
    },
  });

  assert.deepEqual(element.writes, ['price']);
  assert.deepEqual(element.events, ['input', 'change']);
  assert.equal(result, 'selected Price in Sort');
});

test('finds the chosen value even when the dropdown offers it out of order', async (t) => {
  // The value is matched by option value, not by position: the observer skips
  // options it will not offer, so a position from the offered list does not
  // address the live <select>.
  const element = fakeElement({
    tagName: 'SELECT',
    options: [{ value: 'relevance' }, { value: 'price' }, { value: 'rating' }],
  });
  const page = fakePage([[7, element]]);
  cleanup(t);

  await execute({
    page,
    decision: {
      operation: 'SELECT',
      kind: 'select',
      target: '1',
      descriptor: { node: 7, operation: 'SELECT', role: 'combobox', label: 'Sort', value: 'Relevance', option: 'rating', optionLabel: 'Rating' },
    },
  });

  assert.deepEqual(element.writes, ['rating']);
});

test('reports a dropdown value that is no longer offered', async (t) => {
  const element = fakeElement({ tagName: 'SELECT', options: [{ value: 'relevance' }] });
  const page = fakePage([[7, element]]);
  cleanup(t);

  await assert.rejects(
    execute({
      page,
      decision: {
        operation: 'SELECT',
        kind: 'select',
        target: '1',
        descriptor: { node: 7, operation: 'SELECT', role: 'combobox', label: 'Sort', value: 'Relevance', option: 'price', optionLabel: 'Price' },
      },
    }),
    /no longer offered/,
  );
});

test('refuses a target that left the page', async (t) => {
  const page = fakePage([]);
  cleanup(t);

  const { decision } = fill(7);
  await assert.rejects(execute({ page, decision, valueProvider: async () => 'shoes' }), /target \[1\] is no longer on the page/);
});

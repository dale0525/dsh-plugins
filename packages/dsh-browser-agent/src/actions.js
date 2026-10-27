/**
 * The dynamic action space: observation -> indexed element table.
 *
 * One observed node receives one index even when it supports several
 * operations, and each operation gets its OWN target map. Both matter. A shared
 * target pool would let a `CLICK` answer name a target only `SELECT` can
 * execute, and the upstream design rejects that class of answer by
 * construction rather than by post-hoc checking; a per-node index is what makes
 * the model's target unambiguous when a control is both clickable and fillable.
 *
 * A dropdown is ONE target carrying its options as data, and the value to set is
 * a separate question — "set Country to France" is one action with a parameter,
 * not one action per country. Emitting an action per option also made the option
 * count compete with every real control for the observer's action budget: two
 * 160-option dropdowns consumed it entirely and left `CLICK` with no targets.
 *
 * Pure and browser-free, so the numbering rules are testable offline.
 *
 * @module @logictan/dsh-browser-agent/actions
 */

/** Instructions attached to the operation question. */
export const OPERATION_LABELS = Object.freeze({
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
});

/**
 * Labels for the operations that need no observed element.
 *
 * `DONE` and `BLOCKED` are not controls — they are terminal answers — but they
 * belong to the same choice criteria, which is why they share one table.
 */
export const CONTROL_LABELS = Object.freeze({
  SCROLL_UP: 'Scroll the page up.',
  SCROLL_DOWN: 'Scroll the page down.',
  PRESS_KEY: 'Press one key on the page, e.g. Enter to submit a filled form or Escape to dismiss a popup. A second question chooses the key.',
  WAIT: 'Wait for the page to update.',
  DONE: 'Every requirement is visibly satisfied.',
  BLOCKED: 'No supported operation can progress.',
});

/**
 * The keys `PRESS_KEY` may send, with what each one is for.
 *
 * Kept to the keys that unblock a page rather than to a full keyboard: the
 * operation exists because a filled form still needs submitting, an
 * autocomplete list still needs accepting, and a popup still needs dismissing —
 * none of which is reachable by clicking. Editing keys are not offered:
 * `TYPE_TEXT` replaces a field's whole value, so character-by-character editing
 * has nothing left to do.
 */
export const KEYS = Object.freeze({
  Enter: 'Submit the form, or accept the highlighted autocomplete suggestion.',
  Tab: 'Move focus to the next control, which also commits a field the page validates on blur.',
  Escape: 'Dismiss an open popup, dropdown or autocomplete list.',
  ArrowDown: 'Move to the next item in an open listbox or suggestion list.',
  ArrowUp: 'Move to the previous item in an open listbox or suggestion list.',
  'Control+Enter': 'Submit a multi-line field that treats a plain Enter as a newline.',
});

/** Observed operations that address a specific element, keyed by observer kind. */
const OPERATION_FOR_KIND = Object.freeze({ click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' });

/**
 * The observer kind that executes one wire operation.
 *
 * The executor switches on the observer's kind, not on the wire name: the
 * operation is spelled `TYPE_TEXT` on the wire and `fill` in the observer. It
 * is derived from {@link OPERATION_FOR_KIND} so the two directions cannot drift
 * — deriving it by lowercasing the operation instead would produce `type_text`,
 * which no executor branch matches.
 */
export const KIND_FOR_OPERATION = Object.freeze(
  Object.fromEntries(Object.entries(OPERATION_FOR_KIND).map(([kind, operation]) => [operation, kind])),
);

/** Observed state keys copied onto both the element row and its target descriptor. */
const STATE_KEYS = Object.freeze(['checked', 'selected', 'expanded']);

/** Page-scroll step in CSS pixels, matching the upstream observer. */
const SCROLL_STEP = 560;

/**
 * Build the indexed element table and the per-operation target maps.
 *
 * @param observed - one entry per observed control ACTION, not per node: a text
 *   field the observer marks fillable produces a `fill` entry and a `click`
 *   entry sharing one `node`, and a dropdown produces a single `select` entry
 *   carrying its selectable `options` as data. Every entry carries
 *   `label`/`value` for the ELEMENT and whatever of
 *   `checked`/`selected`/`expanded` the observer read.
 * @param [options] - `controls` lists the target-less operations the observer
 *   offers. Omit it to offer all of them.
 * @returns `elements` (the table sent as state), `targets` (per-operation
 *   index -> descriptor), and `controls` (target-less operations).
 */
export function actionSpace(observed, options = {}) {
  const elements = [];
  const indices = new Map();
  const targets = {};

  for (const action of observed) {
    const operation = OPERATION_FOR_KIND[action.kind];
    if (operation === undefined) continue;

    // A dropdown with nothing to choose from is not an action: the value
    // question would have one answer, and an empty criteria map cannot be sent.
    if (operation === 'SELECT' && (action.options === undefined || action.options.length === 0)) continue;

    if (!indices.has(action.node)) {
      const element = {
        index: String(elements.length + 1),
        label: action.label,
        role: action.role,
        operations: [],
        value: action.value,
      };
      for (const key of STATE_KEYS) {
        if (action[key] !== undefined) element[key] = action[key];
      }
      indices.set(action.node, element.index);
      elements.push(element);
    }

    const index = indices.get(action.node);
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);

    const group = (targets[operation] ??= {});
    const descriptor = {
      node: action.node,
      operation,
      role: action.role,
      label: action.label,
      value: action.value,
    };
    for (const key of STATE_KEYS) {
      if (action[key] !== undefined) descriptor[key] = action[key];
    }

    if (operation === 'SELECT') {
      // One target per dropdown, carrying every option it offers. The value is
      // a separate question (see `./request.js`), because "set Country to
      // France" is one action with a parameter, not one action per country.
      group[index] = { ...descriptor, currentValue: action.value, options: action.options };
      continue;
    }

    group[index] = descriptor;
  }

  const offered = options.controls ?? ['SCROLL_UP', 'SCROLL_DOWN', 'PRESS_KEY', 'WAIT'];
  const controls = {};
  for (const name of offered) {
    if (name === 'SCROLL_UP') controls.SCROLL_UP = { kind: 'scroll', label: CONTROL_LABELS.SCROLL_UP, delta: -SCROLL_STEP };
    else if (name === 'SCROLL_DOWN') controls.SCROLL_DOWN = { kind: 'scroll', label: CONTROL_LABELS.SCROLL_DOWN, delta: SCROLL_STEP };
    else if (name === 'PRESS_KEY') controls.PRESS_KEY = { kind: 'press', label: CONTROL_LABELS.PRESS_KEY };
    else if (name === 'WAIT') controls.WAIT = { kind: 'wait', label: CONTROL_LABELS.WAIT };
  }

  return { elements, targets, controls };
}

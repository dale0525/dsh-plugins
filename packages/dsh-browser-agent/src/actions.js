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
 * A dropdown option is its own target, addressed `<element>:<option>`, because
 * "select France" is a different action from "select the Country dropdown". The
 * option target carries BOTH the value to set and the dropdown's current
 * selection, since the model needs the latter to decide and the executor needs
 * the former to act.
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
  WAIT: 'Wait for the page to update.',
  DONE: 'Every requirement is visibly satisfied.',
  BLOCKED: 'No supported operation can progress.',
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
 *   entry sharing one `node`, and a dropdown produces one `select` entry per
 *   selectable option. Every entry carries `label`/`value` for the ELEMENT and
 *   whatever of `checked`/`selected`/`expanded` the observer read; a `select`
 *   entry additionally carries `optionLabel`/`optionValue` for the option it
 *   offers, plus `optionDomIndex` — the option's 1-based position in the live
 *   `<select>`. That position is NOT the entry's position in `observed`: the
 *   observer skips options that are already selected or disabled, so the offered
 *   list is a subset.
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
      if (operation === 'SELECT') element.options = [];
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
      const option = {
        index: `${index}:${element.options.length + 1}`,
        label: action.optionLabel,
        value: action.optionValue,
      };
      element.options.push(option);
      group[option.index] = {
        ...descriptor,
        label: option.label,
        value: option.value,
        // The dropdown's own current selection travels with the option: the
        // model needs it to decide, and the element row already carries it.
        currentValue: action.value,
        element: Number(index),
        optionIndex: action.optionDomIndex,
      };
    } else {
      group[index] = descriptor;
    }
  }

  const offered = options.controls ?? ['SCROLL_UP', 'SCROLL_DOWN', 'WAIT'];
  const controls = {};
  for (const name of offered) {
    if (name === 'SCROLL_UP') controls.SCROLL_UP = { kind: 'scroll', label: CONTROL_LABELS.SCROLL_UP, delta: -SCROLL_STEP };
    else if (name === 'SCROLL_DOWN') controls.SCROLL_DOWN = { kind: 'scroll', label: CONTROL_LABELS.SCROLL_DOWN, delta: SCROLL_STEP };
    else if (name === 'WAIT') controls.WAIT = { kind: 'wait', label: CONTROL_LABELS.WAIT };
  }

  return { elements, targets, controls };
}

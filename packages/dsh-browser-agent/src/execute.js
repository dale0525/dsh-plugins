/**
 * Action execution against the attached page.
 *
 * Every target is resolved from the observation's own identity map, and its
 * geometry is re-read immediately before input: the page may have moved since
 * the observation, and clicking stale coordinates would hit whatever now
 * occupies them. A target that is gone is reported as a failed step rather than
 * acted on blind, and the loop re-observes.
 *
 * The identity map is `window.__dshBrowserAgent`, written by `./observe.js`.
 * The page-side functions below therefore read that one shape and nothing else;
 * if the observer's cache is renamed, both modules must change together.
 *
 * @module @logictan/dsh-browser-agent/execute
 */

/** How long to let the page settle after an interaction, in milliseconds. */
const SETTLE_MS = 120;

/** A dropdown option gets longer, because its list may still be rendering. */
const OPTION_SETTLE_MS = 200;

/**
 * Resolve one code-owned identity to its live node inside the page.
 *
 * Must stay self-contained: it is serialized and evaluated in the page.
 * @param node - the identity from the observation.
 * @returns whether the node is still actionable, after scrolling it into view.
 */
function resolveAndScroll(node) {
  const element = window.__dshBrowserAgent?.nodes?.get(node);
  if (!element || !element.isConnected) return false;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  return true;
}

/**
 * Focus one target and select the text it already holds.
 *
 * Must stay self-contained: it is serialized and evaluated in the page. The
 * selection is what makes the following insert REPLACE the field's value rather
 * than append to it.
 *
 * @param node - the identity from the observation.
 * @returns whether the node is still actionable.
 */
function focusAndSelect(node) {
  const element = window.__dshBrowserAgent?.nodes?.get(node);
  if (!element || !element.isConnected) return false;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  if (typeof element.select === 'function') {
    element.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

/**
 * Read back what one target now contains.
 *
 * Must stay self-contained: it is serialized and evaluated in the page.
 * @param node - the identity from the observation.
 * @returns the field's text, or `null` when the node is gone.
 */
function readText(node) {
  const element = window.__dshBrowserAgent?.nodes?.get(node);
  if (!element || !element.isConnected) return null;
  return element.isContentEditable ? element.textContent : element.value;
}

/**
 * Execute one decision against the page.
 *
 * @param input - the page, the resolved decision, and the TYPE_TEXT value
 *   provider (called only for `TYPE_TEXT`).
 * @returns a short human-readable description of what was done.
 * @throws {Error} when the target is no longer actionable, the value provider
 *   could not produce a value, or the field refused the text.
 */
export async function execute(input) {
  const { page, decision, valueProvider } = input;

  if (decision.kind === 'done' || decision.kind === 'blocked') return decision.kind;
  if (decision.kind === 'wait') {
    await page.waitForTimeout(SETTLE_MS);
    return 'waited for the page';
  }
  if (decision.kind === 'press') {
    // No target: a key goes to whatever the page has focused, which is how a
    // filled field gets submitted and how an open listbox gets accepted.
    await page.keyboard.press(decision.key);
    await page.waitForTimeout(SETTLE_MS);
    return `pressed ${decision.key}`;
  }
  if (decision.kind === 'scroll') {
    await page.evaluate((delta) => window.scrollBy(0, delta), decision.delta);
    await page.waitForTimeout(SETTLE_MS);
    return `scrolled by ${decision.delta}px`;
  }

  const descriptor = decision.descriptor;

  if (decision.kind === 'fill') {
    const value = await valueProvider(descriptor);
    const focused = await page.evaluate(focusAndSelect, descriptor.node);
    if (!focused) throw new Error(`target [${decision.target}] is no longer on the page`);
    // Text arrives as a real keystroke insert, not as a `value` assignment:
    // React and Vue track the value property, so an assignment updates their
    // tracker and the event they then see is discarded as a no-op — the field
    // stays empty however convincing the trace looks.
    await page.keyboard.insertText(value);
    const readback = await page.evaluate(readText, descriptor.node);
    if (readback !== value) {
      throw new Error(`the field ${descriptor.label} did not accept the text`);
    }
    await page.waitForTimeout(SETTLE_MS);
    return `typed "${value}" into ${descriptor.label}`;
  }

  const live = await page.evaluate(resolveAndScroll, descriptor.node);
  if (!live) throw new Error(`target [${decision.target}] is no longer on the page`);

  if (decision.kind === 'click') {
    await page.evaluate((node) => {
      window.__dshBrowserAgent.nodes.get(node).click();
    }, descriptor.node);
    await page.waitForTimeout(SETTLE_MS);
    return `clicked ${descriptor.label}`;
  }

  if (decision.kind === 'select') {
    await page.evaluate(
      ({ node, value }) => {
        const element = window.__dshBrowserAgent.nodes.get(node);
        const option = [...element.options].find((candidate) => candidate.value === value);
        if (option === undefined) throw new Error('the option is no longer offered');
        element.value = option.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { node: descriptor.node, value: descriptor.option },
    );
    await page.waitForTimeout(OPTION_SETTLE_MS);
    return `selected ${descriptor.optionLabel} in ${descriptor.label}`;
  }

  throw new Error(`unsupported operation ${decision.operation}`);
}

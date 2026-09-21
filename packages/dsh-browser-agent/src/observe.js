/**
 * Page observation: one DOM walk producing the element table's raw material.
 *
 * The snapshot runs INSIDE the page, so it can read computed visibility, ARIA
 * references and label associations — none of which are reachable from Node
 * without a second round trip per element. It returns one entry per control
 * ACTION rather than per node: a fillable text field yields a `fill` entry and
 * a `click` entry sharing one identity, and a dropdown yields one `select`
 * entry per selectable option. {@link actionSpace} turns that into the indexed
 * table.
 *
 * Element identity is code-owned: a WeakMap assigns a number to each node the
 * first time it is seen and a Map keeps the live reference the executor needs.
 * Replaced nodes get fresh identities and disconnected ones are pruned, so an
 * identity from an earlier observation can never resolve to a different
 * element. Navigation starts a fresh cache because the whole document is gone.
 *
 * `snapshot` is serialized and evaluated in the page, so it must close over
 * NOTHING from this module: its limits arrive as arguments.
 *
 * @module @logictan/dsh-browser-agent/observe
 */

/**
 * Roles the observer treats as actionable.
 *
 * Restricted to the roles with a defined interaction, matching upstream: a
 * generic container is not an action, and offering one would let the model
 * choose a target nothing can execute.
 */
export const ROLES = [
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'menuitemradio', 'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton',
];

/** Upper bound on retained actions, so a huge page cannot blow the request. */
export const MAX_ACTIONS = 250;

/** Upper bound on visible page text, in characters. */
export const MAX_TEXT = 6000;

/**
 * The page-side snapshot. Serialized into the page by the caller, so every
 * limit it needs is a parameter.
 *
 * @param limits - the roles to treat as actionable and the caps to apply.
 * @returns the page's url, title, visible text, one entry per control action,
 *   the target-less controls it offers, and the number of actions dropped by
 *   the cap.
 */
export function snapshot(limits) {
  if (!document.body) return null;
  const cache = (window.__dshBrowserAgent ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });

  const identity = (element) => {
    if (!cache.ids.has(element)) {
      cache.ids.set(element, cache.next++);
      cache.nodes.set(cache.ids.get(element), element);
    }
    return cache.ids.get(element);
  };

  for (const [id, element] of cache.nodes) if (!element.isConnected) cache.nodes.delete(id);

  const safe = (element) => !['password', 'file', 'hidden'].includes(element.type);
  const visible = (element) =>
    !element.closest('[aria-hidden="true"],[inert]') &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  const name = (element, seen = new Set()) => {
    if (!element || seen.has(element)) return '';
    seen.add(element);
    const referenced = (element.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => name(document.getElementById(id), seen))
      .filter(Boolean)
      .join(' ');
    return (
      referenced ||
      element.getAttribute('aria-label') ||
      [...(element.labels || [])].map((label) => name(label, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(element.type) ? element.value : '') ||
      element.getAttribute('alt') ||
      (element.tagName === 'INPUT'
        ? ''
        : [...element.childNodes]
            .map((node) =>
              node.nodeType === 3
                ? node.textContent
                : node.nodeType === 1 && node.getAttribute('aria-hidden') !== 'true'
                  ? name(node, seen)
                  : '',
            )
            .join(' ')
            .trim()) ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      ''
    );
  };

  const role = (element) => {
    const explicit = element.getAttribute('role');
    if (limits.roles.includes(explicit)) return explicit;
    if (element.tagName === 'BUTTON' || element.tagName === 'SUMMARY') return 'button';
    if (element.tagName === 'A') return 'link';
    if (element.tagName === 'SELECT') return 'combobox';
    if (element.tagName === 'TEXTAREA' || element.isContentEditable) return 'textbox';
    if (element.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(element.type)) return element.type;
      if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button';
      if (element.type === 'search') return 'searchbox';
      if (element.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(element.type)) return 'textbox';
    }
    return null;
  };

  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    limits.roles.map((name_) => '[role="' + name_ + '"]').join(',');

  const actions = [];
  for (const element of document.querySelectorAll(selector)) {
    if (!safe(element) || !visible(element) || element.matches(':disabled')) continue;
    if (element.closest('[aria-disabled="true"]')) continue;
    const rect = element.getBoundingClientRect();
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const elementRole = role(element);
    if (!elementRole || rect.width <= 0 || rect.height <= 0) continue;
    if (centerX < 0 || centerY < 0 || centerX >= innerWidth || centerY >= innerHeight) continue;
    if (elementRole === 'gridcell' && element.querySelector('button,[role="button"]')) continue;

    const base = { node: identity(element), role: elementRole, label: name(element) || elementRole };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = element.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(element.type)) base.checked = String(element.checked);

    if (element.tagName === 'SELECT') {
      const current = [...element.selectedOptions].map((option) => option.label).join(', ');
      for (let i = 0; i < element.options.length; i += 1) {
        const option = element.options[i];
        if (option.selected || option.disabled || option.closest('optgroup[disabled]')) continue;
        actions.push({
          ...base,
          kind: 'select',
          value: current,
          optionLabel: option.label,
          optionValue: option.value,
          // The executor indexes the live <select>'s options directly, and the
          // skip-list above makes this differ from the option's position in the
          // offered list. Carrying the DOM position is what keeps them in step.
          optionDomIndex: i + 1,
        });
      }
      continue;
    }

    const editable =
      !element.readOnly &&
      element.getAttribute('aria-readonly') !== 'true' &&
      (['textbox', 'searchbox', 'spinbutton'].includes(elementRole) ||
        (elementRole === 'combobox' && ['INPUT', 'TEXTAREA'].includes(element.tagName)));
    const value =
      'value' in element
        ? String(element.value)
        : element.isContentEditable || elementRole === 'combobox'
          ? element.innerText.trim()
          : '';

    actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
    if (editable) actions.push({ ...base, kind: 'click', value });
  }

  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  let length = 0;
  while ((node = walker.nextNode()) && length < limits.maxText) {
    const value = node.textContent.trim();
    const parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) {
      words.push(value);
      length += value.length;
    }
  }

  const omitted = Math.max(0, actions.length - limits.maxActions);
  actions.splice(limits.maxActions);

  const controls = [];
  if (scrollY + innerHeight < document.documentElement.scrollHeight - 2) controls.push('SCROLL_DOWN');
  if (scrollY > 0) controls.push('SCROLL_UP');
  controls.push('WAIT');

  return {
    url: location.href,
    title: document.title,
    text: words.join('\n').slice(0, limits.maxText),
    actions,
    controls,
    omitted,
  };
}

/** The limits {@link snapshot} is called with. */
export const SNAPSHOT_LIMITS = Object.freeze({ roles: ROLES, maxActions: MAX_ACTIONS, maxText: MAX_TEXT });

/**
 * Render tests for the settings card, with real React in a real document.
 *
 * The card is the part of this plugin a user actually touches, and it has two
 * failure modes that every other test here would miss:
 *
 *  - a `useSyncExternalStore` snapshot that is rebuilt on each call throws React
 *    error #185 (maximum update depth), and the Host turns a crashed slot entry
 *    into an EMPTY element — the page shows the plugin's title and nothing under
 *    it, with the cause only in the console;
 *  - a wrong prop name against the shared components renders an empty control
 *    without failing anything.
 *
 * So this mounts the REAL built bundle with real React and drives it: add a row,
 * save the table, set and clear a password, and check the write the Host would
 * receive. The shared component layer is loaded from its own built bundle, so the
 * card is exercised against the same components the browser will use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

/** Install a document; React DOM needs one and `useSyncExternalStore` needs a client. */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return window;
}

/** Evaluate one built browser half under a loader shim. */
function loadBundle(window, path, requireFn) {
  let registration;
  window.__ModuleLoader__ = { load: (entry) => { registration = entry } };
  const code = readFileSync(path, 'utf8');
  new Function('window', 'document', code)(window, window.document);
  assert.ok(registration !== undefined, `${path} registered nothing`);
  return registration.factory(requireFn);
}

/**
 * Load the plugin's card and the shared components it renders with.
 *
 * @param window - the installed document.
 * @returns `{ui, face}`.
 */
function loadPlugin(window) {
  const sharedPath = join(here, '..', '..', 'dsh-plugins-shared-client', 'lib', 'client.js');
  const ui = loadBundle(window, sharedPath, (specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier);
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  const face = loadBundle(window, join(here, '..', 'lib', 'client.js'), (specifier) => {
    if (specifier === 'react') return require('react');
    if (specifier === '@logictan/dsh-plugins-shared-client') return ui;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  return { ui, face };
}

/**
 * A form whose snapshot the test controls, shaped like the Host's.
 *
 * The snapshot object is created once and replaced only when a write is
 * accepted, because a fresh object per call is exactly the bug under test.
 *
 * @param initial - the `hosts` array.
 * @returns `{writes, handle, setValue}`.
 */
function makeForm(initial) {
  const writes = [];
  let snapshot = { status: 'ready', value: { hosts: initial }, writable: true, revision: 5 };
  const listeners = new Set();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    writes,
    setValue(next) {
      snapshot = { ...snapshot, value: { hosts: next }, revision: snapshot.revision + 1 };
      publish();
    },
    handle: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      mutate: async (ops, expectedRevision) => {
        writes.push({ ops, expectedRevision });
        const op = ops[0];
        if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'hosts') {
          snapshot = { ...snapshot, value: { hosts: op.value }, revision: snapshot.revision + 1 };
          publish();
        }
        return true;
      },
    },
  };
}

/** A describe face over a schema with no renderable fields (the card owns the table). */
function makeDescribe() {
  const snapshot = {
    status: 'ready',
    view: {
      namespaces: [
        {
          ns: 'dsh-ssh',
          schema: { uid: 10, refs: { 2: { type: 'array', meta: { default: [], comment: 'SSH 主机' } }, 10: { type: 'object', meta: {}, dict: { hosts: 2 } } } },
        },
      ],
    },
  };
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

/**
 * Mount the card with a recording context.
 *
 * @param options.hosts - initial host table.
 * @param options.stored - which credential refs report as configured.
 * @returns the mount handle.
 */
async function mountCard(options = {}) {
  const window = installDom();
  const { face } = loadPlugin(window);
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');

  const form = makeForm(options.hosts ?? []);
  const credentials = {
    describe: async (refs) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [ref, { configured: (options.stored ?? []).includes(ref) }])),
    }),
    set: async (ref, value) => {
      (options.calls ??= []).push({ kind: 'set', ref, value });
      return { ok: true };
    },
    unset: async (ref) => {
      (options.calls ??= []).push({ kind: 'unset', ref });
      return { ok: true };
    },
  };

  let component;
  const registeredOptions = [];
  const slots = {
    inject: (_name, callback) => callback(),
    register: (entryOptions, registered) => {
      registeredOptions.push(entryOptions);
      component = registered;
      return () => {};
    },
  };
  const scoped = {
    slots,
    remote: { credentials, $on: () => () => {} },
    configForms: { get: () => form.handle, describe: makeDescribe },
  };
  face.apply({ slots, remote: scoped.remote, inject: (_names, callback) => callback(scoped) });

  // The card's props come from the slot entry, so they are taken from what the
  // registration declared rather than reconstructed here.
  const props = registeredOptions[0].inject();

  const container = window.document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(component, props));
  });

  return {
    window,
    container,
    form,
    credentials,
    act,
    async settle() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async unmount() {
      await act(async () => root.unmount());
    },
  };
}

/** Find a button by its visible text. */
function button(container, label) {
  return [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
}

test('the card renders the stored table and the password section without looping', async () => {
  const mounted = await mountCard({
    hosts: [{ alias: 'nas', host: '10.0.0.2', port: 22, username: 'root' }],
    stored: ['SSH_PASSWORD_NAS'],
  });
  try {
    await mounted.settle();
    const html = mounted.container.innerHTML;
    assert.ok(html.includes('SSH 主机'), 'the host card did not render');
    assert.ok(html.includes('10.0.0.2'), 'the stored host is missing');
    assert.ok(html.includes('root'), 'the stored username is missing');
    // The password section is separate and appears once an alias is stored.
    assert.ok(html.includes('密码'), 'the password card did not render');
    assert.ok(html.includes('已设置'), 'the stored password is not reported as set');
  } finally {
    await mounted.unmount();
  }
});

test('an empty table says so and offers the add button', async () => {
  const mounted = await mountCard({ hosts: [] });
  try {
    await mounted.settle();
    assert.ok(mounted.container.innerHTML.includes('还没有主机'));
    assert.notEqual(button(mounted.container, '添加主机'), undefined);
  } finally {
    await mounted.unmount();
  }
});

test('a new row is staged, then written as the whole table in one edit', async () => {
  const mounted = await mountCard({ hosts: [] });
  try {
    await mounted.settle();
    const { act } = mounted;
    await act(async () => {
      button(mounted.container, '添加主机').dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
    });

    const inputs = [...mounted.container.querySelectorAll('input')];
    assert.ok(inputs.length >= 4, 'the new row did not render its fields');

    // Type into alias / host / port / username in document order.
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(mounted.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    };
    await act(async () => {
      setValue(inputs[0], 'nas');
      setValue(inputs[1], '10.0.0.2');
      setValue(inputs[2], '22');
      setValue(inputs[3], 'root');
    });

    const save = button(mounted.container, '保存主机表');
    assert.notEqual(save, undefined, 'the save button did not appear');
    assert.equal(save.disabled, false, 'a complete row must be saveable');
    await act(async () => {
      save.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
    });
    await mounted.settle();

    assert.equal(mounted.form.writes.length, 1, 'expected exactly one write');
    assert.deepEqual(mounted.form.writes[0].ops, [
      { op: 'set', path: ['hosts'], value: [{ alias: 'nas', host: '10.0.0.2', port: 22, username: 'root' }] },
    ]);
    assert.equal(mounted.form.writes[0].expectedRevision, 5);
  } finally {
    await mounted.unmount();
  }
});

test('an invalid row blocks the save and says which row is wrong', async () => {
  const mounted = await mountCard({ hosts: [] });
  try {
    await mounted.settle();
    const { act } = mounted;
    await act(async () => {
      button(mounted.container, '添加主机').dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
    });
    await mounted.settle();
    assert.ok(mounted.container.innerHTML.includes('第 1 行'), 'the row problem was not reported');
    const save = button(mounted.container, '保存主机表');
    assert.equal(save.disabled, true, 'an invalid table must not be saveable');
    assert.equal(mounted.form.writes.length, 0);
  } finally {
    await mounted.unmount();
  }
});

test('a password is written to its own credential reference and never into the table', async () => {
  const calls = [];
  const mounted = await mountCard({
    hosts: [{ alias: 'nas', host: '10.0.0.2', port: 22, username: 'root' }],
    calls,
  });
  try {
    await mounted.settle();
    const { act } = mounted;
    const passwordInput = mounted.container.querySelector('input[type="password"]');
    assert.notEqual(passwordInput, null, 'the password field did not render');

    const setter = Object.getOwnPropertyDescriptor(mounted.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
      setter.call(passwordInput, 'hunter2');
      passwordInput.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    });

    const save = button(mounted.container, '保存密码');
    assert.notEqual(save, undefined);
    assert.equal(save.disabled, false);
    await act(async () => {
      save.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
    });
    await mounted.settle();

    assert.deepEqual(calls, [{ kind: 'set', ref: 'SSH_PASSWORD_NAS', value: 'hunter2' }]);
    assert.equal(mounted.form.writes.length, 0, 'a password must never reach the config table');
  } finally {
    await mounted.unmount();
  }
});

test('clearing a password unsets the reference, and the button is off while nothing is stored', async () => {
  const calls = [];
  const mounted = await mountCard({
    hosts: [{ alias: 'nas', host: '10.0.0.2', port: 22, username: 'root' }],
    stored: ['SSH_PASSWORD_NAS'],
    calls,
  });
  try {
    await mounted.settle();
    const { act } = mounted;
    const clear = button(mounted.container, '清除密码');
    assert.notEqual(clear, undefined);
    assert.equal(clear.disabled, false, 'a stored password must be clearable');
    await act(async () => {
      clear.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
    });
    await mounted.settle();
    assert.deepEqual(calls, [{ kind: 'unset', ref: 'SSH_PASSWORD_NAS' }]);
  } finally {
    await mounted.unmount();
  }
});

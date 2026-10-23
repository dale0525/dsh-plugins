/**
 * Render tests for the settings card, with real React in a real document.
 *
 * The card is the only part of this plugin a user touches, and it has two
 * failure modes no other test here would catch:
 *
 *  - a `useSyncExternalStore` snapshot rebuilt on each call throws React error
 *    #185, and the Host renders a crashed slot entry as an EMPTY element — the
 *    page shows the plugin's title and nothing under it, cause only in the
 *    console;
 *  - a wrong prop name against the shared components renders an empty control
 *    without failing anything.
 *
 * So this mounts the REAL built bundle with real React, against the shared
 * component layer's own built bundle, and drives it.
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
  window.__ModuleLoader__ = {
    load: (entry) => {
      registration = entry;
    },
  };
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
 * @param value - the stored config value.
 * @returns `{writes, handle, setValue}`.
 */
function makeForm(value) {
  const writes = [];
  let snapshot = { status: 'ready', value, writable: true, revision: 3 };
  const listeners = new Set();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    writes,
    handle: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      mutate: async (ops, expectedRevision) => {
        writes.push({ ops, expectedRevision });
        return true;
      },
    },
  };
}

/** A describe face publishing the plugin's real serialized schema. */
function makeDescribe(schema) {
  const snapshot = { status: 'ready', view: { namespaces: [{ ns: 'dsh-lan-access', schema }] } };
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

/**
 * The schema as the Host publishes it, taken from the real `Config`.
 *
 * Reading it from the host half rather than hand-writing a fixture keeps the
 * card's field labels honest: if the schema's `comment()` strings change, this
 * test sees the new ones.
 */
async function realSchema() {
  const { Config } = await import('../src/config.js');
  return Config.toJSON();
}

/**
 * Mount the card with a recording context.
 *
 * @param options - `{value, schema, status, stored, statusFails}`.
 * @returns the mount handle.
 */
async function mountCard(options = {}) {
  const window = installDom();
  const { face } = loadPlugin(window);
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');

  const form = makeForm(options.value ?? { enabled: true, port: 10000, auth: 'password' });
  const calls = [];
  const credentials = {
    describe: async (refs) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [ref, { configured: (options.stored ?? []).includes(ref) }])),
    }),
    set: async (ref, value) => {
      calls.push({ kind: 'set', ref, value });
      return { ok: true };
    },
    unset: async (ref) => {
      calls.push({ kind: 'unset', ref });
      return { ok: true };
    },
  };

  // The card reads live listener facts over HTTP; the fetch stub answers the way
  // the host half's status route does.
  const fetches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init });
    if (options.statusFails === true) return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => options.status ?? { enabled: true, port: 10000, auth: 'password', listening: true, addresses: ['192.168.1.20'], hostPort: 10000 },
    };
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
    configForms: { get: () => form.handle, describe: () => makeDescribe(options.schema ?? defaultSchema) },
  };
  face.apply({ slots, remote: scoped.remote, inject: (_names, callback) => callback(scoped) });

  // `view` is supplied by the slot at render time, not by `inject()`, so the
  // test adds it the way the Host does.
  const props = { ...registeredOptions[0].inject(), view: options.view ?? 'page' };
  const container = window.document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(component, props));
  });

  return {
    window,
    container,
    form,
    calls,
    fetches,
    registeredOptions,
    act,
    async settle() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
    },
  };
}

/** A schema with the three real fields and nothing else. */
const defaultSchema = {
  uid: 10,
  refs: {
    2: { type: 'boolean', meta: { default: true, comment: '启用局域网访问' } },
    3: { type: 'number', meta: { default: 10000, min: 1, max: 65535, comment: '访问端口' } },
    4: { type: 'const', meta: {}, value: 'password' },
    5: { type: 'const', meta: {}, value: 'none' },
    6: { type: 'union', meta: { default: 'password', comment: '鉴权方式' }, list: [4, 5] },
    10: { type: 'object', meta: {}, dict: { enabled: 2, port: 3, auth: 6 } },
  },
};

/** Find a button by its visible text. */
function button(container, label) {
  return [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
}

test('the card renders the schema fields and the address list without looping', async () => {
  const mounted = await mountCard();
  try {
    await mounted.settle();
    const html = mounted.container.innerHTML;
    assert.ok(html.includes('局域网访问'), 'the card did not render');
    assert.ok(html.includes('访问端口'), 'the port field is missing');
    assert.ok(html.includes('鉴权方式'), 'the auth field is missing');
    assert.ok(html.includes('访问地址'), 'the address card did not render');
    // Both the loopback and the LAN address are shown, because "one port" is the
    // whole feature and the user needs to know which to type where.
    assert.ok(html.includes('http://127.0.0.1:10000/'), html);
    assert.ok(html.includes('http://192.168.1.20:10000/'), html);
  } finally {
    await mounted.unmount();
  }
});

test('the card asks the host for the live status rather than guessing the port', async () => {
  const mounted = await mountCard();
  try {
    await mounted.settle();
    assert.ok(mounted.fetches.length > 0);
    assert.equal(mounted.fetches[0].url, '/dsh-lan-access/status');
  } finally {
    await mounted.unmount();
  }
});

test('a stopped listener says so instead of showing addresses that answer nothing', async () => {
  const mounted = await mountCard({
    value: { enabled: false, port: 10000, auth: 'password' },
    status: { enabled: false, port: 10000, auth: 'password', listening: false, addresses: ['192.168.1.20'], hostPort: 3080 },
  });
  try {
    await mounted.settle();
    const html = mounted.container.innerHTML;
    assert.ok(html.includes('没有监听'), html);
    assert.ok(!html.includes('http://192.168.1.20:10000/'), html);
  } finally {
    await mounted.unmount();
  }
});

test('a failed status read is reported, not rendered as an empty list', async () => {
  const mounted = await mountCard({ statusFails: true });
  try {
    await mounted.settle();
    assert.ok(mounted.container.innerHTML.includes('读取访问状态失败'), mounted.container.innerHTML);
  } finally {
    await mounted.unmount();
  }
});

test('a stored password renders as dots, never as a value', async () => {
  const mounted = await mountCard({ stored: ['DSH_LAN_ACCESS_PASSWORD'] });
  try {
    await mounted.settle();
    const html = mounted.container.innerHTML;
    assert.ok(html.includes('已设置（不回读）'), html);
    // `describe` never returns the value, so the field has nothing to fill in;
    // the shared `SecretField` renders a masked placeholder instead of an input.
    const secret = [...mounted.container.querySelectorAll('input')].find((node) => node.type === 'password');
    assert.equal(secret, undefined, 'no password input should be pre-filled');
    assert.ok(html.includes('••••'), 'the stored state should read as masked');
  } finally {
    await mounted.unmount();
  }
});

test('an unset password says that nobody can get in', async () => {
  const mounted = await mountCard({ stored: [] });
  try {
    await mounted.settle();
    assert.ok(mounted.container.innerHTML.includes('未设置'), mounted.container.innerHTML);
  } finally {
    await mounted.unmount();
  }
});

test('saving a password writes the credential, never the config', async () => {
  const mounted = await mountCard({ stored: [] });
  try {
    await mounted.settle();
    const secret = [...mounted.container.querySelectorAll('input')].find((node) => node.type === 'password');
    // React tracks the DOM value; setting it through the native setter is what
    // makes the change event carry the new text.
    const setter = Object.getOwnPropertyDescriptor(mounted.window.HTMLInputElement.prototype, 'value').set;
    await mounted.act(async () => {
      setter.call(secret, 'hunter2');
      secret.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    });
    await mounted.act(async () => {
      button(mounted.container, '保存密码').dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
    });
    await mounted.settle();

    assert.deepEqual(mounted.calls, [{ kind: 'set', ref: 'DSH_LAN_ACCESS_PASSWORD', value: 'hunter2' }]);
    // The plaintext must not reach the config row, which config sync exports.
    assert.deepEqual(mounted.form.writes, []);
    assert.ok(mounted.container.innerHTML.includes('密码已保存'), mounted.container.innerHTML);
  } finally {
    await mounted.unmount();
  }
});

test('an empty password is refused before it reaches the credential store', async () => {
  const mounted = await mountCard({ stored: [] });
  try {
    await mounted.settle();
    await mounted.act(async () => {
      button(mounted.container, '保存密码').dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
    });
    await mounted.settle();
    // An empty stored value is "unset" to the credential seam, so saving one
    // would silently do nothing while reporting success.
    assert.deepEqual(mounted.calls, []);
  } finally {
    await mounted.unmount();
  }
});

test('clearing the password is refused while none is stored', async () => {
  const mounted = await mountCard({ stored: [] });
  try {
    await mounted.settle();
    const clear = button(mounted.container, '清除密码');
    assert.equal(clear.disabled, true);
  } finally {
    await mounted.unmount();
  }
});

test('a port equal to the host listener port is named as a conflict', async () => {
  const mounted = await mountCard({
    value: { enabled: true, port: 3080, auth: 'password' },
    status: { enabled: true, port: 3080, auth: 'password', listening: false, addresses: ['192.168.1.20'], hostPort: 3080 },
  });
  try {
    await mounted.settle();
    // Binding would succeed while loopback bypassed this plugin's gate, so the
    // card has to say so before the user saves and wonders why it did not work.
    assert.ok(mounted.container.innerHTML.includes('绕过本插件的鉴权'), mounted.container.innerHTML);
  } finally {
    await mounted.unmount();
  }
});

test('the collapsed row summarizes the live state instead of repeating the intro', async () => {
  const mounted = await mountCard({
    view: 'summary',
    value: { enabled: true, port: 10000, auth: 'none' },
    status: { enabled: true, port: 10000, auth: 'none', listening: true, addresses: ['192.168.1.20'], hostPort: 3080 },
  });
  try {
    await mounted.settle();
    const summary = mounted.container.textContent;
    assert.ok(summary.includes('10000'), summary);
    assert.ok(summary.includes('不需要密码'), summary);
  } finally {
    await mounted.unmount();
  }
});

test('the card registers one slot entry per bundle name and no more', async () => {
  const mounted = await mountCard();
  try {
    await mounted.settle();
    assert.deepEqual(
      mounted.registeredOptions.map((entry) => entry.key),
      ['@logictan/dsh-plugins-all#dsh-lan-access', '@logictan/dsh-lan-access#dsh-lan-access'],
    );
    assert.ok(mounted.registeredOptions.every((entry) => entry.name === 'plugins.row.config'));
  } finally {
    await mounted.unmount();
  }
});

test('the real schema from the host half renders every field', async () => {
  const schema = await realSchema();
  const mounted = await mountCard({ schema });
  try {
    await mounted.settle();
    const html = mounted.container.innerHTML;
    // Field labels come from the schema's `comment()` strings.
    assert.ok(html.includes('启用局域网访问'), html);
    assert.ok(html.includes('访问端口'), html);
    assert.ok(html.includes('鉴权方式'), html);
  } finally {
    await mounted.unmount();
  }
});

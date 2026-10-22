/**
 * Tests for the browser half's load contract and its wiring.
 *
 * A client bundle that fails to register, or registers under the wrong id, fails
 * silently — the card simply never appears, with nothing in the page to say why.
 * So this executes the real `lib/client.js` under a stubbed module loader and
 * checks what the host would actually see: one registration under the package
 * name, a factory that returns a named face, and a card bound to both bundle
 * keys the Plugins page may use.
 *
 * The bundle is not a module: it is a `window.__ModuleLoader__.load(...)` call,
 * so it is imported for its side effect and the captured spec is inspected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

/** Minimal React stand-in: `apply` registers, it never renders. */
const reactStub = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/** Minimal shared-component stand-in: the card only reads components while rendering. */
const uiStub = new Proxy({}, { get: () => () => null });

/** The `require` the loader hands a client factory. */
function requireStub(id) {
  if (id === 'react') return reactStub;
  if (id === '@logictan/dsh-plugins-shared-client') return uiStub;
  throw new Error(`unexpected require: ${id}`);
}

/** The single `load()` call the bundle makes at import time. */
let registration;
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      assert.equal(registration, undefined, 'the bundle must register exactly once');
      registration = spec;
    },
  },
};
await import(join(root, 'lib', 'client.js'));

test('the bundle registers exactly once, under the package name', () => {
  assert.notEqual(registration, undefined, 'the bundle never called __ModuleLoader__.load');
  assert.equal(registration.id, manifest.name);
});

test('the factory returns a named face that asks for the slots it renders into', () => {
  const face = registration.factory(requireStub);
  // The face name is the plugin's own name (the row id), not the package name:
  // the client runner reports it as the fiber's name.
  assert.equal(face.name, 'dsh-ssh');
  assert.equal(typeof face.apply, 'function');
  // `slots` and `remote` are structural; `configForms` and `remote.credentials`
  // are requested nested, so a deployment without them loses only the card.
  assert.deepEqual(face.inject, ['slots', 'remote']);
});

test('the card is bound to both bundle keys the Plugins page may use', () => {
  const registrations = [];
  const slots = {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { hosts: [] }, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  };
  const scoped = {
    slots,
    remote: { credentials: { describe: async () => ({ ok: true, value: {} }) } },
    configForms: { get: () => form, describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({}) }) },
  };
  const ctx = {
    slots,
    remote: scoped.remote,
    inject: (names, callback) => callback(scoped),
  };

  registration.factory(requireStub).apply(ctx);

  assert.equal(registrations.length, 2, 'one registration per bundle name');
  assert.deepEqual(
    registrations.map((entry) => entry.options.key),
    ['@logictan/dsh-plugins-all#dsh-ssh', '@logictan/dsh-ssh#dsh-ssh'],
  );
  for (const entry of registrations) {
    assert.equal(entry.options.name, 'plugins.row.config');
    assert.equal(typeof entry.component, 'function');
    const props = entry.options.inject();
    assert.equal(props.scope, form);
    assert.notEqual(props.describe, undefined);
    assert.equal(props.ctx, scoped);
  }
});

test('a deployment without the settings services registers nothing instead of throwing', () => {
  const ctx = {
    slots: { inject: () => {}, register: () => () => {} },
    remote: {},
    // The real runtime skips the callback entirely when a dependency is absent.
    inject: () => {},
  };
  assert.doesNotThrow(() => registration.factory(requireStub).apply(ctx));
});

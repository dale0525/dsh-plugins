/**
 * Render-level tests for the two escape hatches `ConfigForm` exposes.
 *
 * A schema describes a plugin's own scalars. It cannot describe the parts of a
 * settings card that are driven by something else: a credential owned by the
 * credentials service, a model list fetched from a plugin's own HTTP route, a
 * structured editor for a list of channel objects. Those three are real (they
 * are `dsh-browser-agent`'s TypeSafe key and route pickers, `dsh-desktop-agent`'s
 * vision-model picker, and `dsh-imagegen`'s channel editor), and without a way
 * to place them the migration would have deleted them.
 *
 * So `ConfigForm` takes `children` (appended inside the card, after the fields)
 * and `renderControl` (replaces one field's control, keeping the schema's label).
 * Both are load-bearing: a regression that drops either one silently deletes a
 * section from a shipped settings page, with every existing test still green.
 *
 * This mounts the REAL built bundle with real React in a real document. The
 * bundle is not an ES module — it registers a factory through the loader
 * protocol — so it is evaluated with a `__ModuleLoader__` shim rather than
 * imported. jsdom and react-dom are devDependencies of this package for exactly
 * this test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const { JSDOM } = require('jsdom')

/** Install a document, because React DOM needs one and useSyncExternalStore needs a client. */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  })
  const { window } = dom
  const keys = [
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
  ]
  for (const key of keys) {
    // `navigator` is getter-only on current Node, so plain assignment throws.
    Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return window
}

/** Evaluate the built browser half and return its exports. */
function loadSharedClient(window) {
  let registration
  window.__ModuleLoader__ = { load: (entry) => { registration = entry } }
  const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  new Function('window', 'document', code)(window, window.document)
  assert.ok(registration !== undefined, 'the built client half registered nothing')
  return registration.factory((specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
}

/** A form whose snapshot the test controls, shaped like the Host's. */
function makeForm(value) {
  const writes = []
  const snapshot = { status: 'ready', value, writable: true, revision: 3 }
  return {
    writes,
    handle: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate: async (ops, expectedRevision) => {
        writes.push({ ops, expectedRevision })
        return true
      },
    },
  }
}

/**
 * A describe face over one schema.
 *
 * The snapshot is a module-level constant rather than a fresh object per call:
 * the Host's face returns a stable reference until the document changes, and a
 * fresh object is what makes `useSyncExternalStore` loop forever.
 */
function makeDescribe(namespace, schema) {
  const snapshot = { status: 'ready', view: { namespaces: [{ ns: namespace, schema }] } }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

const SCHEMA = {
  uid: 10,
  refs: {
    2: { type: 'boolean', meta: { default: true, comment: '启用' } },
    3: { type: 'string', meta: { default: '', comment: '访问地址' } },
    4: { type: 'string', meta: { default: '', comment: '内部标识', hidden: true } },
    10: { type: 'object', meta: { default: {} }, dict: { enabled: 2, endpoint: 3, internal: 4 } },
  },
}

test('children are appended inside the card, after the schema fields', async () => {
  const window = installDom()
  const ui = loadSharedClient(window)
  const React = require('react')
  const { act } = require('react')
  const { createRoot } = require('react-dom/client')
  const form = makeForm({ enabled: true, endpoint: '' })
  const describe = makeDescribe('probe', SCHEMA)

  const container = window.document.getElementById('root')
  const root = createRoot(container)
  await act(async () => {
    root.render(
      React.createElement(
        ui.ConfigForm,
        { namespace: 'probe', form: form.handle, describe },
        React.createElement('div', { id: 'extra' }, '凭据与认证'),
      ),
    )
  })

  const html = container.innerHTML
  assert.ok(html.includes('启用'), 'schema field missing')
  const extra = container.querySelector('#extra')
  assert.ok(extra !== null, 'children were dropped')
  assert.ok(extra.textContent.includes('凭据与认证'))

  // Order matters: the design puts schema fields first, extras below them.
  const fields = container.querySelector('.dsp-card-body')
  assert.ok(fields !== null, 'the card body is missing')
  const order = [...fields.children].map((node) => node.id || '')
  assert.equal(order[order.length - 1], 'extra', `children rendered in the wrong place: ${order.join(',')}`)

  await act(async () => { root.unmount() })
})

test('renderControl replaces one field control and keeps the schema label', async () => {
  const window = installDom()
  const ui = loadSharedClient(window)
  const React = require('react')
  const { act } = require('react')
  const { createRoot } = require('react-dom/client')
  const form = makeForm({ enabled: true, endpoint: '' })
  const describe = makeDescribe('probe', SCHEMA)

  const seen = []
  const container = window.document.getElementById('root')
  const root = createRoot(container)
  await act(async () => {
    root.render(
      React.createElement(ui.ConfigForm, {
        namespace: 'probe',
        form: form.handle,
        describe,
        renderControl: (field) => {
          seen.push(field.key)
          if (field.key !== 'endpoint') return undefined
          return React.createElement('button', { id: 'picker', type: 'button' }, '选择模型')
        },
      }),
    )
  })

  const picker = container.querySelector('#picker')
  assert.ok(picker !== null, 'the overridden control was not rendered')
  assert.ok(picker.textContent.includes('选择模型'))

  // The default text input for that field must be gone, not merely shadowed.
  const inputs = [...container.querySelectorAll('input.dsp-input')]
  assert.equal(inputs.length, 0, `the default control was still rendered: ${inputs.length}`)

  // The label still comes from the schema, so an override never loses its row.
  assert.ok(container.innerHTML.includes('访问地址'), 'the overridden field lost its schema label')

  // Every field is offered to the hook, so an override can decide per field.
  assert.deepEqual(seen, ['enabled', 'endpoint'])

  await act(async () => { root.unmount() })
})

test('a field marked hidden in the schema is not rendered', async () => {
  const window = installDom()
  const ui = loadSharedClient(window)
  const React = require('react')
  const { act } = require('react')
  const { createRoot } = require('react-dom/client')
  const form = makeForm({ enabled: true, endpoint: '', internal: 'x' })
  const describe = makeDescribe('probe', SCHEMA)

  const container = window.document.getElementById('root')
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ui.ConfigForm, { namespace: 'probe', form: form.handle, describe }))
  })

  const html = container.innerHTML
  assert.ok(html.includes('启用'), 'the visible field is missing')
  assert.ok(!html.includes('内部标识'), 'a hidden field was rendered')
  assert.ok(!html.includes('internal'), 'a hidden field was rendered by its key')

  await act(async () => { root.unmount() })
})

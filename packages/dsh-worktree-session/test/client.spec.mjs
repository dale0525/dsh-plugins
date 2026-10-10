/**
 * Tests for the browser half's load contract.
 *
 * A client bundle that fails to register, or registers under the wrong id,
 * fails silently: the plugin simply never appears. These tests execute the real
 * `lib/client.js` under a stubbed module loader and check the registration the
 * host would actually see.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'lib', 'client.js')
const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))

/** Minimal React stand-in: `apply` only registers, it never renders. */
const reactStub = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

/** Minimal primitives stand-in carrying the exports the bundle reads. */
const primitivesStub = new Proxy({}, { get: () => () => null })

// Swappable, so a test that really renders can install a hook runtime. The
// bundle reads these once per factory call, so a swap takes effect on the next
// `factory(requireStub)`.
let reactImpl = reactStub
let primitivesImpl = primitivesStub

/** The `require` the loader hands a client factory. */
function requireStub(id) {
  if (id === 'react') return reactImpl
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesImpl
  throw new Error(`unexpected require: ${id}`)
}

/** Capture the single `load()` call the bundle makes at import time. */
let registration
before(async () => {
  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => {
        assert.equal(registration, undefined, 'the bundle must register exactly once')
        registration = spec
      },
    },
  }
  await import(bundle)
})

describe('client bundle load contract', () => {
  it('registers exactly once, under the package name', () => {
    assert.notEqual(registration, undefined, 'the bundle never called __ModuleLoader__.load')
    assert.equal(registration.id, manifest.name)
  })

  it('declares a factory that returns a named face', () => {
    const face = registration.factory(requireStub)

    assert.equal(face.name, manifest.name)
    assert.equal(typeof face.apply, 'function')
    assert.deepEqual(face.inject, ['slots', 'locale'])
  })
})

/**
 * Apply the bundle against a recording context.
 *
 * Shared by the wiring suite and the row-marker suite: both need the effects
 * the plugin registers, and the marker effect is registered through a nested
 * `inject`, so the callback has to hand it back a context with `effect` on it.
 */
function applyWith(services) {
  const registrations = []
  const injected = []
  const effects = []

  const slots = {
    inject: (name, callback) => {
      injected.push(name)
      callback()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  }

  const ctx = {
    slots,
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (callback) => effects.push(callback),
    inject: (names, callback) => callback({ slots, locale: ctx.locale, effect: ctx.effect, ...services }),
    ...services,
  }

  registration.factory(requireStub).apply(ctx)
  return { registrations, injected, effects }
}

describe('client apply wiring', () => {
  it('registers the composer picker', () => {
    const { registrations, injected } = applyWith({})

    assert.deepEqual(injected, ['conversation.input.left'])
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'conversation.input.left')
    assert.equal(registrations[0].options.id, 'worktree-entry')
  })

  it('declares its locale namespace on every entry, so the framework injects t', () => {
    const { registrations } = applyWith({})

    for (const entry of registrations) assert.equal(entry.options.locale, 'worktreeSession')
  })

  it('injects the workspace services into the composer picker', () => {
    const workspaces = { create: () => {} }
    const uiWorkspace = { connectWorkspace: () => {} }
    const { registrations } = applyWith({ workspaces, uiWorkspace })

    const picker = registrations.find((entry) => entry.options.name === 'conversation.input.left')

    const share = picker.options.inject()
    assert.equal(share.workspaces, workspaces)
    assert.equal(share.uiWorkspace, uiWorkspace)
  })

  it('registers its dictionaries and its row markers through effects', () => {
    const { effects } = applyWith({})

    // The marker effect needs a DOM; driving it is the row-marker suite's job.
    assert.equal(effects.length, 2)
    assert.equal(typeof effects[0](), 'function')
  })
})

describe('workspace row markers', () => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const originalObserver = globalThis.MutationObserver

  after(() => {
    globalThis.fetch = originalFetch
    globalThis.document = originalDocument
    globalThis.MutationObserver = originalObserver
  })

  /**
   * A DOM just large enough for the marker pass: workspace rows, one `<style>`
   * registry, and a MutationObserver that records what it was asked to watch.
   */
  function makeDom() {
    const rows = []
    const styles = []
    const observers = []

    const document = {
      querySelectorAll: (selector) =>
        selector === '[data-row-key^="workspace:"]'
          ? rows.filter((row) => String(row.getAttribute('data-row-key')).startsWith('workspace:'))
          : [],
      querySelector: (selector) => {
        const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
        if (match === null) return null
        return styles.find((style) => style.dataset.pluginCss === match[1]) || null
      },
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: (tag) => styles.push(tag) },
      body: {},
    }

    class MutationObserver {
      constructor(callback) {
        this.callback = callback
        observers.push(this)
      }
      observe(target, options) {
        this.target = target
        this.options = options
      }
      disconnect() {
        this.disconnected = true
      }
    }

    return {
      document,
      MutationObserver,
      styles,
      observers,
      addRow: (workspaceId) => {
        const attrs = { 'data-row-key': `workspace:${workspaceId}` }
        const row = {
          getAttribute: (name) => (name in attrs ? attrs[name] : null),
          setAttribute: (name, value) => {
            attrs[name] = value
          },
          removeAttribute: (name) => {
            delete attrs[name]
          },
        }
        rows.push(row)
        return row
      },
    }
  }

  /** A status read answering "is this directory a linked worktree". */
  function statusFetch(worktreePaths) {
    return (url) => {
      const cwd = decodeURIComponent(String(url).split('cwd=')[1])
      const worktrees = [{ path: '/repo', isMain: true, name: 'repo' }]
      if (worktreePaths.includes(cwd)) worktrees.push({ path: cwd, isMain: false, name: cwd.split('/').pop() })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ isRepo: true, repoRoot: '/repo', worktrees }),
      })
    }
  }

  /** Let the queued status promises run. */
  async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  const listOf = (items) => ({ list: { getSnapshot: () => ({ phase: 'ready', items }) } })

  /** Run the row-marker effect against one workspace list and DOM. */
  async function mountRows(workspaces, dom) {
    globalThis.document = dom.document
    globalThis.MutationObserver = dom.MutationObserver
    const { effects } = applyWith({ workspaces })
    const cleanup = effects[1]()
    await settle()
    return cleanup
  }

  it('marks a worktree row and leaves the main checkout alone', async () => {
    globalThis.fetch = statusFetch(['/repo/.worktrees/wt-abc123'])
    const dom = makeDom()
    const mainRow = dom.addRow('w-main')
    const worktreeRow = dom.addRow('w-wt')

    await mountRows(
      listOf([
        { workspaceId: 'w-main', path: '/repo' },
        { workspaceId: 'w-wt', path: '/repo/.worktrees/wt-abc123' },
      ]),
      dom,
    )

    assert.equal(worktreeRow.getAttribute('data-dsh-worktree'), 'branch')
    assert.equal(mainRow.getAttribute('data-dsh-worktree'), null)
  })

  it('drops the marker when the directory is no longer a worktree', async () => {
    globalThis.fetch = statusFetch([])
    const dom = makeDom()
    const row = dom.addRow('w-wt')
    row.setAttribute('data-dsh-worktree', 'branch')

    await mountRows(listOf([{ workspaceId: 'w-wt', path: '/repo/.worktrees/wt-abc123' }]), dom)

    assert.equal(row.getAttribute('data-dsh-worktree'), null)
  })

  it('injects its stylesheet once and re-stamps rows the sidebar re-creates', async () => {
    globalThis.fetch = statusFetch(['/repo/.worktrees/wt-abc123'])
    const dom = makeDom()
    const workspaces = listOf([{ workspaceId: 'w-wt', path: '/repo/.worktrees/wt-abc123' }])

    await mountRows(workspaces, dom)
    // A second activation must not append a second copy of the stylesheet.
    await mountRows(workspaces, dom)

    assert.equal(dom.styles.length, 1)
    assert.ok(dom.styles[0].textContent.includes('[data-dsh-worktree]'))

    // React re-creates a row as groups expand; the observer re-stamps it.
    const later = dom.addRow('w-wt')
    await dom.observers[dom.observers.length - 1].callback()
    await settle()
    assert.equal(later.getAttribute('data-dsh-worktree'), 'branch')
  })

  it('disconnects its observer when the effect is disposed', async () => {
    globalThis.fetch = statusFetch([])
    const dom = makeDom()

    const cleanup = await mountRows(listOf([]), dom)
    cleanup()

    assert.equal(dom.observers[0].disconnected, true)
    assert.deepEqual(dom.observers[0].options, { childList: true, subtree: true })
  })
})


describe('composer picker status handling', () => {
  /**
   * Enough of React to run the real component: ordered hooks, effect deps, and
   * a re-render when a setter fires. `createElement` only records, so the
   * returned tree is inspected rather than mounted.
   */
  function makeReact() {
    let hooks = []
    let cursor = 0
    let rendering = false
    let pending = false
    let onRender = () => {}

    const api = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useRef: (initial) => {
        const i = cursor++
        if (!(i in hooks)) hooks[i] = { current: initial }
        return hooks[i]
      },
      useState: (initial) => {
        const i = cursor++
        if (!(i in hooks)) hooks[i] = initial
        return [
          hooks[i],
          (value) => {
            hooks[i] = typeof value === 'function' ? value(hooks[i]) : value
            if (rendering) pending = true
            else onRender()
          },
        ]
      },
      useEffect: (fn, deps) => {
        const i = cursor++
        const previous = hooks[i]
        const changed =
          previous === undefined || !deps || !previous.deps || deps.some((dep, k) => !Object.is(dep, previous.deps[k]))
        hooks[i] = { deps, cleanup: previous && previous.cleanup, run: changed ? fn : undefined }
      },
    }

    /** Render once, running any effects that became due. */
    const render = (Component, props) => {
      rendering = true
      cursor = 0
      const tree = Component(props)
      for (const hook of hooks) {
        if (hook && hook.run) {
          if (hook.cleanup) hook.cleanup()
          hook.cleanup = hook.run() || undefined
          hook.run = undefined
        }
      }
      rendering = false
      if (pending) {
        pending = false
        return render(Component, props)
      }
      return tree
    }

    return { api, render, setOnRender: (fn) => (onRender = fn), reset: () => (hooks = []) }
  }

  /** The picker component, captured from the bundle's own registration. */
  function pickerComponent(react) {
    let component
    const slots = {
      inject: (name, callback) => callback(),
      register: (options, registered) => {
        if (options.name === 'conversation.input.left') component = registered
        return () => {}
      },
    }
    const ctx = {
      slots,
      locale: { register: () => () => {}, bind: () => (key) => key },
      effect: () => {},
      inject: (names, callback) => callback({ slots, locale: ctx.locale, effect: ctx.effect }),
    }
    reactImpl = react.api
    primitivesImpl = new Proxy(
      {
        Menu: function Menu() {},
        Button: function Button() {},
        IconBranchOutlineRegular: function IconBranchOutlineRegular() {},
        IconPlusOutlineRegular: function IconPlusOutlineRegular() {},
      },
      { get: (target, key) => (key in target ? target[key] : () => null) },
    )
    registration.factory(requireStub).apply(ctx)
    return component
  }

  /** Props standing in for the framework's own injections. */
  function pickerProps(cwd) {
    return {
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      sessionId: 'session-1',
      useSessions: (selector) => selector({ byId: { 'session-1': { cwd } } }),
      useWorkspaces: (selector) => selector({ items: [] }),
      useInput: (selector) => selector({ draft: '', attachmentIds: [] }),
      inputActions: { setDraft: () => {} },
      workspaces: { create: () => Promise.resolve({ workspaceId: 'w1' }) },
      uiWorkspace: { connectWorkspace: () => Promise.resolve() },
    }
  }

  /** Let queued promise callbacks run. */
  async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  /** Drive one mount: render, let promises settle, re-render. */
  async function mount(cwd) {
    const react = makeReact()
    const Component = pickerComponent(react)
    const props = pickerProps(cwd)
    let tree = react.render(Component, props)
    react.setOnRender(() => {
      tree = react.render(Component, props)
    })
    await settle()
    return { tree: () => tree }
  }

  /** The label the picker's trigger currently shows. */
  function labelOf(mounted) {
    return mounted.tree().props.anchor.children[0]
  }

  const originalFetch = globalThis.fetch
  after(() => {
    globalThis.fetch = originalFetch
  })

  it('reports a failure instead of loading forever when the read fails', async () => {
    globalThis.fetch = () => Promise.reject(new Error('404'))

    const mounted = await mount('/repo-failing')

    // The regression: swallowing the error into `null` left this at the loading
    // label with no sign that anything had gone wrong.
    assert.equal(labelOf(mounted), 'entry.failed')
  })

  it('keeps the control live on failure, so it can be retried', async () => {
    globalThis.fetch = () => Promise.reject(new Error('404'))

    const mounted = await mount('/repo-retry')

    assert.equal(mounted.tree().props.anchor.props.disabled, false)
    assert.equal(mounted.tree().props.anchor.props.title, 'menu.unavailable')
  })

  it('asks before creating a worktree when the composer holds a draft', async () => {
    // The asymmetry this pins: switching to an existing worktree asked for
    // confirmation, while "create" wiped the same draft silently.
    const calls = []
    globalThis.fetch = (url, options) => {
      calls.push({ url, options })
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            isRepo: true,
            repoRoot: '/repo-draft',
            worktrees: [{ path: '/repo-draft', name: 'repo-draft', isMain: true, prunable: false }],
          }),
      })
    }

    const react = makeReact()
    const Component = pickerComponent(react)
    const props = pickerProps('/repo-draft')
    props.useInput = (selector) => selector({ draft: 'half-written prompt', attachmentIds: [] })
    let tree = react.render(Component, props)
    react.setOnRender(() => {
      tree = react.render(Component, props)
    })
    await settle()

    // First activation is a confirmation request, not a creation.
    tree.props.onSelect('__new__')
    await settle()

    assert.equal(calls.filter((c) => c.url === '/api/dsh-worktree/create').length, 0, 'create must not run yet')
    assert.equal(tree.props.items[0].text, 'menu.draft')

    // The second activation goes through.
    tree.props.onSelect('__new__')
    await settle()

    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, '/api/dsh-worktree/create')
  })

  it('shows the main checkout when the read succeeds', async () => {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            isRepo: true,
            repoRoot: '/repo-ok',
            worktrees: [{ path: '/repo-ok', name: 'repo-ok', isMain: true, prunable: false }],
          }),
      })

    const mounted = await mount('/repo-ok')

    assert.equal(labelOf(mounted), 'entry.main')
  })

  it('lands on the new worktree after creating it, without a manual switch', async () => {
    // The regression: `connectWorkspace` only connects, so the user was left
    // in the blank composer they started in and had to find the new workspace
    // in the sidebar and start a second conversation there.
    const opened = []
    globalThis.fetch = (url) =>
      Promise.resolve({
        ok: true,
        json: () =>
          url === '/api/dsh-worktree/create'
            ? Promise.resolve({ path: '/repo-nav/.worktrees/wt-abc123' })
            : Promise.resolve({
                isRepo: true,
                repoRoot: '/repo-nav',
                worktrees: [{ path: '/repo-nav', name: 'repo-nav', isMain: true, prunable: false }],
              }),
      })

    const react = makeReact()
    const Component = pickerComponent(react)
    const props = pickerProps('/repo-nav')
    props.workspaces = { create: () => Promise.resolve({ workspaceId: 'w-new' }) }
    props.uiWorkspace = {
      connectWorkspace: () => {
        throw new Error('create must navigate, not merely connect')
      },
      openWorkspace: (workspaceId) => {
        opened.push(workspaceId)
        return Promise.resolve()
      },
    }
    let tree = react.render(Component, props)
    react.setOnRender(() => {
      tree = react.render(Component, props)
    })
    await settle()

    tree.props.onSelect('__new__')
    await settle()

    assert.deepEqual(opened, ['w-new'])
  })
})

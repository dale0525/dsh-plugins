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

describe('client apply wiring', () => {
  /** Apply the bundle against a recording context. */
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
      inject: (names, callback) => callback({ slots, locale: ctx.locale, ...services }),
      ...services,
    }

    registration.factory(requireStub).apply(ctx)
    return { registrations, injected, effects }
  }

  it('registers the composer picker and the sidebar badge', () => {
    const { registrations, injected } = applyWith({})

    assert.deepEqual(injected, ['conversation.input.left', 'sidebar.session.row.leading'])
    assert.equal(registrations.length, 2)

    const bySlot = {}
    for (const entry of registrations) bySlot[entry.options.name] = entry
    assert.equal(bySlot['conversation.input.left'].options.id, 'worktree-entry')
    assert.equal(bySlot['sidebar.session.row.leading'].options.id, 'worktree-badge')
  })

  it('declares its locale namespace on every entry, so the framework injects t', () => {
    const { registrations } = applyWith({})

    for (const entry of registrations) assert.equal(entry.options.locale, 'worktreeSession')
  })

  it('injects the workspace services into the composer picker only', () => {
    const workspaces = { create: () => {} }
    const uiWorkspace = { connectWorkspace: () => {} }
    const { registrations } = applyWith({ workspaces, uiWorkspace })

    const picker = registrations.find((entry) => entry.options.name === 'conversation.input.left')
    const badge = registrations.find((entry) => entry.options.name === 'sidebar.session.row.leading')

    const share = picker.options.inject()
    assert.equal(share.workspaces, workspaces)
    assert.equal(share.uiWorkspace, uiWorkspace)
    // The badge only reads the Session list, so it carries no share.
    assert.equal(badge.options.inject, undefined)
  })

  it('registers its dictionaries through an effect', () => {
    const { effects } = applyWith({})

    assert.equal(effects.length, 1)
    assert.equal(typeof effects[0](), 'function')
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
      inject: (names, callback) => callback({ slots, locale: ctx.locale }),
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
})

describe('sidebar badge', () => {
  /** Install a hook runtime and capture the badge component in one go. */
  function loadBadge() {
    const hooks = []
    let cursor = 0
    // Set before `apply`: the factory captures these modules when it runs.
    reactImpl = {
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
          },
        ]
      },
      useEffect: (fn) => {
        cursor += 1
        fn()
      },
    }
    primitivesImpl = new Proxy(
      { IconBranchOutlineRegular: function IconBranchOutlineRegular() {} },
      { get: (t, k) => (k in t ? t[k] : () => null) },
    )

    let component
    const slots = {
      inject: (name, callback) => callback(),
      register: (options, registered) => {
        if (options.name === 'sidebar.session.row.leading') component = registered
        return () => {}
      },
    }
    const ctx = {
      slots,
      locale: { register: () => () => {}, bind: () => (key) => key },
      effect: () => {},
      inject: (names, callback) => callback({ slots, locale: ctx.locale }),
    }
    registration.factory(requireStub).apply(ctx)

    return async (cwd, response, { reject = false } = {}) => {
      globalThis.fetch = () =>
        reject ? Promise.reject(new Error('404')) : Promise.resolve({ ok: true, json: () => Promise.resolve(response) })

      const props = {
        t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
        sessionId: 'session-1',
        useSessions: (selector) => selector({ byId: { 'session-1': { cwd } } }),
      }
      cursor = 0
      component(props)
      for (let i = 0; i < 8; i += 1) await Promise.resolve()
      cursor = 0
      return component(props)
    }
  }

  /** The status payload for a repository whose worktrees are as given. */
  function statusOf(worktrees) {
    return { isRepo: true, repoRoot: worktrees[0].path, worktrees }
  }

  it('marks a Session working in a linked worktree', async () => {
    const render = loadBadge()

    const tree = await render(
      '/repo/.worktrees/wt-abc123',
      statusOf([
        { path: '/repo', name: 'repo', isMain: true, prunable: false },
        { path: '/repo/.worktrees/wt-abc123', name: 'wt-abc123', isMain: false, prunable: false },
      ]),
    )

    assert.notEqual(tree, null)
    assert.equal(tree.props['aria-label'], 'badge.title:{"name":"wt-abc123"}')
  })

  it('stays silent on the main checkout', async () => {
    const render = loadBadge()

    const tree = await render('/repo', statusOf([{ path: '/repo', name: 'repo', isMain: true, prunable: false }]))

    assert.equal(tree, null)
  })

  it('stays silent when the status read fails, rather than guessing', async () => {
    const render = loadBadge()

    const tree = await render('/repo/.worktrees/wt-abc123', undefined, { reject: true })

    assert.equal(tree, null)
  })
})

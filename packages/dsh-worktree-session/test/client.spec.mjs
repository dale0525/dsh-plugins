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
   * A DOM just large enough for the marker pass: workspace rows, session rows,
   * one `<style>` registry, and a MutationObserver that records what it was
   * asked to watch.
   */
  function makeDom() {
    const rows = []
    const sessionRows = []
    const styles = []
    const observers = []

    /** One row, with the attributes and title box a real row exposes. */
    function makeRow(key) {
      const attrs = { 'data-row-key': key }
      // The row's title, where the worktree count is stamped. A real row
      // always has one; `null` models the host re-rendering a row mid-pass.
      const title = {
        titleAttrs: {},
        getAttribute: function (name) {
          return name in this.titleAttrs ? this.titleAttrs[name] : null
        },
        setAttribute: function (name, value) {
          this.titleAttrs[name] = value
        },
        removeAttribute: function (name) {
          delete this.titleAttrs[name]
        },
      }
      return {
        title,
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        setAttribute: (name, value) => {
          attrs[name] = value
        },
        removeAttribute: (name) => {
          delete attrs[name]
        },
        querySelector: (selector) => (selector === '[class*="_title"]' ? title : null),
      }
    }

    const document = {
      querySelectorAll: (selector) => {
        if (selector === '[data-row-key^="workspace:"]') {
          return rows.filter((row) => String(row.getAttribute('data-row-key')).startsWith('workspace:'))
        }
        if (selector === '[data-row-key^="session:"]') {
          return sessionRows.filter((row) => String(row.getAttribute('data-row-key')).startsWith('session:'))
        }
        return []
      },
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
        const row = makeRow(`workspace:${workspaceId}`)
        rows.push(row)
        return row
      },
      addSessionRow: (sessionId) => {
        const row = makeRow(`session:${sessionId}`)
        sessionRows.push(row)
        return row
      },
    }
  }

  /** A status read answering "is this directory a linked worktree". */
  function statusFetch(worktreePaths) {
    return (url) => {
      const cwd = decodeURIComponent(String(url).split('cwd=')[1].split('&')[0])
      const worktrees = [{ path: '/repo', isMain: true, name: 'repo' }]
      if (worktreePaths.includes(cwd)) worktrees.push({ path: cwd, isMain: false, name: cwd.split('/').pop() })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ isRepo: true, repoRoot: '/repo', worktrees, deferred: true }),
      })
    }
  }

  /** Let the queued status promises run. */
  async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  const listOf = (items) => ({ list: { getSnapshot: () => ({ phase: 'ready', items }), subscribe: () => () => {} } })

  /** A Session list snapshot carrying one row's projections. */
  function sessionsOf(byId) {
    return { list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }), subscribe: () => () => {} } }
  }

  /** Run the row-marker effect against one workspace list, one Session list and DOM. */
  async function mountRows(workspaces, dom, sessions = sessionsOf({})) {
    globalThis.document = dom.document
    globalThis.MutationObserver = dom.MutationObserver
    const { effects } = applyWith({ workspaces, sessions })
    const cleanup = effects[1]()
    await settle()
    return cleanup
  }

  it('marks a worktree row and leaves the main checkout alone', async () => {
    globalThis.fetch = statusFetch(['/repo/.worktrees/fix-the-parser'])
    const dom = makeDom()
    const mainRow = dom.addRow('w-main')
    const worktreeRow = dom.addRow('w-wt')

    await mountRows(
      listOf([
        { workspaceId: 'w-main', path: '/repo' },
        { workspaceId: 'w-wt', path: '/repo/.worktrees/fix-the-parser' },
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

    await mountRows(listOf([{ workspaceId: 'w-wt', path: '/repo/.worktrees/fix-the-parser' }]), dom)

    assert.equal(row.getAttribute('data-dsh-worktree'), null)
  })

  it('injects its stylesheet once and re-stamps rows the sidebar re-creates', async () => {
    globalThis.fetch = statusFetch(['/repo/.worktrees/fix-the-parser'])
    const dom = makeDom()
    const workspaces = listOf([{ workspaceId: 'w-wt', path: '/repo/.worktrees/fix-the-parser' }])

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

  it('rewrites an already-injected stylesheet instead of keeping the old build', async () => {
    // The client HMR swaps this plugin's fiber without reloading the page. An
    // "inject once" guard left the previous build's CSS in the document, so a
    // stylesheet change stayed invisible until a manual refresh — measured with
    // the worktree count rule, which never appeared.
    globalThis.fetch = statusFetch([])
    const dom = makeDom()
    const stale = { dataset: { pluginCss: 'worktree-session/rows.css' }, textContent: 'old build' }
    dom.styles.push(stale)

    await mountRows(listOf([]), dom)

    assert.equal(dom.styles.length, 1, 'the stale tag must be reused, not duplicated')
    assert.notEqual(stale.textContent, 'old build')
    assert.ok(stale.textContent.includes('[data-dsh-worktree-count]'))
  })

  it('gives a session row a glyph naming the checkout it runs in', async () => {
    globalThis.fetch = statusFetch([])
    const dom = makeDom()

    await mountRows(listOf([{ workspaceId: 'w-main', path: '/repo' }]), dom)
    const css = dom.styles[0].textContent

    // The glyph hangs off the leading cell instead of filling it: that cell is
    // the sidebar's indent reference, so replacing its contents would flatten a
    // session against its workspace row (the host's own status dot already
    // takes it over while a session runs).
    assert.match(css, /\[data-row-key\^="session:"\]>span:first-child\{position:relative\}/)
    assert.match(css, /\[data-row-key\^="session:"\]>span:first-child::after\{content:""/)
    assert.match(css, /left:100%/, 'the glyph must sit beside the leading cell, not inside it')
    // The title has to reserve the glyph's width, or the two would overlap.
    assert.match(css, /\[data-row-key\^="session:"\]>span:nth-child\(2\)\{margin-left:20px\}/)
    // A Session running in a worktree takes the branch glyph and the blue tint;
    // a plain one keeps the document glyph in slate.
    assert.match(
      css,
      /\[data-row-key\^="session:"\]\[data-dsh-worktree-session\]>span:first-child::after\{background-color:#60a5fa/,
    )
    // Read the base rule by its exact selector rather than by substring: the
    // worktree override *contains* this selector, so an unanchored pattern
    // matches the blue rule and the assertion can never fail.
    const base = css
      .split('}')
      .map((chunk) => chunk.split('{'))
      .find(([selector]) => selector === '[data-row-key^="session:"]>span:first-child::after')
    assert.ok(base, 'the session glyph needs a base rule')
    assert.match(base[1], /background-color:#94a3b8/, 'a plain session stays slate')
    assert.equal(/#60a5fa/.test(base[1]), false, 'only a worktree session may tint the glyph blue')
  })

  it('marks a session row whose working directory moved into a worktree', async () => {
    // This is the whole point of the icon: the Session keeps the `cwd` it was
    // created in — which is what keeps it in its Workspace group — while
    // `workingDirectory` follows the checkout its tools actually run in. The
    // two disagreeing is the definition of "this conversation works in a
    // worktree", and it arrives with the list, so no request is needed.
    globalThis.fetch = statusFetch([])
    const dom = makeDom()
    const inWorktree = dom.addSessionRow('session-wt')
    const plain = dom.addSessionRow('session-plain')

    await mountRows(
      listOf([]),
      dom,
      sessionsOf({
        'session-wt': { cwd: '/repo', projectionValues: { workingDirectory: '/repo/.worktrees/fix-the-parser' } },
        'session-plain': { cwd: '/repo', projectionValues: { workingDirectory: '/repo' } },
      }),
    )

    assert.equal(inWorktree.getAttribute('data-dsh-worktree-session'), 'branch')
    assert.equal(plain.getAttribute('data-dsh-worktree-session'), null)
  })

  it('leaves a session with no recorded working directory unmarked', async () => {
    // Cold rows have no projection until they are opened, and a missing value
    // is not evidence of a worktree.
    globalThis.fetch = statusFetch([])
    const dom = makeDom()
    const cold = dom.addSessionRow('session-cold')

    await mountRows(listOf([]), dom, sessionsOf({ 'session-cold': { cwd: '/repo' } }))

    assert.equal(cold.getAttribute('data-dsh-worktree-session'), null)
  })

  it('drops the session marker when the projection catches up', async () => {
    globalThis.fetch = statusFetch([])
    const dom = makeDom()
    const row = dom.addSessionRow('session-wt')
    row.setAttribute('data-dsh-worktree-session', 'branch')

    await mountRows(
      listOf([]),
      dom,
      sessionsOf({ 'session-wt': { cwd: '/repo', projectionValues: { workingDirectory: '/repo' } } }),
    )

    assert.equal(row.getAttribute('data-dsh-worktree-session'), null)
  })

  it('disconnects its observer when the effect is disposed', async () => {
    globalThis.fetch = statusFetch([])
    const dom = makeDom()

    const cleanup = await mountRows(listOf([]), dom)
    cleanup()

    assert.equal(dom.observers[0].disconnected, true)
    assert.deepEqual(dom.observers[0].options, { childList: true, subtree: true })
  })

  it('counts the repository worktrees on the plain workspace row', async () => {
    // Three linked worktrees plus a prunable leftover: the prunable one is not
    // counted, matching the picker's menu, which also filters it out.
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            isRepo: true,
            repoRoot: '/repo',
            worktrees: [
              { path: '/repo', isMain: true, name: 'repo' },
              { path: '/repo/.worktrees/wt-a', isMain: false, name: 'wt-a' },
              { path: '/repo/.worktrees/wt-b', isMain: false, name: 'wt-b' },
              { path: '/repo/.worktrees/wt-c', isMain: false, name: 'wt-c' },
              { path: '/repo/.worktrees/wt-gone', isMain: false, prunable: true, name: 'wt-gone' },
            ],
          }),
      })
    const dom = makeDom()
    const mainRow = dom.addRow('w-main')

    await mountRows(listOf([{ workspaceId: 'w-main', path: '/repo' }]), dom)

    assert.equal(mainRow.title.getAttribute('data-dsh-worktree-count'), '3')
  })

  it('leaves the count off a workspace with no worktrees', async () => {
    globalThis.fetch = statusFetch([])
    const dom = makeDom()
    const row = dom.addRow('w-main')

    await mountRows(listOf([{ workspaceId: 'w-main', path: '/repo' }]), dom)

    assert.equal(row.title.getAttribute('data-dsh-worktree-count'), null)
  })

  it('never counts worktrees on a worktree row itself', async () => {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            isRepo: true,
            repoRoot: '/repo',
            worktrees: [
              { path: '/repo', isMain: true, name: 'repo' },
              { path: '/repo/.worktrees/wt-a', isMain: false, name: 'wt-a' },
              { path: '/repo/.worktrees/wt-b', isMain: false, name: 'wt-b' },
            ],
          }),
      })
    const dom = makeDom()
    const worktreeRow = dom.addRow('w-wt')

    await mountRows(listOf([{ workspaceId: 'w-wt', path: '/repo/.worktrees/wt-a' }]), dom)

    assert.equal(worktreeRow.getAttribute('data-dsh-worktree'), 'branch')
    assert.equal(worktreeRow.title.getAttribute('data-dsh-worktree-count'), null)
  })

  it('rewrites the count only when it changes', async () => {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            isRepo: true,
            repoRoot: '/repo',
            worktrees: [
              { path: '/repo', isMain: true, name: 'repo' },
              { path: '/repo/.worktrees/wt-a', isMain: false, name: 'wt-a' },
            ],
          }),
      })
    const dom = makeDom()
    const row = dom.addRow('w-main')
    const workspaces = listOf([{ workspaceId: 'w-main', path: '/repo' }])

    await mountRows(workspaces, dom)
    assert.equal(row.title.getAttribute('data-dsh-worktree-count'), '1')

    // A second pass over unchanged data must not touch the attribute: the write
    // would invalidate style for every row on every composer keystroke.
    let writes = 0
    const originalSet = row.title.setAttribute.bind(row.title)
    row.title.setAttribute = (key, value) => {
      writes += 1
      originalSet(key, value)
    }
    await dom.observers[dom.observers.length - 1].callback()
    await settle()

    assert.equal(writes, 0)
    assert.equal(row.title.getAttribute('data-dsh-worktree-count'), '1')
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
  function pickerProps(cwd, overrides = {}) {
    return {
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      sessionId: 'session-1',
      useSessions: (selector) =>
        selector({ byId: { 'session-1': { cwd, blank: overrides.blank !== false } } }),
      useWorkspaces: (selector) => selector({ items: [] }),
      useInput: (selector) => selector({ draft: '', attachmentIds: [] }),
      inputActions: { setDraft: () => {} },
      workspaces: { create: () => Promise.resolve({ workspaceId: 'w1' }) },
      uiWorkspace: { connectWorkspace: () => Promise.resolve() },
      ...overrides.props,
    }
  }

  /** Let queued promise callbacks run. */
  async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  /** A status body answering one repository with the given worktrees. */
  function statusBody(worktrees, extra = {}) {
    return {
      isRepo: true,
      repoRoot: '/repo',
      worktrees,
      deferred: true,
      ...extra,
    }
  }

  /** A fetch that answers status and records every call. */
  function recordingFetch(status, calls = []) {
    return (url, options) => {
      calls.push({ url, options })
      return Promise.resolve({ ok: true, json: () => Promise.resolve(status) })
    }
  }

  /** Drive one mount: render, let promises settle, re-render. */
  async function mount(cwd, overrides = {}) {
    const react = makeReact()
    const Component = pickerComponent(react)
    const props = pickerProps(cwd, overrides)
    let tree = react.render(Component, props)
    react.setOnRender(() => {
      tree = react.render(Component, props)
    })
    await settle()
    return { tree: () => tree, react, Component, props }
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

  it('shows the main checkout when the read succeeds', async () => {
    globalThis.fetch = recordingFetch(statusBody([{ path: '/repo-ok', name: 'repo-ok', isMain: true, prunable: false }]))

    const mounted = await mount('/repo-ok')

    assert.equal(labelOf(mounted), 'entry.main')
  })

  it('records the intent instead of creating anything on the spot', async () => {
    // The whole redesign: a branch cannot be named before the user has said
    // what the task is, so the menu only records the intent. The host half
    // creates the branch from the first message and moves the Session.
    const calls = []
    globalThis.fetch = recordingFetch(
      statusBody([{ path: '/repo-defer', name: 'repo-defer', isMain: true, prunable: false }]),
      calls,
    )

    const mounted = await mount('/repo-defer')
    mounted.tree().props.onSelect('__new__')
    await settle()

    const prepare = calls.filter((call) => call.url === '/api/dsh-worktree/prepare')
    assert.equal(prepare.length, 1)
    assert.equal(calls.filter((call) => String(call.url).includes('/create')).length, 0)
    assert.deepEqual(JSON.parse(prepare[0].options.body), { sessionId: 'session-1', from: '/repo-defer' })
  })

  it('offers the deferred item only where a Session can actually be moved', async () => {
    // Without the host's working-directory service the flow has nowhere to
    // land, so offering it would be a promise the plugin cannot keep.
    globalThis.fetch = recordingFetch(
      statusBody([{ path: '/repo-no-defer', name: 'repo-no-defer', isMain: true, prunable: false }], { deferred: false }),
    )

    const mounted = await mount('/repo-no-defer')

    assert.deepEqual(mounted.tree().props.footer, [])
  })

  it('offers the deferred item only in a conversation that has no message yet', async () => {
    // Naming happens on the first message; a Session that already has one can
    // never run the flow.
    globalThis.fetch = recordingFetch(
      statusBody([{ path: '/repo-started', name: 'repo-started', isMain: true, prunable: false }]),
    )

    const mounted = await mount('/repo-started', { blank: false })

    const [item] = mounted.tree().props.footer
    assert.equal(item.disabled, true)
  })

  it('keeps the draft when recording the intent', async () => {
    // Preparing only records intent, so unlike switching it must not touch the
    // composer. The old "create" path wiped the draft, which is why it had to
    // ask for confirmation first.
    let cleared = 0
    const calls = []
    globalThis.fetch = recordingFetch(
      statusBody([{ path: '/repo-draft', name: 'repo-draft', isMain: true, prunable: false }]),
      calls,
    )

    const mounted = await mount('/repo-draft', {
      props: {
        useInput: (selector) => selector({ draft: 'half-written prompt', attachmentIds: [] }),
        inputActions: { setDraft: () => (cleared += 1) },
      },
    })
    mounted.tree().props.onSelect('__new__')
    await settle()

    assert.equal(cleared, 0)
    assert.equal(calls.filter((call) => call.url === '/api/dsh-worktree/prepare').length, 1)
  })

  it('asks before switching to another checkout, which does discard the draft', async () => {
    const opened = []
    globalThis.fetch = recordingFetch(
      statusBody([
        { path: '/repo-switch', name: 'repo-switch', isMain: true, prunable: false },
        { path: '/repo-switch/.worktrees/other', name: 'other', isMain: false, prunable: false },
      ]),
    )

    const mounted = await mount('/repo-switch', {
      props: {
        useInput: (selector) => selector({ draft: 'half-written prompt', attachmentIds: [] }),
        workspaces: { create: () => Promise.resolve({ workspaceId: 'w-other' }) },
        uiWorkspace: { openWorkspace: (id) => (opened.push(id), Promise.resolve()) },
      },
    })

    // First activation is a confirmation request, not a switch.
    mounted.tree().props.onSelect('/repo-switch/.worktrees/other')
    await settle()

    assert.deepEqual(opened, [])
    assert.equal(mounted.tree().props.items[0].text, 'menu.draft')

    // The second activation goes through.
    mounted.tree().props.onSelect('/repo-switch/.worktrees/other')
    await settle()

    assert.deepEqual(opened, ['w-other'])
  })

  it('shows the pending state once the intent is recorded', async () => {
    globalThis.fetch = recordingFetch(
      statusBody([{ path: '/repo-pending', name: 'repo-pending', isMain: true, prunable: false }], { waiting: true }),
    )

    const mounted = await mount('/repo-pending')

    assert.equal(labelOf(mounted), 'entry.pending')
    const [item] = mounted.tree().props.footer
    assert.equal(item.disabled, true, 'a second intent must not be recordable')
  })

  it('lands on an existing worktree through a navigation, not a bare connect', async () => {
    // The regression: `connectWorkspace` only connects, so the user was left
    // in the blank composer they started in and had to find the workspace in
    // the sidebar and start a second conversation there.
    const opened = []
    globalThis.fetch = recordingFetch(
      statusBody([
        { path: '/repo-nav', name: 'repo-nav', isMain: true, prunable: false },
        { path: '/repo-nav/.worktrees/other', name: 'other', isMain: false, prunable: false },
      ]),
    )

    const mounted = await mount('/repo-nav', {
      props: {
        workspaces: { create: () => Promise.resolve({ workspaceId: 'w-new' }) },
        uiWorkspace: {
          connectWorkspace: () => {
            throw new Error('switching must navigate, not merely connect')
          },
          openWorkspace: (workspaceId) => {
            opened.push(workspaceId)
            return Promise.resolve()
          },
        },
      },
    })

    mounted.tree().props.onSelect('/repo-nav/.worktrees/other')
    await settle()

    assert.deepEqual(opened, ['w-new'])
  })
})

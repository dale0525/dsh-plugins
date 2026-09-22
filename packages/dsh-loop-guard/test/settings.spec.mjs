/**
 * The configuration contract.
 *
 * As of the 0.1.7-alpha.1 settings redesign the guard has exactly ONE config
 * surface: its own `Config` schema. `dsh-settings` derives the Plugins-page
 * form for a loader entry from that entry's schema, keyed by the entry id
 * (`loop-guard`), so the former `loop-guard` settings namespace and the
 * `installSection` seam it needed are both gone. These tests pin the three
 * properties that replaced that seam, each of which is a way the guard can
 * silently stop being configurable:
 *
 *  1. EVERY field is `volatile()`. A plain field is delivered to `apply` as a
 *     plain value, not as a `{ get() }` reference — `config.x.get()` then throws
 *     during activation — and it is also the flag `dsh-settings` reads to decide
 *     whether the field appears in the Plugins-page form at all. So a field
 *     missing the marker is both a boot failure and an invisible setting.
 *  2. `apply` resolves the effective config through those references at the
 *     point of use, NOT once at activation. The Loader commits an edit into the
 *     very references it already handed over, so a snapshot taken at mount would
 *     pin the values the profile started with and the page's save button would
 *     appear to do nothing.
 *  3. The guard needs no settings service to mount. The regression this file
 *     was written for is a `pending (waiting for service: settingsScope)` entry:
 *     a plugin that waits on a service the profile does not provide never
 *     activates, and the Web UI's boot audit then fails the whole page.
 *
 * The references here are stand-ins built from the real schema output, not the
 * Loader's own objects: the guard depends only on the documented `{ get() }`
 * protocol, and pinning the protocol rather than one host implementation is
 * what keeps these tests meaningful when the host's loader changes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

import * as plugin from '../lib/index.js'
import { Config } from '../lib/index.js'

/** The namespace the guard used to register, kept only for the assertion below. */
const NS = 'loop-guard'

/**
 * The row config a profile would write into `cordis.patch.yml`.
 *
 * It is no longer a "composition layer" merged under a user layer — it is
 * simply the entry's config, and the Plugins page edits that same entry — but
 * a row that states values must still see them in effect.
 */
const ROW_CONFIG = { maxThinkingSteps: 3, maxRepeatedText: 60 }

/**
 * Live references over the real schema, one per field.
 *
 * Built by parsing through `Config` so the key set and the defaults cannot
 * drift from the schema, then re-wrapped in a mutable cell: a real reference is
 * written by the Loader, and the cell's `set` is the test-side equivalent of
 * that commit. Returns the refs and the cell writer separately so the refs
 * object carries nothing but the `{ get() }` protocol.
 */
function refsFor(overrides = {}) {
  const parsed = new Config(overrides)
  const cells = {}
  const refs = {}
  for (const key of Object.keys(parsed)) {
    cells[key] = parsed[key].get()
    refs[key] = { get: () => cells[key] }
  }
  return { refs, set: (key, value) => { cells[key] = value } }
}

/**
 * A context double carrying one `llm/stream` listener and an agents registry.
 *
 * `inject` is recorded rather than implemented: the guard must not request any
 * service to mount, and a re-added `ctx.inject(['settings'], …)` is exactly the
 * shape that produced the boot failure this file guards against.
 */
function contextWith({ agent, streamSink, settings }) {
  const injected = []
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      if (callback !== undefined) callback({})
    },
    on(name, listener) {
      if (name === 'llm/stream') streamSink.push(listener)
    },
    logger: { warn() {}, debug() {}, info() {} },
    agents: { get: () => agent },
    get: (name) => (name === 'settings' ? settings : undefined),
  }
  return { ctx, injected }
}

/** An agent stand-in recording the reactions it receives. */
function fakeAgent() {
  const steered = []
  return {
    steer: (message) => steered.push(message),
    inject: () => {},
    cancel: () => {},
    steered,
  }
}

/**
 * Drive one visible-output call through the installed listener and report the
 * terminal chunk, which is how a break is observable from the outside.
 */
async function fire(stream, options, chunks) {
  const out = []
  for await (const chunk of stream(markAgentLoopRequest(options), async function* () {
    for (const text of chunks) yield { type: 'text-delta', index: 0, text }
  })) out.push(chunk)
  return out
}

/**
 * A visible-output bleed with an exact 172-character period.
 *
 * The period is the point: the shipped cap is 512 and an earlier draft used 64,
 * so a 172-periodic text is the sample that separates the two. A shorter period
 * would be caught by BOTH caps and prove nothing.
 */
const BLEED = (() => {
  const pool = ['好。', '我写报告。', '（写）', '现在。']
  let unit = ''
  for (let i = 0; unit.length < 172; i++) unit += pool[i % pool.length] + '\n'
  return unit.repeat(60)
})()

/** Drive the bleed in 16-character deltas, as a provider would stream it. */
async function fireBleed(stream) {
  return fire(stream, { sessionId: 's1' }, BLEED.match(/[\s\S]{1,16}/g))
}

/** The keys the guard's `Config` interface declares, read off the schema. */
const CONFIG_KEYS = Object.keys(Config.dict)

test('every Config field is volatile, so the Plugins page can edit it', () => {
  // A field without the marker still configures the guard through the row's
  // `cordis.patch.yml` config, but `dsh-settings` cannot show or edit it — and
  // the guard would receive a plain value where it expects a reference.
  for (const key of CONFIG_KEYS) {
    assert.equal(
      Config.dict[key].meta?.volatile,
      true,
      `Config.${key} must be marked volatile()`,
    )
  }
  assert.ok(CONFIG_KEYS.length > 0, 'the schema must declare at least one field')
})

test('the schema output is a live reference for every field', () => {
  // The behavioural form of the check above: this is what `apply` actually
  // receives from the Loader, so it is the shape that decides whether the
  // guard's `.get()` calls work at activation.
  const refs = new Config({})
  assert.deepEqual(Object.keys(refs).sort(), [...CONFIG_KEYS].sort())
  for (const key of CONFIG_KEYS) {
    assert.equal(typeof refs[key].get, 'function', `Config.${key} must resolve to a reference`)
  }
})

test('apply mounts without a settings service and requests none', () => {
  const agent = fakeAgent()
  const stream = []
  const { ctx, injected } = contextWith({ agent, streamSink: stream, settings: undefined })

  plugin.apply(ctx, refsFor(ROW_CONFIG).refs)

  assert.equal(stream.length, 1, 'the guard must observe llm/stream')
  assert.deepEqual(
    injected.filter((names) => names.includes('settings')),
    [],
    'the guard must not wait on a settings service to mount',
  )
  assert.deepEqual(plugin.inject, ['agents'], 'the guard declares only the agents service')
})

test('apply resolves every field through its live reference', async () => {
  // Nothing is read at mount: the guard installs the listener and resolves the
  // config when a call actually arrives. That is the property that makes a page
  // edit take effect on the next call, and it is also why this test has to drive
  // a stream rather than just calling `apply`.
  const agent = fakeAgent()
  const stream = []
  const { ctx } = contextWith({ agent, streamSink: stream })

  const { refs } = refsFor(ROW_CONFIG)
  const reads = new Set()
  for (const key of Object.keys(refs)) {
    const inner = refs[key]
    refs[key] = { get: () => { reads.add(key); return inner.get() } }
  }

  plugin.apply(ctx, refs)
  assert.deepEqual([...reads], [], 'mounting alone must not read the config')

  await fireBleed(stream[0])

  assert.deepEqual(
    [...reads].sort(),
    [...CONFIG_KEYS].sort(),
    'every field must be resolved when the call is judged',
  )
})

test('an edit made after mount is picked up on the next call', async () => {
  const agent = fakeAgent()
  const stream = []
  const { ctx } = contextWith({ agent, streamSink: stream })
  const { refs, set } = refsFor(ROW_CONFIG)

  plugin.apply(ctx, refs)

  // With the shipped 512 cap the 172-period bleed is cut mid-stream.
  const first = await fireBleed(stream[0])
  assert.ok(
    first.some((chunk) => chunk.type === 'finish'),
    "with the shipped 512 cap in effect the 172-period bleed must be cut",
  )

  // The Loader commits a page edit into the same reference. The next call must
  // see it: a snapshot taken at mount would keep cutting the bleed.
  set('maxRepeatedCycleChars', 0)

  const second = await fireBleed(stream[0])
  assert.equal(
    second.some((chunk) => chunk.type === 'finish'),
    false,
    'a cap disabled after mount must not cut the bleed on the next call',
  )
})

test('the configured cap stands when nothing is edited', async () => {
  const agent = fakeAgent()
  const stream = []
  const { ctx } = contextWith({ agent, streamSink: stream })

  plugin.apply(ctx, refsFor(ROW_CONFIG).refs)

  const out = await fireBleed(stream[0])

  assert.ok(
    out.some((chunk) => chunk.type === 'finish'),
    "with the shipped 512 cap in effect the 172-period bleed must be cut",
  )
})

test('a row config that widens the cap is honoured', async () => {
  // The other direction of the same property: the row's `config` is the entry's
  // config, so a value written there must reach the breaker — here the cap is
  // lowered to 64, below the 172-character period, which makes the bleed
  // invisible and therefore must NOT be cut.
  const agent = fakeAgent()
  const stream = []
  const { ctx } = contextWith({ agent, streamSink: stream })

  plugin.apply(ctx, refsFor({
    maxRepeatedCycleChars: 64,
    minRepeatedCycleChars: 256,
  }).refs)

  const out = await fireBleed(stream[0])

  assert.equal(
    out.some((chunk) => chunk.type === 'finish'),
    false,
    'with a 64 cap in effect the 172-period bleed must NOT be cut',
  )
})

test('the guard no longer registers a settings namespace', async () => {
  // `settings.register` / `settings.get` / `settings.installSection` were all
  // removed in dsh-settings 0.1.7-alpha.1. The guard must not touch them, and a
  // settings service that only implements the OLD API must be irrelevant: it is
  // present here, throws on any call, and mounting must still succeed.
  const agent = fakeAgent()
  const stream = []
  const legacy = {
    register() { throw new Error('settings.register was removed in 0.1.7-alpha.1') },
    get() { throw new Error('settings.get was removed in 0.1.7-alpha.1') },
    installSection() { throw new Error('settings.installSection was removed in 0.1.7-alpha.1') },
  }
  const { ctx } = contextWith({ agent, streamSink: stream, settings: legacy })

  assert.doesNotThrow(() => plugin.apply(ctx, refsFor(ROW_CONFIG).refs))
  assert.equal(stream.length, 1, 'the guard must still observe llm/stream')

  // The only settings read left is the language lookup, which goes through
  // `describe()` — a service without it must degrade to the default language
  // rather than throw out of the listener.
  await assert.doesNotReject(() => fire(stream[0], { sessionId: 's1' }, ['plain output']))
})

test('the retired namespace is not referenced anywhere in the client manifest', async () => {
  // The browser half failed on `settingsScope`, which 0.1.7-alpha.1 no longer
  // provides. Its declared inject list must stay free of it.
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const inject = manifest.dsh?.client?.inject ?? []
  assert.deepEqual(
    inject.filter((name) => name === 'settingsScope'),
    [],
    'dsh.client.inject must not name the retired settingsScope service',
  )
  assert.equal(
    manifest.dependencies?.['@deepseek-ai/dsh-settings'],
    undefined,
    'the guard must not depend on dsh-settings',
  )
  assert.ok(
    NS.length > 0,
    'the entry id is the settings key, so it must stay non-empty',
  )
})

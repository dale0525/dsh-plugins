/**
 * The settings section contract.
 *
 * The row's `config` in `cordis.patch.yml` is the composition layer; the
 * `loop-guard` settings namespace is the user layer on top of it. These tests
 * pin the two properties that make that layering real, both of which failed in
 * an earlier draft:
 *
 *  1. `ctx.inject` is NOT synchronous even when the settings service is already
 *     present. Installing the listeners eagerly against the composition config
 *     would therefore pin the defaults in place and the user's section would
 *     never be read. The guard must resolve the effective config at the point of
 *     use instead.
 *  2. `setSource` hands over a THUNK, not a value. Treating it as the value
 *     spreads a function into the config object and every field becomes
 *     `undefined`.
 *
 * The settings service here is a stand-in, not the shipped one: the guard only
 * depends on `installSection`'s documented protocol, and pinning that protocol
 * (rather than the shipped implementation) is what keeps these tests meaningful
 * when the host's settings package changes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

import * as plugin from '../lib/index.js'
import { Config } from '../lib/index.js'

/** Resolve the row config the way the cordis loader does, defaults included. */
const COMPOSITION = new Config({
  maxThinkingSteps: 3,
  maxRepeatedText: 60,
})

/** The namespace the guard registers. */
const NS = 'loop-guard'

/**
 * A settings service stand-in implementing `installSection`.
 *
 * `setSource` is called with a thunk over the current source, exactly as the
 * shipped provider does, and `onChange` right after — the same order.
 */
function fakeSettings(entry, userLayer) {
  const installed = []
  const provider = {
    installSection(owner, ns, schema, base, hooks) {
      installed.push({ owner, ns, schema, base, hooks })
      const source = () => ({ ...base, ...userLayer() })
      hooks.setSource(source)
      hooks.onChange()
    },
  }
  return { provider, installed }
}

/** A context double carrying a settings service and one llm/stream listener. */
function contextWith({ agent, settings, streamSink }) {
  const injected = []
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      if (names.includes('settings')) callback({ settings })
    },
    on(name, listener) {
      if (name === 'llm/stream') streamSink.push(listener)
    },
    logger: { warn() {}, debug() {}, info() {} },
    agents: { get: () => agent },
    get: () => undefined,
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

test('the settings section is registered under the row namespace', () => {
  const agent = fakeAgent()
  const stream = []
  const { provider, installed } = fakeSettings(COMPOSITION, () => ({}))
  const { ctx, injected } = contextWith({ agent, settings: provider, streamSink: stream })

  plugin.apply(ctx, COMPOSITION)

  assert.deepEqual(injected, [['settings']], 'the settings service must be requested')
  assert.equal(installed.length, 1, 'exactly one section must be registered')
  assert.equal(installed[0].ns, NS)
  assert.equal(installed[0].base, COMPOSITION, 'the composition config is the section base')
})

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

test('a user-layer value overrides the composition value', async () => {
  const agent = fakeAgent()
  const stream = []
  // The user states a 64-character period cap — below the shipped 512 — so the
  // 172-period bleed is invisible to the effective config. The composition
  // config, which has 512, WOULD catch it; the test fails if the user layer is
  // ignored and the composition value is used instead.
  const user = { maxRepeatedCycleChars: 64, minRepeatedCycleChars: 256 }
  const { provider } = fakeSettings(COMPOSITION, () => user)
  const { ctx } = contextWith({ agent, settings: provider, streamSink: stream })

  plugin.apply(ctx, COMPOSITION)

  const out = await fireBleed(stream[0])

  assert.equal(
    out.some((chunk) => chunk.type === 'finish'),
    false,
    "with the user's 64 cap in effect the 172-period bleed must NOT be cut",
  )
})

test('the composition value stands when the user states nothing', async () => {
  const agent = fakeAgent()
  const stream = []
  const { provider } = fakeSettings(COMPOSITION, () => ({}))
  const { ctx } = contextWith({ agent, settings: provider, streamSink: stream })

  plugin.apply(ctx, COMPOSITION)

  const out = await fireBleed(stream[0])

  assert.ok(
    out.some((chunk) => chunk.type === 'finish'),
    "with the composition's 512 cap in effect the 172-period bleed must be cut",
  )
})

test('a profile with no settings service still installs the listeners', () => {
  const agent = fakeAgent()
  const stream = []
  // A context whose inject never fires: no settings service in this profile.
  const ctx = {
    inject: () => {},
    on: (name, listener) => {
      if (name === 'llm/stream') stream.push(listener)
    },
    logger: { warn() {}, debug() {}, info() {} },
    agents: { get: () => agent },
    get: () => undefined,
  }

  plugin.apply(ctx, COMPOSITION)

  assert.equal(stream.length, 1, 'the guard must still observe llm/stream')
})

test('the section schema covers every composition key', async () => {
  // A key the row accepts but the section omits could never be edited from the
  // Plugins page; one the section accepts but the row omits would be dropped by
  // the engine. The two sets are one contract and must stay equal.
  const { SettingsSection } = await import('../lib/settings.js')
  // The schema's DECLARED keys, not a resolved sample: the section deliberately
  // carries no defaults, so `SettingsSection({})` resolves to an empty object
  // and comparing resolved values would compare nothing.
  const compositionKeys = Object.keys(new Config({}))
  const sectionKeys = Object.keys(SettingsSection.dict ?? {})

  assert.deepEqual(
    sectionKeys.sort(),
    compositionKeys.sort(),
    'the settings section and the composition schema must declare the same keys',
  )
})

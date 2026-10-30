import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { SESSION_FORMAT_VERSION, Session } from '@deepseek-ai/dsh-session'
import VerbatimCompactionEngine, { name } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Load the sanitized fixture log. */
function events() {
  return readFileSync(join(here, 'fixtures', 'session.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

/** Build a live Session over the fixture. */
function buildSession() {
  const header = { version: SESSION_FORMAT_VERSION, id: 'fixture', createdAt: 1, isSeeded: false }
  return Session.create('fixture', events(), header, 0)
}

/**
 * Mount the backend over real `TokenMeter` and a counting llm stub, and return
 * the mounted engine plus the call counter.
 *
 * `TokenMeter` requires `sessionProjections`; the backend requires `llm`,
 * `tokenMeter` and `sessions`. The llm stub's `stream` counts calls so the
 * "no model call" criterion is measured rather than assumed.
 */
async function harness() {
  const calls = { stream: 0 }
  const ctx = new Context()
  await ctx.plugin((c) => {
    c.provide('sessionProjections')
    c.set('sessionProjections', { register: () => () => {} })
    c.provide('llm')
    c.set('llm', {
      resolveModelInfo: async () => ({ provider: 'fixture', id: 'fixture-model', contextWindow: 450000 }),
      stream: async function* stream() {
        calls.stream += 1
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    c.provide('sessions')
    c.set('sessions', { flush: async () => true })
  })
  await ctx.plugin(TokenMeter)
  const fork = ctx.plugin(VerbatimCompactionEngine, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fork.error, undefined, `plugin mount failed: ${fork.error?.message}`)
  const engine = ctx.get('compaction')
  assert.ok(engine, 'backend must register the compaction service')
  return { engine, calls, ctx }
}

/** A minimal agent handle for `compactRegion`. */
function agentFor(session) {
  return {
    id: 'fixture',
    session,
    options: { provider: 'fixture', model: 'fixture-model' },
    runMaintenance: (run) => run(new AbortController().signal),
  }
}

/** The last checkpoint the backend wrote, or undefined. */
function checkpointOf(session) {
  const checkpoints = session
    .snapshotEvents()
    .filter((event) => event.type === 'user/message' && event.data.source?.kind === 'compact-checkpoint')
  return checkpoints.at(-1)
}

/** The digest text inside one checkpoint, with the host's own framing excluded. */
function digestOf(checkpoint) {
  return checkpoint.data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .replace(/^This is an automatically generated checkpoint[^\n]*\n?/, '')
    .replace('</compacted-summary>', '')
}

test('the plugin name matches the patch row id', () => {
  assert.equal(name, 'verbatim-compaction')
})

test('compactRegion still compacts when the model returns nothing', async () => {
  // The verbatim digest is the floor: extraction is an enrichment, and a model
  // that yields no text must not stop the compaction or lose the prose. The
  // fixture's `stream` yields only `finish`, so every extraction returns null.
  const { engine, calls } = await harness()
  const session = buildSession()
  const nodes = session.surface.nodes
  const agent = agentFor(session)

  const result = await engine.compactRegion(nodes[1], nodes.at(-1), agent)

  assert.ok(calls.stream > 0, 'extraction is attempted per turn now')
  assert.ok(result.summary.length > 0)
  const checkpoint = checkpointOf(session)
  assert.ok(checkpoint, 'a compaction checkpoint must be written')
  assert.ok(digestOf(checkpoint).length > 0)
})

test('the checkpoint carries user and assistant prose verbatim and no reasoning', async () => {
  const { engine } = await harness()
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  const source = events()
  for (const event of source) {
    if (event.type !== 'user/message') continue
    const prose = event.data.content.find((block) => block.type === 'text').text
    assert.ok(text.includes(prose), `user prose missing: ${prose.slice(0, 40)}`)
  }
  assert.ok(text.includes('ASSISTANT-'))
  assert.ok(!text.includes('REASONING-SHOULD-NEVER-APPEAR'))
})

test('a second compaction keeps the first compaction\'s content', async () => {
  const { engine } = await harness()
  const session = buildSession()
  const agent = agentFor(session)

  // Both rounds shadow everything except the retained tail, which is what the
  // base class does: `selectCompactableRange` starts at `surfaceNodes[firstIdx]`
  // and keeps only the tail worth `retainTokens`. Compacting down to a single
  // node would instead exercise a region the automatic path never selects.
  const first = session.surface.nodes
  await engine.compactRegion(first[1], first.at(-1), agent)
  const afterFirst = digestOf(checkpointOf(session))

  const second = session.surface.nodes
  await engine.compactRegion(second[1], second.at(-1), agent)
  const afterSecond = digestOf(checkpointOf(session))

  for (const event of events()) {
    if (event.type !== 'user/message') continue
    const prose = event.data.content.find((block) => block.type === 'text').text
    assert.ok(afterSecond.includes(prose), `user prose lost on the second compaction: ${prose.slice(0, 40)}`)
  }
  assert.ok(afterSecond.length >= afterFirst.length / 2)
})

test('the summary is smaller than the span it replaces', async () => {
  const { engine, ctx } = await harness()
  const session = buildSession()
  const nodes = session.surface.nodes
  const before = ctx.tokenMeter.measure(session)
  const shadowed = new Set(nodes.slice(1, -1))
  const shadowedPrice = before.nodes
    .filter((node) => shadowed.has(node.seq))
    .reduce((total, node) => total + node.tokens, 0)

  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const summaryTokens = ctx.tokenMeter.measure(session).nodes
    .filter((node) => node.seq === checkpointOf(session).seq)
    .reduce((total, node) => total + node.tokens, 0)
  assert.ok(summaryTokens < shadowedPrice, `${summaryTokens} >= ${shadowedPrice}`)
})

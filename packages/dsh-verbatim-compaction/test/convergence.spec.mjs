/**
 * Convergence: a compaction must leave the surface materially smaller than it
 * found it.
 *
 * The real failure this pins: session `小鹏汽车 App 改造评估` compacted at
 * `seq 22036` with `shadowedTokenCount = 87733` and produced a 348539-character
 * digest priced at 87135 tokens — a 598-token (0.7%) reduction. The surface was
 * still above the 256464-token threshold, so the next step compacted again, this
 * time with a shadowed range of exactly one seq (the checkpoint itself), and
 * reproduced the same 348k characters. The third attempt was aborted.
 *
 * The budget was `shadowedPrice - 86 - 512`, i.e. "just barely smaller than what
 * I replace", which is exactly the shrink guard's own bound. Satisfying the
 * guard is not enough: a compaction that frees 0.7% of the context re-triggers
 * immediately and never converges. The budget must be a fraction of the shadowed
 * price, not the whole of it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { SESSION_FORMAT_VERSION, Session } from '@deepseek-ai/dsh-session'
import VerbatimCompactionEngine from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

function events() {
  return readFileSync(join(here, 'fixtures', 'session.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

function buildSession() {
  const header = { version: SESSION_FORMAT_VERSION, id: 'fixture', createdAt: 1, isSeeded: false }
  return Session.create('fixture', events(), header, 0)
}

async function harness(options = {}) {
  const ctx = new Context()
  await ctx.plugin((c) => {
    c.provide('sessionProjections')
    c.set('sessionProjections', { register: () => () => {} })
    c.provide('llm')
    c.set('llm', {
      resolveModelInfo: async () => ({ provider: 'fixture', id: 'fixture-model', contextWindow: 450000 }),
      stream: async function* stream() {
        if (options.extraction !== undefined) {
          yield { type: 'text-delta', text: options.extraction }
        }
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
  return { engine, ctx }
}

function agentFor(session) {
  return {
    id: 'fixture',
    session,
    options: { provider: 'fixture', model: 'fixture-model' },
    runMaintenance: (run) => run(new AbortController().signal),
  }
}

function checkpointOf(session) {
  return session
    .snapshotEvents()
    .filter((event) => event.type === 'user/message' && event.data.source?.kind === 'compact-checkpoint')
    .at(-1)
}

function nodeTokens(ctx, session, seq) {
  return ctx.tokenMeter.measure(session).nodes.filter((node) => node.seq === seq).reduce((total, node) => total + node.tokens, 0)
}

function digestLength(checkpoint) {
  return checkpoint.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').length
}

test('one compaction reclaims at least half of what it shadows', async () => {
  const { engine, ctx } = await harness()
  const session = buildSession()
  const nodes = session.surface.nodes
  const before = ctx.tokenMeter.measure(session)
  const shadowed = new Set(nodes.slice(1, -1))
  const shadowedPrice = before.nodes.filter((node) => shadowed.has(node.seq)).reduce((total, node) => total + node.tokens, 0)

  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const summaryTokens = nodeTokens(ctx, session, checkpointOf(session).seq)
  // The observed production bug sat at 99.3% of the shadowed price. Half is the
  // contract: below that, each compaction makes real progress and the loop
  // terminates; above it, the same surface re-triggers on the next step.
  assert.ok(
    summaryTokens <= shadowedPrice * 0.5,
    `compaction reclaimed only ${shadowedPrice - summaryTokens} of ${shadowedPrice} tokens`,
  )
})

test('recompacting a lone checkpoint halves the digest instead of reproducing it', async () => {
  // The production pathology, exactly: after the first compaction the surface
  // held nothing but the checkpoint, so the next compaction shadowed one seq and
  // reproduced the same 348k characters (346555 vs 348539). Halving per round is
  // what turns that fixed point into geometric decay.
  const { engine } = await harness()
  const session = buildSession()
  const agent = agentFor(session)

  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agent)
  const first = digestLength(checkpointOf(session))

  const lone = checkpointOf(session).seq
  await engine.compactRegion(lone, lone, agent)
  const second = digestLength(checkpointOf(session))

  assert.ok(
    second <= first * 0.6,
    `lone-checkpoint recompaction kept ${second} of ${first} characters`,
  )
})

test('the digest never carries the checkpoint it replaces as history', async () => {
  const { engine } = await harness()
  const session = buildSession()
  const agent = agentFor(session)

  const first = session.surface.nodes
  await engine.compactRegion(first[1], first.at(-1), agent)
  const firstText = checkpointOf(session).data.content.map((block) => block.text).join('\n')

  const second = session.surface.nodes
  await engine.compactRegion(second[1], second.at(-1), agent)
  const secondText = checkpointOf(session).data.content.map((block) => block.text).join('\n')

  // The second digest is rebuilt from the log, so it must not contain the
  // first checkpoint's framing verbatim: that would nest checkpoint inside
  // checkpoint and grow without bound.
  assert.ok(!secondText.includes(firstText), 'second digest embedded the first checkpoint wholesale')
})

test('extraction leads the digest so truncation cannot delete it', async () => {
  // The first version appended the extraction and then sliced the tail. Under a
  // tight budget that deleted the "what did this turn conclude" record first and
  // kept the prose it summarised — the exact inversion of the design's intent.
  const { engine } = await harness({ extraction: '## Did\n- EXTRACTED-MARKER' })
  const session = buildSession()
  const nodes = session.surface.nodes

  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))
  const text = checkpointOf(session).data.content.map((block) => block.text).join('\n')

  assert.ok(text.includes('EXTRACTED-MARKER'), 'extraction must survive truncation')
  assert.ok(
    text.indexOf('EXTRACTED-MARKER') < text.indexOf('## user (turn 1)'),
    'extraction must precede the verbatim history',
  )
})

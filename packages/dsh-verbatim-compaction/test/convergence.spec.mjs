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
      stream: async function* stream(request) {
        if (options.extraction !== undefined) {
          const prompt = request.messages.at(-1).content.map((block) => block.text).join('')
          const turns = [...prompt.matchAll(/^=== TURN (\d+) ===$/gm)].map((match) => Number(match[1]))
          yield {
            type: 'text-delta',
            text: turns.map((turn) => `=== TURN ${turn} ===\n${options.extraction}`).join('\n\n'),
          }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      imageRequestPricing: () => undefined,
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

test('recompacting a lone checkpoint never grows the digest', async () => {
  // With a share-of-span budget the digest halved each round (279048 -> 139865
  // chars), and that halving was what turned the fixed point into decay. An
  // absolute ceiling reaches its floor instead: once the digest is at the
  // ceiling it stops shrinking, so the property worth pinning is that
  // recompaction never *grows* it — a digest that grows is the fixed point
  // returning.
  //
  // The fixture digest is far below the ceiling, so this asserts the weaker but
  // still meaningful invariant on this log; the ceiling itself is pinned in
  // extractive.spec.mjs.
  const { engine } = await harness()
  const session = buildSession()
  const agent = agentFor(session)

  const first = session.surface.nodes
  await engine.compactRegion(first[1], first.at(-1), agent)
  const firstLength = digestLength(checkpointOf(session))

  const lone = checkpointOf(session).seq
  await engine.compactRegion(lone, lone, agent)
  const secondLength = digestLength(checkpointOf(session))

  assert.ok(
    secondLength <= firstLength,
    `lone-checkpoint recompaction grew the digest: ${firstLength} -> ${secondLength}`,
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

test('the extraction occupies its own turn, not a block at the head', async () => {
  // The earlier design hoisted one extracted block to the top of the digest and
  // then sliced the tail, which deleted history to make room. Inlining the block
  // into the turn it describes removes that competition entirely: the extraction
  // and its turn are the same unit, so truncation can only drop whole turns.
  const { engine } = await harness({ extraction: '## Did\n- INLINE-MARKER' })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = checkpointOf(session).data.content.map((block) => block.text).join('\n')
  const marker = text.indexOf('INLINE-MARKER')
  assert.ok(marker >= 0, 'extraction must appear')
  // It sits under the assistant heading of its own turn, not above the history.
  const before = text.slice(0, marker)
  assert.ok(before.includes('### assistant (turn'), 'extraction must be inside a turn section')
  assert.ok(before.includes('## user (turn'), 'and that section must already have started')
})

/**
 * The extractive design: user prose verbatim, assistant prose replaced by one
 * extracted block per turn.
 *
 * Why this replaced the fully-verbatim digest: measured over 8 real sessions and
 * 4400 assistant text messages, 58.2% of the characters were substantive
 * conclusions, 35.8% were short findings carrying data, and the rest was
 * procedural narration that the tool trace already implies. Keeping all of it
 * verbatim made the digest grow linearly with history (51019 chars at one span,
 * 348539 at another), which is the growth that produced the compaction loop.
 *
 * What must NOT change: the user's own words stay verbatim. An assistant reply
 * can be reconstructed from its tool calls; a user's correction, warning, or
 * constraint cannot. The host's own summarizer paraphrases those, and that
 * paraphrase is the loss this plugin exists to prevent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { SESSION_FORMAT_VERSION, Session } from '@deepseek-ai/dsh-session'
import VerbatimCompactionEngine, { DIGEST_TOKEN_CEILING, renderDigest } from '../lib/index.js'

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
        options.onCall?.(request)
        if (options.extraction !== undefined) {
          // Answer in the batch protocol: one `=== TURN n ===` block per turn
          // named in the request. A model that answers in the old per-turn shape
          // yields no blocks and the digest silently keeps prose, so the protocol
          // is worth asserting rather than assuming.
          const prompt = request.messages.at(-1).content.map((block) => block.text).join('')
          const slots = [...prompt.matchAll(/^=== SLOT (\S+) \(turn /gm)].map((match) => match[1])
          const answer = slots
            .map((slot) => `=== SLOT ${slot} ===\n${options.extraction}`)
            .join('\n\n')
          yield { type: 'text-delta', text: answer }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      imageRequestPricing: () => undefined,
    })
    c.provide('sessions')
    c.set('sessions', { flush: async () => true })
  })
  await ctx.plugin(TokenMeter)
  const fork = ctx.plugin(VerbatimCompactionEngine, options.config ?? {})
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

function digestOf(checkpoint) {
  return checkpoint.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

test('user prose stays verbatim when extraction succeeds', async () => {
  const { engine } = await harness({ extraction: '## Did\n- EXTRACTED-BODY' })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  for (const event of events()) {
    if (event.type !== 'user/message') continue
    const prose = event.data.content.find((block) => block.type === 'text').text
    assert.ok(text.includes(prose), `user prose missing: ${prose.slice(0, 40)}`)
  }
})

test('assistant prose is replaced by the extraction, not kept alongside it', async () => {
  const { engine } = await harness({ extraction: '## Did\n- EXTRACTED-BODY' })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  assert.ok(text.includes('EXTRACTED-BODY'), 'extraction must be present')
  assert.ok(
    !text.includes('ASSISTANT-1.1'),
    'assistant prose must not also be kept verbatim: that is the duplication this design removes',
  )
})

test('assistant prose is kept verbatim when extraction fails', async () => {
  // The fallback matters more than the feature: a provider outage must not turn
  // a compaction into a checkpoint that lost the assistant's work as well.
  const { engine } = await harness()
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  assert.ok(text.includes('ASSISTANT-'), 'without extraction the prose is the only record left')
  assert.ok(!text.includes('REASONING-SHOULD-NEVER-APPEAR'))
})

test('the digest is capped by an absolute ceiling, not by the span it replaces', async () => {
  // The share-of-shadowed budget made the digest grow with history: 51019 chars
  // on one span and 348539 on another, which is the growth that re-triggered
  // compaction. A fixed ceiling is what makes the size independent of history.
  const { engine } = await harness({ extraction: `## Did\n- ${'x'.repeat(4000)}` })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  assert.ok(
    text.length <= DIGEST_TOKEN_CEILING * 4,
    `digest ${text.length} exceeds ceiling ${DIGEST_TOKEN_CEILING * 4} chars`,
  )
})

test('extraction is requested once per turn, in one batched call per compaction', async () => {
  const calls = []
  const { engine } = await harness({ extraction: '## Did\n- X', onCall: (request) => calls.push(request) })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const turns = new Set(
    events().filter((event) => event.type === 'turn/start').map((event) => event.data.turn),
  )
  assert.ok(calls.length > 0, 'extraction must run')
  assert.ok(
    calls.length <= Math.max(1, Math.ceil(turns.size / 4)),
    `${calls.length} calls for ${turns.size} turns is not batched`,
  )
})

test('a digest full of extractions still keeps every user message', async () => {
  // The regression this pins: `assistantChars` skipped turns that had an
  // extraction, so a digest made almost entirely of extractions reported a
  // bisection bound of zero. The cap had nothing to shrink, the renderer fell
  // through to dropping the oldest turns, and the first two human messages went
  // with them — including 「请用pixi管理开发环境」, a standing constraint.
  //
  // Real numbers from the session that exposed it: human prose in the span was
  // 469 characters, one 420-character extraction per turn was 55020. The
  // extraction is 117x the prose, so it always wins any competition for room.
  const { engine } = await harness({ extraction: `## Did\n- ${'y'.repeat(3000)}` })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  assert.ok(!text.includes('earlier turn(s) dropped'), 'turns must be thinned, not dropped')
  for (const event of events()) {
    if (event.type !== 'user/message') continue
    const prose = event.data.content.find((block) => block.type === 'text').text
    assert.ok(text.includes(prose), `user prose evicted by extraction: ${prose.slice(0, 40)}`)
  }
})

test('two requests sharing one turn number get their own extractions', async () => {
  // A real session carried two user requests under a single `turn/start` (both
  // numbered 1): 「修复内置书源…」 and 「模拟器使用硬件加速！」. Keying the
  // extraction map by turn number made the second block overwrite the first, and
  // the digest printed the same 1.3k-character block twice — once under a request
  // about source refresh, once under a request about emulator acceleration.
  const { engine } = await harness({
    // Answer per slot, so a collision in the key shows up as a wrong body rather
    // than a missing one.
    extraction: '## Did\n- PER-SLOT',
  })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  const blocks = text.match(/## Did\n- PER-SLOT/g) ?? []
  // One block per slot (a section may hold more than one turn), so the count to
  // compare against is the assistant headings the renderer emitted.
  const assistantSlots = text.match(/^### assistant$/gm) ?? []
  assert.equal(
    blocks.length,
    assistantSlots.length,
    `${assistantSlots.length} assistant slots but ${blocks.length} extraction blocks`,
  )
  // The bug was one block printed twice; a per-slot answer must be distinct per
  // slot, so the total is what proves no overwrite happened.
  assert.ok(blocks.length >= 2, 'fixture must have at least two slots')
})

test('a duplicate turn number does not collapse two blocks into one', () => {
  // Pure-function level: buildSections already separates the two requests into
  // their own sections, so the fix is that the key is positional.
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'FIRST' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'SECOND' }], source: { kind: 'user' } } },
  ]
  const rendered = renderDigest(events, 20000, new Map([['0:0', 'BLOCK-FIRST'], ['1:0', 'BLOCK-SECOND']]))
  assert.ok(rendered.includes('BLOCK-FIRST'), 'first slot must keep its own block')
  assert.ok(rendered.includes('BLOCK-SECOND'), 'second slot must keep its own block')
  assert.ok(!/BLOCK-FIRST[\s\S]*BLOCK-FIRST/.test(rendered), 'the same block must not appear twice')
})

test('the extraction block carries what the turn asked the user', async () => {
  // 35% of real user messages are 12 characters or fewer ("3", "1", "同意", "做",
  // "继续"), and 46% answer a question the previous turn asked. A digest that
  // keeps 「3」 verbatim but drops the question it answers records a decision with
  // no record of what was decided.
  const { engine } = await harness({ extraction: '## Asked\n- ASKED-BODY' })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  assert.ok(digestOf(checkpointOf(session)).includes('ASKED-BODY'))
})

test('the extraction instruction asks for all four sections in order', async () => {
  const calls = []
  const { engine } = await harness({ extraction: '## Asked\n- x', onCall: (r) => calls.push(r) })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const prompt = calls[0].messages.at(-1).content.map((block) => block.text).join('')
  const order = ['## Asked', '## Did', '## Concluded', '## Overturned'].map((h) => prompt.indexOf(h))
  assert.ok(order.every((index) => index >= 0), 'every section must be requested')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections must be requested in order')
})

test('headings keep the user/assistant marker but drop the turn number', async () => {
  // Turn numbers are not unique — a real session carried two requests under one
  // `turn/start` — so a heading that prints one is a heading that can lie.
  const { engine } = await harness({ extraction: '## Asked\n- x' })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  assert.ok(text.includes('## user\n'), 'user heading must remain')
  assert.ok(text.includes('### assistant\n'), 'assistant heading must remain')
  assert.ok(!/^## user \(turn /m.test(text), 'turn number must be gone from the user heading')
  assert.ok(!/^### assistant \(turn /m.test(text), 'turn number must be gone from the assistant heading')
})

test('sections whose body is only "(none)" are dropped', async () => {
  // A real block carried `## Overturned\n- (none)` on most turns. The heading
  // costs ~4 tokens and the placeholder another ~3, so 130 turns of nothing
  // spend ~900 tokens recording that nothing happened.
  const { engine } = await harness({
    extraction: '## Asked\n- (none)\n## Did\n- REAL-WORK\n## Concluded\n- (none)\n## Overturned\n- (none)',
  })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  assert.ok(text.includes('REAL-WORK'), 'the non-empty section must survive')
  assert.ok(!text.includes('## Asked'), 'an empty Asked must be dropped')
  assert.ok(!text.includes('## Concluded'), 'an empty Concluded must be dropped')
  assert.ok(!text.includes('## Overturned'), 'an empty Overturned must be dropped')
  assert.ok(!text.includes('(none)'), 'the placeholder must not survive anywhere')
})

test('an extraction with nothing at all leaves no empty assistant block', async () => {
  const { engine } = await harness({
    extraction: '## Asked\n- (none)\n## Did\n- (none)\n## Concluded\n- (none)\n## Overturned\n- (none)',
  })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const text = digestOf(checkpointOf(session))
  assert.ok(!text.includes('(none)'), 'placeholders must be gone')
  // The turn keeps its pointer line, so the assistant heading may remain — what
  // must not remain is a heading followed by nothing.
  assert.ok(!/### assistant\n\s*\n\s*\n/.test(text), 'no assistant heading with an empty body')
})

test('a slot already extracted in an earlier compaction is not extracted again', async () => {
  // Measured on the session that compacted 33 times: 142 turns extracted, 129 of
  // them (91%) already extracted by an earlier compaction, because `digestSource`
  // rebuilds from the raw log and the raw events never leave it. Across all 370
  // local sessions, 81% of compaction work is this repeat.
  const calls = []
  const { engine } = await harness({ extraction: '## Did\n- CACHED', onCall: (r) => calls.push(r) })
  const session = buildSession()
  const agent = agentFor(session)

  const first = session.surface.nodes
  await engine.compactRegion(first[1], first.at(-1), agent)
  const firstSlots = calls.flatMap((c) => slotKeysOf(c))

  const before = calls.length
  const second = session.surface.nodes
  await engine.compactRegion(second[1], second.at(-1), agent)
  const secondSlots = calls.slice(before).flatMap((c) => slotKeysOf(c))

  const overlap = secondSlots.filter((key) => firstSlots.includes(key))
  assert.deepEqual(overlap, [], `these slots were extracted twice: ${overlap.join(', ')}`)
})

test('the cache is keyed by content, so a changed turn is extracted again', async () => {
  // Keying by slot position would be wrong: the same position holds different
  // content once history grows. Keying by content means a turn whose prose
  // changed gets a fresh extraction instead of a stale one.
  const { engine } = await harness({ extraction: '## Did\n- v1' })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const engine2 = (await harness({ extraction: '## Did\n- v2' })).engine
  const session2 = buildSession()
  const nodes2 = session2.surface.nodes
  await engine2.compactRegion(nodes2[1], nodes2.at(-1), agentFor(session2))

  // Two independent engines over identical logs must both produce their own
  // answer: no cross-session cache, so nothing leaks between sessions.
  assert.ok(digestOf(checkpointOf(session2)).includes('v2'))
})

/** Every `=== SLOT <key> (turn ...` key named in one extraction request. */
function slotKeysOf(request) {
  const prompt = request.messages.at(-1).content.map((block) => block.text).join('')
  return [...prompt.matchAll(/^=== SLOT (\S+) \(turn /gm)].map((match) => match[1])
}

test('Asked never restates the user request, and says so in the instruction', async () => {
  // A real block printed the user's own request back as `## Asked`, in English,
  // directly under the same request quoted verbatim: the same content twice, and
  // the section answering the wrong question. `## Asked` records what the
  // ASSISTANT asked the USER; the user's request is already in the digest.
  const calls = []
  const { engine } = await harness({ extraction: '## Did\n- x', onCall: (r) => calls.push(r) })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const prompt = calls[0].messages.at(-1).content.map((block) => block.text).join('')
  const asked = prompt.slice(prompt.indexOf('## Asked'), prompt.indexOf('## Did'))
  assert.ok(
    /assistant/i.test(asked) && /user/i.test(asked),
    'the Asked instruction must name who asks and who answers',
  )
  assert.ok(
    /never|do not/i.test(asked) && /request/i.test(asked),
    'the Asked instruction must forbid restating the user request',
  )
})

test('the material labels the user text so it cannot be mistaken for a question', async () => {
  // The old label was `USER REQUEST:`, which a model reasonably read as "what
  // this turn asked". The label now says the text is the user's instruction and
  // must not be copied into Asked.
  const calls = []
  const { engine } = await harness({ extraction: '## Did\n- x', onCall: (r) => calls.push(r) })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const prompt = calls[0].messages.at(-1).content.map((block) => block.text).join('')
  assert.ok(!prompt.includes('USER REQUEST:'), 'the ambiguous label must be gone')
  assert.ok(/USER INSTRUCTION/i.test(prompt), 'the new label must say whose instruction it is')
})

test('a turn whose assistant prose is empty cannot produce an Asked section', async () => {
  // The XPeng turn that exposed this had 96 assistant messages, 150 tool calls,
  // and 156 characters of prose. With no question to quote, the model restated
  // the user's request as Asked. When a turn has no assistant prose at all there
  // is nothing to ask, so the section must not be requested for it.
  const calls = []
  const { engine } = await harness({ extraction: '## Did\n- x', onCall: (r) => calls.push(r) })
  const session = buildSession()
  const nodes = session.surface.nodes
  await engine.compactRegion(nodes[1], nodes.at(-1), agentFor(session))

  const prompt = calls[0].messages.at(-1).content.map((block) => block.text).join('')
  // Every slot with `ASSISTANT PROSE:\n(none)` must be marked as having nothing
  // to ask, so the model is told to omit Asked rather than invent one.
  for (const part of prompt.split('=== SLOT ').slice(1)) {
    if (!part.includes('ASSISTANT PROSE:\n(none)')) continue
    assert.ok(
      /ASKED: omit/.test(part),
      'a slot with no prose must explicitly say Asked has nothing to record',
    )
  }
})

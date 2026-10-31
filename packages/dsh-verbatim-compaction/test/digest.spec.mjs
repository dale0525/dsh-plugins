import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESSION_FORMAT_VERSION, Session } from '@deepseek-ai/dsh-session'
import { buildSections, digestSource, renderDigest, shadowedSeqs } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Load the sanitized fixture log and build a live Session over it. */
function fixture() {
  const text = readFileSync(join(here, 'fixtures', 'session.jsonl'), 'utf8')
  const events = text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
  const header = { version: SESSION_FORMAT_VERSION, id: 'fixture', createdAt: 1, isSeeded: false }
  const session = Session.create('fixture', events, header, 0)
  return { events, session }
}

test('buildSections starts one section per request, user or goal', () => {
  // A goal round opens a section too: it carries the objective the turn serves,
  // and a goal-triggered turn has no user message of its own. Duplicate
  // objectives collapse, because the host re-injects the same one every round.
  const { events } = fixture()
  const sections = buildSections(events)
  const requests = new Set()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const kind = event.data.source?.kind
    if (kind === 'user') requests.add(event.data.content[0].text)
    else if (kind === 'goal') requests.add(/Objective:\s*"([\s\S]*?)"/.exec(event.data.content[0].text)?.[1] ?? '')
  }
  assert.equal(sections.length, requests.size)
  assert.ok(sections.length > 1)
})

test('buildSections reads turn numbers from the log', () => {
  const { events } = fixture()
  const turns = buildSections(events).flatMap((section) => section.turns.map((turn) => turn.turn))
  assert.ok(turns.every((turn) => typeof turn === 'number'), 'no heading may render as "turn ?"')
  assert.deepEqual(turns, [...turns].sort((left, right) => left - right), 'turn numbers must not go backwards')
})

test('reasoning never reaches the digest', () => {
  const { events } = fixture()
  const digest = renderDigest(events, 196752)
  assert.ok(digest.includes('ASSISTANT-'))
  assert.ok(!digest.includes('REASONING-SHOULD-NEVER-APPEAR'))
})

test('user and assistant prose appear verbatim', () => {
  const { events } = fixture()
  const digest = renderDigest(events, 196752)
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event.data.source?.kind === 'goal') continue
    const text = event.data.content.find((block) => block.type === 'text').text
    assert.ok(digest.includes(text), `user prose missing: ${text.slice(0, 40)}`)
  }
})

test('tool results contribute no content and no pointer line', () => {
  // The pointer line was removed: it restated `## Did` at 1202 tokens per
  // 122-turn session, and the extraction already receives every call's
  // description, so the line added only counts and byte totals.
  const { events } = fixture()
  const digest = renderDigest(events, 196752)
  assert.ok(!/ {2}tools: /.test(digest), 'the pointer line must be gone')
  assert.ok(!digest.includes('TOOL-OUTPUT'), 'tool output content must never appear')
})

test('tool errors surface as a first-line pointer', () => {
  const { events } = fixture()
  const digest = renderDigest(events, 196752)
  if (events.some((event) => event.type === 'tool/result' && event.data.message.isError === true)) {
    assert.ok(/ {2}errors: \d+: /.test(digest))
  }
})

test('the digest is deterministic', () => {
  const { events } = fixture()
  assert.equal(renderDigest(events, 196752), renderDigest(events, 196752))
})

test('truncation always keeps the newest user request and drops the oldest', () => {
  const { events } = fixture()
  // Goal messages are recorded as their objective, so the "newest request" here
  // is the last human message; goal rounds sit after it in the fixture and are
  // not part of this budget walk.
  const userTexts = events
    .filter((event) => event.type === 'user/message' && event.data.source?.kind === 'user')
    .map((event) => event.data.content[0].text)

  // The newest request is what the next turn depends on, so every budget must
  // keep it, and every budget below the whole digest must have dropped something
  // older than it.
  // Budgets far below the user text, so T1 must actually cut.
  for (const budget of [100, 200, 300]) {
    const digest = renderDigest(events, budget)
    assert.ok(digest.includes(userTexts.at(-1)), `newest user request lost at budget ${budget}`)
    assert.ok(!digest.includes(userTexts[0]), `oldest user request kept at budget ${budget}`)
  }

  // The default budget is far above the digest, so nothing is touched at all.
  const full = renderDigest(events, 196752)
  assert.deepEqual(userTexts.filter((text) => !full.includes(text)), [])
})

test('the digest never exceeds its budget, however small', () => {
  const { events } = fixture()
  for (const budget of [40, 100, 250, 700]) {
    assert.ok(renderDigest(events, budget).length <= budget * 4, `budget ${budget} overrun`)
  }
})

test('a log with no turn/start markers still renders every user message', () => {
  // Headings no longer carry a turn number, so a missing marker no longer has a
  // degraded branch to show. What must still hold is that nothing is lost.
  const { events } = fixture()
  const stripped = events.filter((event) => event.type !== 'turn/start')
  const digest = renderDigest(stripped, 196752)
  assert.ok(digest.length > 0)
  for (const event of stripped) {
    if (event.type !== 'user/message') continue
    if (event.data.source?.kind === 'goal') continue
    const text = event.data.content.find((block) => block.type === 'text').text
    assert.ok(digest.includes(text), 'a missing marker must not lose prose')
  }
})

test('digestSource excludes the retained tail and every checkpoint', () => {
  const { events, session } = fixture()
  const retained = new Set(session.surface.nodes.slice(-3))
  const source = digestSource(session, retained)
  for (const event of source) {
    if (event.type === 'turn/start') continue
    assert.equal(event.surfaceOp, 'append')
    assert.ok(!retained.has(event.seq))
    assert.notEqual(event.data?.source?.kind, 'compact-checkpoint')
  }
  assert.ok(source.length > 0)
})

test('shadowedSeqs recovers the span from the message count', () => {
  const { events, session } = fixture()
  const nodes = session.surface.nodes
  const head = events.find((event) => event.type === 'system/message')
  const region = nodes.slice(1, 4)
  const input = {
    messages: [session.deriveEventMessage(head), ...region.map((seq) => session.deriveEventMessage(session.eventAt(seq)))],
  }
  assert.deepEqual(shadowedSeqs(session, input), region)
})

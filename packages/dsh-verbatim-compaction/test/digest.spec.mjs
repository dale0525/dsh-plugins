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

test('buildSections starts one section per non-injected user message', () => {
  const { events } = fixture()
  const sections = buildSections(events)
  const userMessages = events.filter((event) => event.type === 'user/message')
  assert.equal(sections.length, userMessages.length)
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
    const text = event.data.content.find((block) => block.type === 'text').text
    assert.ok(digest.includes(text), `user prose missing: ${text.slice(0, 40)}`)
  }
})

test('tool results collapse to one pointer line, not their content', () => {
  const { events } = fixture()
  const digest = renderDigest(events, 196752)
  assert.ok(/ {2}tools: .+\(\d+ bytes\)/.test(digest))
  assert.ok(!digest.includes('TOOL-OUTPUT'))
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

test('a tight budget truncates assistant prose before user prose', () => {
  const { events } = fixture()
  const full = renderDigest(events, 196752)
  // Enough for every user message plus headings, far too little for the assistant prose.
  const userChars = events
    .filter((event) => event.type === 'user/message')
    .reduce((total, event) => total + event.data.content[0].text.length, 0)
  const tight = renderDigest(events, Math.ceil((userChars + 1500) / 4))
  assert.ok(tight.length < full.length)
  assert.ok(/…\(\+\d+ chars\)/.test(tight), 'assistant prose should be the first thing cut')
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = event.data.content.find((block) => block.type === 'text').text
    assert.ok(tight.includes(text), `user prose must survive assistant truncation: ${text.slice(0, 40)}`)
  }
})

test('the digest never exceeds its budget, however small', () => {
  const { events } = fixture()
  for (const budget of [40, 100, 250, 700]) {
    assert.ok(renderDigest(events, budget).length <= budget * 4, `budget ${budget} overrun`)
  }
})

test('a log with no turn/start markers still renders, labelling turns "?"', () => {
  const { events } = fixture()
  const stripped = events.filter((event) => event.type !== 'turn/start')
  const digest = renderDigest(stripped, 196752)
  assert.ok(digest.length > 0)
  assert.ok(digest.includes('(turn ?)'), 'the degraded branch must be visible, not silently wrong')
  for (const event of stripped) {
    if (event.type !== 'user/message') continue
    const text = event.data.content.find((block) => block.type === 'text').text
    assert.ok(digest.includes(text), 'degraded labelling must not lose prose')
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

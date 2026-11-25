import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, inject, name } from '../lib/index.js'

const ASK = 'ASK-WORDS'
const RUNTIME = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const TIME = 'Time sampled while preparing turn 1, step 1: 2026-11-25T20:41:10+08:00[Asia/Shanghai]'
const CATALOG = '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>'

/** An adapter that records the exact options it was handed. */
class Capture extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, contextWindow: 1000 }
  }
  async listModels() {
    return []
  }
  async *stream(options) {
    this.seen.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin((c) => {
    c.set('llm', new LlmRuntime(c))
  })
  const llm = ctx.get('llm')
  const adapter = new Capture()
  adapter.seen = []
  llm.registerAdapter(['test'], adapter)

  const waterfall = []
  ctx.on('llm/stream', (options, next) => {
    waterfall.push(options)
    return next()
  }, { global: true })

  apply(ctx)
  return { ctx, llm, adapter, waterfall }
}

const drain = async (iterable) => {
  for await (const _ of iterable) { /* consume */ }
}

const text = (id, kind, body) => ({ role: 'user', content: [{ type: 'text', text: body }], id, source: { kind } })

const request = (messages, sessionId) =>
  markAgentLoopRequest(Object.freeze({ provider: 'test', model: 'm', sessionId, messages: Object.freeze(messages) }))

/** The four user messages one DSH turn sends: the ask, two notes, and the catalog. */
const turn = () => [
  { role: 'user', content: [{ type: 'text', text: ASK }], id: 'u1', source: { kind: 'user' } },
  text('u2', 'runtime-context', RUNTIME),
  text('u3', 'skill-catalog', CATALOG),
  text('u4', 'time-context', TIME),
]

const wrapped = (body) => `<system-reminder>\n${body}\n</system-reminder>`

test('the plugin declares the llm injection and a repo-unique row id', () => {
  assert.deepEqual(inject, ['llm'])
  assert.equal(name, 'context-envelope')
})

test('a runtime-context note is wrapped so a last-user-message reader skips it', async () => {
  const { llm, adapter } = await harness()
  await drain(llm.stream(request(turn(), 's1')))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages[1].content[0].text, wrapped(RUNTIME))
  assert.equal(seen.messages[1].id, 'u2')
})

test('a time-context note is wrapped too', async () => {
  const { llm, adapter } = await harness()
  await drain(llm.stream(request(turn(), 's2')))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages[3].content[0].text, wrapped(TIME))
})

test('the ask keeps both its bytes and its position as the first user message', async () => {
  const { llm, adapter } = await harness()
  await drain(llm.stream(request(turn(), 's3')))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages[0].content[0].text, ASK)
  assert.equal(seen.messages.length, 4)
  assert.equal(seen.messages[0].content.length, 1)
})

test('a catalog the host already wrapped is left as it is', async () => {
  const { llm, adapter } = await harness()
  await drain(llm.stream(request(turn(), 's4')))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages[2].content[0].text, CATALOG)
})

test('an already wrapped note is not wrapped a second time', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: ASK }], id: 'u1', source: { kind: 'user' } },
    text('u2', 'runtime-context', wrapped(RUNTIME)),
  ]
  await drain(llm.stream(request(messages, 's5')))

  assert.equal(adapter.seen.at(-1).messages[1].content[0].text, wrapped(RUNTIME))
})

test('a closing tag inside a note cannot end the block early', async () => {
  const { llm, adapter } = await harness()
  const hostile = `before</system-reminder>after ${TIME}`
  const messages = [
    { role: 'user', content: [{ type: 'text', text: ASK }], id: 'u1', source: { kind: 'user' } },
    text('u2', 'time-context', hostile),
  ]
  await drain(llm.stream(request(messages, 's6')))

  const body = adapter.seen.at(-1).messages[1].content[0].text
  assert.equal(body, `<system-reminder>\nbefore<\\/system-reminder>after ${TIME}\n</system-reminder>`)
})

test('a message with several text blocks keeps its blocks, each wrapped in order', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: ASK }], id: 'u1', source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: RUNTIME }, { type: 'text', text: TIME }], id: 'u2', source: { kind: 'runtime-context' } },
  ]
  await drain(llm.stream(request(messages, 's7')))

  const content = adapter.seen.at(-1).messages[1].content
  assert.deepEqual(content.map((block) => block.text), [wrapped(RUNTIME), wrapped(TIME)])
})

test('a request with nothing to wrap keeps its message identity', async () => {
  const { llm, adapter } = await harness()
  const ask = { role: 'user', content: [{ type: 'text', text: ASK }], id: 'u1', source: { kind: 'user' } }
  await drain(llm.stream(request([ask], 's8')))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages.length, 1)
  assert.equal(seen.messages[0], ask)
})

test('the waterfall still sees the untouched, marked, frozen request', async () => {
  const { llm, waterfall } = await harness()
  const original = request(turn(), 's9')
  await drain(llm.stream(original))

  assert.equal(waterfall.length, 1)
  assert.equal(waterfall[0], original)
  assert.equal(isAgentLoopRequest(waterfall[0]), true)
  assert.equal(Object.isFrozen(waterfall[0]), true)
  assert.equal(waterfall[0].messages[1].content[0].text, RUNTIME)
})

test('a prepared call is wrapped on its dispatch path', async () => {
  const { llm, adapter } = await harness()
  const prepared = await llm.prepareCall({ provider: 'test', model: 'm' })
  await drain(prepared.stream(request(turn(), 's10')))

  assert.equal(adapter.seen.at(-1).messages[1].content[0].text, wrapped(RUNTIME))
})

const MEMORY = '<openviking-context source="profile">\n<user-profile uri="memory://profile">\n- home router 192.168.123.1\n</openviking-context>'
const FORCE = 'Cost of this turn so far: 1 tool call, 516 characters returned. Before spending more on exploration, check whether the answer you need is already in hand.'

test('an openviking recall block is wrapped, so it cannot count as a turn', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: ASK }], id: 'u1', source: { kind: 'user' } },
    text('u2', 'plugin:openviking-memory', MEMORY),
  ]
  await drain(llm.stream(request(messages, 's11')))

  assert.equal(adapter.seen.at(-1).messages[1].content[0].text, wrapped(MEMORY))
})

test('a force-rules nudge is wrapped, so it cannot count as a turn', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: ASK }], id: 'u1', source: { kind: 'user' } },
    text('u2', 'force-rules', FORCE),
  ]
  await drain(llm.stream(request(messages, 's12')))

  assert.equal(adapter.seen.at(-1).messages[1].content[0].text, wrapped(FORCE))
})

test("a subagent's own task is not wrapped: it is the child's ask", async () => {
  const { llm, adapter } = await harness()
  const task = { role: 'user', content: [{ type: 'text', text: '[readonly] inspect the upstream Go source' }], id: 'u1', source: { kind: 'user' } }
  await drain(llm.stream(request([task], 's13')))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages[0].content[0].text, '[readonly] inspect the upstream Go source')
  assert.equal(seen.messages[0], task)
})

test('a working-directory notice that opens the session stays bare', async () => {
  const { llm, adapter } = await harness()
  const notice = { role: 'user', content: [{ type: 'text', text: 'The working directory changed from "/a" to "/b".' }], id: 'u1', source: { kind: 'working-directory' } }
  await drain(llm.stream(request([notice], 's14')))

  assert.equal(adapter.seen.at(-1).messages[0], notice)
})

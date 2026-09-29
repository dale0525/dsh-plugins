import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, inject, name } from '../lib/index.js'

const COT = 'SECRET-COT'
const ONLY_COT = 'ONLY-COT'

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

/**
 * Build a live llm runtime, install the plugin, and return the capture adapter
 * plus a drain helper that runs one request end to end.
 */
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

const replay = (blocks) => ({
  blocks,
  response: { api: 'openai-completions', provider: 'test', model: 'm', stopReason: 'stop' },
})

const replayedAssistant = (id, content, blocks) => ({
  role: 'assistant',
  content,
  id,
  source: { kind: 'model', provider: 'test', model: 'm', replayState: replay(blocks) },
})

const userText = (id, text) => ({ role: 'user', content: [{ type: 'text', text }], id, source: { kind: 'user' } })

/** One assistant turn carrying reasoning plus a visible answer. */
const reasoningHistory = () => [
  userText('u1', 'question'),
  replayedAssistant(
    'a1',
    [{ type: 'reasoning', text: COT }, { type: 'text', text: 'the answer' }],
    [{ type: 'reasoning', thinkingSignature: 'sig-1' }, { type: 'text' }],
  ),
]

const request = (messages, sessionId) =>
  markAgentLoopRequest(Object.freeze({ provider: 'test', model: 'm', sessionId, messages: Object.freeze(messages) }))

test('the plugin declares the llm injection and a repo-unique row id', () => {
  assert.deepEqual(inject, ['llm'])
  assert.equal(name, 'reasoning-strip')
})

test('replayed reasoning never reaches the adapter, but the answer does', async () => {
  const { llm, adapter } = await harness()
  const messages = reasoningHistory()
  await drain(llm.stream(request(messages, 's1')))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages.length, 2)
  const assistant = seen.messages[1]
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'the answer' }])
  assert.equal(JSON.stringify(seen).includes(COT), false)
})

test('a message left empty by stripping is dropped from the request', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    userText('u1', 'question'),
    replayedAssistant('a1', [{ type: 'reasoning', text: ONLY_COT }], [{ type: 'reasoning', thinkingSignature: 'sig-2' }]),
    userText('u2', 'next'),
  ]
  await drain(llm.stream(request(messages, 's2')))

  const seen = adapter.seen.at(-1)
  assert.deepEqual(seen.messages.map((message) => message.id), ['u1', 'u2'])
  assert.equal(JSON.stringify(seen).includes(ONLY_COT), false)
})

test('replay blocks stay aligned with the surviving content', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    userText('u1', 'question'),
    replayedAssistant(
      'a1',
      [
        { type: 'reasoning', text: COT },
        { type: 'text', text: 'the answer' },
        { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{}' },
      ],
      [{ type: 'reasoning', thinkingSignature: 'sig-3' }, { type: 'text', textSignature: 'ts' }, { type: 'tool-call' }],
    ),
    { role: 'tool', content: [{ type: 'text', text: 'result' }], id: 't1', source: { kind: 'tool', callId: 'call_1' } },
  ]
  await drain(llm.stream(request(messages, 's3')))

  const assistant = adapter.seen.at(-1).messages[1]
  assert.deepEqual(assistant.content.map((block) => block.type), ['text', 'tool-call'])
  assert.equal(assistant.content[1].id, 'call_1')
  const blocks = assistant.source.replayState.blocks
  assert.equal(blocks.length, assistant.content.length)
  assert.deepEqual(blocks.map((block) => block.type), ['text', 'tool-call'])
  assert.equal(blocks[0].textSignature, 'ts')
  assert.equal(adapter.seen.at(-1).messages[2].role, 'tool')
})

test('replay metadata that cannot be realigned is dropped, not replayed stale', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    userText('u1', 'question'),
    {
      role: 'assistant',
      content: [{ type: 'reasoning', text: COT }, { type: 'text', text: 'answer' }],
      id: 'a1',
      source: { kind: 'model', provider: 'test', model: 'm', replayState: { response: { api: 'x', provider: 'test', model: 'm', stopReason: 'stop' } } },
    },
  ]
  await drain(llm.stream(request(messages, 's4')))

  const assistant = adapter.seen.at(-1).messages[1]
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'answer' }])
  assert.equal('replayState' in assistant.source, false)
})

test('reasoning-free history is passed through untouched', async () => {
  const { llm, adapter } = await harness()
  const messages = [
    userText('u1', 'question'),
    { role: 'assistant', content: [{ type: 'text', text: 'the answer' }], id: 'a1', source: { kind: 'model', provider: 'test', model: 'm' } },
  ]
  const frozen = Object.freeze(messages)
  const original = request(frozen, 's5')
  await drain(llm.stream(original))

  const seen = adapter.seen.at(-1)
  assert.equal(seen.messages[0], messages[0])
  assert.equal(seen.messages[1], messages[1])
})

test('the waterfall still sees the untouched, marked, frozen request', async () => {
  const { llm, waterfall } = await harness()
  const messages = reasoningHistory()
  const original = request(messages, 's6')
  await drain(llm.stream(original))

  assert.equal(waterfall.length, 1)
  assert.equal(waterfall[0], original)
  assert.equal(isAgentLoopRequest(waterfall[0]), true)
  assert.equal(Object.isFrozen(waterfall[0]), true)
  assert.equal(waterfall[0].messages[1].content.some((block) => block.type === 'reasoning'), true)
})

test('a prepared call is stripped on its dispatch path', async () => {
  const { llm, adapter } = await harness()
  const messages = reasoningHistory()
  const prepared = await llm.prepareCall({ provider: 'test', model: 'm' })
  await drain(prepared.stream(request(messages, 's7')))

  const seen = adapter.seen.at(-1)
  assert.deepEqual(seen.messages[1].content, [{ type: 'text', text: 'the answer' }])
  assert.equal(JSON.stringify(seen).includes(COT), false)
})

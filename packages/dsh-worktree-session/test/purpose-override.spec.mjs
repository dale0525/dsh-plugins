import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  Config,
  applyPurposeOverride,
  chooseNameForTest,
  pairedRouteOf,
} from '../lib/index.js'

const ref = (value) => ({ get: () => value })

test('Config exposes exactly the three editable override scalars', () => {
  const fields = Object.keys(Config.dict)
  assert.deepEqual(fields, ['provider', 'model', 'reasoningEffort'])
  for (const field of fields) assert.equal(Config.dict[field].meta.volatile, true)
})

test('an empty configuration and an incomplete route leave the chat route alone', () => {
  const base = { provider: 'chat-provider', model: 'chat-model', maxTokens: 24 }
  assert.deepEqual(applyPurposeOverride(base, {}), base)
  assert.deepEqual(applyPurposeOverride(base, { provider: ref('other') }), base)
  assert.deepEqual(applyPurposeOverride(base, { model: ref('other') }), base)
  assert.equal(pairedRouteOf({ provider: ref('other') }), undefined)
})

test('a complete route is applied as a pair and a configured effort wins', () => {
  const base = { provider: 'chat-provider', model: 'chat-model', maxTokens: 24 }
  assert.deepEqual(applyPurposeOverride(base, {
    provider: ref('aliyun'),
    model: ref('qwen-max'),
    reasoningEffort: ref('off'),
  }), {
    provider: 'aliyun',
    model: 'qwen-max',
    maxTokens: 24,
    reasoningEffort: 'off',
  })
})

test('a failed naming call still falls back to a random branch name', async () => {
  const llm = { stream: async function* () { throw new Error('offline') } }
  const chosen = await chooseNameForTest(llm, { options: { provider: 'p', model: 'm' } }, 'hello', AbortSignal.timeout(50))
  assert.equal(chosen.startsWith('worktree-'), true)
})

/** An LLM stand-in answering each call with the next scripted reply. */
function scripted(replies) {
  const calls = []
  return {
    calls,
    stream: async function* (options) {
      calls.push(options)
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
      if (reply.text !== '') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
      }
      yield { type: 'finish', reason: reply.reason ?? { kind: 'stop' } }
    },
  }
}

const agent = { options: { provider: 'p', model: 'm' } }

test('the naming call leaves room for a model that thinks before answering', async () => {
  // 24 tokens are consumed entirely by the gateway's reasoning content, so the
  // reply body never arrives and every branch falls back to a random name.
  const llm = scripted([{ text: 'fix-app-reconnect' }])
  const chosen = await chooseNameForTest(llm, agent, 'hello', AbortSignal.timeout(50))
  assert.equal(chosen, 'fix-app-reconnect')
  assert.ok(llm.calls[0].maxTokens > 24, `maxTokens was ${llm.calls[0].maxTokens}`)
})

test('a reply in another script is asked again instead of being truncated to a fragment', async () => {
  const llm = scripted([{ text: '自研app车控接入米家调研' }, { text: 'mijia-vehicle-control' }])
  const chosen = await chooseNameForTest(llm, agent, 'hello', AbortSignal.timeout(50))
  assert.equal(chosen, 'mijia-vehicle-control')
  assert.equal(llm.calls.length, 2)
  assert.match(llm.calls[1].system, /English/)
})

test('a second unusable reply falls back rather than reusing the fragment', async () => {
  const llm = scripted([{ text: '自研app车控接入米家调研' }, { text: '把车辆型号做批量映射' }])
  const chosen = await chooseNameForTest(llm, agent, 'hello', AbortSignal.timeout(50))
  assert.equal(chosen.startsWith('worktree-'), true)
  assert.equal(llm.calls.length, 2)
})

test('a truncated reply is not accepted as a name', async () => {
  const llm = scripted([{ text: 'app-widget', reason: { kind: 'max-tokens' } }, { text: 'app-widget-design' }])
  const chosen = await chooseNameForTest(llm, agent, 'hello', AbortSignal.timeout(50))
  assert.equal(chosen, 'app-widget-design')
  assert.equal(llm.calls.length, 2)
})

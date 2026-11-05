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

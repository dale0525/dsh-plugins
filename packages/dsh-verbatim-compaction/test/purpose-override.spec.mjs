import { test } from 'node:test'
import assert from 'node:assert/strict'

import VerbatimCompactionEngine, {
  applyPurposeOverride,
  pairedRouteOf,
} from '../lib/index.js'

test('static Config keeps the base-class keys and adds three editable override scalars', () => {
  const fields = Object.keys(VerbatimCompactionEngine.Config.dict)
  assert.ok(fields.includes('thresholdRatio'))
  assert.ok(fields.includes('summarizationProvider'))
  assert.deepEqual(fields.filter((key) => ['provider', 'model', 'reasoningEffort'].includes(key)), [
    'provider', 'model', 'reasoningEffort',
  ])
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    assert.equal(VerbatimCompactionEngine.Config.dict[key].meta.volatile, true)
  }
})

test('an empty configuration preserves the resolved route and the cheapest effort', () => {
  const base = { provider: 'chat-provider', model: 'chat-model', purpose: 'compaction' }
  const withCheapest = { ...base, reasoningEffort: 'low' }
  assert.deepEqual(applyPurposeOverride(base, {}, 'low'), withCheapest)
  assert.deepEqual(applyPurposeOverride(base, { provider: { get: () => 'other' } }, 'low'), withCheapest)
})

test('a complete route replaces both fields and a configured effort replaces the cheapest', () => {
  const base = { provider: 'chat-provider', model: 'chat-model', purpose: 'compaction' }
  assert.deepEqual(applyPurposeOverride(base, {
    provider: { get: () => 'aliyun' },
    model: { get: () => 'qwen-max' },
    reasoningEffort: { get: () => 'off' },
  }, 'low'), {
    provider: 'aliyun',
    model: 'qwen-max',
    purpose: 'compaction',
    reasoningEffort: 'off',
  })
})

test('a configured route without an effort keeps the cheapest effort', () => {
  const base = { provider: 'chat-provider', model: 'chat-model' }
  assert.deepEqual(applyPurposeOverride(base, {
    provider: { get: () => 'aliyun' },
    model: { get: () => 'qwen-max' },
    reasoningEffort: { get: () => '' },
  }, 'low'), {
    provider: 'aliyun',
    model: 'qwen-max',
    reasoningEffort: 'low',
  })
  assert.equal(pairedRouteOf({ provider: { get: () => 'aliyun' } }), undefined)
})

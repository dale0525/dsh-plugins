import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  Config,
  apply,
  getLiveConfig,
  name,
  setLiveConfig,
} from '../lib/purpose.js'

const ref = (value) => ({ get: () => value })

test('the purpose settings row is a standalone volatile schema', () => {
  assert.equal(name, 'verbatim-compaction-purpose')
  assert.deepEqual(Object.keys(Config.dict).sort(), ['model', 'provider', 'reasoningEffort'])
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    assert.equal(Config.dict[key].meta.volatile, true)
    assert.equal(Config.dict[key].meta.default, '')
  }
})

test('the root-realm row publishes its live config to the isolated compaction engine', () => {
  const config = { provider: ref('aliyun'), model: ref('qwen-max'), reasoningEffort: ref('off') }
  apply({}, config)
  assert.equal(getLiveConfig(), config)

  const replacement = { provider: ref(''), model: ref(''), reasoningEffort: ref('') }
  setLiveConfig(replacement)
  assert.equal(getLiveConfig(), replacement)
})

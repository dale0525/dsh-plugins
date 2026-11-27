import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chooseNameForTest } from '../lib/index.js'

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

const agent = { options: { provider: 'session-provider', model: 'session-model' } }

test('the naming call uses the conversation\'s own route, with no second model configured', async () => {
  const llm = scripted([{ text: 'fix-app-reconnect' }])
  const chosen = await chooseNameForTest(llm, agent, 'hello', AbortSignal.timeout(50))
  assert.equal(chosen, 'fix-app-reconnect')
  assert.equal(llm.calls[0].provider, 'session-provider')
  assert.equal(llm.calls[0].model, 'session-model')
  assert.equal('reasoningEffort' in llm.calls[0], false)
})

test('a failed naming call still falls back to a random branch name', async () => {
  const llm = { stream: async function* () { throw new Error('offline') } }
  const chosen = await chooseNameForTest(llm, agent, 'hello', AbortSignal.timeout(50))
  assert.equal(chosen.startsWith('worktree-'), true)
})

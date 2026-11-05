/**
 * Shorthand model ids: the row id may be a gateway's shortened stem of a
 * registered pattern ("hy4" for "hy4-preview"). The fallback only runs after
 * both strings miss the exact and substring tiers, requires a whole-token
 * prefix, and refuses to guess when more than one entry could own it.
 */

import { describe, expect, it } from 'vitest'
import { matchKnowledgeBase } from '../src/knowledge.js'

describe('shorthand model-id matching', () => {
  it('resolves a unique token-prefix shorthand', () => {
    expect(matchKnowledgeBase('hy4')?.id).toBe('hunyuan-hy4')
    expect(matchKnowledgeBase('hy-4')?.id).toBe('hunyuan-hy4')
  })

  it('resolves a shorthand through the second string', () => {
    expect(matchKnowledgeBase('relay-invented-id', 'hy4')?.id).toBe('hunyuan-hy4')
  })

  it('refuses ambiguous stems instead of guessing', () => {
    expect(matchKnowledgeBase('gpt-5')?.id).toBe('openai-gpt-5')
    expect(matchKnowledgeBase('deepseek-v4')?.id).toBe('deepseek-v4')
    expect(matchKnowledgeBase('qwen3.8')?.id).toBe('qwen-3-8')
    expect(matchKnowledgeBase('deepseek')).toBeUndefined()
  })

  it('does not turn a partial token into a prefix match', () => {
    expect(matchKnowledgeBase('o')).toBeUndefined()
    expect(matchKnowledgeBase('hy')).toBeUndefined()
  })

  it('keeps the exact tier ahead of the shorthand fallback', () => {
    expect(matchKnowledgeBase('anthropic/claude-4.5-opus-20251124')?.id).toBe('anthropic-claude-opus-4-5')
    expect(matchKnowledgeBase('hy4-preview')?.id).toBe('hunyuan-hy4')
  })
})

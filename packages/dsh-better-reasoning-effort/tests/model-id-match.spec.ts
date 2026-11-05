/**
 * Exact/canonical model-id matching. The row id and its mapped/display id
 * are matched separately: the row id wins, and only when both miss the exact
 * tier does the family substring ladder answer.
 *
 * The offline catalog registers literal spellings (vendor ids, canonical
 * slugs, provider-qualified forms). Suffixes like :batch / -latest / dates
 * only hit exactly when explicitly listed, never by a general strip rule.
 */

import { describe, expect, it } from 'vitest'
import { matchKnowledgeBase } from '../src/knowledge.js'

describe('canonical model-id matching', () => {
  it('resolves a vendor canonical slug the family ladder misroutes', () => {
    // OpenRouter's canonical_slug for Claude Opus 4.5; the substring ladder
    // used to fall through to the generic 'anthropic-claude' entry.
    expect(matchKnowledgeBase('anthropic/claude-4.5-opus-20251124')?.id).toBe('anthropic-claude-opus-4-5')
  })

  it('lets the row id win over a longer mapped string', () => {
    // The joined-haystack matcher used to let 'claude-opus-5' (from the
    // second string) outrank 'gpt-5.2' (from the row id).
    expect(matchKnowledgeBase('gpt-5.2', 'anthropic/claude-opus-5.5-20260921')?.id).toBe('openai-gpt-5-2')
  })

  it('matches through the second (mapped/display) string when the row id is opaque', () => {
    expect(matchKnowledgeBase('cpa-relay-x', 'anthropic/claude-4.5-opus-20251124')?.id).toBe('anthropic-claude-opus-4-5')
  })

  it('keeps the family fallback for an unregistered variant', () => {
    expect(matchKnowledgeBase('claude-opus-5-5:batch')?.id).toBe('anthropic-claude-5')
    expect(matchKnowledgeBase('relay-xyz', 'anthropic/claude-opus-5.5-20260921:batch')?.id).toBe('anthropic-claude-5')
  })

  it('keeps the longest-boundary family fallback unchanged', () => {
    expect(matchKnowledgeBase('deepseek-chat')?.id).toBe('deepseek-v3')
    expect(matchKnowledgeBase('qwen3.8-27b')?.id).toBe('qwen-3-8-27b')
  })
})

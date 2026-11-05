/**
 * Purpose-override contract tests.
 *
 * They validate the same exported functions the footer editor uses, so a
 * regression cannot hide behind a test-local copy of the parsing algorithm.
 */

import { describe, expect, it } from 'vitest'
import {
  PURPOSE_NAMESPACES,
  applyPurposeOverride,
  configuredModelsOf,
  effortsOf,
  overrideOf,
  pairedRoute,
  purposeOps,
  purposeStateOf,
  revisionOf,
} from '../src/purpose-overrides.js'

/** A describe envelope with one user-configured route and two override rows. */
function describeFixture() {
  return {
    writable: true,
    namespaces: [
      {
        ns: 'llm-pi-ai',
        revision: 2,
        value: { providers: { builtin: { models: [{ id: 'catalog-only' }] } } },
        user: {
          providers: {
            aliyun: {
              models: [
                { id: 'qwen-max', reasoningEfforts: { off: null, low: 'low', high: 'high' } },
                { id: 'qwen-turbo', reasoningEfforts: false },
                { name: 'id omitted' },
              ],
            },
          },
        },
      },
      {
        ns: PURPOSE_NAMESPACES.compaction,
        revision: 7,
        value: { provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'low' },
      },
      {
        ns: PURPOSE_NAMESPACES.worktreeBranch,
        revision: 9,
        value: {},
      },
    ],
  }
}

describe('configuredModelsOf', () => {
  it('lists only models declared in the raw llm-pi-ai user layer', () => {
    const models = configuredModelsOf(describeFixture())
    expect(models).toEqual([
      { provider: 'aliyun', model: 'qwen-max', efforts: ['off', 'low', 'high'] },
      { provider: 'aliyun', model: 'qwen-turbo', efforts: [] },
    ])
    expect(models.some(entry => entry.model === 'catalog-only')).toBe(false)
  })

  it('keeps off as a selectable level when the model declares it', () => {
    expect(effortsOf(configuredModelsOf(describeFixture()), 'aliyun', 'qwen-max')).toContain('off')
    expect(effortsOf(configuredModelsOf(describeFixture()), 'aliyun', 'missing')).toEqual([])
  })

  it('returns no models for a describe envelope without the user layer', () => {
    const described = { namespaces: [{ ns: 'llm-pi-ai', value: { providers: {} } }] }
    expect(configuredModelsOf(described)).toEqual([])
    expect(purposeStateOf(described).writable).toBe(false)
    expect(purposeStateOf(described).revisions).toEqual({ compaction: undefined, worktreeBranch: undefined })
  })
})

describe('overrideOf', () => {
  it('reads one namespace from the resolved value layer and fences its revision', () => {
    const described = describeFixture()
    expect(overrideOf(described, PURPOSE_NAMESPACES.compaction)).toEqual({
      provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'low',
    })
    expect(overrideOf(described, PURPOSE_NAMESPACES.worktreeBranch)).toEqual({})
    expect(revisionOf(described, PURPOSE_NAMESPACES.compaction)).toBe(7)
    expect(revisionOf(described, 'missing')).toBeUndefined()
    expect(purposeStateOf(described)).toEqual({
      writable: true,
      models: [
        { provider: 'aliyun', model: 'qwen-max', efforts: ['off', 'low', 'high'] },
        { provider: 'aliyun', model: 'qwen-turbo', efforts: [] },
      ],
      overrides: {
        compaction: { provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'low' },
        worktreeBranch: {},
      },
      revisions: { compaction: 7, worktreeBranch: 9 },
    })
  })

  it('treats empty scalar strings as the default', () => {
    const described = {
      namespaces: [{ ns: PURPOSE_NAMESPACES.compaction, revision: 4, value: {
        provider: '', model: '', reasoningEffort: '',
      } }],
    }
    expect(overrideOf(described, PURPOSE_NAMESPACES.compaction)).toEqual({})
    expect(purposeOps(overrideOf(described, PURPOSE_NAMESPACES.compaction))).toEqual([
      { op: 'unset', path: ['provider'] },
      { op: 'unset', path: ['model'] },
      { op: 'unset', path: ['reasoningEffort'] },
    ])
  })
})

describe('applyPurposeOverride', () => {
  it('rewrites a complete route pair and a configured effort', () => {
    const base = { provider: 'chat', model: 'chat-model', maxTokens: 24, purpose: 'compaction' }
    expect(applyPurposeOverride(base, {
      provider: 'aliyun', model: 'qwen-max', reasoningEffort: 'off',
    })).toEqual({
      provider: 'aliyun', model: 'qwen-max', maxTokens: 24, purpose: 'compaction', reasoningEffort: 'off',
    })
    expect(base).toEqual({ provider: 'chat', model: 'chat-model', maxTokens: 24, purpose: 'compaction' })
  })

  it('ignores a half-paired route while still applying a configured effort', () => {
    const result = applyPurposeOverride(
      { provider: 'chat', model: 'chat-model' },
      { provider: 'aliyun', reasoningEffort: 'low' },
    )
    expect(result).toEqual({ provider: 'chat', model: 'chat-model', reasoningEffort: 'low' })
    expect(pairedRoute({ provider: 'aliyun' })).toBeUndefined()
  })

  it('fails open when no override is configured', () => {
    const base = { provider: 'chat', model: 'chat-model', reasoningEffort: 'high' }
    expect(applyPurposeOverride(base, {})).toBe(base)
  })
})

describe('purposeOps', () => {
  it('writes all three scalar fields and unsets blanks', () => {
    expect(purposeOps({ provider: 'aliyun', model: 'qwen-max', reasoningEffort: '' })).toEqual([
      { op: 'set', path: ['provider'], value: 'aliyun' },
      { op: 'set', path: ['model'], value: 'qwen-max' },
      { op: 'unset', path: ['reasoningEffort'] },
    ])
  })

  it('unsets both fields of an incomplete route instead of persisting half a pair', () => {
    expect(purposeOps({ provider: 'aliyun' })).toEqual([
      { op: 'unset', path: ['provider'] },
      { op: 'unset', path: ['model'] },
      { op: 'unset', path: ['reasoningEffort'] },
    ])
  })
})

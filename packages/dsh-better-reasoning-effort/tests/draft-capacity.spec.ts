/**
 * Draft-state capacity prefill: a freshly adopted model row shows its computed
 * capacity in the official inputs BEFORE the user saves. The values are a
 * suggestion, not a write: a row whose inputs are not both empty stays as is.
 */

import { describe, expect, it } from 'vitest'
import { draftCapacityOf } from '../src/client/draft-capacity.js'

describe('draftCapacityOf', () => {
  it('fills both official capacity inputs from the knowledge base', () => {
    expect(draftCapacityOf('gpt-5.6-sol', '', '')).toEqual({ contextWindow: '449536', maxTokens: '128000' })
    expect(draftCapacityOf('claude-opus-5-5', '', '')).toEqual({ contextWindow: '449536', maxTokens: '128000' })
    expect(draftCapacityOf('gpt-4o', '', '')).toEqual({ contextWindow: '209920', maxTokens: '16384' })
  })

  it('does not overwrite a value the row already carries', () => {
    expect(draftCapacityOf('gpt-5.6-sol', '400000', '')).toBeUndefined()
    expect(draftCapacityOf('gpt-5.6-sol', '', '64000')).toBeUndefined()
  })

  it('stays silent when the entry lacks a maximum output or the id is unknown', () => {
    expect(draftCapacityOf('hy4', '', '')).toBeUndefined()
    expect(draftCapacityOf('some-random-model', '', '')).toBeUndefined()
    expect(draftCapacityOf('deepseek', '', '')).toBeUndefined()
  })
})

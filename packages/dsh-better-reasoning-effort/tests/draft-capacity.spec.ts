/**
 * Draft-state capacity prefill: a freshly adopted model row shows its computed
 * capacity in the official inputs BEFORE the user saves. The values are a
 * suggestion, not a write: a row whose inputs are not both empty stays as is.
 */

import { describe, expect, it } from 'vitest'
import { buildAutofillPatch } from '../src/autofill.js'
import { draftCapacityOf, draftEffortDeclarationOf, draftEffortPropsOf } from '../src/client/draft-capacity.js'

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

describe('draftEffortDeclarationOf', () => {
  const route = { api: 'openai-completions', baseURL: 'https://gw.example.com/v1' }

  it('reuses the curated suggestion that the saved-row autofill writes', () => {
    const draft = draftEffortDeclarationOf('qwen-max', route)
    const patch = buildAutofillPatch({ route: { ...route, models: [{ id: 'qwen-max' }] } })
    const saved = (patch!.providers as Record<string, { models: Record<string, unknown>[] }>).route.models[0]
    expect(draft).toEqual({
      efforts: saved['reasoningEfforts'],
      compat: saved['compat'],
      defaultEffort: saved['defaultEffort'],
      input: saved['input'],
    })
    expect(draft?.efforts).toEqual({ off: null, high: 'high' })
    expect(draft?.defaultEffort).toBe('high')
  })

  it('stays silent for an uncurated or endpoint-disabled model', () => {
    expect(draftEffortDeclarationOf('some-random-model', route)).toBeUndefined()
    expect(draftEffortDeclarationOf('qwen-max', route, { reasoning: false, source: 'supports_reasoning' })).toBeUndefined()
  })

  it('matches the saved-row patch for a curated entry without a default pick', () => {
    const draft = draftEffortDeclarationOf('deepseek-chat', route)
    const patch = buildAutofillPatch({ route: { ...route, models: [{ id: 'deepseek-chat' }] } })
    const saved = (patch!.providers as Record<string, { models: Record<string, unknown>[] }>).route.models[0]
    expect(draft?.efforts).toEqual(saved['reasoningEfforts'])
    expect(draft?.defaultEffort).toBeUndefined()
    expect(saved['defaultEffort']).toBeUndefined()
  })
})

describe('draftEffortPropsOf', () => {
  const route = { api: 'openai-completions', baseURL: 'https://gw.example.com/v1' }

  it('shows the curated ladder and its companion fields before Save', () => {
    const props = draftEffortPropsOf('qwen-max', route, false)
    const patch = buildAutofillPatch({ route: { ...route, models: [{ id: 'qwen-max' }] } })
    const saved = (patch!.providers as Record<string, { models: Record<string, unknown>[] }>).route.models[0]
    expect(props.efforts).toEqual(saved['reasoningEfforts'])
    expect(props.compat).toEqual(saved['compat'])
    expect(props.defaultEffort).toBe(saved['defaultEffort'])
    expect(props.input).toEqual(saved['input'])
    expect(props.efforts).toEqual({ off: null, high: 'high' })
  })

  it('leaves the ladder to the official control when it owns reasoning', () => {
    const props = draftEffortPropsOf('qwen-max', route, true)
    expect(props.efforts).toBeUndefined()
    expect(props.compat).toBeDefined()
    expect(props.defaultEffort).toBe('high')
    expect(props.input).toBeDefined()
  })

  it('shows nothing for an uncurated model', () => {
    expect(draftEffortPropsOf('some-random-model', route, false)).toEqual({})
    expect(draftEffortPropsOf('some-random-model', route, true)).toEqual({})
  })
})

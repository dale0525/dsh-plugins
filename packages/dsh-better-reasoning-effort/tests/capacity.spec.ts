/**
 * Capacity auto-fill: translate the knowledge base's physical model capacities
 * into the pi-ai model-row fields compaction-basic needs.
 *
 * Expected numbers are worked out from the engine's trigger formula
 *   thresholdTokens = floor(min(0.8 * W, W - maxTokens - 65536))
 * solved for the wanted effective context T = min(256000, physicalWindow):
 *   W = T + maxTokens + 65536
 * (the second term dominates because T <= 256000 < 4 * 65536).
 */

import { describe, expect, it } from 'vitest'
import { buildAutofillPatch, capacityFillOf } from '../src/autofill.js'

type Models = Record<string, { models: Record<string, unknown>[] }>

const modelsOf = (patch: ReturnType<typeof buildAutofillPatch>, route: string): Record<string, unknown>[] =>
  ((patch!.providers as Models)[route]!).models

describe('capacityFillOf', () => {
  it('keeps effective context at 256000 for a large-window model', () => {
    // deepseek-flash: physical 1,048,576 / max output 384,000 -> 256000 + 384000 + 65536.
    expect(capacityFillOf(1_048_576, 384_000)).toEqual({
      maxTokens: 384_000,
      contextWindow: 705_536,
    })
  })

  it('caps effective context at the physical window for a smaller model', () => {
    // gpt-4o: physical 128,000 / max output 16,384 -> 128000 + 16384 + 65536.
    expect(capacityFillOf(128_000, 16_384)).toEqual({
      maxTokens: 16_384,
      contextWindow: 209_920,
    })
  })

  it('never lets the ceiling exceed the physical window', () => {
    expect(capacityFillOf(65_536, 8_192).contextWindow).toBe(65_536 + 8_192 + 65_536)
  })
})

describe('buildAutofillPatch capacity fill', () => {
  it('fills maxTokens and the compaction-derived contextWindow on a new model row', () => {
    const patch = buildAutofillPatch({ route: { models: [{ id: 'deepseek-flash' }] } })
    const [row] = modelsOf(patch, 'route')
    expect(row['maxTokens']).toBe(384_000)
    expect(row['contextWindow']).toBe(705_536)
    expect(row['reasoningEfforts']).toBeDefined()
  })

  it('does not overwrite capacities the user already set', () => {
    const patch = buildAutofillPatch({
      route: { models: [{ id: 'deepseek-flash', contextWindow: 300_000, maxTokens: 128_000 }] },
    })
    const [row] = modelsOf(patch, 'route')
    expect(row['contextWindow']).toBe(300_000)
    expect(row['maxTokens']).toBe(128_000)
  })

  it('leaves capacity unset for a knowledge entry with no max output', () => {
    // grok-4.7 deliberately carries no maxTokens (catalogs disagree).
    const patch = buildAutofillPatch({ route: { models: [{ id: 'grok-4.7' }] } })
    const [row] = modelsOf(patch, 'route')
    expect(row['contextWindow']).toBeUndefined()
    expect(row['maxTokens']).toBeUndefined()
  })

  it('does not touch capacity on a row that already declared its ladder', () => {
    // A row the user has configured is not a new row; leaving its capacity
    // empty keeps "use the provider default" intact.
    const patch = buildAutofillPatch({
      route: {
        models: [{
          id: 'deepseek-flash',
          reasoningEfforts: { high: 'high' },
          input: ['text'],
        }],
      },
    })
    expect(patch).toBeUndefined()
  })
})

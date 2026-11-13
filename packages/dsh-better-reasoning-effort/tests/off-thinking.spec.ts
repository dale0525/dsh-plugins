/**
 * Off-effort wire completion: a request that means "do not think" must carry
 * BOTH spellings, because a gateway fans out to upstreams that each honour a
 * different one.
 *
 * The measured failure this guards: `reasoning_effort: 'none'` alone left an
 * upstream thinking, its reasoning content consumed the whole token budget, and
 * the reply came back empty with `finish_reason: length`.
 */

import { describe, expect, it } from 'vitest'
import { buildOffWireIndex, emptyOffWireIndex, withOffThinking } from '../src/off-thinking.js'

describe('buildOffWireIndex', () => {
  it('indexes the off wire value a route declares', () => {
    const index = buildOffWireIndex({
      magpie: {
        baseURL: 'https://hub.example.com/v1',
        models: [{ id: 'group/deepseek-flash', reasoningEfforts: { off: 'none', high: 'high' } }],
      },
    })
    expect(index.byOrigin.get('https://hub.example.com')).toEqual(['none'])
  })

  it('ignores a route that declares no off level, no models, or no endpoint', () => {
    const index = buildOffWireIndex({
      noOff: { baseURL: 'https://a.example.com', models: [{ id: 'm', reasoningEfforts: { high: 'high' } }] },
      noModels: { baseURL: 'https://b.example.com' },
      noEndpoint: { models: [{ id: 'm', reasoningEfforts: { off: 'none' } }] },
      badEndpoint: { baseURL: 'not a url', models: [{ id: 'm', reasoningEfforts: { off: 'none' } }] },
    })
    expect(index.byOrigin.size).toBe(0)
  })

  it('collects one value per route, not one per model', () => {
    const index = buildOffWireIndex({
      shared: {
        baseURL: 'https://shared.example.com',
        models: [
          { id: 'a', reasoningEfforts: { off: 'none' } },
          { id: 'b', reasoningEfforts: { off: 'none' } },
        ],
      },
    })
    expect(index.byOrigin.get('https://shared.example.com')).toEqual(['none'])
  })
})

describe('withOffThinking', () => {
  it('adds the thinking field to a body whose effort is the off value', () => {
    const body = { model: 'm', reasoning_effort: 'none', max_tokens: 24 }
    expect(withOffThinking(body, ['none'])).toEqual({
      model: 'm',
      reasoning_effort: 'none',
      max_tokens: 24,
      thinking: { type: 'disabled' },
    })
  })

  it('leaves a body that names another effort alone — it is asking to think', () => {
    expect(withOffThinking({ reasoning_effort: 'high' }, ['none'])).toBeUndefined()
  })

  it('leaves a body with no effort alone', () => {
    expect(withOffThinking({ model: 'm' }, ['none'])).toBeUndefined()
  })

  it('never overwrites a thinking field the caller already set', () => {
    expect(withOffThinking({ reasoning_effort: 'none', thinking: { type: 'enabled' } }, ['none'])).toBeUndefined()
    expect(withOffThinking({ reasoning_effort: 'none', thinking: null }, ['none'])).toBeUndefined()
  })

  it('matches the route\u2019s own off spelling rather than assuming "none"', () => {
    expect(withOffThinking({ reasoning_effort: 'none' }, ['minimal'])).toBeUndefined()
    expect(withOffThinking({ reasoning_effort: 'minimal' }, ['minimal'])).toEqual({
      reasoning_effort: 'minimal',
      thinking: { type: 'disabled' },
    })
  })
})

describe('emptyOffWireIndex', () => {
  it('matches nothing', () => {
    expect(emptyOffWireIndex().byOrigin.size).toBe(0)
  })
})

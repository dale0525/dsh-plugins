/**
 * DOM half of draft capacity prefill: drive the two official capacity inputs
 * through their own React onChange path, once per row, without writing any
 * configuration.
 */
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { prefillDraftCapacities } from '../src/client/injection/models-page-editor.js'

/** One expanded disclosure with the host's two numbered capacity inputs. */
function disclosure(context = '', max = ''): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = `
    <div class="ModelsSection_modelAdvanced__hash">
      <label><span>Context window</span><input type="text" inputmode="numeric" aria-label="Context window 1" value="${context}" /></label>
      <label><span>Max output tokens</span><input type="text" inputmode="numeric" aria-label="Max output tokens 1" value="${max}" /></label>
    </div>`
  // jsdom's innerHTML sets defaultValue, not the live value React controls.
  const inputs = container.querySelectorAll<HTMLInputElement>('input')
  inputs[0]!.value = context
  inputs[1]!.value = max
  return container
}

const values = (container: HTMLElement): [string, string] => {
  const inputs = container.querySelectorAll<HTMLInputElement>('input')
  return [inputs[0]!.value, inputs[1]!.value]
}

describe('prefillDraftCapacities', () => {
  it('fills both empty inputs for a knowledge-base model', () => {
    const container = disclosure()
    const seen: string[] = []
    for (const input of container.querySelectorAll<HTMLInputElement>('input'))
      input.addEventListener('input', () => seen.push(input.getAttribute('aria-label') ?? ''))
    expect(prefillDraftCapacities(container, 'gpt-5.6-sol', ['Context window'], ['Max output tokens'])).toBe(true)
    expect(values(container)).toEqual(['449536', '128000'])
    expect(seen).toEqual(['Context window 1', 'Max output tokens 1'])
  })

  it('leaves a row with either value already filled untouched', () => {
    expect(prefillDraftCapacities(disclosure('400000', ''), 'gpt-5.6-sol', ['Context window'], ['Max output tokens'])).toBe(false)
    expect(prefillDraftCapacities(disclosure('', '64000'), 'gpt-5.6-sol', ['Context window'], ['Max output tokens'])).toBe(false)
  })

  it('does not refill a row the user cleared after the first seed', () => {
    const container = disclosure()
    expect(prefillDraftCapacities(container, 'gpt-5.6-sol', ['Context window'], ['Max output tokens'])).toBe(true)
    const inputs = container.querySelectorAll<HTMLInputElement>('input')
    inputs[0]!.value = ''
    inputs[1]!.value = ''
    expect(prefillDraftCapacities(container, 'gpt-5.6-sol', ['Context window'], ['Max output tokens'])).toBe(false)
    expect(values(container)).toEqual(['', ''])
  })

  it('stays silent for an unknown model or a row without the inputs', () => {
    expect(prefillDraftCapacities(disclosure(), 'some-random-model', ['Context window'], ['Max output tokens'])).toBe(false)
    expect(prefillDraftCapacities(document.createElement('div'), 'gpt-5.6-sol', ['Context window'], ['Max output tokens'])).toBe(false)
  })
})

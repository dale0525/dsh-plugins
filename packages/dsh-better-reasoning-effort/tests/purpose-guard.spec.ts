/**
 * Render-level contract for the auxiliary-model footer editor.
 *
 * The pure parser has its own tests; this file pins the two facts only the
 * mounted component can prove: its options come from the `llm-pi-ai` USER layer,
 * and one edit writes the OWNING plugin namespace with that row's revision.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { PurposeOverrides, registerPurposeOverridesSlot } from '../src/client/PurposeOverrides.js'
import { en, zh } from '../src/client/locales.js'
import type { RemoteApi } from '../src/client/types.js'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

const t: Translate = (key) => (en as Record<string, string>)[key] ?? key

/** One user-configured model and two independently writable plugin rows. */
function describeValue(stored: Record<string, Record<string, string>>) {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [
      {
        ns: 'llm-pi-ai',
        revision: 3,
        value: { providers: { builtin: { models: [{ id: 'catalog-only' }] } } },
        user: {
          providers: {
            aliyun: { models: [{ id: 'qwen-max', reasoningEfforts: { off: null, low: 'low', high: 'high' } }] },
          },
        },
      },
      { ns: 'verbatim-compaction-purpose', revision: 7, value: stored['verbatim-compaction-purpose'] ?? {} },
      { ns: 'worktree-session', revision: 11, value: stored['worktree-session'] ?? {} },
    ],
  }
}

/** A settings Remote whose describe reflects the writes the editor makes. */
function fakeApi() {
  const stored: Record<string, Record<string, string>> = {}
  const describe = vi.fn(async () => ({ ok: true as const, value: describeValue(stored) }))
  const mutate = vi.fn(async (ns: string, ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: string }>, _revision?: number) => {
    const next: Record<string, string> = { ...(stored[ns] ?? {}) }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set' && op.value !== undefined) next[field] = op.value
      else Reflect.deleteProperty(next, field)
    }
    stored[ns] = next
    return { ok: true as const, value: undefined }
  })
  return {
    api: {
      settings: { describe, mutate },
    } as unknown as RemoteApi,
    describe,
    mutate,
  }
}

async function render(api: RemoteApi): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(PurposeOverrides, { api, t }))
  })
  return {
    container,
    async unmount() {
      await act(async () => { root!.unmount() })
      container.remove()
    },
  }
}

function optionTexts(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map(option => option.textContent ?? '')
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PurposeOverrides footer editor', () => {
  it('keeps the English and Chinese dictionaries aligned', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('registers a second footer seat with the read/write seam injected', () => {
    const registered: Array<Record<string, unknown>> = []
    const { api } = fakeApi()
    const ctx = {
      slots: {
        inject: (_name: string, registrar: () => unknown) => registrar(),
        register: (options: Record<string, unknown>) => { registered.push(options); return () => {} },
      },
    }
    const dispose = registerPurposeOverridesSlot(ctx as never, api, t)
    expect(registered[0]).toMatchObject({
      name: 'settings.models.footer',
      id: 'dsh-better-reasoning-effort-purpose-overrides',
      order: 20,
    })
    expect((registered[0]!['inject'] as () => Record<string, unknown>)()).toEqual({ api, t })
    expect(typeof dispose).toBe('function')
  })

  it('offers only user-configured models and their declared effort levels', async () => {
    const { api } = fakeApi()
    const view = await render(api)
    try {
      const selects = Array.from(view.container.querySelectorAll('select'))
      expect(selects).toHaveLength(4)
      for (const modelSelect of [selects[0]!, selects[2]!]) {
        expect(optionTexts(modelSelect)).toContain('Follow chat model')
        expect(optionTexts(modelSelect)).toContain('aliyun / qwen-max')
        expect(optionTexts(modelSelect)).not.toContain('builtin / catalog-only')
      }
      // The store override is empty on mount, so its effort picker has only
      // the blank option. Selecting the user model exposes its declared keys.
      expect(optionTexts(selects[1]!)).toEqual([en.purposeEffortUnset])
      await act(async () => {
        const modelSelect = view.container.querySelectorAll('select')[0]!
        modelSelect.value = JSON.stringify(['aliyun', 'qwen-max'])
        modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await vi.waitFor(() => expect(optionTexts(view.container.querySelectorAll('select')[1]!)).toContain('high'))
      expect(optionTexts(view.container.querySelectorAll('select')[1]!)).toContain('off')
    } finally {
      await view.unmount()
    }
  })

  it('writes the worktree namespace with its own revision fence', async () => {
    const { api, mutate } = fakeApi()
    const view = await render(api)
    try {
      await act(async () => {
        const modelSelect = view.container.querySelectorAll('select')[2]!
        modelSelect.value = JSON.stringify(['aliyun', 'qwen-max'])
        modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
      expect(mutate.mock.calls[0]![0]).toBe('worktree-session')
      expect(mutate.mock.calls[0]![2]).toBe(11)
      expect(mutate.mock.calls[0]![1]).toEqual([
        { op: 'set', path: ['provider'], value: 'aliyun' },
        { op: 'set', path: ['model'], value: 'qwen-max' },
        { op: 'unset', path: ['reasoningEffort'] },
      ])
    } finally {
      await view.unmount()
    }
  })

  it('keeps the compaction edit on the compaction namespace', async () => {
    const { api, mutate } = fakeApi()
    const view = await render(api)
    try {
      await act(async () => {
        const modelSelect = view.container.querySelectorAll('select')[0]!
        modelSelect.value = JSON.stringify(['aliyun', 'qwen-max'])
        modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
      expect(mutate.mock.calls[0]![0]).toBe('verbatim-compaction-purpose')
      expect(mutate.mock.calls[0]![2]).toBe(7)
    } finally {
      await view.unmount()
    }
  })
})

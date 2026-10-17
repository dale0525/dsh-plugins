/**
 * The provider-card request-image cap: the parsed/rendered contract, plus the
 * one pin that keeps the UI's "follow the default" copy honest.
 *
 * The write seam itself is covered against the settings layer in `ops.spec.ts`
 * (`providerBudgetOf` / `writeProviderBudget`); this file covers what only
 * exists once the component is mounted, and the default the copy quotes.
 */

// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { BudgetEditor, mibOf, parseBudget, type BudgetEditorProps } from '../src/client/BudgetEditor.js'
import { DEFAULT_IMAGE_BUDGET_BYTES } from '../src/constants.js'
import { en } from '../src/client/locales.js'
import type { RemoteApi } from '../src/client/types.js'

;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

/** The shell's Translate face, approximated with the en dictionary. */
const t = (key: string, params?: Record<string, string | number>): string => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${String(name)}}`, String(value))
  }
  return text
}

/** One refused settings write, in the wire's envelope shape. */
type Refusal = { ok: false; error: { code: string; message: string } }

/** The write seam a fake Remote exposes, so a test can read what was sent. */
type MutateSpy = ReturnType<typeof vi.fn<(ns: string, ops: unknown[], revision?: number) => Promise<unknown>>>

/**
 * pi-ai's own default for the cap, extracted MECHANICALLY from the installed
 * artifact. The field's copy promises "leave it empty and the adapter's default
 * applies", so the number the UI quotes must be the adapter's -- a dependency
 * upgrade that changes it fails HERE instead of making the section lie.
 */
function kernelDefaultImageBudget(): number {
  const source = readFileSync('node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js', 'utf8')
  const match = source.match(/const DEFAULT_MAX_REQUEST_IMAGE_BYTES = ([^;]+);/)
  if (match === null) {
    throw new Error(
      'could not extract DEFAULT_MAX_REQUEST_IMAGE_BYTES from @deepseek-ai/dsh-llm-pi-ai/lib/index.js -- '
      + 'the generated shape changed; update this extractor together with the upgrade',
    )
  }
  const value: unknown = new Function(`return (${match[1]!})`)()
  if (typeof value !== 'number') throw new Error('the kernel default is not a number')
  return value
}

/**
 * A settings Remote answering one namespace view, with ONE spy behind
 * `api.mutate` and `api.settings.mutate` (the editor reaches the seam through
 * the latter; a second spy would let a test pass on a call it never made).
 */
function fakeApi(options: {
  budget?: unknown
  writable?: boolean
  mutate?: () => Promise<{ ok: true } | Refusal>
} = {}): RemoteApi & { mutate: MutateSpy } {
  const profile = {
    baseURL: 'https://relay.example.com',
    ...(options.budget === undefined ? {} : { maxRequestImageBytes: options.budget }),
  }
  const view = {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { cpa: profile } },
    user: { providers: { cpa: profile } },
    base: {},
    revision: 7,
    applies: 'live',
    secrets: [],
  }
  const mutate: MutateSpy = vi.fn(async () =>
    (options.mutate === undefined ? { ok: true } : await options.mutate()) as never)
  const api = {
    settings: {
      async describe() {
        return { ok: true, value: { namespaces: [view], writable: options.writable !== false } } as never
      },
      mutate,
    },
  }
  return Object.assign(api, { mutate }) as unknown as RemoteApi & { mutate: MutateSpy }
}

/** Render the section inside a provider-card row, the way the page does. */
async function renderEditor(props: BudgetEditorProps): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
  const row = document.createElement('li')
  row.className = 'rowCard'
  document.body.appendChild(row)
  const container = document.createElement('div')
  row.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(BudgetEditor, props))
  })
  return {
    container,
    async unmount() {
      await act(async () => { root!.unmount() })
      row.remove()
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const hit = Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent === text)
  if (hit === undefined) throw new Error(`no button "${text}"`)
  return hit
}

/** The section's disclosure control (the heading is the button). */
function disclosure(container: HTMLElement): HTMLButtonElement {
  const hit = container.querySelector<HTMLButtonElement>('.bre-headers-disclosure')
  if (hit === null) throw new Error('no disclosure control')
  return hit
}

async function expand(container: HTMLElement): Promise<void> {
  if (disclosure(container).getAttribute('aria-expanded') !== 'true') {
    await act(async () => { disclosure(container).click() })
  }
}

/** Type into the React-controlled cap field. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function capField(container: HTMLElement): HTMLInputElement {
  const hit = container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')
  if (hit === null) throw new Error('no cap field')
  return hit
}

/** The ops one mutate call carried. */
function writtenOps(spy: MutateSpy): { op: string; path: string[]; value?: unknown }[] {
  return (spy.mock.calls[0] as unknown[])[1] as { op: string; path: string[]; value?: unknown }[]
}

describe('parseBudget', () => {
  it('reads a byte count, and a blank field as "follow the default"', () => {
    expect(parseBudget('8388608')).toBe(8388608)
    expect(parseBudget('1')).toBe(1)
    expect(parseBudget('')).toBeUndefined()
  })

  it('refuses anything that is not a positive whole number of bytes', () => {
    // The kernel throws on a non-positive-integer bound at load time, so the
    // editor must not be able to store one.
    for (const text of ['0', '-1', '1.5', '8 MiB', '1e6', '0x10', 'abc', ' ']) {
      expect(parseBudget(text), JSON.stringify(text)).toBeNull()
    }
  })
})

describe('mibOf', () => {
  it('renders whole MiB without a decimal and keeps a fractional one', () => {
    expect(mibOf(8388608)).toBe('8 MiB')
    expect(mibOf(20971520)).toBe('20 MiB')
    expect(mibOf(1500000)).toBe('1.43 MiB')
  })
})

describe('the quoted default', () => {
  it('is the installed kernel default', () => {
    expect(DEFAULT_IMAGE_BUDGET_BYTES).toBe(kernelDefaultImageBudget())
  })
})

describe('BudgetEditor', () => {
  beforeEach(() => { (globalThis as Record<string, unknown>)['fetch'] = vi.fn(async () => { throw new Error('offline') }) })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows only its heading until the disclosure is opened', async () => {
    const api = fakeApi({ budget: 8388608 })
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      const control = disclosure(editor.container)
      expect(control.getAttribute('aria-expanded')).toBe('false')
      expect(control.textContent).toContain(en.budgetTitle)
      // The one fact worth showing while closed.
      expect(control.textContent).toContain('8 MiB')
      expect(editor.container.textContent).not.toContain(en.budgetHint)
      expect(editor.container.querySelector('input')).toBeNull()

      await expand(editor.container)
      expect(disclosure(editor.container).getAttribute('aria-expanded')).toBe('true')
      expect(editor.container.textContent).toContain('8388608')
    } finally {
      await editor.unmount()
    }
  })

  it('reports inheritance, and no cap figure, when no layer declares one', async () => {
    const api = fakeApi({})
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      // Nothing to count while the default applies.
      expect(editor.container.querySelector('.bre-headers-count')).toBeNull()
      await expand(editor.container)
      // The copy names the real default, both in bytes and in MiB: the whole
      // point of the section is that the default is NOT a safe value.
      expect(editor.container.textContent).toContain(
        t('budgetInherited', { default: `${String(DEFAULT_IMAGE_BUDGET_BYTES)} B (${mibOf(DEFAULT_IMAGE_BUDGET_BYTES)})` }),
      )
    } finally {
      await editor.unmount()
    }
  })

  it('prefills the stored cap and writes one inline field', async () => {
    const api = fakeApi({ budget: 8388608 })
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      await expand(editor.container)
      await act(async () => { buttonByText(editor.container, en.headersEdit).click() })
      expect(capField(editor.container).value).toBe('8388608')

      await type(capField(editor.container), '4194304')
      await act(async () => { buttonByText(editor.container, en.headersSave).click() })

      expect(api.mutate).toHaveBeenCalledTimes(1)
      const [ns, ops, revision] = api.mutate.mock.calls[0] as [string, { op: string; path: string[]; value?: unknown }[], number]
      expect(ns).toBe('llm-pi-ai')
      expect(ops).toEqual([{ op: 'set', path: ['providers', 'cpa', 'maxRequestImageBytes'], value: 4194304 }])
      expect(revision).toBe(7)
      expect(editor.container.textContent).toContain(en.budgetSaved)
    } finally {
      await editor.unmount()
    }
  })

  it('clears the cap with an unset when the field is emptied', async () => {
    const api = fakeApi({ budget: 8388608 })
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      await expand(editor.container)
      await act(async () => { buttonByText(editor.container, en.headersEdit).click() })
      await type(capField(editor.container), '')
      await act(async () => { buttonByText(editor.container, en.headersSave).click() })

      expect(writtenOps(api.mutate)).toEqual([{ op: 'unset', path: ['providers', 'cpa', 'maxRequestImageBytes'] }])
      expect(editor.container.textContent).toContain(en.budgetCleared)
    } finally {
      await editor.unmount()
    }
  })

  it('refuses an invalid cap without writing', async () => {
    const api = fakeApi({ budget: 8388608 })
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      await expand(editor.container)
      await act(async () => { buttonByText(editor.container, en.headersEdit).click() })
      await type(capField(editor.container), '8 MiB')
      await act(async () => { buttonByText(editor.container, en.headersSave).click() })

      expect(api.mutate).not.toHaveBeenCalled()
      expect(editor.container.textContent).toContain(en.budgetInvalid)
      // Still editing: the draft must not be lost to a refusal.
      expect(buttonByText(editor.container, en.headersSave)).toBeDefined()
    } finally {
      await editor.unmount()
    }
  })

  it('discards the draft on cancel without writing', async () => {
    const api = fakeApi({ budget: 8388608 })
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      await expand(editor.container)
      await act(async () => { buttonByText(editor.container, en.headersEdit).click() })
      await type(capField(editor.container), '1024')
      await act(async () => { buttonByText(editor.container, en.headersCancel).click() })
      expect(api.mutate).not.toHaveBeenCalled()

      await act(async () => { buttonByText(editor.container, en.headersEdit).click() })
      expect(capField(editor.container).value).toBe('8388608')
    } finally {
      await editor.unmount()
    }
  })

  it('surfaces a refused write and stays in edit mode', async () => {
    const api = fakeApi({
      budget: 8388608,
      mutate: async () => ({ ok: false, error: { code: 'settings/rejected', message: 'nope' } }),
    })
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      await expand(editor.container)
      await act(async () => { buttonByText(editor.container, en.headersEdit).click() })
      await act(async () => { buttonByText(editor.container, en.headersSave).click() })
      expect(editor.container.textContent).toContain('nope')
      expect(buttonByText(editor.container, en.headersSave)).toBeDefined()
    } finally {
      await editor.unmount()
    }
  })

  it('offers no edit action when the document is not writable', async () => {
    const api = fakeApi({ budget: 8388608, writable: false })
    const editor = await renderEditor({ route: 'cpa', api, t })
    try {
      await expand(editor.container)
      // It still REPORTS the configured cap; it just offers no way to change it.
      expect(editor.container.textContent).toContain('8388608')
      expect(editor.container.textContent).not.toContain(en.headersEdit)
    } finally {
      await editor.unmount()
    }
  })
})

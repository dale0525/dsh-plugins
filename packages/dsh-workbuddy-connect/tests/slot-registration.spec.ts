import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { WORKBUDDY_BUNDLE_NAMES, WORKBUDDY_ROW_ID } from '../src/client/index.tsx'

/**
 * The row-configuration contract this plugin registers against.
 *
 * DSH 0.1.6 replaced `settings.plugin.item` with `plugins.row.config`, keyed by
 * `<bundle package name>#<row id>`. Two consequences drive these tests, and
 * both are properties of the real slot registry rather than of this plugin's
 * code — so they drive the actual `SlotCore` instead of trusting the
 * registration shape:
 *
 *  1. One row has exactly ONE configuration key. The plugin serves two product
 *     cards, and a second registration under the same key throws, so the two
 *     cards must share a single entry (`WorkBuddyPluginConfig` renders both).
 *  2. The key is built from the bundle package name, which differs between the
 *     aggregated install and a standalone one — both keys are registered, and
 *     the one whose bundle is absent is simply never dispatched.
 *
 * The register calls are typed loosely on purpose: the point under test is the
 * registry's behaviour, not the DSH client typings.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal component stand-in; the registry only stores the reference. */
const Component = (): null => null

const register = (core: SlotCore, options: Record<string, unknown>): unknown =>
  (core.register as any)(options, Component)

/**
 * Declare `plugins.row.config` the way DSH does: a parent entry contributes a
 * `children` table. `SlotCore` has no standalone declare method — the child
 * spec is owned by the registering entry, which is also why a slot can only be
 * claimed once.
 */
function declareRowConfig(core: SlotCore): void {
  register(core, {
    name: 'root',
    children: { 'plugins.row.config': { kind: 'keyed', scope: 'root' } },
  })
}

const entries = (core: SlotCore): any[] => (core.entries as any)('plugins.row.config')

/** The keys the real client entry registers. */
const registeredKeys = (): string[] =>
  WORKBUDDY_BUNDLE_NAMES.map(bundle => `${bundle}#${WORKBUDDY_ROW_ID}`)

describe('plugins.row.config carries the WorkBuddy row', () => {
  it('accepts the key the real client entry builds for every bundle shape', () => {
    const core = new SlotCore()
    declareRowConfig(core)
    expect(() => {
      for (const key of registeredKeys()) register(core, { name: 'plugins.row.config', key })
    }).not.toThrow()
    expect(entries(core)).toHaveLength(WORKBUDDY_BUNDLE_NAMES.length)
  })

  it('keys the entry by <bundle>#<row id>, so the page can find it', () => {
    const core = new SlotCore()
    declareRowConfig(core)
    for (const key of registeredKeys()) register(core, { name: 'plugins.row.config', key })
    const cells = (core.entriesOfSlot as any)('plugins.row.config') as { options: { key?: string } }[]
    expect(cells.map(cell => cell.options.key).sort()).toEqual([...registeredKeys()].sort())
  })

  it('rejects a second entry for the same bundle and row', () => {
    // This is why the two product cards share ONE entry instead of registering
    // two keys: the row is declared once, so it has one configuration key.
    const core = new SlotCore()
    declareRowConfig(core)
    const key = registeredKeys()[0]!
    register(core, { name: 'plugins.row.config', key })
    expect(() => register(core, { name: 'plugins.row.config', key }))
      .toThrow(/already has an entry for key/)
  })

  it('requires an explicit key', () => {
    // The breakage the client entry's try/catch exists for.
    const core = new SlotCore()
    declareRowConfig(core)
    expect(() => register(core, { name: 'plugins.row.config' }))
      .toThrow(/requires options.key/)
  })

  it('rejects registering into the undeclared legacy slot', () => {
    // The 0.1.6 breakage this migration fixes: the old slot is gone, so a
    // registration that still named it would throw and the card would vanish.
    const core = new SlotCore()
    expect(() => register(core, { name: 'settings.plugin.item', key: 'workbuddy' }))
      .toThrow(/not declared/)
  })
})

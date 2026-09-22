/**
 * Test-side construction of the live config references `apply` receives.
 *
 * Since the 0.1.7-alpha.1 settings redesign this plugin's `Config` schema is
 * the only configuration surface, and every field of it is `volatile()`. The
 * Loader hands `apply` a `{ get() }` reference per field — not the values — so a
 * test that passed a plain object would fail at the first `config.x.get()`.
 *
 * The wrapper parses through the REAL `Config` rather than hand-building the
 * refs, for two reasons:
 *
 *  - The key set and the defaults cannot drift from the schema. A test config
 *    that omits a field gets the field's shipped default, which is what a real
 *    profile resolves to.
 *  - A field that lost its `volatile()` marker throws here (`.get` is not a
 *    function on a plain value) instead of silently handing the test a plain
 *    value, so the failure points at the schema rather than at whichever
 *    assertion happens to read the field first. That is exactly the condition
 *    the host's `volatileForm` checks before it will render a form at all.
 *
 * `set` is the test-side equivalent of the Loader committing a Plugins-page
 * edit into an existing reference; it exists so a test can prove that a value
 * edited AFTER mount is picked up without a remount.
 */

import { Config } from '../../src/index.js'
import type { ConfigRefs } from '../../src/index.js'

/** The parsed shape of a schema whose every field is volatile. */
type ParsedRefs = Record<string, { get(): unknown }>

/** Construct the schema; a non-volatile field surfaces as a plain value here. */
const parse = Config as unknown as new (value: unknown) => ParsedRefs

/**
 * @param config - the plain config the test wants in effect.
 * @returns the references plus a writer for the live-edit cases.
 */
export function refs(config: Record<string, unknown> = {}): {
  refs: ConfigRefs
  set: (key: string, value: unknown) => void
} {
  const parsed = new parse(config)
  const cells: Record<string, unknown> = {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(parsed)) {
    cells[key] = parsed[key]!.get()
    out[key] = { get: () => cells[key] }
  }
  return { refs: out as unknown as ConfigRefs, set: (key, value) => { cells[key] = value } }
}

/** The references alone, for the common case that never edits after mount. */
export function configRefs(config: Record<string, unknown> = {}): ConfigRefs {
  return refs(config).refs
}

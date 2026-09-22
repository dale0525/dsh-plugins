/**
 * Test-side construction of the live config references `apply` receives.
 *
 * Since the 0.1.7-alpha.1 settings redesign the guard's `Config` schema is the
 * only config surface, and every field of it is `volatile()`. The Loader hands
 * `apply` a `{ get() }` reference per field — not the values — so a test that
 * passes a plain object would fail at the first `config.x.get()`.
 *
 * The wrapper parses through the REAL `Config` rather than hand-building the
 * refs, for two reasons:
 *
 *  - The key set and the defaults cannot drift from the schema. A test config
 *    that omits a field gets the field's shipped default, which is what a real
 *    profile resolves to; under the retired namespace model an omitted field
 *    arrived as `undefined`, which was never a shape production could produce.
 *  - A field that lost its `volatile()` marker would throw here instead of
 *    silently handing the test a plain value, so the failure points at the
 *    schema rather than at whatever assertion happens to read the field first.
 *
 * `set` is the test-side equivalent of the Loader committing a page edit into
 * an existing reference; it exists so a test can prove that a value edited
 * AFTER mount is picked up without a remount.
 *
 * @param config - the plain config the test wants in effect.
 * @returns the references plus a writer for the live-edit cases.
 */
import { Config } from '../../lib/index.js'

export function refs(config = {}) {
  const parsed = new Config(config)
  const cells = {}
  const out = {}
  for (const key of Object.keys(parsed)) {
    cells[key] = parsed[key].get()
    out[key] = { get: () => cells[key] }
  }
  return { refs: out, set: (key, value) => { cells[key] = value } }
}

/** The references alone, for the common case that never edits after mount. */
export function configRefs(config = {}) {
  return refs(config).refs
}

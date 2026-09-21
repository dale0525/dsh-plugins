/**
 * Host-plane bridge for `ctx-mem` (slice S1: the pure decision layer).
 *
 * This is the package's ROOT face (`exports["."]`), and it must be: the web
 * plugin table locates a package's `dsh.client` manifest from the specifier of
 * the loader row that mounts it, and it only accepts a bare package name
 * (`dsh-client-modules`'s `exactPackageSpecifier`). A row named with a subpath
 * resolves to no manifest, so the browser half would never load. The engine
 * therefore lives at `./engine`, which no client scan needs to see.
 *
 * The host's `cordis` loader resolves every loader entry's config through the
 * synchronous `internal/config` waterfall. This bridge hangs off that waterfall
 * and injects a `patches` array into a covered preset composition, so the
 * preset's own `compaction-basic` row is disabled and the `ctx-mem` row is
 * inserted into its `compaction` group — no dedicated preset copy needed.
 *
 * The decision functions below are pure and side-effect free apart from the
 * deliberate in-place mutation of `config` in `applyBridge` (see its note).
 */
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SETTINGS_NAMESPACE, SettingsSection, mergeEngineConfig } from './config.js'

export const name = 'ctx-mem-bridge'

/** Set of preset ids this bridge covers. */
export const COVERED_PRESETS = new Set(['standard', 'ptc', 'cordis'])

const COMPOSITION_FILE = 'agent.cordis.yml'
const CTX_MEM_ID = 'ctx-mem'

/**
 * Extract the preset id from a composition path.
 * @param {unknown} path - the config's `path` (a file:// URL string, or anything)
 * @returns {string|null} the preset directory name, or null when `path` is not
 *   a preset composition path.
 */
export function presetIdFromPath(path) {
  if (typeof path !== 'string' || !path.endsWith(COMPOSITION_FILE)) return null
  let resolved = path
  if (path.startsWith('file:')) {
    try {
      resolved = fileURLToPath(path)
    } catch {
      return null
    }
  }
  return basename(dirname(resolved))
}

/**
 * The patch list injected into a covered preset composition.
 *
 * `engine` is the ctx-mem engine config the user wrote on the BRIDGE row
 * (`config: { engine: {...} }`). It is forwarded onto the injected row, because
 * that row is generated here and is the only place the engine's config can now
 * live. An empty object adds no `config:` key at all, so the engine keeps
 * falling back to its own defaults.
 * @param {Record<string, unknown>} [engine] - engine config to forward.
 * @returns {Array<object>} a fresh array each call
 */
export function buildPatches(engine) {
  const row = { id: CTX_MEM_ID, name: '@logictan/dsh-ctx-mem/engine' }
  if (engine !== undefined && engine !== null && Object.keys(engine).length > 0) row.config = { ...engine }
  return [
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
    { id: 'compaction', insert: [row] },
  ]
}

/** Whether an existing patch list already carries a ctx-mem row, top level or inserted. */
function hasCtxMem(patches) {
  if (!Array.isArray(patches)) return false
  return patches.some(
    (patch) =>
      patch?.id === CTX_MEM_ID ||
      (Array.isArray(patch?.insert) && patch.insert.some((row) => row?.id === CTX_MEM_ID)),
  )
}

/**
 * Decide the config to hand back to the loader.
 *
 * When it patches, it mutates `config` in place and returns that same object:
 * a downstream WeakMap is keyed on this identity, so cloning here would break
 * preset package resolution.
 *
 * Our patches are APPENDED to any list already on the config, never substituted
 * for it: `hasCtxMem` already concedes that `patches` can pre-exist, so
 * overwriting a pre-existing list would silently drop another producer's rows.
 * @param {unknown} config - the resolved config object (mutated in place when patched)
 * @param {Record<string, unknown>} [engine] - engine config forwarded onto the injected row.
 * @returns {{config: unknown, patched: boolean}}
 */
export function applyBridge(config, engine) {
  if (typeof config !== 'object' || config === null) return { config, patched: false }
  const id = presetIdFromPath(config.path)
  if (id === null || !COVERED_PRESETS.has(id)) return { config, patched: false }
  if (hasCtxMem(config.patches)) return { config, patched: false }
  const existing = Array.isArray(config.patches) ? config.patches : []
  config.patches = [...existing, ...buildPatches(engine)]
  return { config, patched: true }
}

/**
 * The waterfall listener body.
 *
 * `engine` is the config the bridge row was mounted with; cordis passes a row's
 * config positionally to `apply`, so it is captured in a closure there and
 * threaded through here.
 * @param {unknown} config
 * @param {() => unknown} next
 * @param {Record<string, unknown>} [engine]
 */
export function onInternalConfig(config, next, engine) {
  const out = next()
  applyBridge(out, engine)
  return out
}

/**
 * Composition base for the settings section.
 *
 * Only `maxCheckpointTokens` is forwarded, and only because it carries a schema
 * default: without a base value the card would always display the constant
 * 10,000, hiding a composition that sets something else.
 *
 * Every other key stays ABSENT on purpose. The resolved section is what the card
 * reads, and for these keys "absent" is the honest answer — it means the user has
 * not overridden them. Forwarding the composition value would make an inherited
 * value indistinguishable from a stated one, and for the mutually exclusive
 * retention pair it would display both forms at once.
 *
 * The engine still receives the composition's values: `mergeEngineConfig` takes
 * the row's `config.engine` as the base and layers the section over it, so a key
 * the section omits keeps the composition's value.
 * @param {Record<string, unknown>} [engine]
 * @returns {Record<string, unknown>}
 */
function sectionBase(engine) {
  const base = {}
  if (engine?.maxCheckpointTokens !== undefined) base.maxCheckpointTokens = engine.maxCheckpointTokens
  return base
}

const plugin = {
  name,
  apply(ctx, config) {
    const engine = config?.engine
    // The settings section is the source for the compression knobs once the
    // settings service is up; before that — or in a profile shipping no
    // settings provider — the row's own engine config stands alone. The source
    // is read on every waterfall pass rather than captured, so a composition
    // mounted after a settings change already sees it.
    let section = () => engine
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, SettingsSection, sectionBase(engine), {
        setSource(source) {
          section = source
        },
        // Nothing to do until restart: the engine captured its config when the
        // preset composition mounted.
        onChange() {},
      })
    })
    ctx.on(
      'internal/config',
      (c, next) => onInternalConfig(c, next, mergeEngineConfig(engine, section())),
      { global: true },
    )
  },
}

export default plugin

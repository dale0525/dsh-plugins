/**
 * The package names the market recognises as ITSELF.
 *
 * Three spellings are live at once, and all three must stay:
 *
 * - `dsh-market` — the patch row id the browser half also uses as its
 *   settings namespace and route prefix.
 * - `dshmarket` — upstream's unscoped package name. A profile that installed
 *   the market before this fork was renamed still carries it in
 *   `dependencies`, and the market may legitimately run alongside it.
 * - `@logictan/dshmarket` — this fork's published name.
 *
 * Every surface that asks "is this row us?" reads this one set, so adding a
 * fourth spelling is one edit rather than a search. Insertion order is
 * OLDEST-INSTALLED FIRST: {@link selfNameIn} returns the first match, and a
 * profile that somehow carries two spellings is far more likely to be
 * running the one it installed first.
 *
 * Deliberately dependency-free: the browser half inlines this module, so it
 * may not reach for anything Node-only.
 */
export const MARKET_SELF_NAMES: ReadonlySet<string> = new Set([
  'dshmarket',
  'dsh-market',
  '@logictan/dshmarket',
])

/** Whether `name` is one of the market's own package names. */
export function isMarketSelfName(name: string): boolean {
  return MARKET_SELF_NAMES.has(name)
}

/**
 * The spelling to assume when a profile's dependency map cannot be read.
 *
 * Upstream's unscoped name: it is what every write path used before this
 * fork existed and what the overwhelming majority of profiles still carry,
 * so falling back to it is the choice that keeps an unreadable profile
 * behaving exactly as it did rather than failing in a new way.
 */
export const DEFAULT_SELF_NAME = 'dshmarket'

/**
 * Which self name a profile's dependency map actually holds, or undefined.
 *
 * The market detects and updates itself inside a profile, and every write
 * path (`plugin update`, `plugin remove`) has to name the package the
 * manifest really carries — guessing a spelling that is not there makes the
 * operation a no-op that reports success.
 */
export function selfNameIn(installed: Record<string, string | undefined>): string | undefined {
  for (const name of MARKET_SELF_NAMES) {
    if (installed[name] !== undefined) return name
  }
  return undefined
}

/**
 * The two halves of the rename that no compiler can check.
 *
 * 1. The market recognises itself in a profile by PACKAGE NAME, and three
 *    spellings are live at once: the row id `dsh-market`, upstream's
 *    unscoped `dshmarket` (a profile installed before this fork still
 *    carries it), and this fork's `@logictan/dshmarket`. Every surface that
 *    asks "is this row us?" reads one set, so the set itself is the
 *    contract — a spelling missing from it makes the market fail to
 *    recognise its own row, which silently disables self-update rather than
 *    erroring.
 *
 * 2. The config card is dispatched by `<bundle package name>#<row id>`. The
 *    row id must equal the host half's `export const name`, and BOTH bundle
 *    names must be registered: the page keys the row by whichever package
 *    DECLARES it, which is the aggregate when installed through this
 *    repository's bundle and this package when installed standalone.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MARKET_SELF_NAMES, isMarketSelfName, selfNameIn } from '../src/self-names.ts'
import { MARKET_BUNDLE_NAMES, MARKET_ROW_ID } from '../src/client/index.ts'

describe('market self names', () => {
  it('recognises all three live spellings', () => {
    expect(isMarketSelfName('dsh-market')).toBe(true)
    expect(isMarketSelfName('dshmarket')).toBe(true)
    expect(isMarketSelfName('@logictan/dshmarket')).toBe(true)
  })

  it('does not claim a neighbouring package', () => {
    // A prefix match would swallow these; the set is exact membership.
    expect(isMarketSelfName('dsh-market-clone')).toBe(false)
    expect(isMarketSelfName('@logictan/dshmarket-extra')).toBe(false)
    expect(isMarketSelfName('@other/dshmarket')).toBe(false)
    expect(isMarketSelfName('dsh-loop')).toBe(false)
  })

  it('resolves the spelling a profile actually carries', () => {
    expect(selfNameIn({ dshmarket: '^1.0.0' })).toBe('dshmarket')
    expect(selfNameIn({ '@logictan/dshmarket': '^1.0.0' })).toBe('@logictan/dshmarket')
    expect(selfNameIn({ 'dsh-loop': '^1.0.0' })).toBeUndefined()
  })

  it('keeps upstream spelling first so an old profile resolves as it always did', () => {
    // Insertion order is the tie-break, and a profile carrying two spellings
    // is overwhelmingly one that upgraded in place.
    expect([...MARKET_SELF_NAMES][0]).toBe('dshmarket')
  })
})

describe('plugins.row.config registration', () => {
  it('keys the row by the host half name', () => {
    // The patch row id and the host half's `export const name` are the same
    // string; if they drift, the card is dispatched under a key no row
    // declares and simply never appears.
    const host = readFileSync(resolve('src/index.ts'), 'utf8')
    expect(host).toContain(`export const name = '${MARKET_ROW_ID}'`)

    const patch = readFileSync(resolve('cordis.patch.yml'), 'utf8')
    expect(patch).toContain(`id: ${MARKET_ROW_ID}`)
  })

  it('registers every bundle that can declare the row', () => {
    // Both, deliberately: the page dispatches only the keys its own bundles
    // declare, so the absent one never fires and costs one registration.
    expect([...MARKET_BUNDLE_NAMES]).toEqual(['@logictan/dsh-plugins-all', '@logictan/dshmarket'])
  })

  it('composes the exact dispatch keys the page looks up', () => {
    expect(MARKET_BUNDLE_NAMES.map(bundle => `${bundle}#${MARKET_ROW_ID}`)).toEqual([
      '@logictan/dsh-plugins-all#dsh-market',
      '@logictan/dshmarket#dsh-market',
    ])
  })

  it('registers into the slot DSH 0.1.6 declares, not the removed one', () => {
    const source = readFileSync(resolve('src/client/index.ts'), 'utf8')
    expect(source).toContain("inject('plugins.row.config'")
    expect(source).toContain("name: 'plugins.row.config'")
    // `settings.plugin.item` is no longer declared by the host, and a
    // registration into an undeclared slot throws — which took the card
    // down. Only the explanatory comment may mention it.
    for (const line of source.split('\n')) {
      if (line.includes('settings.plugin.item')) expect(line.trim().startsWith('//')).toBe(true)
    }
  })

  it('keeps the nested settingsScope guard', () => {
    // Naming settingsScope at module level would gate the whole plugin on a
    // service older hosts lack, taking the market's own page with it.
    expect(readFileSync(resolve('src/client/index.ts'), 'utf8')).toContain("inject(['settingsScope']")
  })
})

/**
 * Tailwind config for the theme stylesheet.
 *
 * Tailwind is used as a **compile-time** utility resolver, not as a runtime
 * framework: `src/theme.css` writes the design's own utility strings inside
 * `@apply`, and this config compiles them down to plain CSS that is embedded
 * into the client bundle. Nothing from Tailwind ships to the browser.
 *
 * Two settings are load-bearing:
 *
 *  - `content: []` — nothing is scanned. Only the utilities named in an
 *    `@apply` are emitted, so the output is exactly the rules this theme
 *    needs (~5 KB) instead of a whole utility sheet.
 *  - `preflight: false` — Tailwind's preflight is a global reset
 *    (`* { border-width: 0; box-sizing: border-box }`, `img { max-width: 100% }`,
 *    `svg { vertical-align: middle }`, `body { line-height: 1.5 }`). Injecting
 *    it into the host would repaint the host's own components: measured damage
 *    is 7 of 14 probes (svg baseline→middle, img none→100%, body line-height
 *    normal→24px, button font 13.33→14px, sidebar row border none→solid,
 *    input box 4x20→0x18, table height 557→535). Disabled here, and the build
 *    asserts the compiled CSS contains no preflight.
 */
module.exports = {
  content: [],
  corePlugins: {
    preflight: false,
  },
}

/**
 * Tailwind is a COMPILE-TIME utility resolver here, exactly as in
 * `dsh-macos-theme`: the stylesheet is authored with `@apply`, the build
 * compiles it to plain CSS once, and the result is inlined into `lib/client.js`.
 *
 * `content: []` — nothing is scanned for utility class names, so the only
 * utilities that reach the output are the ones an `@apply` names. That is what
 * keeps this package's styles from colliding with the host's own class names:
 * the DOM only ever carries this package's `dsp-*` semantic classes.
 *
 * `preflight: false` — the host owns the page reset; Tailwind's preflight would
 * restyle every host element on the page.
 */
module.exports = {
  content: [],
  corePlugins: {
    preflight: false,
  },
}

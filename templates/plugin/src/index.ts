/**
 * @logictan/<name> — host half.
 *
 * Replace this file's body with the plugin's actual host-side behaviour. What
 * must survive the replacement:
 *
 *  - `export const name` equals the `id` in cordis.patch.yml. Nothing checks
 *    this automatically; a mismatch means the row mounts a plugin whose id does
 *    not match its own name, which only shows up as a confusing loader message.
 *
 *  - `export const Config` is exported from THIS entry, not from a subpath. The
 *    settings service reads `entry.fiber.runtime.Config` — a schema exported
 *    anywhere else is invisible and the plugin's settings card is simply empty.
 *
 *  - Every field is `.volatile()`. A non-volatile field is rendered read-only:
 *    the Host refuses a write to a path that is not under a `.volatile()` node
 *    (`Config field "<path>" is not volatile`). Volatility is what lets a value
 *    be edited without a remount.
 *
 * @module @logictan/<name>
 */

import Schema from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'

/** Cordis companion plugin name. Must equal this plugin's `cordis.patch.yml` row id. */
export const name = '<name>'

/**
 * Configuration surface.
 *
 * The browser half renders these fields automatically through `ConfigForm`, so
 * adding a knob is one line here and nothing in the browser half. `comment` is
 * the field's label and `description` the sentence under it; without a
 * `comment` the label falls back to the key.
 *
 * A field is read in the browser half through the settings namespace this
 * plugin registers (`@logictan/<name>`), not from a prop, so both halves agree
 * on the key names — and only the key names.
 */
export const Config = Schema.object({
  /** Replace with a real knob, or delete the whole schema if there is none. */
  enabled: Schema.boolean().default(true).comment('启用').description('关闭后本插件不生效').volatile(),
})

/**
 * Host plugin body.
 *
 * Services are requested through a nested `ctx.inject([...], scoped => …)`
 * rather than the plugin's own `inject` list. A named missing service in
 * `inject` means cordis never calls `apply` at all, so "this deployment has no
 * service X" would silently become "this plugin does not exist". Nested, an
 * absent service costs only the feature that needs it.
 */
export function apply(ctx: Context): void {
  void ctx
}

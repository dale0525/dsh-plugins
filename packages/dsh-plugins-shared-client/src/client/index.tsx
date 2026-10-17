/**
 * @logictan/dsh-plugins-shared-client — browser half.
 *
 * Two jobs in one bundle, because the module table only has room for one:
 *
 *  1. **It is the module.** Every plugin that renders a settings card imports
 *     its components from this package, and the loader serves them from this
 *     file's `module.exports`. Consumers declare the dependency in
 *     `dsh.client.external` so the module graph orders this row first.
 *  2. **It is a plugin.** The package has a patch row of its own, and that row
 *     is what puts this file into the module table at all — a package that is
 *     merely a `dependencies` entry never reaches the table, and the consumer's
 *     `require` then fails with `missed the module table`. Having a row means
 *     the runner also resolves a plugin from these exports, so `apply` exists
 *     and does the one thing the layer actually needs at activation time:
 *     install the stylesheet.
 *
 * The stylesheet is rewritten on every activation rather than skipped when a
 * tag is already present. HMR replaces the plugin fiber without re-running boot,
 * so an "already exists" guard would make every later CSS change invisible until
 * a manual page refresh.
 */
import { createElement } from 'react'

export const name = 'plugins-shared-client'

/**
 * Compiled by `build.mjs`: Tailwind compiles `src/theme.css` and the resulting
 * text replaces this placeholder in the bundle. The identifier is declared here
 * so `tsc --noEmit` accepts it, and `build.mjs` fails the build if the emitted
 * bundle no longer contains it.
 */
declare const __DSH_SHARED_CSS__: string
const CSS: string = __DSH_SHARED_CSS__

const STYLE_ID = '@logictan/dsh-plugins-shared-client/styles'

export function apply(): void {
  let tag = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (tag === null) {
    tag = document.createElement('style')
    tag.id = STYLE_ID
    document.head.appendChild(tag)
  }
  tag.textContent = CSS
}

export { cx } from './cx.ts'
export { Button } from './Button.tsx'
export type { ButtonSize, ButtonVariant } from './Button.tsx'
export { describeConfigFields } from './config-schema.ts'
export type { ConfigField } from './config-schema.ts'
export { ConfigForm, ConfigSummary } from './ConfigForm.tsx'
export type {
  ConfigDescribeHandle,
  ConfigFormHandle,
  ConfigFormProps,
  ConfigFormSnapshot,
  ConfigPathOp,
} from './ConfigForm.tsx'
export { Banner, EmptyState, Skeleton, StatusDot, Tag } from './feedback.tsx'
export type { StatusKind } from './feedback.tsx'
export { Field, NumberField, SecretField, TextArea, TextField } from './fields.tsx'
export type { FieldShellProps } from './fields.tsx'
export { ListEditor, ReadonlySummary, SettingsCard } from './layout.tsx'
export { Select } from './Select.tsx'
export type { SelectOption } from './Select.tsx'
export { Checkbox, Radio, Segmented, Switch } from './toggles.tsx'
export type { SegmentedOption } from './toggles.tsx'
export * as icons from './icons.tsx'

/**
 * `createElement` is re-exported because a consumer's plugin object may need to
 * build a one-off element outside JSX (a `title`, an inline glyph) without
 * pulling React into its own bundle. It is also what keeps `react` referenced
 * from this module rather than only from JSX internals.
 */
export { createElement }

/** Browser half: WorkBuddy account status inside Plugin configuration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { WorkBuddyProbeControl } from './WorkBuddyProbeControl.tsx'
import { WorkBuddyPluginConfig } from './WorkBuddyPluginConfig.tsx'
import type { WorkBuddyPluginConfigInjected } from './WorkBuddyPluginConfig.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-connect-client'

/**
 * The patch row this plugin's own `cordis.patch.yml` inserts.
 *
 * It equals the host half's `export const name` in `src/index.ts`, and the
 * browser half addresses its configuration page by
 * `<bundle package name>#<this id>`.
 */
export const WORKBUDDY_ROW_ID = 'llm-workbuddy'

/**
 * Bundle package names whose row {@link WORKBUDDY_ROW_ID} this card configures.
 *
 * The Plugins page keys a row's configuration by the name of the package that
 * declares the row. This plugin reaches a profile in one of two shapes, and the
 * key differs between them: as a dependency of this repository's aggregate
 * bundle, the declaring package is the aggregate; installed on its own, it is
 * this package. Both keys are registered — the one whose bundle is not
 * installed simply never renders, because the page dispatches only the keys its
 * own bundles declare.
 */
export const WORKBUDDY_BUNDLE_NAMES = [
  '@logictan/dsh-plugins-all',
  '@logictan/dsh-workbuddy-connect',
] as const

/**
 * Client services required by the Plugin configuration contribution.
 *
 * DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
 * hold the browser `ClientContext` alias and the `slots` service). The services
 * this card relies on now come from narrower packages: the `slots` registry
 * moved to `@deepseek-ai/dsh-client-ui-renderer`, `locale` stayed in
 * `@deepseek-ai/dsh-client-locale`, and the `plugins.row.config` slot is
 * declared by `@deepseek-ai/dsh-client-ui-plugin-manager`. All three are named
 * in the package's `dsh.client.inject` list, so cordis has activated them
 * before this plugin's fiber starts.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency at the client entry is required by the Desktop
// renderer; without it Cordis rejects `directoryFor()` before this bundle can
// finish registering its contributions.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/**
 * Register card copy and the WorkBuddy configuration page.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the 0.1.5→0.1.6 move from `settings.plugin.item` to the
 * `plugins.*.config` slots) degrades to a `console.error` instead of throwing
 * into the DSH loader and raising the red "Failed to load plugins" banner. The
 * host provider keeps working: the `workbuddy` model channel is unaffected, and
 * `dsh-workbuddy-connect status` reports host health via the heartbeat file.
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-connect: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPluginConfigInjected['t']
    // One entry per bundle that can declare this row, each rendering BOTH
    // product cards. The slot is key-dispatched by `<bundle>#<row id>`, and a
    // bundle declares the row once, so the two products cannot occupy two keys:
    // a second registration under the same key throws. The products stay
    // separate cards inside the one page instead — they show different
    // accounts, balances, and model sets, so a single merged form could not say
    // which account a number belongs to.
    for (const bundle of WORKBUDDY_BUNDLE_NAMES) {
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: `${bundle}#${WORKBUDDY_ROW_ID}`,
        inject: (): WorkBuddyPluginConfigInjected => ({ t }),
      }, WorkBuddyPluginConfig))
    }
    ctx.inject(['modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'workbuddy-probe',
        order: 10,
        inject: sessionId => ({
          directory: scope.modelDirectories.directoryFor(
            sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
          ).store,
          t,
        }),
      }, WorkBuddyProbeControl))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy-connect] client card failed to load (host provider unaffected):', error)
  }
}

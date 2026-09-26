/**
 * Browser-half entry for the dsh-imagegen plugin — runs inside the dsh web GUI.
 *
 * Registers the locale dictionaries, binds the plugin's own settings scope (its
 * bridge routes serve the namespace), registers the row's configuration entry
 * onto the Plugins page's per-row configuration slot, and registers the inline
 * image renderer for image-generation tool results. Failure policy: mounting
 * problems are logged, never thrown — the web shell fails the whole boot when a
 * plugin apply throws, and an external plugin must not take the GUI down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { applyHostLocale } from './helpers.ts'
import { en, ru, zh, type ImageGenKey } from './locales.ts'
import { ImageGenSettingsCard, ImageGenSettingsCardController } from './SettingsCard.tsx'
import { bindImageGenScope, type ImageGenScope } from './settings-scope.ts'
import { registerImageToolviews, type ImageToolViewOwnerProps } from './image-toolview.tsx'

/** Locale namespace this plugin owns. */
const NS = 'dsh-imagegen'

/**
 * The patch row this plugin's own `cordis.patch.yml` inserts.
 *
 * It equals the host half's `export const name` in `src/index.ts`, and the
 * browser half addresses its configuration entry by
 * `<bundle package name>#<this id>`.
 */
export const IMAGEGEN_ROW_ID = 'imagegen'

/**
 * Bundle package names whose row {@link IMAGEGEN_ROW_ID} this card configures.
 *
 * The Plugins page keys a row's configuration by the name of the package that
 * declares the row. This plugin reaches a profile in one of two shapes, and the
 * key differs between them: as a dependency of this repository's aggregate
 * bundle, the declaring package is the aggregate; installed on its own, it is
 * this package. Both keys are registered — the one whose bundle is not
 * installed simply never renders, because the page dispatches only the keys its
 * own bundles declare.
 */
export const IMAGEGEN_BUNDLE_NAMES = [
  '@logictan/dsh-plugins-all',
  '@logictan/dsh-imagegen',
] as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-imagegen surface copy. */
    'dsh-imagegen': ImageGenKey
  }

  interface SlotMap {
    /**
     * The official plugin row-configuration slot the Plugins page declares for
     * a row a bundle contributes (the configure control beside the row opens
     * this entry's own page). This card registers there as its own standalone
     * entry — independent of the dsh-web-ui family group — so this plugin never
     * reads as part of that family. Spelled here with the same shape so this
     * package can register without depending on the sibling UI package.
     */
    'plugins.row.config': { kind: 'keyed'; scope: 'root'; owner: ImageGenPluginConfigOwnerProps }
    /** Image-generation results render their durable image blocks inline. */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ImageToolViewOwnerProps }
  }
}

/** Owner share of a plugin row's configuration entry. */
export interface ImageGenPluginConfigOwnerProps {
  /** The view the Plugins page asks for: the row's one-liner, or its page. */
  readonly view: 'summary' | 'page'
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Mount the settings card and the inline image renderer.
 * @param ctx - client root context (services: slots, locale, connection).
 */
export function apply(ctx: ClientContext): void {
  // The host locale service only knows zh/en dictionaries (its type is
  // fixed); ru rides the untyped single-locale registration instead.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-imagegen: dictionaries')
  // Russian ships as a language pack: the dictionary lands in this plugin's
  // namespace, and Русский joins the shared DSH language catalog (Settings →
  // General → Language) with per-key fallback to English for host copy.
  // Registration order/aggregation between register(NS, 'ru', …) and
  // addLanguage differs across host builds and a duplicate throws — these
  // surfaces must degrade silently, never fail the GUI boot.
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, 'ru', ru)
    } catch (error) {
      console.warn('[dsh-imagegen] ru dictionary not registered:', error)
      return () => {}
    }
  }, 'dsh-imagegen: ru dictionary')
  ctx.effect(() => {
    try {
      if (ctx.locale.getLocale().locales.some(locale => locale.id === 'ru')) return () => {}
      return ctx.locale.addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })
    } catch (error) {
      console.warn('[dsh-imagegen] ru language not added to the catalog:', error)
      return () => {}
    }
  }, 'dsh-imagegen: ru language pack')
  // Every plugin surface renders through tt(); bridge DSH locale switches
  // into it so the whole plugin follows the interface language.
  ctx.effect(() => {
    const applyLocale = (): void => { applyHostLocale(ctx.locale.getLocale().active) }
    applyLocale()
    return ctx.locale.subscribe(applyLocale)
  }, 'dsh-imagegen: follow host locale')
  registerImageToolviews(ctx)

  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const loopback = connection?.isLoopback === true
  // The bridge routes are loopback-fenced; remote browsers get an unavailable
  // scope (the card explains the gap) instead of failing fetches.
  const scope: ImageGenScope = bindImageGenScope(loopback
    ? (input, init) => fetch(input, init)
    : () => { throw new Error('settings bridge is loopback-only') })

  // Re-read the scope whenever the connection resets (same invalidation the
  // official settings binder wires).
  ctx.effect(() => {
    const disposers = [
      ctx.on('connection/reset', () => { void scope.load() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-imagegen: settings scope invalidation')

  // Plugin configuration entry: one staged form over the plugin's settings
  // scope, registered onto the Plugins page's per-row configuration slot. One
  // entry per bundle that can declare this row; the slot is key-dispatched by
  // `<bundle>#<row id>`, so both keys are registered and the bundle that is not
  // installed simply never dispatches its key.
  const settingsCard = new ImageGenSettingsCardController(scope)
  for (const bundle of IMAGEGEN_BUNDLE_NAMES) {
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: `${bundle}#${IMAGEGEN_ROW_ID}`,
      locale: NS,
      inject: () => settingsCard.inject(),
    }, ImageGenSettingsCard))
  }
}

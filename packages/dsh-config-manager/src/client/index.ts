/**
 * dsh-config-manager 浏览器半入口 —— 运行在 dsh web GUI 内。
 * 宽读法改造：仅保留同步设置页与对应字典注册。
 */
import type { ClientContext } from './client-types.ts'
// Type-only：拉入 ctx.locale 的 Context 合并（dsh-client-locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only：拉入 settings.section 的 SlotMap 合并（dsh-client-ui-settings）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only：拉入 SlotMap / LocaleNamespaceMap 合并表（dsh-client-ui-slots）。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ConfigManagerApi } from './api.ts'
import { ConfigManagerSection } from './ConfigManagerSection.tsx'
import { en, zh, type ConfigManagerKey } from './locales.ts'
import { makeUiT, type UiT } from '../ui/i18n.ts'
import { SyncApi } from './sync/sync-api.ts'
import { en as syncEn, zh as syncZh, type SyncKey } from './sync/sync-locales.ts'

/** 本插件拥有的 locale namespace。 */
const NS = 'config-manager'
/** 远程同步设置区块的独立 locale namespace。 */
const SYNC_NS = 'config-manager-sync'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Config Manager 表面文案。 */
    'config-manager': ConfigManagerKey
    /** 远程同步设置区块文案。 */
    'config-manager-sync': SyncKey
  }
}

/** 必需服务（fiber inject 等待 —— slots/locale 必须先就绪）。 */
export const inject = ['slots', 'locale']

/** 类型面（导出纪律：除插件契约外无值导出）。 */
export type { ConfigManagerSectionProps } from './ConfigManagerSection.tsx'
export type { SyncSettingsViewProps } from './sync/SyncSettingsView.tsx'
export type { ConfigManagerApiError, ServiceStatus } from './api.ts'
export type { ConfigManagerKey } from './locales.ts'
export type { SyncKey } from './sync/sync-locales.ts'

/**
 * 注册 Config Manager 设置页。
 * @param ctx - client root context（slots + locale 服务）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'config-manager: dictionaries')
  ctx.effect(() => ctx.locale.register(SYNC_NS, { zh: syncZh, en: syncEn }), 'config-manager: sync dictionaries')

  const t = ctx.locale.bind(NS)
  const uiT: UiT = makeUiT(ctx.locale.getLocale().active === 'en' ? 'en' : 'zh')
  const api = new ConfigManagerApi(uiT)
  const syncT = ctx.locale.bind(SYNC_NS)
  const syncApi = new SyncApi(uiT)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'config-manager',
    order: 60,
    label: () => t('section.label'),
    locale: NS,
    inject: () => ({ api, syncApi, syncT }),
  }, ConfigManagerSection))
}

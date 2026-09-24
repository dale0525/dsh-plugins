/**
 * dsh-config-manager 浏览器半入口 —— 运行在 dsh web GUI 内。
 *
 * 落位：本插件的配置页挂在「插件」页里 @logictan/dsh-plugins-all 的详情页上
 * （plugins.bundle.config，按 bundle 包名寻址），不再占用设置页左侧栏的
 * settings.section 席位。
 */
import type { ClientContext } from './client-types.ts'
// Type-only：拉入 ctx.locale 的 Context 合并（dsh-client-locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
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

/**
 * 可能声明本插件行的 bundle 包名（bundle 配置页按**包名**寻址，不是行 id）。
 *
 * 两种落地形态对应两个 key：作为本仓库聚合包的依赖时是聚合包，单独安装时是本包。
 * 两个 key 都注册——未安装的那个 bundle 永远不会被页面派发，因此不会渲染。
 */
export const CONFIG_MANAGER_BUNDLE_NAMES = [
  '@logictan/dsh-plugins-all',
  '@logictan/dsh-config-manager',
] as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Config Manager 表面文案。 */
    'config-manager': ConfigManagerKey
    /** 远程同步设置区块文案。 */
    'config-manager-sync': SyncKey
  }

  interface SlotMap {
    /**
     * 插件页为 bundle 声明的自有配置槽（bundle 详情页正文里、行列表之上，
     * 仅 `view: 'page'`）。此处按同一形状自行声明，从而无需依赖
     * dsh-client-ui-plugin-manager 即可注册。
     */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: ConfigManagerPluginConfigOwnerProps }
  }
}

/** 插件配置项的 owner props：页面要求的视图（bundle 配置只渲染 page）。 */
export interface ConfigManagerPluginConfigOwnerProps {
  /** 页面要求的视图：`page` 为带保存控件的表单页。 */
  readonly view: 'summary' | 'page'
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
 * 注册 Config Manager 配置页（插件页 @logictan/dsh-plugins-all 详情页内）。
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

  // 每个可能声明本插件行的 bundle 各注册一个 key；未安装的那个不会被页面派发。
  for (const bundle of CONFIG_MANAGER_BUNDLE_NAMES) {
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: bundle,
      locale: NS,
      inject: () => ({ api, syncApi, syncT }),
    }, ConfigManagerSection))
  }
}

/**
 * Client 半的类型集中出口：把对 @deepseek-ai 运行时包的类型依赖收敛到本文件，
 * 其余组件只从 `../client-types.ts` 引用，避免类型散落与误用值导入。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export type { ClientContext }
export type { TranslateNS }

/** 本插件 Client 半的注入业务面：每个 settings.section 注册项都拿到同一个 api 实例 */
export interface ConfigManagerSectionInjected {
  api: import('./api.ts').ConfigManagerApi
  /** 远程同步 API */
  syncApi: import('./sync/sync-api.ts').SyncApi
  /** 远程同步 locale（config-manager-sync 命名空间） */
  syncT: import('@deepseek-ai/dsh-client-ui-slots').TranslateNS<'config-manager-sync'>
}

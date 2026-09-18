/**
 * dsh-config-manager — Agent 可调用的模型工具。
 *
 * 在 host 半注册 2 个 Cordis 模型工具，让 Agent 能自主驱动配置同步：
 *   config_sync_push        手动推送同步（写远端）
 *   config_sync_pull        拉取差异预览（零写入）
 *
 * 设计遵循 AGENTS.md 铁律：
 *   - 所有业务逻辑为可独立测试的纯编排函数（createModelTools），
 *     复用 src/core 已解耦引擎（SyncEngine），不重复实现；
 *   - React / HTTP 壳不参与；本文件是「引擎侧编排」，不放浏览器 src/ui/；
 *   - ctx.tools 服务用可选读取（ctx.get）守卫：未组合 tools 的部署不注册、不崩溃。
 *
 * 安全不变量（硬约束，勿破坏）：
 *   - config_sync_pull 零写入（只 analyze+plan 出差异）；落地需另走确认导入管道；
 *   - 分区/路径走既有白名单（SECTION_IDS 过滤）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { SyncEngine } from '../sync/sync-engine.ts'
import { SECTION_IDS } from '../schema/config.ts'
import type { SectionId } from '../schema/types.ts'
import { readFullSyncConfig, readSyncConfigFor } from '../sync/sync-config.ts'
import type { SyncConfig, SyncTransportType } from '../sync/sync-config.ts'
import type { ConfigAdapter, HostContext } from './types.ts'
import { runWithMutationLock } from '../utils/env-lock.ts'

/* ------------------------------------------------------------ 依赖与类型 */

/** 模型工具所需依赖（与 host 路由同一来源闭包）。 */
export interface ModelToolsDeps {
  /** HostContext 门面（homeDir / profile / msg / log） */
  host: HostContext
  /** 全部分区适配器 */
  adapters: ConfigAdapter[]
  /** 同步状态目录（$DSH_HOME/dsh-config-manager/sync） */
  syncDir: string
  /** SyncEngine 工厂（git/webdav 按配置分支构造传输；与 host 路由同一来源） */
  makeSyncEngine: (cfg: SyncConfig) => SyncEngine
}

/** SECTION_IDS 白名单过滤（未知/非法分区 id 丢弃，与 host 路由语义一致）。 */
function filterSectionIds(ids: readonly string[]): SectionId[] {
  return ids.filter((id): id is SectionId => (SECTION_IDS as readonly string[]).includes(id))
}

/** 解析同步引擎：channel 缺省取已配置的活动通道（git/webdav），未配置则抛可操作错误。 */
async function resolveEngine(
  deps: ModelToolsDeps,
  channel?: SyncTransportType,
): Promise<{ engine: SyncEngine; channel: SyncTransportType }> {
  let ch: SyncTransportType = channel ?? 'git'
  if (channel === undefined) {
    const full = await readFullSyncConfig(deps.syncDir)
    if (full !== null && full.transport === 'webdav') ch = 'webdav'
  }
  const cfg = await readSyncConfigFor(deps.syncDir, ch)
  if (cfg === null) {
    throw new Error(`同步通道 ${ch} 尚未配置（sync-config.json 缺失或损坏）`)
  }
  return { engine: deps.makeSyncEngine(cfg), channel: ch }
}

/* ------------------------------------------------------------ 纯编排函数 */

/** 5 个工具的纯编排实现（可独立测试，不依赖 Cordis ctx）。所有返回均为 JsonValue（可序列化、无 undefined）。 */
export function createModelTools(deps: ModelToolsDeps) {
  return {
    /** 手动推送同步（写远端）。明文快照：勾选即同步，不加密、不脱敏。 */
    async syncPush(input: {
      channel?: SyncTransportType
      sections?: SectionId[]
    }): Promise<JsonValue> {
      const { engine } = await resolveEngine(deps, input.channel)
      const sections = input.sections === undefined ? undefined : filterSectionIds(input.sections)
      // Phase 2 锁：push 写远端 + 本地散文件 + sync-state，属 GLOBAL mutation。
      // Step 3 P0-A：外部 push 记 intent journal（crash 后不可证明 → NEEDS_ATTENTION，不自动重推）。
      const doPush = () => engine.push({
        ...(sections === undefined ? {} : { sections }),
      })
      const report = await runWithMutationLock(deps.host.mutationLock, { op: 'model-sync-push', isBlocked: () => deps.host.safeModeIsBlocked?.() ?? false }, async (lockCtx) => {
        if (deps.host.phase3Recovery !== undefined && lockCtx !== null) {
          const r = await deps.host.phase3Recovery.runExternalIntent({
            operationType: 'model-sync-push',
            lockCtx,
            intent: { adapter: 'sync', ref: input.channel ?? 'default', kind: 'Push' },
            fn: doPush,
          })
          return r.result
        }
        return doPush()
      })
      return {
        ok: report.ok,
        snapshotId: report.snapshotId,
        sections: report.sections,
        warnings: report.warnings,
        ...(report.message === undefined ? {} : { message: report.message }),
      }
    },

    /** 拉取差异预览（零写入：只下载 + analyze + plan 出差异报告）。 */
    async syncPull(input: {
      channel?: SyncTransportType
      snapshotId?: string
      strategy?: 'merge' | 'replace' | 'skipExisting'
    }): Promise<JsonValue> {
      const { engine } = await resolveEngine(deps, input.channel)
      const strategy = input.strategy === 'replace' || input.strategy === 'skipExisting' ? input.strategy : 'replace'
      const report = await engine.pull({
        strategy,
        ...(input.snapshotId === undefined || input.snapshotId === '' ? {} : { snapshotId: input.snapshotId }),
      })
      return {
        ok: report.ok,
        snapshotId: report.snapshotId,
        needsReview: report.needsReview,
        changes: report.changes.map((c) => ({
          id: c.id,
          adapter: c.adapter,
          kind: c.kind,
          description: c.description,
          severity: c.severity,
        })),
        ...(report.message === undefined ? {} : { message: report.message }),
      }
    },
  }
}

/* ------------------------------------------------------------ 注册（defineTool 薄壳） */

type ModelTools = ReturnType<typeof createModelTools>

/** 把 2 个模型工具注册进 ctx.tools；tools 服务未组合时静默跳过（不崩溃）。 */
export function registerModelTools(ctx: Context, deps: ModelToolsDeps): void {
  const toolsSvc = ctx.get('tools')
  if (toolsSvc === null || toolsSvc === undefined || typeof toolsSvc !== 'object') {
    deps.host.log.warn?.('tools 服务不可用：跳过模型工具注册（引擎能力仍可用）')
    return
  }
  const tools: ModelTools = createModelTools(deps)
  const disposers: (() => void)[] = []
  // 注意：必须经 ctx.get('tools') 的结果注册，绝不能用 ctx.tools 属性访问——
  // Cordis 的属性访问要求插件声明 inject: ['tools']，未声明时即使服务存在也会抛
  // "cannot get property X without inject"（tools 是可选服务，不应进 inject）。
  const register = (def: Parameters<typeof ctx.tools.register>[0]): void => {
    disposers.push(toolsSvc.register(def))
  }

  register(defineTool({
    name: 'config_sync_push',
    description:
      '手动推送 DSH 配置同步到远端（Git/WebDAV），复用已持久化的通道配置。写远端属主动操作；快照为明文（私有通道自用），勾选即同步。',
    parameters: {
      channel: {
        type: 'string',
        enum: ['git', 'webdav'],
        description: '同步通道；缺省 = 已配置的活动通道',
      },
      sections: {
        type: 'array',
        items: { type: 'string', enum: [...SECTION_IDS] },
        description: '仅推送的分区；缺省 = 全部推荐分区',
      },
    },
    output: {
      schema: { type: 'json', description: '推送报告（snapshotId / 实际同步分区 / 告警）' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.syncPush(args)
    },
  }))

  register(defineTool({
    name: 'config_sync_pull',
    description:
      '拉取远端同步差异预览（Git/WebDAV，零写入：只下载 + 分析出差异报告，绝不直接写配置）。若要落地差异需另走确认导入管道。',
    parameters: {
      channel: {
        type: 'string',
        enum: ['git', 'webdav'],
        description: '同步通道；缺省 = 已配置的活动通道',
      },
      snapshotId: {
        type: 'string',
        description: '远端快照 id；缺省 = 最新',
      },
      strategy: {
        type: 'string',
        enum: ['merge', 'replace', 'skipExisting'],
        description: '差异全局策略；缺省 replace（远端值覆盖本地）',
      },
    },
    output: {
      schema: { type: 'json', description: '差异报告（changes 列表 / needsReview）' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.syncPull(args)
    },
  }))

  ctx.effect(() => () => { for (const d of disposers) d() }, 'config-manager: model tools')
}

/**
 * dsh-config-manager — host half.
 *
 * Mounts the backup / export / import engine (src/core Exporter + Importer
 * three-stage flow) behind the `/api/dsh-config-manager/*` route family that
 * the browser half (`./client`) calls, and wraps the real DSH host services
 * into the engine's `HostContext` facade (src/core/types.ts):
 *
 *   ctx.settings           -> SettingsFacade      (@deepseek-ai/dsh-settings)
 *   ctx.credentials        -> CredentialsFacade   (@deepseek-ai/dsh-credentials)
 *   ctx.plugins            -> PluginsFacade       (官方 dsh plugin CLI 通道 + profile 文件，
 *                                                  见 src/core/plugin-cli.ts)
 *   ctx.workspaceRegistry  -> WorkspaceFacade     (@deepseek-ai/dsh-workspace)
 *   ~/.dsh/cordis.patch.yml-> PatchFileFacade     (js-yaml)
 *   $DSH_HOME files        -> FileSystemFacade    (node:fs, home-relative)
 *   resolveDshHome()       -> homeDir             (@deepseek-ai/dsh-home-paths)
 *
 * Security posture (mirrors the verified @linxin666/dsh-ssh@0.1.12 routes):
 *  - every route carries the loopback-only + same-origin trust fence
 *    (isLoopbackRequest); LAN-exposed deployments never serve these endpoints;
 *  - uploads/exported ZIPs are staged under $DSH_HOME/dsh-config-manager/{tmp,exports}
 *    and every `path`/`zipPath` reference is confined to those roots;
 *  - there is no encryption layer: every backup is plaintext, and secret values are
 *    stripped by the secret scanner before they reach any file, manifest, or log;
 *  - the import execute endpoint refuses to run without `confirm: true`
 *    (core ImportNotConfirmedError safety valve).
 *
 * Optional services are read with ctx.get() at call time (never injected), so
 * the engine keeps working in profiles without the web-only workspace
 * service; hard dependencies are the core `settings`/`credentials` services
 * present in every profile. Plugin install/list no longer depend on the
 * web-only pluginMarketplace/pluginInventory services: both go through the
 * official `dsh plugin --profile <name>` CLI (pnpm forwarder) and read the
 * profile's package.json / node_modules directly.
 */

import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as dshCredentials from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pull the Cordis Context augmentations (webServer / workspaceRegistry)
// and the WebRoute contract without any runtime import.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as yaml from 'js-yaml'

import { Exporter, FileSnapshotStore, Importer, verifySnapshot } from './core/index.ts'
import { APPLY_ORDER, ProfileManager, isValidProfileName } from './profiles/index.ts'
import { cleanupCaches } from './core/cache-cleaner.ts'
import { deleteSnapshot, isValidSnapshotId, listSnapshots, planRestore, setSnapshotPinned, validateSnapshotForRestore, type RestorePlan, type RestoreReport, type RestoreSnapshotVerdict } from './core/restore.ts'
import { rollback as performRollback } from './core/rollback.ts'
// Phase 1 P0-1/P0-2：配置生命周期（自动快照 / 撤销 / 重做）与 P0-5 崩溃归因。
// 监听工厂用真 fs.watch 注入（core 侧只依赖抽象，便于测试驱动时序）。
import { ConfigLifecycle } from './core/config-lifecycle.ts'
import { deleteConfigSnapshot } from './core/config-snapshot.ts'
import {
  adviceFor, beginBoot, computeBootAlert, listCandidateLogs, markBootOk,
  readBootState, readCrashLogTail, writeBootState,
} from './core/crash-report.ts'
// Phase 1 P0-3：启动救援模式（备份 patch/package.json → 写最小 patch → 中和 bundles）
import { enterRescueMode, exitRescueMode, rescueModeStatus } from './core/boot-rescue.ts'
import { watch as fsWatch } from 'node:fs'
import { recomputeRecoveryDecision, executeRecovery } from './core/reconcile.ts'
import { verifyRecovery, recoveryTerminalState } from './core/verify-recovery.ts'
import { createRecoveryOrchestrator, type RecoveryExecutorFns } from './core/recovery-orchestrator.ts'
import { redactJournalText, isValidOperationId, isTerminalState, transitionJournalState, JournalStore, type OperationJournal } from './core/journal.ts'
import { RunRegistry, type RunState } from './core/run-registry.ts'
import { registerModelTools } from './core/model-tools.ts'
import { computeConsultReport, type ConsultSourceRef, type ConsultSourceData, type MigratabilityResult } from './core/migration-consult.ts'
import { readExportZipSource, buildLocalSnapshotSource, buildProfileSource } from './core/consult-source.ts'
import { makeMsg, msgOf, zhMsg } from './core/messages.ts'
import type { MsgFunc } from './core/messages.ts'
import {
  cleanupAbortedInstall, hasDshBundlePatch, installErrorFor, installSpecFor, listInstalledPlugins,
  resolveProfileDir, resolveProfileNameFromArgv, runDshPlugin, validateProfileName,
} from './core/plugin-cli.ts'
import type {
  ConfigAdapter, CredentialsFacade, FileSystemFacade, HostContext, ImportDecisions,
  ImportPlan, NamespaceInfo, PatchFileFacade, PlanItem, PlanItemKind, PluginInfo, PluginsFacade,
  SettingsFacade, Snapshot, WorkspaceFacade,
} from './core/types.ts'
import { ImportNotConfirmedError, ImportUserSkippedError } from './core/types.ts'
import { createAdapters } from './adapters/index.ts'
import { HOME_PATCH_FILE, PROFILE_PATCH_FILE } from './core/patch-layers.ts'
import { createLocalPluginPackHook } from './core/local-plugin-host.ts'
import { createHardenedZipParser } from './security/zip-security.ts'
import { atomicCopyFile, atomicWriteFile } from './utils/atomic-write.ts'
import { EnvironmentLockManager, runWithMutationLock, EnvironmentLockUnavailableError, type MutationLockContext } from './utils/env-lock.ts'
import { activeProxySummary } from './utils/proxy.ts'
import { listRecursiveFollowingLinks } from './utils/recursive-walk.ts'
import { Phase3Recovery, TransactionRecoveryRequiredError, mapLockStateForStartup } from './core/phase3-host.ts'
import type { JournalRunContext } from './core/phase3-host.ts'
import { classifyStartup } from './core/startup-barrier.ts'
import type { MutationLockPort } from './utils/env-lock.ts'
import type { RecursiveListing } from './utils/recursive-walk.ts'
import { GitTransport } from './sync/git/git-transport.ts'
import { WebDavTransport } from './sync/webdav/webdav-transport.ts'
import { DeviceFlowStore, GitHubAuthClient, GitHubAuthError } from './sync/github-auth.ts'
import { SyncEngine } from './sync/sync-engine.ts'
import type { ApplyItemsReport } from './sync/sync-engine.ts'
import { SyncSessionStore } from './sync/sync-session.ts'
import { AutoSyncScheduler } from './sync/autosync-scheduler.ts'
import { readAllAutosyncConfigs, readAutosyncConfig, writeAutosyncConfig } from './sync/autosync-config.ts'
import type { AutosyncConfig, AutosyncInterval, AutosyncRunStatus } from './sync/autosync-config.ts'
import { appendAutosyncEntry, readSyncHistory } from './sync/sync-history.ts'
import {
  MigrationStore, queryHistory, summarizeHistory, renderExport, parseHistoryQuery,
  type MigrationKind, type MigrationResult, type ReadMigrationResult,
  type StoredMigrationHistoryEntry, MIGRATION_HISTORY_DIR,
} from './core/migration-history.ts'
import { loadSyncState, saveSyncState } from './sync/sync-state.ts'
import {
  readSyncConfig, readSyncConfigFor, readFullSyncConfig, writeSyncConfig, validateRepoUrl, validateWebDavUrl,
  isGitConfig, isWebDavConfig,
} from './sync/sync-config.ts'
import type { SyncConfig, FullSyncConfig, SyncTransportType } from './sync/sync-config.ts'
import {
  defaultSyncSelection, effectiveSections, readAllSyncSelections, readSyncSelection, writeSyncSelection,
  SYNC_SELECTION_SCHEMA_VERSION,
} from './sync/sync-selection.ts'
import type { SyncSelection, SyncSelectionMode } from './sync/sync-selection.ts'
import { readUiPrefs, updateUiPrefs } from './sync/ui-prefs.ts'
import type { UiPrefsChannel } from './sync/ui-prefs.ts'
import type { SyncTransport } from './sync/transport.ts'
import { redact } from './security/redaction.ts'
import { createConfiguredSecretScanner } from './security/secret-scanner.ts'
import type { ConfiguredSecretPatterns } from './security/secret-scanner.ts'
import type { SecretScanner } from './core/types.ts'
import { sha256Hex } from './utils/hashing.ts'
import { isFileSection, SECTION_IDS } from './schema/config.ts'
import { stringifyJsonSafe } from './utils/json.ts'
import type { SectionId, WorkspaceRecord } from './schema/types.ts'
import { zipToBuffer } from './utils/zip.ts'
import { isSameOrChild, normalizePath } from './utils/paths.ts'
import { createLogger, type Logger } from './utils/logger.ts'

/* ---------------------------------------------------------------- identity */

/** Stable cordis plugin name — must match the cordis.patch.yml row id. */
export const name = 'config-manager'

/** Services required before the engine can mount (present in every profile). */
export const inject = ['settings', 'credentials']

/** Plugin version, kept in sync with package.json ("version"). */
const PLUGIN_VERSION = '0.1.62'

/** Plugin own package name — excluded from its own exported plugins list. */
const PLUGIN_NAME = 'dsh-config-manager'

/**
 * Star 引导弹窗指向的 GitHub 仓库（用户引导点 Star 的目标）。
 * 指向**衍生来源的上游仓库**，不是 package.json 的 repository（后者指向本仓库）；
 * 界面不可改（硬编码，参照「一键上传」目标仓库先例）。仅在 GET /star-prompt
 * 响应中返回，供弹窗按钮跳转。
 */
const STAR_PROMPT_REPO_URL = 'https://github.com/xiajiajun516/dsh-config-manager'

/** 缓存自动清理周期：24 小时（启动即清一次 + 此后每日一次；与 cache-cleaner 保留期独立） */
const CACHE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * 内置 GitHub OAuth App 的 client_id（「使用 GitHub 登录」device flow 缺省值）。
 * Client ID 是公开标识（GitHub 官方明确非机密）：内置后所有安装者开箱即用，
 * 无需各自注册/配置 OAuth App；token 仍按用户私有（各自授权、各自存 credentials）。
 * 插件配置的 githubClientId 优先于本默认值（换自有 App 时覆盖）。
 */
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23liq4i7n8UsylGRfb'

/** Plugin config (composition entry); the loader applies it as-is. */
export interface Config {
  /** Master switch; defaults to true. */
  enabled?: boolean
  /** Data root override; defaults to $DSH_HOME/dsh-config-manager. */
  dataDir?: string
  /** 管理的 profile 名（插件依赖读写/安装目标）；缺省取启动参数 --profile，再缺省 'web'。 */
  profile?: string
  /**
   * GitHub OAuth App 的 client_id（「使用 GitHub 登录」device flow）。
   * 缺省使用内置 DEFAULT_GITHUB_CLIENT_ID（公开标识，开箱即用）；
   * 显式配置可覆盖（换自有 OAuth App 时）。
   */
  githubClientId?: string
  /**
   * GitHub OAuth App 的 client_secret（confidential app 必需；public app 可省略）。
   * 只存在于宿主进程：device flow 轮询时由宿主直接发送给 GitHub，绝不回传浏览器/日志。
   */
  githubClientSecret?: string
  /**
   * pluginFiles 分区：额外白名单文件（相对 ~/.dsh 根的单文件名或子路径）。
   * 与默认白名单（dsh-ssh.json、pet.json）合并；用于精确指定要随导出携带的插件配置文件。
   */
  pluginFiles?: string[]
  /**
   * pluginFiles 分区：约定的插件配置目录（相对 ~/.dsh 根，如 'plugin-config'）。
   * 导出时递归收集该目录下所有文件（按相对 ~/.dsh 根的路径写回），实现「往目录放文件即自动随备份携带」。
   */
  pluginFilesDir?: string
  /**
   * F2 个人隐私规则（对齐 dsh-packer config.personalPatterns）：个人化敏感字段名 /
   * 引用字段 / 值形状模式，由部署者注入（个人昵称、本机用户名等），不进开源代码。
   * 未配置时扫描器行为与默认完全一致。
   */
  personalPatterns?: ConfiguredSecretPatterns
}

/* ---------------------------------------------------------------- constants */

/** Route family — must match the browser half's CONFIG_MANAGER_API exactly. */
const API = {
  // 设置页页脚版本行（pluginVersion / dshVersion）。只读，loopback fence。
  status: '/api/dsh-config-manager/status',
  // P2-⑫：导出前只读预览（不落盘 ZIP；返回各分区 counts + 估算大小）
  // P1-⑧：快照管理（手动删除 + 置顶豁免自动清理）
  // m-backup-schedule：定时全量备份（读/存 backup-schedule.json + 立即执行一次）
  // m-backup-files：导出产物管理（列出 exports/*.zip + 删除；下载复用 /download）
  // Phase 7：迁移前咨询（只读健康评分 + 建议；POST，loopback fence）
  // m-sync-ui：远程同步（Git 私有仓库通道）
  syncStatus: '/api/dsh-config-manager/sync/status',
  syncPush: '/api/dsh-config-manager/sync/push',
  syncPull: '/api/dsh-config-manager/sync/pull',
  // m-github-oauth：GitHub OAuth device flow 登录（start → 展示授权码 → poll → token 入库）
  syncGithubStart: '/api/dsh-config-manager/sync/github/start',
  syncGithubPoll: '/api/dsh-config-manager/sync/github/poll',
  syncGithubCancel: '/api/dsh-config-manager/sync/github/cancel',
  // m-sync-github-valid：校验已存 token 是否有效（决定「已登录」→ 隐藏登录区块）
  syncGithubValidate: '/api/dsh-config-manager/sync/github/validate',
  // P2：同步历史 / 自动应用 / 一键回滚
  syncHistory: '/api/dsh-config-manager/sync/history',
  syncRollback: '/api/dsh-config-manager/sync/rollback',
  // m-sync-v2：一键同步（差异确认会话）+ 自动同步 + 历史快照
  syncSnapshotsList: '/api/dsh-config-manager/sync/snapshots-list',
  syncSync: '/api/dsh-config-manager/sync/sync',
  syncApplyItems: '/api/dsh-config-manager/sync/apply-items',
  syncCancel: '/api/dsh-config-manager/sync/cancel',
  syncAutosync: '/api/dsh-config-manager/sync/autosync',
  // m-sync-selection：同步分区选择持久化（默认/高级模式 + 勾选分区；自动同步共用）
  syncSelection: '/api/dsh-config-manager/sync/selection',
  // m-sync-config：同步通道配置保存（UI 表单自动保存 /「保存配置」按钮；凭据写 DSH credentials）
  syncConfig: '/api/dsh-config-manager/sync/config',
  // m-self：插件 UI 偏好（如上次选择的同步通道；ui-prefs.json，随 self 分区进备份）
  syncUiPrefs: '/api/dsh-config-manager/sync/ui-prefs',
  // m-star-prompt：Star 引导弹窗状态（复用 ui-prefs.json；GET 读 + POST 局部更新）
  // 版本更新内容弹窗状态（复用 ui-prefs.json；GET 读 + POST 局部更新）
  // m-market：配置市场（内置单仓库，只读公开仓库：浏览 + 下载 + 安全校验；apply 复用 execute）
  // m-my-configs：「一键上传 / 我的配置」（目标仓库固定 xiajiajun516/dsh-config-market；
  // 登录复用 sync/github/start|poll|cancel，不重复实现；/me/items 401 → 未登录）
  // m-profiles：配置档案（Profile = 一组可切换的配置快照；Save/List/Delete/Rename/Switch/Import）
  // Phase 5：recovery 编排（prefix 路由，内部按 path 分发：status / <opId>/preview|confirm|execute|verify|retry|dismiss）
  // Phase 6：迁移历史审计（统一历史引擎；只读 GET + 导出）
  // Phase 1 P0-1/P0-2：配置生命周期（自动快照 / 撤销 / 重做）与崩溃归因
  // Phase 1 P0-3：启动救援模式（禁用其它插件使 DSH 能启动）
} as const

/**
 * 灾备子系统（Phase 1）总开关 —— 临时下线，待相关缺陷修复后再放出。
 *
 * 置 false 时整个灾备子系统停摆：
 *  - 不启动配置变更监听 → 不产生自动快照（也不再刷「配置快照超出上限」告警）
 *  - 不写 boot-state → 崩溃归因无观测数据（不影响启动）
 *  - /lifecycle /crash /rescue 三条路由一律 503 feature-disabled
 *
 * 与客户端导航入口开关配套：src/client/ConfigManagerSection.tsx 的 SHOW_LIFECYCLE_NAV。
 * 两者都置 true 才是一套完整的灾备功能。
 *
 * 为什么整体下线而不是只停自动快照：自动快照的采集走**全部 adapter**，其中 sessions
 * 分区（历史会话，本机实测 340 MB）远超快照 64 MiB 上限，必然持续失败并刷告警；
 * 在该缺陷修好前，撤销/重做/救援也没有可信的快照基线可用。
 */
const LIFECYCLE_ENABLED: boolean = false

/**
 * 同步 token 的 DSH credentials 引用名（POSIX env-var 形态，满足 CredentialRef 品牌要求）。
 * token 只经 credentialRef 读写（写入由请求体触发，读取在每次 git 网络操作时 resolve），
 * 永不进 repoUrl / argv / commit / 同步文件 / 日志。
 */
export const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN'

/**
 * WebDAV 通道口令的独立 DSH credentials 引用（与 git token 槽位分离）。
 * 口令只经 credentialRef 读写（写入由请求体触发，读取在每次 WebDAV 网络操作时
 * by WebDavTransport 经注入的 getPassword() resolve），永不进 URL / 请求头 / 日志。
 */
export const SYNC_WEBDAV_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD'

/** Cap on JSON request bodies (import plans can be large: 4 MB). */
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024

/** Cap on raw upload bodies (staged to the controlled tmp dir). */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

/* ---------------------------------------------------------- loopback fence */

/** Loopback literal check plus browser same-origin markers (dsh-ssh's fence). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- responses */

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Stream a raw request body to a file, enforcing a byte cap. */
async function writeRequestBodyToFile(req: IncomingMessage, dest: string, maxBytes: number): Promise<number> {
  const sink = createWriteStream(dest)
  let size = 0
  await new Promise<void>((resolvePromise, reject) => {
    req.on('error', reject)
    sink.on('error', reject)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        sink.destroy()
        req.destroy()
        reject(new Error(`upload body exceeds ${maxBytes} bytes`))
      }
    })
    req.pipe(sink)
    sink.on('finish', () => resolvePromise())
  })
  return size
}

/* -------------------------------------------------------------- dsh version */

/** 当前 DSH 应用语言（settings `locale` 命名空间的 preference；缺省 zh）。 */
function resolveAppLanguage(ctx: Context): 'zh' | 'en' {
  try {
    const descriptors = ctx.settings.describe({ redactSecrets: true })
    const locale = descriptors.find((d) => String(d.ns) === 'locale')
    const pref = (locale?.value as { preference?: unknown } | undefined)?.preference
    return pref === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** Resolve the real DSH version from the profile dependency tree (read-only). */
function resolveDshVersion(home: string): string {
  const candidates = [
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch {
      // try the next candidate
    }
  }
  return 'unknown'
}

/* ------------------------------------------------------------ profile name */

/** 解析管理的 profile：config.profile → 启动参数 --profile → 'web'。 */
function resolveProfileName(config?: Config): string {
  const configured = config?.profile
  if (configured !== undefined && configured !== '') return validateProfileName(configured)
  return resolveProfileNameFromArgv()
}

/* ------------------------------------------------------- HostContext facades */

/** Optional Cordis service reader (never injected → never blocks the fiber). */
function readService<T>(ctx: Context, serviceName: string): T | undefined {
  const candidate = ctx.get(serviceName)
  return candidate === null || typeof candidate !== 'object' ? undefined : candidate as T
}

/** Safe settings namespace converter compatible across DSH 0.1.1 and 0.1.2-alpha.x */
const SETTINGS_NAMESPACE_REGEX = /^[a-z][a-z0-9-]*$/
function safeSettingsNamespace(namespace: string): any {
  const fn = (dshSettings as Record<string, unknown>).settingsNamespace
  if (typeof fn === 'function') {
    return (fn as (ns: string) => any)(namespace)
  }
  if (!SETTINGS_NAMESPACE_REGEX.test(namespace)) {
    throw new TypeError(`settings namespace "${namespace}" must match ${String(SETTINGS_NAMESPACE_REGEX)}`)
  }
  return namespace
}

/** Safe credential ref converter compatible across DSH 0.1.1 and 0.1.2-alpha.x */
const CREDENTIAL_REF_REGEX = /^[A-Z_][A-Z0-9_]*$/
function safeCredentialRef(ref: string): any {
  const fn = (dshCredentials as Record<string, unknown>).credentialRef
  if (typeof fn === 'function') {
    return (fn as (r: string) => any)(ref)
  }
  if (!CREDENTIAL_REF_REGEX.test(ref)) {
    throw new TypeError(`credential ref "${ref}" must match ${String(CREDENTIAL_REF_REGEX)}`)
  }
  return ref
}
const credentialRef = safeCredentialRef


/** Settings facade over the real ctx.settings (describe() is namespace-less). */
class DshSettingsFacade implements SettingsFacade {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  private provider(): SettingsProvider {
    return this.ctx.settings
  }

  async describe(namespace: string, opts?: { redactSecrets?: boolean }): Promise<NamespaceInfo> {
    const all = this.provider().describe({ redactSecrets: opts?.redactSecrets ?? true })
    const descriptor = all.find((d) => String(d.ns) === namespace)
    if (!descriptor) throw new Error(`namespace not found: ${namespace}`)
    return {
      value: descriptor.value,
      base: descriptor.base,
      revision: descriptor.revision,
      // Real service reports a single applies value; the core contract is an array.
      applies: descriptor.applies === undefined ? undefined : [descriptor.applies],
      secrets: descriptor.secrets ?? [],
    }
  }

  async replace(namespace: string, value: unknown, expectedRevision?: number): Promise<void> {
    await this.provider().replace(safeSettingsNamespace(namespace), value as object, expectedRevision)
  }

  async update(namespace: string, patch: unknown, expectedRevision?: number): Promise<void> {
    await this.provider().update(safeSettingsNamespace(namespace), patch as object, expectedRevision)
  }
}

/** Credentials facade over the real ctx.credentials (values never round-trip). */
class DshCredentialsFacade implements CredentialsFacade {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }> {
    const info = await this.ctx.credentials.describe(safeCredentialRef(ref))
    return { configured: info.configured, source: info.source, writable: info.writable }
  }

  async set(ref: string, value: string): Promise<void> {
    await this.ctx.credentials.set(safeCredentialRef(ref), value)
  }

  async unset(ref: string): Promise<void> {
    await this.ctx.credentials.unset(safeCredentialRef(ref))
  }
}

/** 包名 → patch 行 id slug（仿 marketplace ensureRow）：去 @、非法字符→-、连续-合并、去首尾-。 */
export function slugOf(name: string): string {
  return name.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
}

/** 某 patch 行（raw）是否激活了指定包名（兼容单行与 insert 块成员）。 */
export function patchRowActivates(raw: unknown, name: string): boolean {
  if (raw === null || typeof raw !== 'object') return false
  const obj = raw as Record<string, unknown>
  const entries = Array.isArray(obj['insert']) ? obj['insert'] : [obj]
  return entries.some((e) => e !== null && typeof e === 'object' && (e as Record<string, unknown>)['name'] === name)
}

/**
 * 非 bundle 插件安装成功后，幂等补 profile cordis.patch.yml 激活行
 * （{id: pm-<slug>, name: <pkg>}，仿 marketplace ensureRow）。bundle 包不写行
 * （CLI 的 reconcile 已维护 dsh.profile.bundles）。
 */
export async function ensureActivationRow(patchFile: PatchFileFacade, pkgDir: string, pkg: string): Promise<void> {
  if (hasDshBundlePatch(pkgDir)) return
  const lines = await patchFile.readPatchLines(PROFILE_PATCH_FILE)
  if (lines.some((l) => patchRowActivates(l.raw, pkg))) return
  const id = `pm-${slugOf(pkg)}`
  await patchFile.applyPatchChanges(PROFILE_PATCH_FILE, [
    { lineId: id, raw: { id, name: pkg }, action: 'insert' },
  ])
}

/**
 * Plugins facade：官方 dsh plugin CLI 通道（任何 profile 可用）+ profile 文件
 * 实时清单 + 非 bundle 插件激活行幂等补写。不再依赖 web 专用
 * pluginMarketplace / pluginInventory 服务。
 *
 * 导出 + runner 可注入：M5 单测用 mock runner 验证「无 marketplace 时 install
 * 走 CLI 通道」的行为契约，不触发真实子进程；生产路径默认参数不变。
 */
export class DshPluginsFacade implements PluginsFacade {
  private readonly homeDir: string
  private readonly profile: string
  private readonly patchFile: PatchFileFacade
  private readonly msg: MsgFunc
  private readonly runner: typeof runDshPlugin

  constructor(
    homeDir: string,
    profile: string,
    patchFile: PatchFileFacade,
    runner: typeof runDshPlugin = runDshPlugin,
    msg: MsgFunc = zhMsg,
  ) {
    this.homeDir = homeDir
    this.profile = profile
    this.patchFile = patchFile
    this.runner = runner
    this.msg = msg
  }

  async listInstalled(): Promise<PluginInfo[]> {
    return listInstalledPlugins(this.homeDir, this.profile)
  }

  async install(pkg: string, spec?: string, signal?: AbortSignal): Promise<{ needsRestart: boolean }> {
    const profileDir = resolveProfileDir(this.homeDir, this.profile)
    // 非 registry 来源（github:/git+/file: 等）按来源 spec 安装；registry 包按裸包名装
    // npm 最新版（官方机制）。spec 丢失（旧备份）时退化为裸包名 → pnpm fetch-404，
    // 由 installErrorFor 给出可操作诊断。
    const result = await this.runner(profileDir, this.profile, ['add', installSpecFor(pkg, spec)], undefined, signal)
    // 用户「跳过当前插件」：宿主 kill 了子进程 → 清理半装状态（删依赖行 + 删 node_modules/<pkg>，
    // 防止「package.json 声明了依赖但没装全」导致 DSH 启动失败），再以跳过语义抛错。
    if (result.aborted || (signal !== undefined && signal.aborted)) {
      cleanupAbortedInstall(profileDir, pkg)
      throw new ImportUserSkippedError(this.msg)
    }
    if (result.exitCode !== 0 || result.timedOut) throw installErrorFor(pkg, result)
    // 非 bundle 插件：CLI 只维护 bundles，需补 profile patch 激活行才能加载。
    // 补写失败不吞：包已装但未激活，明确报错并允许重试（幂等补行）。
    try {
      await ensureActivationRow(this.patchFile, join(profileDir, 'node_modules', pkg), pkg)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(this.msg('host.activationRowFailed', { pkg, reason }))
    }
    return { needsRestart: true }
  }
}

/** Workspace facade over the real ctx.workspaceRegistry. */
class DshWorkspaceFacade implements WorkspaceFacade {
  private readonly ctx: Context
  private readonly msg: MsgFunc

  constructor(ctx: Context, msg: MsgFunc = zhMsg) {
    this.ctx = ctx
    this.msg = msg
  }

  private registry(): { list(): { id: unknown; path: string; title: string; sessionIds: readonly unknown[]; createdAt: string; updatedAt: string }[]; get(id: unknown): { title: string; setTitle(title: string): Promise<void> } | undefined; create(path: string, title?: string): Promise<unknown>; delete(id: unknown): Promise<boolean> } | undefined {
    return readService(this.ctx, 'workspaceRegistry')
  }

  async listRecords(): Promise<WorkspaceRecord[]> {
    const registry = this.registry()
    if (!registry) return []
    return registry.list().map((w) => ({
      id: String(w.id),
      path: w.path,
      title: w.title,
      sessionIds: [...w.sessionIds].map(String),
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }))
  }

  async writeRecord(record: WorkspaceRecord): Promise<void> {
    const registry = this.registry()
    if (!registry) throw new Error(this.msg('host.workspaceUnavailable'))
    const existing = registry.get(record.id as unknown as WorkspaceId)
    if (existing) {
      // DSH API 没有「整体覆盖」写通道：标题可更新；path/会话由 registry 依真实目录维护
      if (record.title !== undefined && existing.title !== record.title) await existing.setTitle(record.title)
      return
    }
    await registry.create(record.path, record.title)
  }

  async removeRecord(id: string): Promise<void> {
    const registry = this.registry()
    if (!registry) return
    await registry.delete(id as unknown as WorkspaceId)
  }
}

/** Patch-file facade：用户 patch 层（$DSH_HOME/cordis.patch.yml）+ profile patch 层
 * （$DSH_HOME/profiles/<name>/cordis.patch.yml），两者都在 home 根内。
 *
 * 导出仅为让测试能用**真实门面**（而非 mock）钉住层寻址——mock 会让两个层 token 的取值
 * 撞车无处暴露（DshPluginsFacade 同款做法）。 */
export class DshPatchFileFacade implements PatchFileFacade {
  private readonly homeDir: string
  private readonly profile: string
  private readonly msg: MsgFunc

  constructor(homeDir: string, profile: string, msg: MsgFunc = zhMsg) {
    this.homeDir = homeDir
    this.profile = profile
    this.msg = msg
  }

  private patchPath(file: string): string {
    if (file === HOME_PATCH_FILE) return join(this.homeDir, HOME_PATCH_FILE)
    if (file === PROFILE_PATCH_FILE) return join(this.homeDir, 'profiles', this.profile, HOME_PATCH_FILE)
    throw new Error(this.msg('host.patchUnsupported', { user: HOME_PATCH_FILE, profile: PROFILE_PATCH_FILE, file }))
  }

  async readPatchLines(file: string): Promise<{ lineId: string; raw: unknown }[]> {
    const p = this.patchPath(file)
    let text: string
    try {
      text = await fs.readFile(p, 'utf8')
    } catch {
      return []
    }
    let doc: unknown
    try {
      doc = yaml.load(text)
    } catch {
      return []
    }
    if (!Array.isArray(doc)) return []
    const lines: { lineId: string; raw: unknown }[] = []
    for (const item of doc) {
      if (item === null || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      const insert = obj['insert']
      if (Array.isArray(insert)) {
        for (const entry of insert) {
          if (entry === null || typeof entry !== 'object') continue
          const id = (entry as Record<string, unknown>)['id']
          if (typeof id === 'string' && id !== '') lines.push({ lineId: id, raw: entry })
        }
        continue
      }
      const id = obj['id']
      if (typeof id === 'string' && id !== '') lines.push({ lineId: id, raw: obj })
    }
    return lines
  }

  async applyPatchChanges(
    file: string,
    changes: { lineId: string; raw: unknown; action: 'insert' | 'update' | 'remove' }[],
  ): Promise<void> {
    const p = this.patchPath(file)

    // 1. Load the current document into an ordered lineId → raw table.
    const rows = new Map<string, unknown>()
    const order: string[] = []
    let doc: unknown
    try {
      doc = yaml.load(await fs.readFile(p, 'utf8'))
    } catch {
      doc = undefined
    }
    if (Array.isArray(doc)) {
      for (const item of doc) {
        if (item === null || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        const insert = obj['insert']
        if (Array.isArray(insert)) {
          for (const entry of insert) {
            if (entry === null || typeof entry !== 'object') continue
            const id = (entry as Record<string, unknown>)['id']
            if (typeof id === 'string' && id !== '' && !rows.has(id)) {
              rows.set(id, entry)
              order.push(id)
            }
          }
          continue
        }
        const id = obj['id']
        if (typeof id === 'string' && id !== '' && !rows.has(id)) {
          rows.set(id, obj)
          order.push(id)
        }
      }
    }

    // 2. Apply the changes.
    for (const change of changes) {
      if (change.action === 'remove') {
        if (rows.delete(change.lineId)) {
          const at = order.indexOf(change.lineId)
          if (at >= 0) order.splice(at, 1)
        }
      } else if (change.action === 'insert' || change.action === 'update') {
        if (!rows.has(change.lineId)) order.push(change.lineId)
        rows.set(change.lineId, change.raw)
      }
    }

    // 3. Rebuild: every id row is emitted as a top-level row. The loader treats
    //    a top-level { id, name } row exactly like an `- insert:` block member
    //    (dsh-base patch precedent), so the document stays semantically equal.
    const out: unknown[] = []
    for (const id of order) {
      const raw = rows.get(id)
      if (raw !== undefined) out.push(raw)
    }
    const text = '# rewritten by dsh-config-manager import (original comments not preserved)\n'
      + yaml.dump(out)
    await atomicWriteFile(p, text)
  }
}

/** File facade over $DSH_HOME, confined to the home root. */
class DshFileSystemFacade implements FileSystemFacade {
  private readonly homeDir: string
  private readonly msg: MsgFunc

  constructor(homeDir: string, msg: MsgFunc = zhMsg) {
    this.homeDir = homeDir
    this.msg = msg
  }

  private abs(relPath: string): string {
    const target = resolve(isAbsolute(relPath) ? relPath : join(this.homeDir, relPath))
    if (!isSameOrChild(target, this.homeDir)) throw new Error(this.msg('host.fsPathEscape', { path: relPath }))
    return target
  }

  async readFile(relPath: string): Promise<Uint8Array> {
    return fs.readFile(this.abs(relPath))
  }

  async writeFile(relPath: string, data: Uint8Array): Promise<void> {
    // 原子写（Phase 1）：同目录 tmp + fsync + rename，覆盖所有经 HostContext.fs 的配置写
    await atomicWriteFile(this.abs(relPath), data)
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.abs(relPath))
      return true
    } catch {
      return false
    }
  }

  async copy(from: string, to: string): Promise<void> {
    await atomicCopyFile(this.abs(from), this.abs(to))
  }

  async remove(relPath: string): Promise<void> {
    await fs.rm(this.abs(relPath), { recursive: true, force: true })
  }

  /** 仅路径列表（既有契约）：委托 listRecursiveDetailed，丢弃诊断。 */
  async listRecursive(dir: string): Promise<string[]> {
    return (await this.listRecursiveDetailed(dir)).paths
  }

  /**
   * 跟随 junction / 符号链接的遍历 + 被跳过链接清单（issue #37）。
   * 实现下沉到 utils/recursive-walk.ts（可用真实临时目录直接单测）。
   */
  async listRecursiveDetailed(dir: string): Promise<RecursiveListing> {
    return listRecursiveFollowingLinks(this.abs(dir), this.homeDir)
  }

  async mkdir(dir: string): Promise<void> {
    await fs.mkdir(this.abs(dir), { recursive: true })
  }
}

/** The engine's HostContext over real DSH services. */
class ConfigManagerHostContext implements HostContext {
  readonly platform: string = process.platform
  readonly arch: string = process.arch
  readonly homeDir: string
  readonly dshVersion: string
  readonly profile: string
  readonly log: Logger
  readonly msg: MsgFunc
  /** 应用语言（resolveAppLanguage；导出历史报告 locale 用） */
  readonly language: 'zh' | 'en'
  readonly settings: SettingsFacade
  readonly credentials: CredentialsFacade
  readonly plugins: PluginsFacade
  readonly workspace: WorkspaceFacade
  readonly patchFile: PatchFileFacade
  readonly fs: FileSystemFacade
  /** Phase 2 跨进程环境锁端口（宿主注入；测试 mock 不注入 → 无锁环境） */
  mutationLock?: MutationLockPort
  /** Phase 3 SAFE MODE：注入同步谓词（读内存标志，供 withMutationLock isBlocked 用；env-lock 不识 policy） */
  safeModeIsBlocked?: () => boolean
  /** Phase 3 恢复/事务（JournalStore + reconcile + SAFE MODE + runJournaled）。apply() 注入。 */
  phase3Recovery?: import('./core/phase3-host.ts').Phase3Recovery

  constructor(ctx: Context, homeDir: string, profile: string) {
    this.homeDir = homeDir
    this.dshVersion = resolveDshVersion(homeDir)
    this.profile = profile
    this.language = resolveAppLanguage(ctx)
    this.msg = makeMsg(this.language)
    const level = process.env.DSH_CONFIG_MANAGER_LOG_LEVEL
    this.log = createLogger({
      level: level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info',
    })
    this.settings = new DshSettingsFacade(ctx)
    this.credentials = new DshCredentialsFacade(ctx)
    this.patchFile = new DshPatchFileFacade(homeDir, profile, this.msg)
    this.plugins = new DshPluginsFacade(homeDir, profile, this.patchFile, undefined, this.msg)
    this.workspace = new DshWorkspaceFacade(ctx, this.msg)
    this.fs = new DshFileSystemFacade(homeDir, this.msg)
  }
}

/* ---------------------------------------------------------------- routes */

/** Controlled staging roots guard. */
function isControlledPath(target: string, roots: string[]): boolean {
  const t = resolve(target)
  return roots.some((root) => isSameOrChild(t, resolve(root)))
}

function dateStamp(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Minimal real dependency check (MCP §15): `which`/`where` probe. */
async function dependencyAvailable(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    await promisify(execFile)(probe, [command], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** 导出/导入执行超时（ms）。正常导出秒级完成；此上限只兜底「宿主卡死」场景，
 * 让客户端拿到明确错误而不是永远停在进度条。 */
const ROUTE_TIMEOUT_MS = 5 * 60 * 1000

/** WebDAV 单请求超时（ms）：慢速 WebDAV（如坚果云限速）上传大快照/读写索引
 * 需要比 git 通道更宽裕的窗口；错误消息会带上实际 ms，便于用户判断。 */
const WEBDAV_TIMEOUT_MS = 120_000

/** 带超时的 Promise：超时以明确错误拒绝（promise 自身由调用方负责，此处只计时）。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface RoutesDeps {
  host: ConfigManagerHostContext
  adapters: ConfigAdapter[]
  exportsDir: string
  tmpDir: string
  snapshotsDir: string
  /** m1：导出/导入 run 注册表（跨请求共享，/progress 与 /runs 的单一事实源） */
  runs: RunRegistry
  /** m-sync-ui：同步状态/配置目录（$DSH_HOME/dsh-config-manager/sync） */
  syncDir: string
  /** m-market：市场目录（$DSH_HOME/dsh-config-manager/market；其下 config/ 与 cache/） */
  /** 插件数据根目录（$DSH_HOME/dsh-config-manager；F1 vault 镜像目录 = <dataDir>/vault） */
  dataDir: string
  /** F2 强化 Secret 扫描器（含部署者 personalPatterns）；缺省 = 默认扫描器 */
  scanner?: SecretScanner
  /** m-sync-ui：原始 DSH credentials（resolve token / set token / describe 状态） */
  credentials: CredentialProvider
  /** m-github-oauth：GitHub OAuth App 凭据（device flow 必需 client_id；client_secret 可选） */
  githubClientId?: string
  githubClientSecret?: string
  /** Phase 6：迁移历史存储（统一审计史；<dataDir>/migration-history） */
  history: MigrationStore
}

/* -------------------------------------------------- sync 路由（m-sync-ui） */

/** 同步路由可预期的请求级错误（status 缺省 400；引擎/传输失败走 500） */
export class SyncRouteError extends Error {
  readonly status: number

  constructor(message: string, status: number = 400) {
    super(message)
    this.name = 'SyncRouteError'
    this.status = status
  }
}

/** 同步路由错误统一出口：SyncRouteError 用其 status，其余 500（GitTransport 错误消息已脱敏） */
export function writeSyncRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof SyncRouteError) {
    writeJson(res, error.status, { error: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { error: message })
}

/** parseSyncBody 的凭据写入依赖（只用到 set；测试可注入内存 mock）。 */
export interface ParseSyncBodyDeps {
  credentials: Pick<CredentialProvider, 'set'>
}

/**
 * 解析同步请求体，按 transport 分支返回归一化的 SyncConfig（可辨识联合，schemaVersion=2）。
 * 请求体形状（flat，M4 契约）：
 * - git:    { transport:'git', repoUrl, token? } —— token 非空写 SYNC_CREDENTIAL_REF；
 *   git 可执行文件固定使用系统 PATH 中的 git（不再接受自定义 gitBin）。
 * - webdav: { transport:'webdav', url, username?, password? } —— password 非空写 SYNC_WEBDAV_CREDENTIAL_REF。
 * 返回值不含任何 secret（password/token 只进 credentials，永不回传/落同步文件）。
 */
export async function parseSyncBody(
  body: Record<string, unknown>,
  deps: ParseSyncBodyDeps,
): Promise<SyncConfig> {
  const transport = body['transport'] === 'webdav' ? 'webdav' : 'git'
  if (transport === 'webdav') {
    const url = typeof body['url'] === 'string' ? body['url'].trim() : ''
    if (url === '') throw new SyncRouteError('url is required for webdav')
    const urlError = validateWebDavUrl(url)
    if (urlError !== null) throw new SyncRouteError(urlError)
    const username = typeof body['username'] === 'string' && body['username'] !== '' ? body['username'] : undefined
    const password = typeof body['password'] === 'string' && body['password'] !== '' ? body['password'] : undefined
    if (password !== undefined) {
      try {
        await deps.credentials.set(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF), password)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new SyncRouteError(
          `WebDAV 口令写入 DSH credentials 失败：${reason}（请在 DSH 凭据管理里配置 ${SYNC_WEBDAV_CREDENTIAL_REF} 后重试）`,
        )
      }
    }
    return {
      schemaVersion: 2,
      transport: 'webdav',
      webdav: { url, ...(username !== undefined ? { username } : {}) },
    }
  }
  // git 通道（沿用现有逻辑）
  const repoUrl = typeof body['repoUrl'] === 'string' ? body['repoUrl'].trim() : ''
  if (repoUrl === '') throw new SyncRouteError('repoUrl is required')
  const urlError = validateRepoUrl(repoUrl)
  if (urlError !== null) throw new SyncRouteError(urlError)
  const token = typeof body['token'] === 'string' && body['token'] !== '' ? body['token'] : undefined
  if (token !== undefined) {
    try {
      await deps.credentials.set(credentialRef(SYNC_CREDENTIAL_REF), token)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new SyncRouteError(
        `token 写入 DSH credentials 失败：${reason}（请在 DSH 凭据管理里配置 ${SYNC_CREDENTIAL_REF} 后重试）`,
      )
    }
  }
  return {
    schemaVersion: 2,
    transport: 'git',
    git: { repoUrl },
  }
}

/** 由 SyncConfig 合成 WebDAV 通道 baseUrl（webdav.url，尾部规范化带 '/'；git 通道返回 ''）。 */
export function webdavBaseUrl(cfg: SyncConfig): string {
  if (!isWebDavConfig(cfg)) return ''
  return cfg.webdav.url.replace(/\/+$/, '') + '/'
}

/**
 * 补全 webdav 配置缺失的 username（从持久化配置回填；纯函数，不修改入参）。
 * 语义与 password 一致：请求未带 username（表单留空/挂载自动加载）→ 沿用已保存的值；
 * 请求显式带 username → 原样保留（用户新输入优先）。非 webdav / 无持久化 → 原样返回。
 */
export function mergePersistedWebDavUsername(cfg: SyncConfig, persisted: SyncConfig | null): SyncConfig {
  if (!isWebDavConfig(cfg) || (cfg.webdav.username !== undefined && cfg.webdav.username !== '')) return cfg
  if (persisted !== null && isWebDavConfig(persisted)
    && typeof persisted.webdav.username === 'string' && persisted.webdav.username !== '') {
    return { ...cfg, webdav: { ...cfg.webdav, username: persisted.webdav.username } }
  }
  return cfg
}

/**
 * 解析 push 请求体的分区选择（sections）——「高级/自定义导出」模式负载。
 * - 缺省 / 非数组 / 空数组 → undefined（= 全部 portable 推荐分区，即「默认/快速导出」模式）；
 * - 元素必须是 knownIds（已知 adapter id）中的非空字符串，非法 → SyncRouteError（不静默吞错）；
 * - 返回去重后的数组（保持原顺序；重复分区不做重复导出）。
 */
export function extractSyncSections(
  body: Record<string, unknown>,
  knownIds: ReadonlySet<string>,
): SectionId[] | undefined {
  const raw = body['sections']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: SectionId[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') {
      throw new SyncRouteError('sections must be an array of non-empty strings')
    }
    if (!knownIds.has(item)) {
      throw new SyncRouteError(`unknown sync section: ${item}`)
    }
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item as SectionId)
    }
  }
  return out
}

/** 需要人工决策的 PlanItemKind（一键同步 needsReview 判定 + 逐项确认标记）。
 * 注意：'Install'（安装插件）不在此列 —— 同步拉取差异时插件按「自动安装」处理：
 * 默认采纳、不逐项展示、无需手动选择（product requirement）。
 * issue #35：'Warning' 必须**可见**——它承载「本次同步会剔除哪些无法满足的声明」这类
 * 改变配置语义的信息；此前非决策项默认自动采用且不展示，用户只看到「同步成功」。 */
const REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Error', 'PathMapping', 'Warning',
])

/**
 * issue #35：会**改变工具链行为**的项 —— 只有 pnpm-workspace.yaml 在本次同步中
 * 移除了无法满足的 patchedDependencies 声明时，才带 detail。
 * 这类项此前属「非冲突项 → 自动采用且不展示」，用户即使已知风险也无法否决
 * （issue #35 正是这条自动采用把目标机 pnpm 弄坏的）。
 * 现在：进确认列表、可见、可取消；但**默认仍采用**（我们的 sanitize 结果严格更安全，
 * 默认不采用反而会静默丢掉 allowBuilds / 冷静期配置）。
 * 注意：与客户端 sync-view.ts 的同名判定必须保持一致（两侧刻意重复，避免跨端 import）。
 */
function isToolchainChangeItem(item: { itemId: string; detail?: string | undefined }): boolean {
  return item.itemId === 'plugins:pnpm-workspace' && item.detail !== undefined && item.detail !== ''
}

/** 一键同步差异项（client 逐项确认的最小契约；与 sync-api.ts SyncConfirmItem 对齐） */
interface SyncConfirmItem {
  itemId: string
  adapter: SectionId
  kind: PlanItemKind
  description: string
  /** 变更详情（如插件「当前 1.1 vs 导入 1.6」），与导入恢复向导展示一致 */
  detail?: string
  severity: 'info' | 'warning' | 'error'
  defaultAdopt: boolean
  adopt: boolean
  conflict?: { path: string; kind: 'key' | 'file' | 'section'; local?: unknown; remote?: unknown; ancestor?: unknown; diff?: string }
  target?: { adapter: SectionId; ref: string }
}

/** 把 ImportPlan 投影为逐项可确认的差异项（默认采用 Create/Update/Install；人工项默认不采用）。 */
function planToConfirmItems(plan: ImportPlan): SyncConfirmItem[] {
  return plan.items.map((item) => {
    const manual = REVIEW_KINDS.has(item.kind)
    let conflict: SyncConfirmItem['conflict']
    if (item.kind === 'Conflict') {
      const c = (item as { conflict?: { path?: string; kind?: string; local?: unknown; remote?: unknown; ancestor?: unknown } }).conflict
      conflict = {
        path: c?.path ?? '$',
        kind: c?.kind === 'file' ? 'file' : c?.kind === 'section' ? 'section' : 'key',
        ...(c?.local !== undefined ? { local: c.local } : {}),
        ...(c?.remote !== undefined ? { remote: c.remote } : {}),
        ...(c?.ancestor !== undefined ? { ancestor: c.ancestor } : {}),
      }
    }
    return {
      itemId: item.id,
      adapter: item.adapter,
      kind: item.kind,
      description: item.description,
      detail: item.detail,
      severity: item.severity,
      defaultAdopt: !manual,
      adopt: !manual,
      ...(conflict !== undefined ? { conflict } : {}),
      ...(item.target !== undefined ? { target: item.target } : {}),
    }
  })
}

/** autosync interval 类型守卫 */
function isAutosyncInterval(v: unknown): v is AutosyncInterval {
  return v === '5m' || v === '15m' || v === '30m' || v === '60m' || v === '6h' || v === '12h' || v === '24h'
}

/** 自动同步状态响应（GET /sync/autosync 与 POST 回填；读盘计算 elapsedMs）。 */
async function buildAutosyncStatus(dir: string, channel: SyncTransportType): Promise<AutosyncStatusResponse> {
  const cfg = await readAutosyncConfig(dir, channel)
  const elapsedMs = cfg.lastRunAt === undefined || cfg.lastRunAt === ''
    ? -1
    : Math.max(0, Date.now() - Date.parse(cfg.lastRunAt))
  return {
    enabled: cfg.enabled,
    interval: cfg.interval,
    ...(cfg.lastRunAt !== undefined ? { lastRunAt: cfg.lastRunAt } : {}),
    ...(cfg.lastRunStatus !== undefined ? { lastRunStatus: cfg.lastRunStatus } : {}),
    ...(cfg.lastRunMessage !== undefined ? { lastRunMessage: cfg.lastRunMessage } : {}),
    consecutiveFailures: cfg.consecutiveFailures,
    elapsedMs,
    ...(cfg.lastRunHistoryId !== undefined ? { lastRunHistoryId: cfg.lastRunHistoryId } : {}),
  }
}

/** 全部通道的自动同步状态（status 路由一次返回；UI 按当前 tab 取对应通道）。 */
async function buildAutosyncStatusByChannel(dir: string): Promise<Record<SyncTransportType, AutosyncStatusResponse>> {
  const all = await readAllAutosyncConfigs(dir)
  const build = async (channel: SyncTransportType): Promise<AutosyncStatusResponse> => {
    const cfg = all[channel]
    const elapsedMs = cfg.lastRunAt === undefined || cfg.lastRunAt === ''
      ? -1
      : Math.max(0, Date.now() - Date.parse(cfg.lastRunAt))
    return {
      enabled: cfg.enabled,
      interval: cfg.interval,
      ...(cfg.lastRunAt !== undefined ? { lastRunAt: cfg.lastRunAt } : {}),
      ...(cfg.lastRunStatus !== undefined ? { lastRunStatus: cfg.lastRunStatus } : {}),
      ...(cfg.lastRunMessage !== undefined ? { lastRunMessage: cfg.lastRunMessage } : {}),
      consecutiveFailures: cfg.consecutiveFailures,
      elapsedMs,
      ...(cfg.lastRunHistoryId !== undefined ? { lastRunHistoryId: cfg.lastRunHistoryId } : {}),
    }
  }
  return { git: await build('git'), webdav: await build('webdav') }
}

/** GET /sync/autosync 响应类型（与 sync-api.ts AutosyncStatusResponse 对齐） */
interface AutosyncStatusResponse {
  enabled: boolean
  interval: AutosyncInterval
  lastRunAt?: string
  lastRunStatus?: AutosyncRunStatus
  lastRunMessage?: string
  consecutiveFailures: number
  elapsedMs: number
  lastRunHistoryId?: string
}

/* -------------------------------------------------- restore 路由（M4） */

/** POST /restore 请求体校验（纯函数；snapshotId 拒绝路径分隔符防 join 越界）。 */
export type BuildRestoreBodyResult =
  | { ok: true; value: { snapshotId: string; dryRun: boolean } }
  | { ok: false; error: string }

export function buildRestoreBody(body: unknown): BuildRestoreBodyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid JSON body' }
  }
  const record = body as Record<string, unknown>
  const snapshotId = record['snapshotId']
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    return { ok: false, error: 'snapshotId is required' }
  }
  if (snapshotId === '.' || snapshotId === '..' || snapshotId.includes('/') || snapshotId.includes('\\')) {
    return { ok: false, error: zhMsg('restore.invalidSnapshotId') }
  }
  return { ok: true, value: { snapshotId, dryRun: record['dryRun'] === true } }
}

/**
 * 宿主侧恢复动作执行器（真实执行 restore 计划）：
 * 整文件/文件还原与删除走 ctx.fs（home-relative facade，越界由 facade 再拦一道），
 * blob 读取与 pre-restore 副本走快照目录（node fs），插件卸载走官方 dsh plugin CLI。
 */
export interface RestoreExecutor {
  /** 读快照目录内 blob（相对 snapshotDir） */
  readBlob(blobPath: string): Promise<Uint8Array>
  /** 把当前 home 文件内容复制到 <snapshotDir>/pre-restore/（覆盖/删除前的双保险） */
  savePreRestore(relPath: string): Promise<void>
  existsHome(relPath: string): Promise<boolean>
  writeHome(relPath: string, data: Uint8Array): Promise<void>
  removeHome(relPath: string): Promise<void>
  /** 卸载插件（官方通道）；失败返回 { ok:false, message } */
  uninstallPlugin(name: string): Promise<{ ok: boolean; message?: string }>
}

/**
 * 按计划执行恢复动作（纯执行器；逐项 try/catch 不拖垮其余），
 * 返回与 CLI 一致的诚实报告。顺序 = 计划顺序（整文件 → 插件 → file 补偿）。
 * @param onAction - 每项动作执行回调（宿主路由埋点：更新 RunRegistry 进度；
 *   index/1-based、total=计划动作数、detail=动作描述）
 */
export async function executeRestorePlan(
  plan: RestorePlan,
  exec: RestoreExecutor,
  onAction?: (info: { index: number; total: number; detail: string }) => void,
): Promise<RestoreReport> {
  const report: RestoreReport = {
    snapshotId: plan.snapshotId,
    restored: [],
    removedPlugins: [],
    manualHints: [],
    failed: [],
    skipped: [],
  }
  const total = plan.actions.length
  let index = 0
  for (const action of plan.actions) {
    index += 1
    onAction?.({ index, total, detail: action.description })
    try {
      switch (action.kind) {
        case 'hostFileRestore':
        case 'fileRestore': {
          if (action.target === undefined || action.blobPath === undefined) {
            throw new Error('恢复动作缺少 target/blobPath')
          }
          if (await exec.existsHome(action.target)) await exec.savePreRestore(action.target)
          await exec.writeHome(action.target, await exec.readBlob(action.blobPath))
          report.restored.push(action.target)
          break
        }
        case 'hostFileRemove':
        case 'fileRemove': {
          if (action.target === undefined) throw new Error('恢复动作缺少 target')
          if (await exec.existsHome(action.target)) {
            await exec.savePreRestore(action.target)
            await exec.removeHome(action.target)
          }
          report.restored.push(action.target)
          break
        }
        case 'pluginRemove': {
          if (action.pluginName === undefined) throw new Error('恢复动作缺少插件名')
          const result = await exec.uninstallPlugin(action.pluginName)
          if (result.ok) {
            report.removedPlugins.push(action.pluginName)
          } else {
            report.failed.push({ item: `plugin:${action.pluginName}`, reason: result.message ?? '卸载失败' })
          }
          break
        }
        case 'credentialHint':
          report.manualHints.push(action.manualHint ?? action.description)
          break
        case 'skip':
          report.skipped.push(action.description)
          break
        default:
          report.skipped.push(`未知动作 ${String(action.kind)}: ${action.description}`)
      }
    } catch (err) {
      report.failed.push({
        item: action.target ?? action.pluginName ?? action.description,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return report
}

/** 宿主 restore 执行器装配：ctx.fs（home-relative）+ 快照目录（node fs）+ runDshPlugin。 */
function makeRestoreExecutor(snapshotDir: string, host: HostContext, profile: string): RestoreExecutor {
  const profileDir = resolveProfileDir(host.homeDir, profile)
  let seq = 0
  return {
    readBlob: async (blobPath) => {
      const target = resolve(snapshotDir, blobPath)
      if (!isSameOrChild(target, snapshotDir)) throw new Error(msgOf(host)('host.restoreBlobEscape', { blob: blobPath }))
      return fs.readFile(target)
    },
    savePreRestore: async (relPath) => {
      const data = await host.fs.readFile(relPath)
      seq += 1
      const safe = relPath.replace(/[\\/:*?"<>|]/g, '_')
      await fs.mkdir(join(snapshotDir, 'pre-restore'), { recursive: true })
      await fs.writeFile(join(snapshotDir, 'pre-restore', `${String(seq).padStart(4, '0')}-${safe}`), data)
    },
    existsHome: (relPath) => host.fs.exists(relPath),
    writeHome: (relPath, data) => host.fs.writeFile(relPath, data),
    removeHome: (relPath) => host.fs.remove(relPath),
    uninstallPlugin: async (name) => {
      const result = await runDshPlugin(profileDir, profile, ['remove', name])
      if (result.exitCode === 0) return { ok: true }
      const output = `${result.stderr}\n${result.stdout}`.trim()
      const tail = output.split('\n').slice(-8).join('\n') || msgOf(host)('host.restoreNoOutput')
      return { ok: false, message: msgOf(host)('host.restoreUninstallFailed', { name, code: String(result.exitCode), tail }) }
    },
  }
}

/**
 * 解析「一键上传/我的配置」请求体的 form 字段：仅 { name, description?, categories?, mode? }。
 * name 必填（非空字符串，trim 后取）；description 可选字符串；categories 可选字符串数组；
 * mode 可选 'migrate' | 'share'（F6 分享模式，非法值忽略→缺省 migrate）。非法 → null（调用方返回 400）。
 */
function parseMeForm(raw: unknown): { name: string; id?: string; description?: string; categories?: string[]; mode?: 'migrate' | 'share' } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
  if (name === '') return null
  const form: { name: string; id?: string; description?: string; categories?: string[]; mode?: 'migrate' | 'share' } = { name }
  // update 模式的可选显式 id（「更新」按钮预填；upload 时省略）
  const idRaw = obj['id']
  if (typeof idRaw === 'string' && idRaw.trim() !== '') form.id = idRaw.trim()
  const description = obj['description']
  if (typeof description === 'string' && description.trim() !== '') form.description = description.trim()
  const categoriesRaw = obj['categories']
  if (Array.isArray(categoriesRaw)) {
    const categories = categoriesRaw.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    if (categories.length > 0) form.categories = categories
  }
  // F6 分享模式：仅接受字面量 'share' / 'migrate'（其余忽略 → 缺省 migrate），随 form 透传 MyRepoService
  if (obj['mode'] === 'share' || obj['mode'] === 'migrate') form.mode = obj['mode']
  return form
}

/**
 * GitHub 凭据「缺失或失效」判定（issue #29）：`no_token`（credentials 里从未配置 token）与
 * `unauthorized`（401，token 过期/被撤销）对用户都是同一个「未登录」，必须走同一分支——
 * 否则 `no_token` 会落到 500，UI 把「未登录」渲染成「登录状态读取失败」的误导性横幅。
 * 其余分类（network_error / rate_limited / server_error / validation_failed / fork_timeout…）
 * 是真实故障，仍按 500 暴露，绝不伪装成「未登录」。
 */
export function isGitHubAuthMissing(error: unknown): boolean {
  return error instanceof GitHubAuthError && (error.code === 'unauthorized' || error.code === 'no_token')
}

/** Build the /api/dsh-config-manager route family. */
function makeRoutes(deps: RoutesDeps): { routes: WebRoute[]; scheduler: AutoSyncScheduler; makeSyncEngine: (cfg: SyncConfig) => SyncEngine; lifecycle: ConfigLifecycle } {
  const { host, adapters, exportsDir, tmpDir, snapshotsDir, runs, syncDir, dataDir, credentials, githubClientId, githubClientSecret, history } = deps
  /**
   * Phase 1 P0-1/P0-2：配置生命周期服务（自动快照 / 撤销 / 重做）。
   *
   * 与既有 `snapshotsDir`（导入前快照，plan 驱动）**分目录**：那里的快照只登记
   * 「本次导入将写入的目标」，无法回答「配置整体变没变」；本服务的快照是状态驱动，
   * 供撤销/重做与自动快照使用。两者保留策略与回放方式都不同，混用会产生错误语义。
   *
   * watchFactory 用真 fs.watch 注入（core 侧只依赖抽象 → 测试可完全驱动时序）。
   * 监听不在此处启动：由 apply() 在「启动 recovery 分类完成且 NORMAL」后启动，
   * 避免恢复进行中就开拍。
   */
  const lifecycle = new ConfigLifecycle({
    dir: join(dataDir, 'config-snapshots'),
    adapters,
    ctx: host,
    profile: host.profile ?? 'web',
    applyOrder: APPLY_ORDER,
    onWarn: (message, detail) => {
      host.log.warn(`[lifecycle] ${message}${detail !== undefined ? `: ${detail instanceof Error ? detail.message : String(detail)}` : ''}`)
    },
    watchFactory: (dir, onEvent) => fsWatch(dir, (eventType, filename) => onEvent(eventType, filename)),
  })

  const roots = [exportsDir, tmpDir]

  /**
   * Phase 6：迁移历史 best-effort 追加（写失败不阻断操作，但记录/降级，不静默丢）。
   * 所有 destructive/migration 结果确定后调用。历史写盘 ms 级，失败仅日志 + 可选告警字段。
   */
  const tryAppendHistory = async (
    raw: { kind: MigrationKind; result: MigrationResult; sections: string[]; operationId?: string; snapshotId?: string; runId?: string; source: 'api' | 'autosync' | 'backup-scheduler' | 'recovery' | 'cli' | 'internal'; summary: string; error?: string },
  ): Promise<string | undefined> => {
    try {
      const res = await history.append(raw)
      if (!res.ok) {
        host.log.warn('迁移历史写入失败', { kind: raw.kind, error: res.error })
        return res.error
      }
      return undefined
    } catch (error) {
      host.log.warn('迁移历史写入异常', { kind: raw.kind, error: error instanceof Error ? error.message : String(error) })
      return error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 从快照目录读取 entries 的 adapter id 集（用于 restore / snapshot-prune 历史 sections）。
   * 读取失败 → 空数组（best-effort；sections 仅用于审计摘要，不影响功能）。
   */
  const snapshotEntrySections = async (snapshotDir: string): Promise<string[]> => {
    try {
      const raw = await fs.readFile(join(snapshotDir, 'snapshot.json'), 'utf8')
      const parsed = JSON.parse(raw) as { entries?: Array<{ adapter?: string }> } | null
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return []
      return Array.from(new Set(parsed.entries.map((e) => e.adapter).filter((s): s is string => typeof s === 'string' && s !== '')))
    } catch {
      return []
    }
  }

  /**
   * Phase 6：自动快照保留清理（snapshot-prune）迁移历史（best-effort）。
   * 由 FileSnapshotStore.prune 经 onPrune 回调触发；fire-and-forget 不阻塞保存。
   */
  const tryAppendSnapshotPrune = async (removedIds: string[]): Promise<void> => {
    if (removedIds.length === 0) return
    try {
      await history.append({
        kind: 'snapshot-prune',
        result: 'success',
        sections: [],
        source: 'api',
        summary: `自动保留清理删除 ${removedIds.length} 个旧快照`,
      })
    } catch (error) {
      host.log.warn('快照保留清理历史写入失败（best-effort）', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** m-github-oauth：宿主侧设备码登记表 + auth 客户端（进程生命周期；device_code 只存内存） */
  const githubFlows = new DeviceFlowStore()
  const githubAuth = new GitHubAuthClient()
  const msg = host.msg

  /** 导入 run 的「当前计划项」中止控制器（/execute 登记，/execute/skip 定位 abort）。
   * 进程生命周期内存登记；同 kind 并发被 RunRegistry 拒绝，单 run 恒只有一个当前项。 */
  const runAbortControllers = new Map<string, AbortController>()

  /** 已知 adapter id 集合（push 请求体 sections 校验用）。 */
  const knownSyncSectionIds = new Set(adapters.map((a) => a.id))
  /** 可同步分区目录（status 回填 UI「高级/自定义导出」勾选列表）。
   *
   *  含**全部已挂载分区**（不再按 portability 过滤）：改造一取消了 portability 对同步范围的
   *  限制，所有分区都可勾选；这里若仍只列 portable，mcp/workspaces/credentialsStatus/
   *  pluginFiles/sessions 就永远无法被勾选，用户既看不到也同步不了。
   *  列表顺序即 adapters 顺序；defaultIncluded 由 UI 用于「推荐分区」默认勾选与计数。 */
  const syncSectionCatalog = adapters
    .map((a) => ({ id: a.id, displayName: a.displayName, portability: a.portability, defaultIncluded: a.defaultIncluded }))

  const makeImporter = (): Importer => new Importer({
    ctx: host,
    adapters,
    snapshotStore: new FileSnapshotStore({
      dir: snapshotsDir,
      // Phase 4 F3：active/quarantine 未收敛 journal 引用的 snapshot 绝不自动 prune
      referencedSnapshotIds: () => host.phase3Recovery?.store.listReferencedSnapshotIds() ?? Promise.resolve(new Set<string>()),
      // Phase 6：自动保留清理 → snapshot-prune 迁移历史（best-effort）
      onPrune: (removedIds) => { void tryAppendSnapshotPrune(removedIds) },
    }),
    parseZipOverride: createHardenedZipParser(),
    dependencyChecker: dependencyAvailable,
    msg,
  })

  /** m-profiles：配置档案管理器（<dataDir>/profiles/<name>/profile.json；切换复用同一快照/回滚管道） */
  const profiles = new ProfileManager({
    dataDir,
    ctx: host,
    adapters,
    snapshotStore: new FileSnapshotStore({
      dir: snapshotsDir,
      // Phase 4 F3：recovery 引用保护
      referencedSnapshotIds: () => host.phase3Recovery?.store.listReferencedSnapshotIds() ?? Promise.resolve(new Set<string>()),
      // Phase 6：自动保留清理 → snapshot-prune 迁移历史（best-effort）
      onPrune: (removedIds) => { void tryAppendSnapshotPrune(removedIds) },
    }),
  })

  /** Fence + method guard (mirrors dsh-ssh). */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /**
   * Phase 2 跨进程锁路由门（destructive 公共入口）。
   * 包裹一个 mutation handler：进入前 acquire GLOBAL 环境锁（无 lock 配置 → 直接放行），
   * 被另一进程/操作持有（含同进程另一操作）→ 409/423 拒绝；执行后 finally 释放。
   * 嵌套调用（rollback / applyItems 内部 executeImportPlan）在外层已持锁区域内运行，绝不 reacquire。
   * Phase 3 SAFE MODE：isBlocked 注入谓词（host.safeModeIsBlocked）被挡 → 423（不执行 destructive）。
   */
  const withMutationGate = (
    op: string,
    handler: (req: IncomingMessage, res: ServerResponse, lockCtx?: MutationLockContext, journalCtx?: JournalRunContext) => Promise<void>,
    opts?: { journaled?: boolean; deferredSnapshot?: boolean },
  ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    return async (req, res) => {
      try {
        await runWithMutationLock(host.mutationLock, { op, isBlocked: () => host.safeModeIsBlocked?.() ?? false }, async (lockCtx) => {
          // Step 3 P0-A：所有被 gate 覆盖的 destructive 路由在已持锁下创建 durable journal
          // （runJournaled 不 double-acquire、不 release；锁由本 gate 的 finally 释放）。
          if (host.phase3Recovery !== undefined && (opts?.journaled ?? true) && lockCtx !== null) {
            await host.phase3Recovery.runJournaled({
              operationType: op,
              lockCtx,
              // Phase 4：生产 snapshot 接线。deferredSnapshot = plan 在 handler 内解析后，
              // 引擎创建 op-bound snapshot 并 bindSnapshot + markApplying（首个 destructive side effect 前）。
              deferredSnapshot: opts?.deferredSnapshot ?? false,
              fn: async (journalCtx) => { await handler(req, res, lockCtx, journalCtx) },
            })
          } else {
            await handler(req, res, lockCtx ?? undefined, undefined)
          }
        })
      } catch (error) {
        if (error instanceof EnvironmentLockUnavailableError) {
          // 内部诊断（op/reason）进日志；用户只看到友好文案（error.message 恒为中文友好版，
          // 不暴露环境锁/op/路径等技术细节）。
          host.log.warn(`mutation lock blocked: op=${error.op} reason=${error.reason}${error.detail !== undefined ? ` detail=${error.detail}` : ''}`)
          writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
          return
        }
        // 非 423：若已由 runJournaled 置 SAFE MODE/失败，保持既有错误语义（400/500）
        if (error instanceof TransactionRecoveryRequiredError) {
          writeJson(res, 423, { error: error.message, code: 'transaction-recovery-required' })
          return
        }
        throw error
      }
    }
  }

  // ------------------------------------------------- sync 路由装配（m-sync-ui）
  // 请求级装配：每次 push/pull 从请求体取 repoUrl，token 非空先写入 DSH
  // credentials（只存值不落盘同步文件/日志），git 网络操作时经 resolve 现取 ——
  // 与 GitTransport「token 只从注入 provider 读取」的安全契约完全对齐。

  /**
   * 解析同步请求体并补全缺失字段（委托给导出的 parseSyncBody，便于单测）。
   * username 回退：webdav 请求体未带 username（如挂载时 snapshotsList 自动加载、
   * 表单留空后直接同步）时，从持久化 sync-config 回填已保存的 username——
   * 否则 WebDavTransport 构造会因空 username 抛错，导致「保存过配置仍无法列出快照」。
   * 语义与 password 一致：留空 = 沿用已保存凭据。
   */
  const prepareSync = async (body: Record<string, unknown>): Promise<SyncConfig> => {
    const cfg = await parseSyncBody(body, { credentials })
    if (isWebDavConfig(cfg) && (cfg.webdav.username === undefined || cfg.webdav.username === '')) {
      try {
        const persisted = await readSyncConfig(syncDir)
        return mergePersistedWebDavUsername(cfg, persisted)
      } catch {
        return cfg // 读失败保持原值（空 username 由 WebDavTransport 构造校验兜底报错）
      }
    }
    return cfg
  }

  /** 同步分区选择缓存（按通道；sync-selection.json；makeSyncEngine 同步读取用，保存路由更新）。
   *  缺失通道 = 尚未加载（启动竞态窗口）；读取/使用处兜底 defaultSyncSelection。 */
  const selectionCache: Partial<Record<SyncTransportType, SyncSelection>> = {}
  void readAllSyncSelections(syncDir).then((all) => {
    selectionCache.git = all.git
    selectionCache.webdav = all.webdav
  }).catch(() => { /* 读失败保持缺省 */ })

  /** 确保指定通道缓存已加载（status/save 路由调用；启动竞态兜底）。 */
  const ensureSelectionLoaded = async (channel: SyncTransportType): Promise<SyncSelection> => {
    const cached = selectionCache[channel]
    if (cached !== undefined) return cached
    try {
      const sel = await readSyncSelection(syncDir, channel)
      selectionCache[channel] = sel
      return sel
    } catch {
      const fallback = defaultSyncSelection()
      selectionCache[channel] = fallback
      return fallback
    }
  }

  /** 指定通道的分区选择视图（{ mode, sections }，无 schemaVersion）。 */
  const selectionView = async (channel: SyncTransportType): Promise<{ mode: SyncSelectionMode; sections: SectionId[] }> => {
    const sel = await ensureSelectionLoaded(channel)
    return { mode: sel.mode, sections: sel.sections }
  }

  /** 全部通道的分区选择视图（status 路由一次返回；UI 按当前 tab 取对应通道）。 */
  const selectionViewByChannel = async (): Promise<Record<SyncTransportType, { mode: SyncSelectionMode; sections: SectionId[] }>> => {
    const all = await readAllSyncSelections(syncDir)
    selectionCache.git = all.git
    selectionCache.webdav = all.webdav
    const view = (sel: SyncSelection): { mode: SyncSelectionMode; sections: SectionId[] } =>
      ({ mode: sel.mode, sections: sel.sections })
    return { git: view(all.git), webdav: view(all.webdav) }
  }

  /** 构造 SyncEngine：按 transport 分支构造对应传输（git → GitTransport；webdav → WebDavTransport）。
   *  同步范围（sections）来自持久化分区选择：advanced 模式 → 只处理勾选分区，
   *  自动同步（merge/apply/push 全链路）与手动 push 共用此配置。 */
  const makeSyncEngine = (cfg: SyncConfig): SyncEngine => {
    let transport: SyncTransport
    if (isWebDavConfig(cfg)) {
      transport = new WebDavTransport({
        baseUrl: webdavBaseUrl(cfg),
        username: cfg.webdav.username ?? '',
        credentials: {
          getPassword: async () => {
            const resolved = await credentials.resolve(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF))
            return resolved?.value ?? ''
          },
        },
        // 显式传超时：不依赖默认值，慢速 WebDAV 上传大快照有足够窗口
        timeoutMs: WEBDAV_TIMEOUT_MS,
        msg,
      })
    } else {
      transport = new GitTransport({
        repoUrl: cfg.git.repoUrl,
        workDir: join(syncDir, 'work'),
        credentials: {
          getToken: async () => {
            const resolved = await credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))
            return resolved?.value ?? ''
          },
        },
        msg,
      })
    }
    const channel: SyncTransportType = isWebDavConfig(cfg) ? 'webdav' : 'git'
    const sections = effectiveSections(selectionCache[channel] ?? defaultSyncSelection())
    return new SyncEngine({
      ctx: host,
      transport,
      stateDir: syncDir,
      adapters,
      importer: makeImporter(),
      localSnapshotsDir: join(syncDir, 'snapshots'),
      zipDir: tmpDir,
      msg,
      ...(sections === undefined ? {} : { sections }),
    })
  }

  /** 一键同步差异确认会话存储（进程内存；/sync/sync 预览 → /sync/apply-items 逐项执行解耦） */
  const syncSessions = new SyncSessionStore()

  /** 自动同步后台调度器（宿主进程生命周期，不依赖浏览器） */
  const scheduler = new AutoSyncScheduler({
    syncDir,
    host,
    makeSyncEngine,
    msg,
    runs,
    mutationLock: host.mutationLock,
    isBlocked: () => host.safeModeIsBlocked?.() ?? false,
    phase3Recovery: host.phase3Recovery,
    // Phase 6：autosync 既写 sync-history.json（既有语义），也写统一迁移历史（COMPLETE 不变量）。
    appendHistoryFn: async (entry) => {
      await appendAutosyncEntry(syncDir, entry).catch(() => undefined)
      await history.append({
        kind: 'autosync',
        result: entry.status === 'success' ? 'success' : entry.status === 'skipped' ? 'skipped' : 'failed',
        sections: entry.appliedSections ?? [],
        source: 'autosync',
        summary: `自动同步 ${entry.direction}${entry.transport !== undefined ? `（${entry.transport}）` : ''}`,
        error: entry.status === 'failed' ? (entry.error ?? entry.skipReason) : undefined,
      }).catch(() => undefined)
    },
  })
  // P1-B：调度器不再在 makeRoutes 内同步 start —— 由 apply() 在「启动 recovery 分类完成后、仅 NORMAL」时启动。

  // ============================================================ Phase 5 recovery orchestration
  // Recovery 路由**禁用 withMutationGate**（避免 double-journal：recovery 复用被恢复 operation 的
  // 现有 journal，不新建）。mutation 路由只经 withMutationLock（Phase 2 GLOBAL 锁）+ loopback fence，
  // **不传 isBlocked**（recovery 是解决 SAFE MODE 的机制，若被 SAFE MODE 阻断会死锁）。
  // 只读路由（status/preview）不持锁。权威 snapshotId 只来自 j.snapshotId（不接受请求体覆盖）。
  // 编排逻辑在 src/core/recovery-orchestrator.ts（可测纯编排层）。
  const recoveryOrchestrator = createRecoveryOrchestrator({
    store: host.phase3Recovery?.store ?? new JournalStore({ transactionsDir: join(dataDir, 'transactions') }),
    runs,
    snapshotsDir,
    host,
    msg,
    snapshotExists: async (snapshotId, binding) => {
      if (host.phase3Recovery === undefined) return false
      return host.phase3Recovery.recoveryHooks.snapshotExists(snapshotId, binding)
    },
    // 动态 getter：环境指纹在 fire-and-forget 启动分类块（initFingerprint）完成后才就绪，
    // 创建期捕获会拿到 'unknown' 初值 → 后续 recovery API 误判 WRONG_ENVIRONMENT。
    // 改动态读取保证 API 调用时取到真实指纹（recovery-orchestrator 已改为 getter 语义）。
    getEnvironmentFingerprint: () => host.phase3Recovery?.recoveryEnvFingerprint ?? 'unknown',
    // 清除 SAFE MODE：同时重置内存标志（isBlocked 读它）与 durable 标记。
    // 仅当 recovery 成功且无其他未解决 incident 时由编排器调用（§5.3 / §10.2）。
    clearSafeMode: async () => {
      if (host.phase3Recovery !== undefined) await host.phase3Recovery.clearSafeMode()
    },
    // issue #31：环境锁只读探测 + 显式回收，供「事故恢复」面板显示/处理**残留锁**。
    // 残留锁不是 journal（journalId 恒 null、transactions/active 为空），旧面板因此恒空。
    inspectLockState: async () => {
      const port = host.mutationLock as EnvironmentLockManager | undefined
      if (port === undefined) return { state: 'FREE' }
      const insp = await port.inspectLockState()
      return { state: insp.state, ...(insp.detail !== undefined ? { detail: insp.detail } : {}) }
    },
    recoverStaleLock: async () => {
      const port = host.mutationLock as EnvironmentLockManager | undefined
      // 无锁端口（测试/未接线）→ 无可回收对象，诚实拒绝而非谎称成功
      if (port === undefined) return { ok: false, removed: false, state: 'FREE', detail: 'no lock port configured' }
      return port.recoverStaleLock()
    },
  })
  /** 构造 recovery 执行器（restore / rollback），供 execute/retry 注入（runId 用于进度埋点）。 */
  const makeRecoveryExecutors = (runId: string): RecoveryExecutorFns => ({
    performRestore: async (snapshotId) => {
      const dir = join(snapshotsDir, snapshotId)
      const restoreOpts = {
        snapshotDir: dir, homeDir: host.homeDir, profile: host.profile, settingsPath: undefined, msg,
        snapshotsRoot: snapshotsDir, environmentFingerprint: host.phase3Recovery?.recoveryEnvFingerprint ?? 'unknown', requireOperationBound: true,
      }
      const plan = await planRestore(restoreOpts)
      const report = await executeRestorePlan(plan, makeRestoreExecutor(dir, host, host.profile), (info) => {
        runs.update(runId, { section: 'recovery', item: info.index, itemTotal: info.total, detail: info.detail })
      })
      return { full: report.failed.length === 0, failed: report.failed.map((f) => f.item) }
    },
    performRollback: async (snapshotId) => {
      const store = new FileSnapshotStore({ dir: snapshotsDir })
      const snap = await store.load(snapshotId)
      const report = await performRollback({ ctx: host, snapshot: snap, store, adapters })
      return { full: report.full, failed: report.failed.map((f) => f.item) }
    },
  })

  const routesList: WebRoute[] = [
    // ------------------------------------------------------------- status
    // 设置页页脚版本行：插件版本 + DSH 版本。只读、无 secret，loopback fence。
    {
      kind: 'exact',
      path: API.status,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, {
          pluginVersion: PLUGIN_VERSION,
          dshVersion: host.dshVersion,
        })
      },
    },
    // ------------------------------------------------------------- export
    // ---------------------------------------------------- export-preview
    // P2-⑫：导出前只读预览（不落盘 ZIP）：对选中分区逐个 adapter.export 收集 counts
    // （与真实导出一致的 secret 剥离，不导出任何值），估算 JSON 载荷大小，返回可展示摘要。
    // 零写入；loopback fence 必备。
    // ------------------------------------------------------------ download
    // -------------------------------------------------------------- upload
    // ------------------------------------------------------------- analyze
    // ---------------------------------------------------------------- plan
    // ------------------------------------------------------------ progress
    // m1：查询单个 run 的实时状态（轮询 / 刷新恢复用；runId 不可猜，走 loopback-only 守卫）
    // ----------------------------------------------------------------- runs
    // m1：列出当前活跃（running）的 run（刷新恢复时重新订阅进度用）
    // ------------------------------------------------------------- execute
    // -------------------------------------------------- execute/skip
    // 用户跳过当前计划项（导入中，目前仅插件安装）：abort 当前项的中止控制器 → 引擎
    // 捕获 ImportUserSkippedError 记为 user-skipped，导入继续执行其余项。
    // ---------------------------------------------------------- snapshots
    // M4：列出快照元信息（id/createdAt/sourceZip/status/计数，createdAt 倒序）
    // ------------------------------------------------------------ restore
    // M4：快照恢复。dryRun=true 只返回动作计划（planRestore，零写入）；
    // 真实执行 = 计划 → 宿主执行器（ctx.fs 整文件/文件还原 + runDshPlugin 卸载插件）
    // → 与 CLI 一致的诚实报告 { restored/removedPlugins/manualHints/failed/skipped }。
    //
    // **并发防护（P1-1）**：真实执行（dryRun=false）经 runs.register('restore') 登记——
    // 同 kind 已有 running 时抛 RunConflictError → 409 拒绝。这是宿主侧的权威防重
    // （前端 loading 只是 UX）：即使两个 tab / 刷新后重复点击，同一时刻至多一个
    // restore 在执行（不同快照并发恢复会交错写文件，同快照并发会互相覆盖
    // pre-restore 双保险备份，都是真实数据风险）。进度经 onAction 埋点更新
    // RunRegistry（/progress 轮询 + /runs 刷新恢复可见）；响应含 runId。
    // ------------------------------------------- snapshots/delete（P1-⑧）
    // 手动删除单个快照（危险操作：该导入前回滚点不可恢复）。loopback fence（guard）；
    // 只接受合法快照 id（deleteSnapshot 内防穿越）。与自动保留清理不同：置顶快照
    // 只能在这里被用户手动删除。
    // --------------------------------------------- snapshots/pin（P1-⑧）
    // 置顶/取消置顶快照：置顶快照豁免「最多保留 N 个」的自动清理（只能手动删除）。
    // 纯元数据写（重写 snapshot.json 的 pinned 字段）；loopback fence 必备。
    // -------------------------------------------------- m-profiles
    // 配置档案（Profile）：保存当前 DSH 配置为多套可切换快照（Work/Personal…）。
    // 安全：Profile 名严格校验（ProfileManager 内部 isValidProfileName 防穿越）；
    // 切换走「预览 → confirm → 快照 → 分阶段 apply → 失败回滚」与导入同一语义；
    // Save 复用 adapter.export（天然不含秘密值）；全部路由 loopback fence。
    // -------------------------------------------------- backup-schedule
    // 定时全量备份设置（GET 读 / PUT 存 sync/backup-schedule.json；无敏感字段）：
    // 保存后重排调度器（reload）；恒不含 secret、不加密（与自动同步同语义）。
    // 与全仓一致：每个方法分支都过 loopback fence（guard）——其他 /api/dsh-config-manager/*
    // 路由全部首行 guard，新增路由不得遗漏（安全不变量：仅 loopback + 同源可访问）。
    // ------------------------------------------------- backup-schedule/run
    // 返回执行结果（status/zip/skipReason/error）+ 最新配置（含 lastRun 状态）。
    // 同全仓：loopback fence（guard）——远程调用方不得触发宿主写盘操作。
    // ------------------------------------------------------ backup-files
    // 导出产物管理（m-backup-files）：列出 exports/*.zip（名称/大小/时间/来源，
    // 时间倒序）+ 删除单个备份文件。下载复用 /download（roots 已含 exportsDir）。
    // 安全：删除只接受文件名（服务端 basename 校验防路径穿越）；恒 loopback guard。
    // ------------------------------------------------------ consult
    // Phase 7：迁移前咨询（只读健康评分 + 建议）。POST，loopback fence。
    // 对 4 种可迁移源（export-zip / local-snapshot / remote-snapshot / profile）生成
    // 统一咨询报告。**只读**：不写配置/快照/journal；临时 ZIP 用 try/finally 立即清理。
    // ------------------------------------------------------ sync/status
    // m-sync-ui：同步状态（通道配置 / 凭据状态 / 上次同步 / 分区数）。只读，无 secret 值。
    {
      kind: 'exact',
      path: API.syncStatus,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          // 完整双命名空间配置：repoUrl / webdav.url 无论当前通道都回填，
          // 保证 UI 在 git ↔ webdav 间切换时另一通道的地址不丢失
          const full = await readFullSyncConfig(syncDir)
          const state = await loadSyncState(syncDir)
          const [cred, webdavCred] = await Promise.all([
            credentials.describe(credentialRef(SYNC_CREDENTIAL_REF)),
            credentials.describe(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF)),
          ])
          const transport: SyncConfig['transport'] = full !== null && full.transport === 'webdav' ? 'webdav' : 'git'
          // m-self：插件 UI 偏好（上次选择的同步通道；ui-prefs.json，随 self 分区进备份）
          const uiPrefs = await readUiPrefs(syncDir)
          // webdav 配置视图（配置过即返回，与当前通道无关：供表单在 git ↔ webdav 切换时回填）
          const webdav = full?.webdav !== undefined
            ? {
                url: full.webdav.url,
                // username 非敏感可回显，供表单回填
                username: full.webdav.username,
                usernameConfigured: typeof full.webdav.username === 'string' && full.webdav.username !== '',
                passwordConfigured: webdavCred.configured,
              }
            : undefined
          writeJson(res, 200, {
            ok: true,
            configured: full !== null,
            transport,
            repoUrl: full?.git?.repoUrl,
            credentialConfigured: cred.configured,
            credentialWritable: cred.writable === true,
            // webdav 配置状态（无 secret 值：口令用 passwordConfigured 布尔标记）
            ...(webdav !== undefined ? { webdav } : {}),
            lastSyncAt: state.lastSyncAt === '' ? undefined : state.lastSyncAt,
            sectionCount: Object.keys(state.sections).length,
            lastTransport: state.transport,
            // 上次选择的同步通道（磁盘 ui-prefs；UI 回填优先于此，localStorage 仅兜底）
            lastSyncChannel: uiPrefs.lastSyncChannel,
            // 可同步分区目录（「高级/自定义导出」勾选列表；只含 portable，无 secret 值）
            syncSections: syncSectionCatalog,
            // 当前分区选择（默认/高级模式 + 勾选分区；当前激活通道；UI 回填用，自动同步共用）
            syncSelection: await selectionView(transport),
            // 全部通道的分区选择（git/webdav 各自独立；UI 按当前 tab 取对应通道）
            syncSelectionByChannel: await selectionViewByChannel(),
            // 自动同步当前状态（当前激活通道；供 UI 顶部开关回填；§3.9）
            autosync: await buildAutosyncStatus(syncDir, transport),
            // 全部通道的自动同步状态（git/webdav 各自独立；UI 按当前 tab 取对应通道）
            autosyncByChannel: await buildAutosyncStatusByChannel(syncDir),
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ sync/config
    // m-sync-config：保存同步通道配置（parseSyncBody 校验 + password/token 写 DSH credentials +
    // writeSyncConfig 落盘）。UI 表单自动保存 /「保存配置」按钮调用；响应为轻量状态视图
    // （仅凭据布尔，无 secret 值），供 UI 直接刷新徽章而不必重拉 status 覆盖正在编辑的表单。
    {
      kind: 'exact',
      path: API.syncConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          await writeSyncConfig(syncDir, syncCfg)
          const [cred, webdavCred] = await Promise.all([
            credentials.describe(credentialRef(SYNC_CREDENTIAL_REF)),
            credentials.describe(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF)),
          ])
          writeJson(res, 200, {
            ok: true,
            configured: true,
            transport: syncCfg.transport,
            credentialConfigured: cred.configured,
            webdav: isWebDavConfig(syncCfg)
              ? {
                  usernameConfigured: typeof syncCfg.webdav.username === 'string' && syncCfg.webdav.username !== '',
                  passwordConfigured: webdavCred.configured,
                }
              : undefined,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/ui-prefs
    // m-self：保存插件 UI 偏好（当前为上次选择的同步通道；ui-prefs.json，随 self 分区进备份）。
    // 纯偏好、无 secret；失败仅提示，不阻断同步主流程。
    // 经 updateUiPrefs 局部合并写：不覆盖其他端点（star-prompt）刚写入的字段。
    {
      kind: 'exact',
      path: API.syncUiPrefs,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const channel: UiPrefsChannel | undefined = body['lastSyncChannel'] === 'webdav' ? 'webdav' : body['lastSyncChannel'] === 'git' ? 'git' : undefined
          await updateUiPrefs(syncDir, { ...(channel !== undefined ? { lastSyncChannel: channel } : {}) })
          writeJson(res, 200, { ok: true, lastSyncChannel: channel })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ star-prompt
    // m-star-prompt：Star 引导弹窗状态（复用 ui-prefs.json；随 self 分区进备份）。
    // GET → 返回仓库地址 + 弹窗状态（UI 挂载时判定是否展示 / 是否补记首次使用时间）；
    // POST → 局部更新（firstSeenAt / dismissed / clicked 白名单），经 updateUiPrefs
    // 合并写，不覆盖 sync/ui-prefs 的 lastSyncChannel。纯偏好、无 secret。
    // ------------------------------------------------------ release-notes-prompt
    // 版本更新内容弹窗状态（复用 ui-prefs.json；随 self 分区进备份）。
    // GET → 返回当前插件版本 + 上次已读版本 + 是否永不提示；
    // POST → 局部更新（lastSeenVersion / dismissed 白名单），经 updateUiPrefs 合并写。
    // ------------------------------------------------------ sync/push
    // m-sync-ui：推送（导出 portable 分区 → 提交私有仓库 → 更新 sync-state）。
    // token 可选：非空先写入 DSH credentials；成功则记忆仓库配置（回填表单用）。
    // sections 可选（高级/自定义导出）：只推送勾选的分区；缺省 = 默认模式全部推荐分区。
    {
      kind: 'exact',
      path: API.syncPush,
      handler: withMutationGate('sync-push', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          const snapshotId =
            typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          const sections = extractSyncSections(body, knownSyncSectionIds)
          // P0-②：push 前只读预览（body.preview === true → 不写远端，只返回「将推送什么」）
          const preview = body['preview'] === true
          // 分支调用以保证 withTimeout 的泛型结果类型正确（SyncPushReport | SyncPushPreview）
          const report = preview
            ? await withTimeout(
                engine.previewPush({ ...(sections === undefined ? {} : { sections }) }),
                ROUTE_TIMEOUT_MS,
                msg('host.syncPushTimeout'),
              )
            : await withTimeout(
                engine.push({
                  ...(snapshotId === undefined ? {} : { snapshotId }),
                  ...(sections === undefined ? {} : { sections }),
                }),
                ROUTE_TIMEOUT_MS,
                msg('host.syncPushTimeout'),
              )
          await writeSyncConfig(syncDir, syncCfg)
          writeJson(res, 200, report)
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      }),
    },
    // ------------------------------------------------------ sync/pull
    // m-sync-ui：拉取差异预览（只读：list/download → 转临时 ZIP → Importer 分析出计划摘要）。
    // 绝不直接写配置、绝不执行导入（executeImportPlan 由上层按用户确认驱动）。
    {
      kind: 'exact',
      path: API.syncPull,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          // 缺省 replace：明文同步的产品语义是「远端值覆盖本地」，不做 diff/合并
          const strategy =
            body['strategy'] === 'merge' || body['strategy'] === 'skipExisting' ? body['strategy'] : 'replace'
          const snapshotId =
            typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          const report = await withTimeout(
            engine.pull({
              strategy,
              ...(snapshotId === undefined ? {} : { snapshotId }),
            }),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPullTimeout'),
          )
          await writeSyncConfig(syncDir, syncCfg)
          writeJson(res, 200, report)
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // -------------------------------------------------- sync/github/start
    // m-github-oauth：发起 GitHub OAuth device flow。请求 GitHub 取设备码，宿主登记
    // （flowId → device_code 只存内存），返回 UI 展示用的 user_code + 授权页 URL。
    // client_id 来自插件配置；未配置时给出可操作指引（不会凭空认证）。
    {
      kind: 'exact',
      path: API.syncGithubStart,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (githubClientId === undefined || githubClientId === '') {
          writeJson(res, 400, {
            error: msg('host.githubMissingClientId'),
          })
          return
        }
        try {
          const started = await githubAuth.startDeviceFlow(githubClientId)
          const flowId = DeviceFlowStore.newFlowId()
          githubFlows.set(flowId, {
            deviceCode: started.deviceCode,
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            interval: started.interval,
            expiresAt: Date.now() + started.expiresIn * 1000,
          })
          // device_code 绝不回传；只回 UI 需要的展示信息
          writeJson(res, 200, {
            flowId,
            userCode: started.userCode,
            verificationUri: started.verificationUri,
            expiresIn: started.expiresIn,
            interval: started.interval,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // -------------------------------------------------- sync/github/poll
    // m-github-oauth：轮询授权结果。凭 flowId 取回宿主登记的 device_code → GitHub 换 token
    // → 成功则立即写入 DSH credentials（SYNC_CREDENTIAL_REF，与手动 token 同槽），
    // token 绝不回传浏览器；pending 返回下次轮询延迟；终止态（denied/expired/error）清理登记。
    {
      kind: 'exact',
      path: API.syncGithubPoll,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const flowId = typeof body?.['flowId'] === 'string' ? body['flowId'] : ''
        if (flowId === '') {
          writeJson(res, 400, { error: 'flowId is required' })
          return
        }
        const flow = githubFlows.get(flowId)
        if (flow === undefined) {
          writeJson(res, 400, { error: msg('host.githubFlowGone') })
          return
        }
        try {
          const result = await githubAuth.pollForToken({
            clientId: flow.clientId,
            deviceCode: flow.deviceCode,
            clientSecret: flow.clientSecret,
            interval: flow.interval,
          })
          if (result.status === 'success' && result.accessToken !== undefined) {
            await credentials.set(credentialRef(SYNC_CREDENTIAL_REF), result.accessToken)
            githubFlows.delete(flowId)
            host.log.info('GitHub OAuth 登录成功（token 已写入 DSH credentials）')
            writeJson(res, 200, { status: 'success', credentialConfigured: true })
            return
          }
          if (result.status === 'pending') {
            writeJson(res, 200, { status: 'pending', pollDelayMs: result.pollDelayMs })
            return
          }
          // 终止态：清理登记，把状态 + 可展示消息回给 UI（不含任何秘密）
          githubFlows.delete(flowId)
          writeJson(res, 200, {
            status: result.status,
            ...(result.message !== undefined ? { message: result.message } : {}),
            ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // -------------------------------------------------- sync/github/cancel
    // m-github-oauth：取消登录流程（丢弃宿主侧 device_code 登记，零副作用）。
    {
      kind: 'exact',
      path: API.syncGithubCancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const flowId = typeof body?.['flowId'] === 'string' ? body['flowId'] : ''
        if (flowId === '') {
          writeJson(res, 400, { error: 'flowId is required' })
          return
        }
        githubFlows.delete(flowId)
        writeJson(res, 200, { ok: true })
      },
    },
    // -------------------------------------------------- sync/github/validate
    // m-sync-github-valid：校验 SYNC_CREDENTIAL_REF 中已存 token 是否有效（GET /user），
    // 供 UI 判定「是否已登录」→ 已登录隐藏 GitHub 登录区块、token 失效则重新展示。
    // 只回布尔 + 登录名（非敏感），token 值绝不回传；仅 401（无效/过期）→ valid:false，
    // 其余错误（网络/限流）向上抛，由 UI 兜底（不误判登出）。
    {
      kind: 'exact',
      path: API.syncGithubValidate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          let configured = false
          let valid = false
          let login: string | undefined
          const resolved = await credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))
          const token = resolved?.value ?? ''
          configured = token !== ''
          if (configured) {
            try {
              const user = await githubAuth.getUser(token)
              valid = true
              login = user.login
            } catch (error) {
              // 仅 401（token 无效/过期）→ 视为未登录；其余错误（网络/限流）向上抛
              if (!(error instanceof GitHubAuthError && error.code === 'unauthorized')) throw error
            }
          }
          writeJson(res, 200, {
            ok: true,
            configured,
            valid,
            ...(login !== undefined ? { login } : {}),
          })
        } catch (error) {
          writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ------------------------------------------------------ sync/history
    // 列出本地快照目录的 manifest.json（id/createdAt/sectionHashes/transport）。
    {
      kind: 'exact',
      path: API.syncHistory,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const localDir = join(syncDir, 'snapshots')
          const entries = await fs.readdir(localDir).catch(() => [])
          const rows: Array<{ id: string; createdAt: string; sectionCount: number; reviewCount: number; transport?: string }> = []
          for (const name of entries) {
            const dir = join(localDir, name)
            const stat = await fs.stat(dir).catch(() => null)
            if (!stat?.isDirectory()) continue
            const manifestPath = join(dir, 'manifest.json')
            const raw = await fs.readFile(manifestPath, 'utf8').catch(() => null)
            if (raw === null) continue
            try {
              const m = JSON.parse(raw) as { id?: unknown; createdAt?: unknown; sectionHashes?: unknown; manifest?: { transport?: unknown } }
              if (typeof m.id !== 'string' || typeof m.createdAt !== 'string') continue
              const sectionCount = m.sectionHashes && typeof m.sectionHashes === 'object'
                ? Object.keys(m.sectionHashes as Record<string, unknown>).length
                : 0
              // 触发通道（push/apply 落盘时写入各快照 manifest.transport；旧快照为 undefined）
              const transport = m.manifest && typeof m.manifest === 'object' && typeof m.manifest.transport === 'string'
                ? m.manifest.transport
                : undefined
              rows.push({ id: m.id, createdAt: m.createdAt, sectionCount, reviewCount: 0, ...(transport !== undefined ? { transport } : {}) })
            } catch { /* skip malformed */ }
          }
          // reviewCount 恒 0：待审队列（sync-review-queue.json）已随合并逻辑一并删除，
          // 保留该字段仅为与客户端契约兼容。
          rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          // 合并自动同步执行记录（sync-history.json）
          const hist = await readSyncHistory(syncDir)
          const merged = [
            ...rows.map((r) => ({ ...r, kind: 'apply' as const })),
            ...hist.autosyncEntries.map((e) => ({
              id: e.createdAt,
              createdAt: e.createdAt,
              kind: 'autosync' as const,
              autosync: e,
            })),
          ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          writeJson(res, 200, { entries: merged })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ sync/snapshots-list
    // m-sync-v2：远端历史快照列表（供「选择历史快照」下拉）。
    {
      kind: 'exact',
      path: API.syncSnapshotsList,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          const metas = await withTimeout(
            engine.listSnapshots(),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPullTimeout'),
          )
          const snapshots = [...metas]
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
            .map((m) => ({
              id: m.id,
              createdAt: m.createdAt,
              sectionCount: m.manifest.sectionIds.length,
              platform: m.manifest.platform,
              dshVersion: m.manifest.dshVersion,
            }))
          const state = await loadSyncState(syncDir)
          writeJson(res, 200, { ok: true, snapshots, currentSnapshotId: state.lastSnapshotId === '' ? undefined : state.lastSnapshotId })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/sync
    // m-sync-v2：一键同步第一步 —— 拉取 → 差异确认会话（内存登记临时 ZIP + ImportPlan）。
    {
      kind: 'exact',
      path: API.syncSync,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          const snapshotId = typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          const preview = await withTimeout(
            engine.preview({ ...(snapshotId === undefined ? {} : { snapshotId }) }),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPullTimeout'),
          )
          if (!preview.ok || preview.plan === null || preview.analysis === null) {
            writeJson(res, 200, { ok: false, syncSessionId: '', snapshotId: preview.snapshotId, items: [], needsReview: false, compatibility: 'unsupported', message: preview.message ?? '同步预览失败' })
            return
          }
          const syncSessionId = syncSessions.set({
            zipPath: preview.zipPath,
            plan: preview.plan,
            analysis: preview.analysis,
            snapshotId: preview.snapshotId,
            config: syncCfg,
          })
          const items = planToConfirmItems(preview.plan)
          const needsReview = items.some((i) => REVIEW_KINDS.has(i.kind) || isToolchainChangeItem(i))
    || preview.analysis.pathIssues.length > 0
          writeJson(res, 200, {
            ok: true,
            syncSessionId,
            snapshotId: preview.snapshotId,
            items,
            needsReview,
            compatibility: preview.analysis.compatibility,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/apply-items
    // m-sync-v2：一键同步第二步 —— 按用户对差异项的逐项决策执行导入。
    {
      kind: 'exact',
      path: API.syncApplyItems,
      handler: withMutationGate('sync-apply', async (req, res, lockCtx, journalCtx) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncSessionId = typeof body['syncSessionId'] === 'string' ? body['syncSessionId'] : ''
          const session = syncSessions.get(syncSessionId)
          if (session === undefined) {
            writeJson(res, 400, { error: '同步会话不存在或已过期，请重新拉取预览' })
            return
          }
          const adoptions = Array.isArray(body['adoptions']) ? body['adoptions'] : []
          // 构造子计划（仅含采纳项）
          const byId = new Map<string, { adopt: boolean; resolution?: string }>()
          for (const a of adoptions as Array<Record<string, unknown>>) {
            if (typeof a?.['itemId'] !== 'string') continue
            byId.set(a['itemId'], { adopt: a['adopt'] === true, resolution: typeof a['resolution'] === 'string' ? a['resolution'] : undefined })
          }
          // 构造子计划（仅含采纳项）。同步冲突决策 useRemote → 核心 importer 的
          // useImported（item 转成 Update，applyOne 才会真正写远端值），
          // keepLocal/skip 从子计划剔除（keepCurrent/skip 语义：不写）。
          // 与导入恢复向导（ConflictList keepCurrent/useImported）的决策语义完全一致。
          const subItems: PlanItem[] = session.plan.items.flatMap((item) => {
            const d = byId.get(item.id)
            if (d === undefined || !d.adopt) return []
            // Conflict 项必须有 resolution；keepLocal/skip 不写入本地 → 剔除
            if (item.kind === 'Conflict') {
              if (d.resolution === undefined) throw new SyncRouteError(`冲突项 ${item.id} 必须提供 resolution（useRemote/keepLocal/skip）`)
              if (d.resolution === 'keepLocal' || d.resolution === 'skip') return []
              // useRemote → 转成 Update 计划项（镜像 analyzer.applyItemResolution 的
              // useImported 分支），applyOne 才会把远端值真正写进本地。
              const c = (item as { conflict?: { itemId?: string } }).conflict
              return [{
                ...item,
                kind: 'Update' as const,
                severity: 'info' as const,
                conflict: { itemId: c?.itemId ?? item.id, resolution: 'useImported' as const },
              } as PlanItem]
            }
            return [item]
          })
          const subPlan: ImportPlan = {
            ...session.plan,
            items: subItems,
          }
          // 消费会话（同一 session 只允许一次 apply-items）
          syncSessions.delete(syncSessionId)
          let engine: SyncEngine
          let report: ApplyItemsReport
          try {
            engine = makeSyncEngine(session.config)
            report = await engine.applyItems(session.zipPath, subPlan, {
              onItem: (info) => { /* 进度可选：runs 已由 applyItems 内部处理 */ },
              snapshotBinding: journalCtx,
            })
          } finally {
            // 用完再清理临时 ZIP（此前在 applyItems 读取前就删除 → ENOENT：无法读取备份文件）
            await fs.rm(dirname(session.zipPath), { recursive: true, force: true }).catch(() => { /* 尽力清理临时 ZIP */ })
          }
          const historyError = await tryAppendHistory({
            kind: 'sync-apply',
            result: report.ok ? 'success' : 'failed',
            sections: Array.isArray(report.applied) ? report.applied.filter((s): s is string => typeof s === 'string') : subItems.map((i) => (i as { adapter?: string }).adapter).filter((s): s is string => typeof s === 'string' && s !== ''),
            operationId: journalCtx?.operationId,
            snapshotId: report.restoreId ?? undefined,
            source: 'api',
            summary: `一键同步应用：${(Array.isArray(report.applied) ? report.applied.length : subItems.length)} 项${report.rolledBack === true ? '（已回滚）' : ''}`,
            error: report.ok ? undefined : '同步应用未完全成功',
          })
          writeJson(res, 200, historyError === undefined ? {
            ok: report.ok,
            applied: report.applied,
            skipped: subItems.map((i) => i.id),
            needsRestart: report.needsRestart === true,
            warnings: report.warnings,
            restoreId: report.restoreId,
            rolledBack: report.rolledBack,
            failed: report.failed,
            result: report.result,
          } : {
            ok: report.ok,
            applied: report.applied,
            skipped: subItems.map((i) => i.id),
            needsRestart: report.needsRestart === true,
            warnings: report.warnings,
            restoreId: report.restoreId,
            rolledBack: report.rolledBack,
            failed: report.failed,
            result: report.result,
            historyWriteError: historyError,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      }, { deferredSnapshot: true }),
    },
    // ------------------------------------------------------ sync/cancel
    // m-sync-v2：取消 / 清理差异确认会话（丢弃临时 ZIP，零副作用）。
    {
      kind: 'exact',
      path: API.syncCancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncSessionId = typeof body['syncSessionId'] === 'string' ? body['syncSessionId'] : ''
          if (syncSessionId !== '') {
            const session = syncSessions.get(syncSessionId)
            if (session !== undefined) {
              await fs.rm(dirname(session.zipPath), { recursive: true, force: true }).catch(() => { /* 尽力清理临时 ZIP */ })
            }
            syncSessions.delete(syncSessionId)
          }
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/autosync
    // m-sync-v2：自动同步配置读写（按通道：git/webdav 各自的开关 + 间隔 + 启动阈值 + 状态）。
    // GET = 读全部通道状态（{ git, webdav }）；POST = 写指定通道（body.transport，缺省 git）。
    // 同一路径注册为一个 exact 路由（方法内部分发），避免 webserver 对重复 exact 路径报错。
    {
      kind: 'exact',
      path: API.syncAutosync,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          try {
            writeJson(res, 200, await buildAutosyncStatusByChannel(syncDir))
          } catch (error) {
            writeSyncRouteError(res, error)
          }
          return
        }
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          // 按通道读写：git/webdav 各自的自动同步配置与运行状态独立（缺省 git 兜底）
          const channel: SyncTransportType = body['transport'] === 'webdav' ? 'webdav' : 'git'
          const cfg = await readAutosyncConfig(syncDir, channel)
          if (typeof body['enabled'] === 'boolean') cfg.enabled = body['enabled']
          if (typeof body['interval'] === 'string' && isAutosyncInterval(body['interval'])) cfg.interval = body['interval']
          if (typeof body['startupMinIntervalMs'] === 'number' && Number.isFinite(body['startupMinIntervalMs']) && body['startupMinIntervalMs'] > 0) {
            cfg.startupMinIntervalMs = body['startupMinIntervalMs']
          }
          await writeAutosyncConfig(syncDir, channel, cfg)
          if (scheduler) scheduler.reload().catch(() => { /* 尽力而为 */ })
          writeJson(res, 200, await buildAutosyncStatus(syncDir, channel))
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/selection
    // m-sync-selection：保存同步分区选择（按通道：git/webdav 各自的模式 + 勾选分区）。
    // 持久化到 sync-selection.json；自动同步调度器与手动 push 共用（makeSyncEngine 注入）。
    // sections 元素必须是可同步（portable）分区 id；mode 非法 → 回退 default。
    {
      kind: 'exact',
      path: API.syncSelection,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          // 按通道读写：git/webdav 各自的模式与分区勾选独立（缺省 git 兜底）
          const channel: SyncTransportType = body['transport'] === 'webdav' ? 'webdav' : 'git'
          const mode: SyncSelectionMode = body['mode'] === 'advanced' ? 'advanced' : 'default'
          const rawSections = Array.isArray(body['sections']) ? body['sections'] : []
          // 目录已含全部分区（不再按 portability 过滤），变量名不沿用 portable*
          const catalogSectionIds = new Set(syncSectionCatalog.map((s) => s.id))
          for (const s of rawSections) {
            if (typeof s !== 'string' || s === '') {
              writeJson(res, 400, { error: 'sections must be an array of non-empty strings' })
              return
            }
            if (!catalogSectionIds.has(s as SectionId)) {
              writeJson(res, 400, { error: `unknown sync section: ${s}` })
              return
            }
          }
          const next: SyncSelection = {
            schemaVersion: SYNC_SELECTION_SCHEMA_VERSION,
            mode,
            sections: [...new Set(rawSections as string[])] as SectionId[],
          }
          await writeSyncSelection(syncDir, channel, next)
          selectionCache[channel] = next
          writeJson(res, 200, { ok: true, transport: channel, mode: next.mode, sections: next.sections })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/rollback
    // P2：UI 一键回滚入口（按 apply 返回的 restoreId 调用 backup→rollback）。
    {
      kind: 'exact',
      path: API.syncRollback,
      handler: withMutationGate('sync-rollback', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const restoreId = typeof body['restoreId'] === 'string' ? body['restoreId'] : ''
          if (restoreId === '') {
            writeJson(res, 400, { error: 'restoreId required' })
            return
          }
          const store = new FileSnapshotStore({ dir: join(syncDir, 'snapshots') })
          const snap = await store.load(restoreId)
          const report = await performRollback({ ctx: host, snapshot: snap, store, adapters })
          const historyError = await tryAppendHistory({
            kind: 'rollback',
            result: 'success',
            sections: [],
            snapshotId: restoreId,
            source: 'api',
            summary: `一键同步回滚（${restoreId}）`,
          })
          writeJson(res, 200, historyError === undefined ? { ok: true, full: report.full } : { ok: true, full: report.full, historyWriteError: historyError })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    // ---------------------------------------------------- market/status
    // 内置单市场（只读、不可编辑）：恒返回内置仓库摘要。无 add/remove —— 市场绑定内置仓库。
    // ---------------------------------------------------- market/refresh
    // ---------------------------------------------------- market/browse
    // ---------------------------------------------------- market/download
    // 拉取 manifest + config.zip → 安全校验（§6）→ valid 则落受控临时区 + dry-run 分析/计划。
    // 真正落盘由用户确认后走既有 POST /execute（zipPath + plan）。零写入到确认。
    // ---------------------------------------------------- market/prepare
    // 发布向导：由「用户上传的配置 zip + 用户填写元数据」生成市场条目包
    // （L2 manifest + config.zip SHA-256 + sections），供 UI 展示/复制与引导推送。
    // 零写入配置：只在受控临时区生成发布目录；插件不做任何 git 写操作、不持有凭据。
    // ---------------------------------------------------- me/status
    // 「一键上传 / 我的配置」登录状态：resolve SYNC_CREDENTIAL_REF token → GET /user。
    // 401 → loggedIn:false（未登录）；token 值不出模块外，只回传 login 用户名。
    // ---------------------------------------------------- me/upload
    // 一键上传：zipPath 必须来自受控上传临时区（复用 /market/prepare 规则）；
    // form 仅 { name, description?, categories? }（name 必填）；元数据全自动由 MyRepoService 生成。
    // ---------------------------------------------------- me/items
    // 查看已上传：读用户仓库 index.json + 收录状态（未收录 / PR 待审核 / 已收录）。
    // 401（token 过期）→ 401 + 脱敏错误，UI 引导重新登录。
    // ---------------------------------------------------- me/update
    // 一键更新：同 upload 时序；version 纯自动 +1、id 不变；PR 未合并 force push 更新 / 已合并基于最新 main 重开。
    // ---------------------------------------------------- me/listing
    // 查询收录/下架任务状态（结果卡轮询）：任务表命中 → 直接返回；未命中 → 回退 GitHub 实况推导；
    // 无任务且无实况 → 200 null。401（token 过期）→ 401，UI 引导重新登录。
    // ---------------------------------------------------- me/relist
    // 重新提交收录（收录失败 / 进程重启丢失后的一键重试）：幂等复用已存在 fork/open PR。
    // ---------------------------------------------------- me/delete
    // 删除条目：同步删用户仓库索引 + items/<id>/ 文件；已收录 → 后台异步提下架 PR；待审核 → 关闭收录 PR。
    // ------------------------------------------------------------ history
    // Phase 6：迁移历史审计（统一历史引擎）。只读 GET：列表（过滤）+ 导出。
    // loopback fence（guard）与全仓一致——仅同源 + loopback 可访问。
    // ------------------------------------------------------------ recovery
    // Phase 5：recovery 编排（prefix 路由，内部按 path 分发）。
    // 禁用 withMutationGate（避免 double-journal）；mutation 路由经 withMutationLock + loopback fence。
    // ------------------------------------------------------------ Phase 1 P0
    // 配置生命周期（自动快照 / 撤销 / 重做）：prefix 路由，内部按 path 分发。
    // mutation 动作经 withMutationGate（GLOBAL 锁 + SAFE MODE 闸门）；status 只读不加锁。
    // 崩溃归因（P0-5）：只读。上次启动是否异常 + 归因 + 建议动作 + last-good 快照。
    // 启动救援模式（P0-3）：on = 备份三处原件后，把 profile patch 改写成只挂载本插件的最小内容、
    // 置空 home patch，并把 dsh.profile.bundles 收窄为 DSH 核心（@deepseek-ai/*）与本插件自身
    // —— 其余用户插件本次启动不挂载（这才是「禁用其它插件」，只中和 patch 层救不了
    // 「插件代码自己把 DSH 搞挂」）；off = 从备份完整还原。两侧都只动
    // cordis.patch.yml / package.json / state.json，可完全回退。
  ]
  return { routes: routesList, scheduler, makeSyncEngine, lifecycle }
}

/* ------------------------------------------------------------------ apply */

/**
 * Mount the config-manager engine: host context, adapters, and the
 * /api/dsh-config-manager routes (when a webServer is present).
 * @param ctx - host plugin context carrying settings/credentials/webServer.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  if (config?.enabled === false) return

  const homeDir = resolveDshHome()
  const dataDir = config?.dataDir !== undefined && config.dataDir !== ''
    ? resolve(config.dataDir)
    : dshHomePath('dsh-config-manager')
  const exportsDir = join(dataDir, 'exports')
  const tmpDir = join(dataDir, 'tmp')
  const snapshotsDir = join(dataDir, 'snapshots')
  const syncDir = join(dataDir, 'sync')
  // Phase 6：迁移历史审计目录（统一历史引擎；加入 RESERVED_INTERNAL_PREFIXES 防 F23 投毒链）
  const historyDir = join(dataDir, MIGRATION_HISTORY_DIR)
  mkdirSync(exportsDir, { recursive: true })
  /**
   * Phase 1 P0-5 崩溃归因：启动即写 boot-state（ok:false），待启动分类完成后翻 ok:true。
   * 崩溃瞬间不写文件 —— 靠「下一次启动发现上次 ok!==true」归因。上次若有崩溃且尚无归因，
   * 此处扫一次日志尾部并把 crashReason 持久化（日志会被滚动覆盖，错过就没了）。
   * best-effort：任何失败都不得影响插件挂载。
   */
  const bootStateDir = join(dataDir, 'config-snapshots')
  const bootBegin = async (): Promise<void> => {
    try {
      const prev = await readBootState(bootStateDir)
      const next = beginBoot(process.pid, prev)
      if (prev !== null && prev.ok !== true && next.crashReason === null) {
        try {
          const alert = computeBootAlert(prev, await readCrashLogTail(await listCandidateLogs(homeDir)))
          if (alert.crashReason !== null) next.crashReason = alert.crashReason
        } catch { /* 归因失败不影响启动 */ }
      }
      await writeBootState(bootStateDir, next)
    } catch (error) {
      host.log.warn('boot-state 写入失败（不影响挂载）', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  // 灾备总开关关闭时不写 boot-state（崩溃归因整体下线，也不留观测残留）。
  if (LIFECYCLE_ENABLED) void bootBegin()
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(snapshotsDir, { recursive: true })
  mkdirSync(syncDir, { recursive: true })
  mkdirSync(historyDir, { recursive: true })

  const host = new ConfigManagerHostContext(ctx, homeDir, resolveProfileName(config))
  // issue #30：出站代理（插件私有，不改全局）。仅在检测到 HTTP(S)_PROXY 时生效；未配置则完全直连。
  // 打一条脱敏日志，便于用户确认「插件当前到底走没走代理」（凭据不进日志）。
  const proxySummary = activeProxySummary()
  if (proxySummary !== null) {
    host.log.info(
      `出站请求经代理 / outbound requests via proxy: http=${proxySummary.http ?? '(none)'} https=${proxySummary.https ?? '(none)'} noProxyEntries=${proxySummary.noProxyEntries}`,
    )
  }
  // Phase 2 跨进程环境锁：全局唯一 GLOBAL EXCLUSIVE MUTATION LOCK（<dataDir>/locks/environment.lock）。
  // 所有 destructive mutation 入口经 runWithMutationLock(host.mutationLock, …) 获取；跨进程/跨 kind 互斥。
  // 随插件生命周期停止：停止 heartbeat 并清除本进程持有（release 由各入口 finally 保证；这里无需额外清理）。
  host.mutationLock = new EnvironmentLockManager({
    dataDir,
    op: 'config-manager',
    target: 'global-mutation',
    lockVersion: PLUGIN_VERSION,
  })
  const envLockManager = host.mutationLock as EnvironmentLockManager
  // Phase 3：启动 reconcile（只读）+ SAFE MODE。宿主 apply() 为同步 →
  // ① 先同步探测 durable SAFE MODE 标记（scheduler.start() 前即被阻断），
  // ② 再异步跑完整只读 reconcile，刷新标志与 durable 标记。不自动 recover stale lock（Rev 3 P1-NEW-2）。
  // Phase 4 F21/F11：注入真实 snapshotExists 正向校验——journal 引用的 snapshot 存在 + READY +
  // verified（manifest/blob hash）+ op/env/owner binding 匹配 journal，才视为可回滚的有效 recovery 证据。
  const phase3Recovery = new Phase3Recovery({
    dataDir,
    packageVersion: PLUGIN_VERSION,
    snapshotExists: async (snapshotId, binding) => {
      if (snapshotId === null || snapshotId === '') return false
      if (!isValidSnapshotId(snapshotId)) return false
      const v = await verifySnapshot(snapshotsDir, snapshotId)
      if (!v.ok) return false
      // binding 校验：journal 引用必须与快照双向一致（operationId/ownerInstanceId/environmentFingerprint）
      const snap = await new FileSnapshotStore({ dir: snapshotsDir }).load(snapshotId).catch(() => null)
      if (snap === null) return false
      if (snap.readiness !== 'READY') return false
      if (binding?.operationId !== undefined && snap.operationId !== binding.operationId) return false
      if (binding?.ownerInstanceId !== undefined && snap.ownerInstanceId !== binding.ownerInstanceId) return false
      if (binding?.environmentFingerprint !== undefined && snap.environmentFingerprint !== binding.environmentFingerprint) return false
      return true
    },
  })
  host.safeModeIsBlocked = () => phase3Recovery.safeModeActive
  host.phase3Recovery = phase3Recovery
  phase3Recovery.probeSafeModeSync()
  if (phase3Recovery.safeModeActive) {
    host.log.warn('Phase 3 SAFE MODE 激活：存在未恢复的 transaction，destructive 操作被阻断（如需恢复请先显式处理）')
  }
  // P1-B：启动 recovery 分类 barrier。调度器（AutoSync/Backup）只在分类完成且 state=NORMAL 时启动。
  // schedulerGate.start 由 makeRoutes 返回 scheduler 后赋值；apply 为同步，
  // 故在该异步分类块 await 完成前，schedulerGate.start 通常已就绪。fail-closed：分类抛错 → 不启动调度器。
  const schedulerGate = { start: null as (() => void) | null }
  let startupStateResolved = false
  let shouldStartSchedulers = false
  void (async () => {
    try {
      await phase3Recovery.initFingerprint()
      const lockInsp = await envLockManager.inspectLockState()
      // P1-A：启动 barrier 前捕获 crashed stale ownership 证据（environment.lock owner.instanceId），
      // 并将其作为 expectedOwnershipInstanceId 传入分类 env → 激活 journal↔ownership binding 校验。
      const staleOwnerId = lockInsp.state === 'STALE_LOCK_DETECTED' || lockInsp.state === 'UNKNOWN_STATE'
        ? await phase3Recovery.captureStaleOwnershipInstanceId()
        : null
      const startupState = classifyStartup({
        store: phase3Recovery.store,
        hooks: phase3Recovery.recoveryHooks,
        env: {
          environmentFingerprint: phase3Recovery.recoveryEnvFingerprint,
          isLiveOwner: async () => false,
          ...(staleOwnerId ? { expectedOwnershipInstanceId: staleOwnerId } : {}),
        },
        lockState: mapLockStateForStartup(lockInsp.state),
      })
      const { state } = await startupState.classify()
      startupStateResolved = true
      phase3Recovery.safeModeActive = phase3Recovery.safeModeActive || ['RECOVERY_REQUIRED', 'NEEDS_ATTENTION', 'UNKNOWN_STATE'].includes(state.kind)
      shouldStartSchedulers = (state.kind === 'NORMAL')
      if (state.kind === 'RECOVERY_REQUIRED' || state.kind === 'NEEDS_ATTENTION') {
        host.log.warn(`Phase 3 ${state.kind}：上次 destructive operation 崩溃残留，需显式恢复；destructive 调度器未启动（read-only host 存活）`)
      } else if (shouldStartSchedulers && schedulerGate.start !== null) {
        schedulerGate.start()
      }
      // Phase 1 P0-5：启动分类已得出结论 → 本次启动判定为成功（推进 lastGoodAt）。
      // 灾备总开关关闭时不写 boot-state。
      if (LIFECYCLE_ENABLED) {
        try {
          await writeBootState(bootStateDir, markBootOk((await readBootState(bootStateDir)) ?? beginBoot(process.pid, null)))
        } catch (error) {
          host.log.warn('boot-state 标记成功失败', { error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (err) {
      // fail-closed：inspectStartup 抛错不默认 NORMAL → 不启动调度器（read-only host 存活）
      startupStateResolved = true
      shouldStartSchedulers = false
      // fail-closed 也是「本次启动成功了」：host 存活（read-only），不该被判为崩溃。
      if (LIFECYCLE_ENABLED) {
        try {
          await writeBootState(bootStateDir, markBootOk((await readBootState(bootStateDir)) ?? beginBoot(process.pid, null)))
        } catch { /* best-effort */ }
      }
      host.log.warn('Phase 3 启动 reconcile 失败（fail-closed：destructive 调度器不启动）', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
  // 缓存自动清理：启动即清一次 + 每 24h 定时清一次。
  // 只清「可重建/一次性」缓存与临时文件（tmp 暂存、exports 导出副本、market cache/work），
  // 保留期内的文件不删（供刷新恢复导入/下载等窗口继续消费）；snapshots 与 sync 属用户数据/安全网不动。
  // 尽力而为：任何失败仅记日志，不影响插件挂载与其他功能。
  const runCacheCleanup = (): void => {
    void cleanupCaches({
      tmpDir,
      exportsDir,
    })
      .then((report) => {
        if (report.removed > 0) {
          host.log.info('缓存自动清理完成', { removed: report.removed, freedBytes: report.freedBytes })
        }
      })
      .catch((error) => {
        host.log.warn('缓存自动清理失败', { error: error instanceof Error ? error.message : String(error) })
      })
  }
  runCacheCleanup()
  const cacheCleanupTimer = setInterval(runCacheCleanup, CACHE_CLEANUP_INTERVAL_MS)
  ctx.effect(() => () => clearInterval(cacheCleanupTimer), 'config-manager: cache cleanup scheduler')
  // self 分区目录（相对 ~/.dsh 根）：dataDir 在 homeDir 下 → 用相对路径挂载 self adapter；
  // 自定义 dataDir 位于 ~/.dsh 之外时 Host fs 门面无法覆盖（confined to home root），
  // 不挂 self 分区并告警（其余分区不受影响）。
  const selfRel = relative(homeDir, dataDir)
  const selfDir = !selfRel.startsWith('..') && !isAbsolute(selfRel) && selfRel !== '' ? selfRel : ''
  if (selfDir === '') {
    host.log.warn(`dataDir 不在 ~/.dsh 之下（${dataDir}），self 分区（插件自身配置备份）不挂载`)
  }
  const adapters = createAdapters({
    // Namespace list = everything the settings service has registered.
    namespaces: async () => (await ctx.settings.describe({ redactSecrets: true })).map((d) => String(d.ns)),
    // Sessions 分区默认关（含敏感内容）：挂载 adapter 供 Custom Export 显式勾选（§3.3/§15）。
    includeSessions: true,
    // 导出 plugins 分区时不列本插件自身，避免备份中的自引用条目。
    selfPluginName: PLUGIN_NAME,
    // pluginFiles 扩展：额外白名单文件 + 约定配置目录（都相对 ~/.dsh 根），支持导出更多插件配置。
    pluginFiles: config?.pluginFiles,
    pluginFilesDir: config?.pluginFilesDir,
    // self 分区：插件自身配置（sync-*.json / market-config.json / ui-prefs.json）；'' = 不挂载
    selfDir,
    // T1：本地源（link:/file:）插件打包 —— 这些 spec 指向本机路径，换机后必然不可达，
    // 曾导致插件被静默丢失。导出时用 npm pack 把源码包一并放进备份，
    // 导入时用解包出的绝对路径重写 spec（见 adapters/plugins.ts 的 applyItem）。
    localPluginPack: createLocalPluginPackHook({ homeDir, dataDir }),
  })

  host.log.info('config-manager 已挂载', {
    homeDir,
    dataDir,
    dshVersion: host.dshVersion,
    adapters: adapters.map((a) => a.id),
  })

  // Phase 6：迁移历史引擎（统一审计史；per-file append-only 存储于 <dataDir>/migration-history）
  const historyStore = new MigrationStore({ dir: historyDir })
  const runs = new RunRegistry({ msg: host.msg })
  const secretScanner = createConfiguredSecretScanner(config?.personalPatterns)
  const { routes, scheduler, makeSyncEngine, lifecycle } = makeRoutes({
    host,
    adapters,
    exportsDir,
    tmpDir,
    snapshotsDir,
    runs,
    syncDir,
    dataDir,
    // F2：部署者 personalPatterns → 强化 secret 扫描器（未配置 = 默认行为）。
    // 该扫描器实现了 scanText（文件类分区文本级扫描，G-09 只告警不改写）——
    // 换成任何没有 scanText 的扫描器都会静默关闭 G-09，改这里务必先看 exporter.ts 的 scanFileSectionText。
    scanner: secretScanner, // M1：与同步路径共用同一实例（见上方 secretScanner 构造）
    credentials: ctx.credentials,
    githubClientId: config?.githubClientId ?? DEFAULT_GITHUB_CLIENT_ID,
    githubClientSecret: config?.githubClientSecret,
    history: historyStore,
  })
  // Agent 可调用的模型工具（P0-1）：复用 src/core 引擎与同一 makeSyncEngine 来源。
  // 不依赖 webServer：host 侧能力在无 Web 部署时仍可用；tools 服务未组合时内部守卫跳过。
  registerModelTools(ctx, {
    host,
    adapters,
    syncDir,
    makeSyncEngine,
  })
  // P1-B：调度器不同步 start —— 由启动 recovery 分类完成后（仅 NORMAL）启动。
  schedulerGate.start = () => {
    scheduler.start();
    // Phase 1 P0-1：配置变更自动快照。放在同一闸门内，确保恢复/事务进行中不开拍。
    // 灾备总开关关闭时不启动监听（否则后台持续采集全部分区并刷「超出上限」告警）。
    if (LIFECYCLE_ENABLED) lifecycle.startAutoSnapshot();
  }
  // 若启动分类已在此构造完成前解析为 NORMAL（罕见竞态），立即补启动。
  if (startupStateResolved && shouldStartSchedulers && schedulerGate.start !== null) { schedulerGate.start(); }
  // 自动同步调度器随插件生命周期停止：插件重载/卸载时清理定时器，
  // 避免旧调度器残留导致重复后台同步。
  ctx.effect(() => () => scheduler.stop(), 'config-manager: autosync scheduler')
  // Phase 1 P0-1：停止配置变更监听（dispose 后不再产生自动快照）。
  ctx.effect(() => () => lifecycle.dispose(), 'config-manager: config lifecycle watcher')
  const webServer = readService<WebServer>(ctx, 'webServer')
  if (webServer === undefined) {
    host.log.warn('webServer 服务不可用：跳过 /api/dsh-config-manager 路由注册（引擎能力仍可用）')
    return
  }
  ctx.effect(() => {
    const disposers = routes.map((route) => webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'config-manager: routes')
}

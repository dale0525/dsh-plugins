/**
 * 远程同步浏览器半 —— `/api/dsh-config-manager/sync/*` 的类型化 fetch 封装。
 *
 * 独立于 `../api.ts`（ConfigManagerApi 为并行会话已改文件，禁碰）：本文件自持
 * 端点常量与 readJson/postJson 小工具（与 api.ts 同款模式），只新增不修改。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按此实现）：
 * ```
 * GET  /api/dsh-config-manager/sync/status → SyncStatusResponse （配置/凭据/上次同步）
 * POST /api/dsh-config-manager/sync/push    → SyncPushReport    （body: { repoUrl, token?, snapshotId? }；直接覆盖远端）
 * POST /api/dsh-config-manager/sync/pull    → SyncPullApplyReport（body: { repoUrl, token?, snapshotId? }；直接覆盖本地）
 * POST /api/dsh-config-manager/sync/github/start   → GithubDeviceFlowStartResponse（GitHub OAuth 设备码）
 * POST /api/dsh-config-manager/sync/github/poll    → GithubPollResponse（凭 flowId 轮询；成功时 token 已由 Host 写入 credentials）
 * POST /api/dsh-config-manager/sync/github/cancel  → { ok: true }
 * ```
 *
 * 安全约束：
 *  - token 只存在于请求体内（同源 loopback，与导入 secretInputs 同策略），由 Host 写入
 *    DSH credentials（credentialRef），绝不落同步文件/日志/URL；响应永不回传 token；
 *  - GitHub device flow：浏览器只持有 flowId（随机 id）+ user_code + 授权页 URL；
 *    device_code 与 access token 只存在于宿主（内存 / DSH credentials），永不回传；
 *  - 错误消息由 Host 侧已脱敏（GitTransport 统一 [REDACTED]），UI 侧再经 ErrorBanner redact 兜底；
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle；sync-engine 仅作 type-only 引用）。
 */
import type { SyncPullApplyReport, SyncPushReport } from '../../sync/sync-engine.ts';
import type { PlanItemKind } from '../../core/types.ts';
// 环境锁契约的**唯一**声明处（ui/types.ts）；此处只复用，不另立一套并行类型。
import type { RecoveryDismissResult, RecoveryIncident, RecoveryLockRecoverResult, RecoveryLockStatus } from '../../ui/types.ts';
import { ConfigManagerApiError } from '../api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/** 同步端点常量（与 Host 半 src/index.ts API 常量保持一致） */
export const SYNC_API = {
  status: '/api/dsh-config-manager/sync/status',
  push: '/api/dsh-config-manager/sync/push',
  pull: '/api/dsh-config-manager/sync/pull',
  githubStart: '/api/dsh-config-manager/sync/github/start',
  githubPoll: '/api/dsh-config-manager/sync/github/poll',
  githubCancel: '/api/dsh-config-manager/sync/github/cancel',
  githubValidate: '/api/dsh-config-manager/sync/github/validate',
  history: '/api/dsh-config-manager/sync/history',
  config: '/api/dsh-config-manager/sync/config',
  uiPrefs: '/api/dsh-config-manager/sync/ui-prefs',
  rollback: '/api/dsh-config-manager/sync/rollback',
  lockRecover: '/api/dsh-config-manager/sync/lock/recover',
  recoveryDismiss: '/api/dsh-config-manager/sync/recovery/dismiss',
} as const;

/** DSH credentials 中的同步 token 引用名（Host 半同值；仅供提示文案使用，值由 Host 读写） */
export const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN';

/** WebDAV 通道密码在 DSH credentials 中的引用名（Host 半同值；仅供提示文案使用，值由 Host 读写） */
export const SYNC_WEBDAV_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD';

/** 远程同步通道类型：git（默认）或 webdav */
export type SyncTransportType = 'git' | 'webdav';

/** GET /sync/status 响应：配置/凭据/上次同步的只读事实（无任何 secret 值） */
export interface SyncStatusResponse {
  ok: boolean;
  /** 是否已保存过仓库/通道配置（sync-config.json；任一通道配置过即为 true） */
  configured: boolean;
  /** git 通道：已配置的仓库地址（不含 token，可回显；与当前通道无关，配置过即返回） */
  repoUrl?: string;
  /** git 通道：DSH credentials 中是否已存在 token（describe 只报状态，值永不返回） */
  credentialConfigured: boolean;
  credentialWritable: boolean;
  /** webdav 通道：配置状态（url 可回显，username 非敏感；password 值永不返回；
   *  与当前通道无关，配置过即返回，供 git ↔ webdav 切换时回填表单） */
  webdav?: WebDavStatusResponse;
  /** sync-state.lastSyncAt；'' = 从未同步 */
  lastSyncAt?: string;
  /** sync-state.sections 条目数 */
  sectionCount: number;
  transport?: { type: string; ref: string };
  /** 上次选择的同步通道（磁盘 ui-prefs.json；UI 回填优先于此，localStorage 仅兜底） */
  lastSyncChannel?: 'git' | 'webdav';
  /** 环境锁分类摘要（只 state/attention，无 owner pid/op）：残留锁入口的徽章与可点判据 */
  lock?: RecoveryLockStatus;
  /** SAFE MODE 出口：未解决 incident 列表（空数组/缺省 = 无阻断）。reason 已由 Host 脱敏。 */
  recovery?: RecoveryIncident[];
}

/** webdav 通道状态字段（无任何 secret 值；password 只报 passwordConfigured 布尔） */
export interface WebDavStatusResponse {
  /** 上次使用的服务器地址（可回显；不含 userinfo） */
  url?: string;
  /** 上次使用的用户名（非敏感，可回显；供表单回填） */
  username?: string;
  /** 是否已填过用户名（布尔；便于 UI 提示徽章） */
  usernameConfigured: boolean;
  /** DSH credentials 中是否已存在密码（值永不返回） */
  passwordConfigured: boolean;
}

/** POST /sync/config 响应：保存成功后的轻量凭据状态（无 secret 值；UI 直接合并刷新徽章）。 */
export interface SyncConfigSaveResponse {
  ok: boolean;
  configured: boolean;
  transport: SyncTransportType;
  /** git 通道：token 是否已配置（值永不返回） */
  credentialConfigured: boolean;
  /** webdav 通道：username/password 是否已配置（值永不返回；git 通道为 undefined） */
  webdav?: {
    usernameConfigured: boolean;
    passwordConfigured: boolean;
  };
}

/** push 请求体（token 可选：非空则 Host 先写入 DSH credentials 再使用）。
 *  扁平形状与 Host parseSyncBody 一致：git 携带 repoUrl/token；
 *  webdav 携带 url/username/password（顶层，不嵌套 webdav 对象）。
 *  git 可执行文件固定使用系统 PATH 中的 git，不再接受自定义路径。
 *  同步范围由 Host 固定（除 workspaces / sessions 外的全部分区）。
 *  快照恒为明文：勾选即同步，不加密、不脱敏。 */
export interface SyncPushPayload {
  /** 通道类型；缺省 'git' */
  transport?: SyncTransportType;
  repoUrl?: string;
  token?: string;
  /** webdav 通道字段（transport='webdav' 时使用；扁平顶层） */
  url?: string;
  username?: string;
  password?: string;
}

/** POST /sync/pull 响应：拉取并直接覆盖本地（含应用前的变更摘要与回滚入口）。 */
export type SyncPullApplyResponse = SyncPullApplyReport;

/* ---------------------------------------------------------------- 同步历史 */

/** 同步历史条目（Host 端返回）。 */
export interface SyncHistoryEntry {
  id: string;
  createdAt: string;
  kind: 'push' | 'pull' | 'apply' | 'rollback';
  sectionCount?: number;
  reviewCount?: number;
  /** 快照类条目的触发通道（git / webdav；旧快照缺省 undefined） */
  transport?: string;
}

/** GET /sync/history 响应：{ entries }。 */
export interface SyncHistoryResponse {
  entries: SyncHistoryEntry[];
}

/* ---------------------------------------------------------------- GitHub OAuth device flow */

/** POST /sync/github/start 响应：UI 展示用（device_code 只存宿主，绝不回传） */
export interface GithubDeviceFlowStartResponse {
  /** 随机 flowId：后续 poll/cancel 凭它引用宿主侧登记的 device_code */
  flowId: string;
  /** 一次性用户码（用户在 GitHub 授权页输入） */
  userCode: string;
  /** GitHub 授权页 URL（用户浏览器打开） */
  verificationUri: string;
  /** 设备码过期秒数 */
  expiresIn: number;
  /** GitHub 建议轮询间隔秒数 */
  interval: number;
}

/** POST /sync/github/poll 响应状态 */
export type GithubPollStatus = 'pending' | 'success' | 'denied' | 'expired' | 'error';

/** POST /sync/github/poll 响应：成功时 token 已由 Host 写入 DSH credentials（值永不回传） */
export interface GithubPollResponse {
  status: GithubPollStatus;
  /** pending：下次轮询前应等待的毫秒数 */
  pollDelayMs?: number;
  /** 终止态错误码（GitHub error code） */
  errorCode?: string;
  /** 终止态可展示消息（来自 GitHub error_description / 宿主文案，不含秘密） */
  message?: string;
  /** success 时恒 true（凭据已配置）；便于 UI 直接刷新状态 */
  credentialConfigured?: boolean;
}

/** POST /sync/github/validate 响应：token 是否已配置 + 是否有效（GET /user；
 *  401 → 无效）。只回布尔 + 登录名（非敏感），token 值永不回传浏览器。 */
export interface GithubValidateResponse {
  ok: boolean;
  /** token 是否存在于 DSH credentials */
  configured: boolean;
  /** token 是否有效（GitHub GET /user 成功；configured=false 时恒 false） */
  valid: boolean;
  /** GitHub 登录名（valid=true 时；非敏感展示位） */
  login?: string;
}

/** 同步请求超时（ms）：与 Host 半 ROUTE_TIMEOUT_MS 对齐（git 网络操作可能较慢） */
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/** 解析 JSON 响应；非 2xx 时抛出带路由 error 消息的 ConfigManagerApiError（与 api.ts 同款） */
async function readJson<T>(response: Response, t: UiT): Promise<T> {
  const notMountedMessage = t('error.notMounted');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) throw new ConfigManagerApiError(notMountedMessage);
    throw new ConfigManagerApiError(t('error.httpInvalidJson', { status: String(response.status) }));
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : response.status === 404
          ? notMountedMessage
          : `HTTP ${response.status}`;
    throw new ConfigManagerApiError(message);
  }
  return body as T;
}

/** POST JSON 请求（带超时：宿主卡死时 UI 拿到明确错误而不是永远转圈） */
async function postJson<T>(path: string, body: unknown, t: UiT): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await readJson<T>(response, t);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ConfigManagerApiError(
        t('error.syncTimeout', { minutes: String(Math.round(SYNC_TIMEOUT_MS / 60000)) }),
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 远程同步浏览器半数据入口（备份与迁移页第 4 个 tab 的注入业务面） */
export class SyncApi {
  readonly t: UiT
  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  /** 读取同步状态（配置 / 凭据 / 上次同步时间 / 分区数） */
  async status(): Promise<SyncStatusResponse> {
    const response = await fetch(SYNC_API.status);
    return readJson<SyncStatusResponse>(response, this.t);
  }

  /** 推送：导出勾选分区 → 提交到私有 Git 仓库 → 更新 sync-state */
  async push(payload: SyncPushPayload): Promise<SyncPushReport> {
    return postJson<SyncPushReport>(SYNC_API.push, payload, this.t);
  }

  /** 拉取：远端快照直接覆盖本地（应用前落回滚快照，失败整体回滚）。 */
  async pull(payload: SyncPushPayload): Promise<SyncPullApplyReport> {
    return postJson<SyncPullApplyReport>(SYNC_API.pull, payload, this.t);
  }

  /** GitHub OAuth device flow：发起登录，返回一次性用户码 + 授权页 URL + flowId */
  async githubStart(): Promise<GithubDeviceFlowStartResponse> {
    return postJson<GithubDeviceFlowStartResponse>(SYNC_API.githubStart, {}, this.t);
  }

  /** GitHub OAuth device flow：凭 flowId 轮询授权结果（成功时 token 已由 Host 写入 credentials） */
  async githubPoll(flowId: string): Promise<GithubPollResponse> {
    return postJson<GithubPollResponse>(SYNC_API.githubPoll, { flowId }, this.t);
  }

  /** GitHub OAuth device flow：取消（丢弃宿主侧登记，零副作用） */
  async githubCancel(flowId: string): Promise<{ ok: boolean }> {
    return postJson<{ ok: boolean }>(SYNC_API.githubCancel, { flowId }, this.t);
  }

  /** GitHub token 有效性校验（判定「是否已登录」：token 存在且 GitHub API 接受；
   *  401 → valid:false 引导重新登录；非 401 错误向上抛，UI 兜底不误判登出） */
  async githubValidate(): Promise<GithubValidateResponse> {
    return postJson<GithubValidateResponse>(SYNC_API.githubValidate, {}, this.t);
  }

  /** 显式回收 stale 残留环境锁（POST /sync/lock/recover，无请求体）。
   *  回收的是「挡住 acquire 的那把锁」，故 Host 侧刻意不经 mutation gate；活锁一律拒绝。
   *  调用方必须处理 ok=false（拒绝是正常结果），并在成功后重拉 status 刷新锁摘要。 */
  async recoverStaleLock(): Promise<RecoveryLockRecoverResult> {
    return postJson<RecoveryLockRecoverResult>(SYNC_API.lockRecover, {}, this.t);
  }

  /** issue #32：放弃未解决 incident（quarantine）并解除 SAFE MODE 阻断。
   *  Host 侧无 trusted snapshot 的 incident 只能走这条；成功后 SAFE MODE 自动解除。 */
  async dismissRecovery(operationId: string): Promise<RecoveryDismissResult> {
    return postJson<RecoveryDismissResult>(SYNC_API.recoveryDismiss, { operationId }, this.t);
  }

  /** 同步历史：列出本地祖先快照（按 createdAt 倒序）。 */
  async history(): Promise<SyncHistoryResponse> {
    const response = await fetch(SYNC_API.history);
    return readJson<SyncHistoryResponse>(response, this.t);
  }

  /** 保存同步通道配置（POST /sync/config）：url/username/password（git: repoUrl/token）持久化。
   *  password/token 经 Host 写入 DSH credentials（值永不回传）；返回凭据布尔供 UI 刷新徽章。 */
  async saveConfig(payload: SyncPushPayload): Promise<SyncConfigSaveResponse> {
    return postJson<SyncConfigSaveResponse>(SYNC_API.config, payload, this.t);
  }

  /** 保存插件 UI 偏好（POST /sync/ui-prefs）：当前为上次选择的同步通道（ui-prefs.json，
   *  随 self 分区进导出备份）。纯偏好无 secret；失败由调用方静默降级（localStorage 兜底）。 */
  async saveUiPrefs(payload: { lastSyncChannel?: 'git' | 'webdav' }): Promise<{ ok: boolean; lastSyncChannel?: 'git' | 'webdav' }> {
    return postJson<{ ok: boolean; lastSyncChannel?: 'git' | 'webdav' }>(SYNC_API.uiPrefs, payload, this.t);
  }

  /** 一键回滚：按 restoreId 调用 backup→rollback */
  async rollback(payload: { restoreId: string }): Promise<{ ok: boolean; full: boolean }> {
    return postJson<{ ok: boolean; full: boolean }>(SYNC_API.rollback, payload, this.t);
  }

}

/**
 * 远程同步区块的纯渲染模型（m-sync-ui）。
 *
 * 与 src/ui/progress.ts → progress-view.ts 同模式：把「报告怎么渲染 / 按钮什么状态 /
 * 状态行写什么 / 私有仓库提示怎么展示」做成无副作用纯函数，node --test 直接测，
 * React 组件只做装配。文案直接用中文（项目源语言），组件不重复造。
 */
import type { GithubPollResponse, SyncStatusResponse } from './sync-api.ts';
import type { RecoveryIncident, RecoveryLockStatus } from '../../ui/types.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/* ---------------------------------------------------------------- 残留环境锁入口 */

/** 残留锁面板的渲染模型（issue #27/#31：GUI 显式回收入口）。 */
export interface LockPanelModel {
  /** 是否渲染整块（无锁/旧宿主不返回 lock → false，不误报） */
  visible: boolean
  /** 是否需用户显式处理（残留锁/无法判定）——决定用警示语气还是中性陈述 */
  attention: boolean
  /** 状态徽章文案（分类映射；未知 state 兜底） */
  badgeLabel: string
  badgeKind: 'ok' | 'info' | 'warn' | 'error'
  /** 说明文案（attention 时给出「重试/重启无效」的完整指引） */
  detail: string
  /** 按钮文案（回收中切换为进行中文案） */
  label: string
  /** 按钮是否可点（仅残留/无法判定可点；活锁会自行释放，回收必被拒绝） */
  canRecover: boolean
}

/** LockState → 徽章文案/语气（未知 state 兜底为「锁不可用」，绝不抛错）。 */
function lockBadge(state: string, t: UiT): { label: string; kind: LockPanelModel['badgeKind'] } {
  switch (state) {
    case 'STALE_LOCK_DETECTED': return { label: t('sync.lock.state.stale'), kind: 'warn' }
    case 'UNKNOWN_STATE': return { label: t('sync.lock.state.unknown'), kind: 'warn' }
    default: return { label: t('sync.lock.state.error'), kind: 'info' }
  }
}

/**
 * 残留锁面板模型。**可见与可点判据都恒为 attention**：与 Host 的 lockState() 投影同一套
 * 规则（STALE_LOCK_DETECTED / UNKNOWN_STATE），避免 UI 自造第二套判据。
 *
 * 为什么**不能**按 state 判断可见性：Host 的 LockState 里根本没有「空闲」取值——所有权文件
 * 不存在时 inspectLockState() 返回的是 LOCKED（"可能正被创建中"，见 env-lock.ts:818-821）。
 * 于是「空闲」与「另一任务正在运行」在 state 上不可区分，按 state 渲染会让空闲态常驻一条
 * 「另一任务持有」的假告警。attention 才是 Host 给出的唯一可操作信号。
 *
 * 是否真的能回收仍由 Host 的 recoverStaleLock 内部重做判定，UI 不预判。
 */
export function lockPanelModel(
  lock: RecoveryLockStatus | undefined,
  recovering: boolean,
  t: UiT = zhUiT,
): LockPanelModel {
  const badge = lockBadge(lock?.state ?? '', t)
  const attention = lock?.attention === true
  return {
    visible: attention,
    attention,
    badgeLabel: badge.label,
    badgeKind: badge.kind,
    detail: t('sync.lock.attention'),
    label: recovering ? t('sync.lock.recovering') : t('sync.lock.recover'),
    canRecover: attention && !recovering,
  }
}

/* ---------------------------------------------------------------- 私有仓库提示 */

/**
 * 私有仓库强制提示文案（Settings 区块常驻警示横幅）。
 * 安全约束：同步内容为可移植配置，public 仓库会公开配置 → 必须私有；
 * token 仅用于认证，绝不写入同步文件/提交内容/日志。
 */
export function privateRepoHint(t: UiT = zhUiT): string {
  return t('sync.privateRepoHint');
}

/* ---------------------------------------------------------------- 按钮状态 */

/** 远程同步通道类型：git（默认）或 webdav */
export type SyncChannel = 'git' | 'webdav';

/* ---------------------------------------------------------------- 每通道独立状态 */

/** 通道子 tab 的渲染模型（active/disabled 由组件据此装配 modeTabs）。 */
export interface ChannelTabModel {
  channel: SyncChannel
  active: boolean
  disabled: boolean
}

/** 通道子 tab 列表：git/webdav 两个 tab；busy 时全部禁用（防并发操作切换）。 */
export function channelTabModels(active: SyncChannel, busy: boolean): ChannelTabModel[] {
  return (['git', 'webdav'] as const).map((channel) => ({
    channel,
    active: channel === active,
    disabled: busy,
  }))
}

/* ---------------------------------------------------------------- 通道选择持久化 */

/** 记住用户最近选择的通道（localStorage key；跨会话保持在用户上次所在栏）。
 *  m-self：磁盘持久化（ui-prefs.json）为权威来源（Host 可读、随 self 分区进备份），
 *  localStorage 仅保留为 status 响应未带回填时的同步降级通道（升级前遗留数据兼容）。 */
export const SYNC_CHANNEL_STORAGE_KEY = 'dsh.configManager.syncChannel';

/** 从 localStorage 读用户记住的通道；无/非法 → null（缺省 git，交由配置回填）。
 *  浏览器环境走 globalThis.localStorage；node 测试注入 mock storage 或返回 null。 */
export function readStoredChannel(storage?: Pick<Storage, 'getItem'> | null): SyncChannel | null {
  const s = storage ?? browserStorage();
  if (s === null) return null;
  try {
    const v = s.getItem(SYNC_CHANNEL_STORAGE_KEY);
    return v === 'webdav' || v === 'git' ? v : null;
  } catch {
    return null; // localStorage 不可用（隐私模式等）静默降级
  }
}

/** 把用户选择的通道写入 localStorage（记住，跨进入保持）。 */
export function writeStoredChannel(channel: SyncChannel, storage?: Pick<Storage, 'setItem'> | null): void {
  const s = storage ?? browserStorage();
  if (s === null) return;
  try {
    s.setItem(SYNC_CHANNEL_STORAGE_KEY, channel);
  } catch {
    // 静默；记住失败不阻断功能
  }
}

/** 浏览器 localStorage；非浏览器（node 测试）→ null */
function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  const g = globalThis as { localStorage?: Storage } | undefined;
  return g?.localStorage ?? null;
}

/* ---------------------------------------------------------------- WebDAV 预设 */

/** 常见 WebDAV 服务器预设：label 展示名 + url 模板（含 <占位> 待用户替换）。 */
export interface WebDavPreset {
  id: string;
  label: string;
  /** url 模板；可能含 <server>/<user> 占位符，用户需替换为真实地址 */
  url: string;
  /** 是否需要用户替换占位符 */
  hasPlaceholder: boolean;
}

/** 内置常见 WebDAV 服务器（预设下拉数据源；第一项为自定义）。 */
export const WEBDAV_PRESETS: readonly WebDavPreset[] = [
  { id: 'custom', label: 'Custom URL', url: '', hasPlaceholder: false },
  { id: 'jianguoyun', label: '坚果云 (Jianguoyun)', url: 'https://dav.jianguoyun.com/dav/', hasPlaceholder: false },
  { id: 'nextcloud', label: 'Nextcloud', url: 'https://<server>/remote.php/dav/files/<user>/', hasPlaceholder: true },
  { id: 'owncloud', label: 'ownCloud', url: 'https://<server>/remote.php/dav/files/<user>/', hasPlaceholder: true },
  { id: 'seafile', label: 'Seafile', url: 'https://<server>/seafdav/', hasPlaceholder: true },
  { id: 'synology', label: 'Synology NAS (WebDAV)', url: 'https://<nas-ip>:5006/', hasPlaceholder: true },
  { id: 'box', label: 'Box', url: 'https://dav.box.com/dav/', hasPlaceholder: false },
];

/** 默认预设（自定义）对应的 id。 */
export const WEBDAV_CUSTOM_PRESET_ID = 'custom';

/** 根据预设 id 取 preset；未知 id → 自定义（缺省）。 */
export function presetById(id: string): WebDavPreset {
  return WEBDAV_PRESETS.find((p) => p.id === id) ?? WEBDAV_PRESETS[0]!;
}

/** 从已填 url 反推最接近的预设 id（用于下拉回显；无匹配 → 自定义）。 */
export function presetIdForUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return WEBDAV_CUSTOM_PRESET_ID;
  for (const p of WEBDAV_PRESETS) {
    if (!p.hasPlaceholder && p.url !== '' && trimmed.toLowerCase().startsWith(p.url.toLowerCase())) {
      return p.id;
    }
  }
  return WEBDAV_CUSTOM_PRESET_ID;
}

export interface SyncButtons {
  canPush: boolean;
  canPull: boolean;
  pushLabel: string;
  pullLabel: string;
}

/** 活动通道的远端地址是否就绪（git=repoUrl，webdav=webdavUrl）。 */
export function computeRemoteReady(channel: SyncChannel, gitUrl: string, webdavUrl: string): boolean {
  const url = channel === 'webdav' ? webdavUrl : gitUrl;
  return url.trim() !== '';
}

/**
 * 按钮可用性与文案：
 * - 任一操作进行中（busy）→ 两个按钮都禁用（防并发 push/pull）；
 * - 活动通道远端地址未就绪（remoteReady=false）→ 禁用（无从同步）；
 * - busy 时按钮文案切换为「正在推送/拉取…」（配 Spinner）。
 */
export function computeSyncButtons(busy: 'push' | 'pull' | 'rollback' | null, remoteReady: boolean, t: UiT = zhUiT): SyncButtons {
  const idle = busy === null;
  const enabled = idle && remoteReady;
  return {
    canPush: enabled,
    canPull: enabled,
    pushLabel: busy === 'push' ? t('sync.pushing') : t('sync.pushLabel'),
    pullLabel: busy === 'pull' ? t('sync.pulling') : t('sync.pullLabel'),
  };
}

/* ---------------------------------------------------------------- 状态行 */

export type SyncStatusKind = 'loading' | 'unconfigured' | 'ready' | 'error';

export interface SyncStatusSummary {
  kind: SyncStatusKind;
  text: string;
}

/** 状态行渲染模型：加载 / 未配置 / 就绪（凭据 + 上次同步 + 通道）/ 错误 */
export function computeSyncStatus(
  statusInfo: SyncStatusResponse | null,
  loading: boolean,
  error: string | null,
  t: UiT = zhUiT,
): SyncStatusSummary {
  if (loading) return { kind: 'loading', text: t('sync.statusLoading') };
  if (error !== null) return { kind: 'error', text: error };
  if (statusInfo === null || !statusInfo.configured) {
    return { kind: 'unconfigured', text: t('sync.statusUnconfigured') };
  }
  const isWebdav = statusInfo.transport?.type === 'webdav';
  const credOk = isWebdav
    ? (statusInfo.webdav?.passwordConfigured ?? false)
    : statusInfo.credentialConfigured;
  const cred = credOk
    ? t('sync.credConfigured')
    : t('sync.credMissing');
  const last =
    statusInfo.lastSyncAt !== undefined && statusInfo.lastSyncAt !== ''
      ? t('sync.lastSync', { time: formatDateTime(statusInfo.lastSyncAt) })
      : t('sync.neverSynced');
  const transport =
    statusInfo.transport !== undefined
      ? ` · ${statusInfo.transport.type}${statusInfo.transport.ref !== '' ? `/${statusInfo.transport.ref}` : ''}`
      : '';
  return { kind: 'ready', text: `${cred} · ${last}${transport}` };
}

/** ISO-8601 → 本地可读时间（YYYY-MM-DD HH:mm；非法输入原样返回） */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 上次同步时间的展示文本（'' / undefined = 从未同步） */
export function formatLastSync(iso: string | undefined, t: UiT = zhUiT): string {
  if (iso === undefined || iso === '') return t('sync.neverSyncedShort');
  return formatDateTime(iso);
}

/* ---------------------------------------------------------------- GitHub 登录视图模型 */

export type GithubLoginPhase = 'idle' | 'starting' | 'waiting' | 'polling' | 'success' | 'error';

export interface GithubLoginView {
  phase: GithubLoginPhase;
  /** 一次性用户码（waiting/polling 展示，用户到 GitHub 授权页输入） */
  userCode: string;
  /** GitHub 授权页 URL */
  verificationUri: string;
  /** 状态行文案（中文，项目源语言；与 computeSyncStatus 同策略，不依赖 locale 注入） */
  statusText: string;
  /** 主按钮文案：发起 / 重新登录 */
  startLabel: string;
  /** 是否可发起/重试登录 */
  canStart: boolean;
  /** 流程进行中是否展示「取消」按钮 */
  canCancel: boolean;
  /** 是否展示设备码 + 授权链接区块 */
  showCode: boolean;
  /** 错误消息（phase=error；来自轮询终止态或请求失败） */
  error: string | null;
}

/**
 * GitHub 登录区块渲染模型（纯函数，node 可测）：
 * - idle → 可发起；starting → 请求设备码中；waiting → 展示设备码等待用户在浏览器授权；
 * - polling → 轮询 GitHub 中（仍展示代码区块）；success → 完成；error → 可重试。
 */
export function computeGithubLoginView(
  phase: GithubLoginPhase,
  userCode: string,
  verificationUri: string,
  error: string | null,
  t: UiT = zhUiT,
): GithubLoginView {
  const inFlight = phase === 'starting' || phase === 'waiting' || phase === 'polling';
  let statusText: string;
  switch (phase) {
    case 'starting':
      statusText = t('sync.github.starting');
      break;
    case 'waiting':
      statusText = userCode === ''
        ? t('sync.github.waitingNoCode')
        : t('sync.github.waiting', { code: userCode });
      break;
    case 'polling':
      statusText = t('sync.github.polling');
      break;
    case 'success':
      statusText = t('sync.github.success');
      break;
    case 'error':
      statusText = error ?? t('sync.github.failed');
      break;
    default:
      statusText = t('sync.github.defaultStatus');
  }
  return {
    phase,
    userCode,
    verificationUri,
    statusText,
    startLabel: phase === 'error' ? t('sync.github.relogin') : t('sync.github.login'),
    canStart: phase === 'idle' || phase === 'error',
    canCancel: inFlight,
    showCode: phase === 'waiting' || phase === 'polling',
    error,
  };
}

/** 轮询终止态 → 用户可读消息（pending 不是终止态，返回空串；成功/拒绝/过期/错误给出明确文案） */
export function githubPollMessage(poll: GithubPollResponse, t: UiT = zhUiT): string {
  switch (poll.status) {
    case 'success':
      return t('sync.github.pollSuccess');
    case 'denied':
      return t('sync.github.pollDenied');
    case 'expired':
      return t('sync.github.pollExpired');
    case 'error':
      return t('sync.github.pollError', { detail: poll.message ?? poll.errorCode ?? t('sync.github.unknownError') });
    default:
      return '';
  }
}

/* ---------------------------------------------------------------- SAFE MODE 恢复入口 */

/** 单条未解决 incident 的渲染行（按钮文案随进行中状态切换）。 */
export interface RecoveryIncidentRow {
  operationId: string
  /** 人类可读的操作名（如「同步推送」） */
  operationLabel: string
  badgeLabel: string
  badgeKind: 'warn' | 'error'
  /** Host 已脱敏的原因文本 */
  reason: string
  createdAt: string
  label: string
  canDismiss: boolean
}

/** SAFE MODE 恢复面板模型（issue #32）。 */
export interface RecoveryPanelModel {
  /** 是否渲染整块（无 incident / 旧宿主不返回 recovery → false，不误报） */
  visible: boolean
  title: string
  detail: string
  items: RecoveryIncidentRow[]
}

/** operationType → 人类可读名（未知类型兜底为通用名，绝不抛错）。 */
function recoveryOpLabel(operationType: string, t: UiT): string {
  switch (operationType) {
    case 'sync-push': return t('sync.recovery.op.syncPush')
    case 'sync-pull': return t('sync.recovery.op.syncPull')
    default: return t('sync.recovery.op.other')
  }
}

/**
 * SAFE MODE 恢复面板模型。**可见性恒为「有未解决 incident」**——这是 Host 侧 423
 * （LOCK_BLOCK_BRIEF.blocked）的真实成因，UI 不自造第二套判据。
 *
 * 为什么必须有这个入口：`blocked` 闸门拦下所有 mutation，而恢复路由曾被整体删除，
 * 于是无 trusted snapshot 的 incident 只剩「放弃恢复」一条路，且当时连这条路也没有
 * 入口 → SAFE MODE 无出口、永久 423（已发生故障）。
 */
export function recoveryPanelModel(
  incidents: readonly RecoveryIncident[] | undefined,
  dismissing: string | null,
  t: UiT = zhUiT,
): RecoveryPanelModel {
  const list = incidents ?? []
  return {
    visible: list.length > 0,
    title: t('sync.recovery.title'),
    detail: t('sync.recovery.attention'),
    items: list.map((i) => ({
      operationId: i.operationId,
      operationLabel: recoveryOpLabel(i.operationType, t),
      badgeLabel: i.decision === 'needs-attention' ? t('sync.recovery.badge.needsAttention') : t('sync.recovery.badge.recovering'),
      badgeKind: i.decision === 'needs-attention' ? 'error' : 'warn',
      reason: i.reason,
      createdAt: i.createdAt,
      label: dismissing === i.operationId ? t('sync.recovery.dismissing') : t('sync.recovery.dismiss'),
      canDismiss: dismissing === null,
    })),
  }
}
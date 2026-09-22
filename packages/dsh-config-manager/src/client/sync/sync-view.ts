/**
 * 远程同步区块的纯渲染模型（m-sync-ui）。
 *
 * 与 src/ui/progress.ts → progress-view.ts 同模式：把「报告怎么渲染 / 按钮什么状态 /
 * 状态行写什么 / 私有仓库提示怎么展示」做成无副作用纯函数，node --test 直接测，
 * React 组件只做装配。文案直接用中文（项目源语言），组件不重复造。
 */
import type { PlanItem, PlanItemKind } from '../../core/types.ts';
import type { SectionId } from '../../schema/types.ts';
import type { PullChange, SyncPullApplyReport, SyncPushReport } from '../../sync/sync-engine.ts';
import { DEFAULT_CATEGORIES } from '../../ui/export-flow.ts';
import { EXPORT_GROUPS, type ExportGroup } from '../../ui/types.ts';
import type { GithubPollResponse, SyncSectionInfo, SyncStatusResponse } from './sync-api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/* ---------------------------------------------------------------- 私有仓库提示 */

/**
 * 私有仓库强制提示文案（Settings 区块常驻警示横幅）。
 * 安全约束：同步内容为可移植配置，public 仓库会公开配置 → 必须私有；
 * token 仅用于认证，绝不写入同步文件/提交内容/日志。
 */
export function privateRepoHint(t: UiT = zhUiT): string {
  return t('sync.privateRepoHint');
}

/* ---------------------------------------------------------------- 同步分区模式 */

/** 远程同步模式：默认（快速导出） / 高级（自定义导出）。 */
export type SyncMode = 'default' | 'advanced';

/** 可同步分区选项（status.syncSections 投影 + 导出目录补充分组/描述；高级模式勾选目录单选项）。 */
export interface SyncSectionOption {
  id: SectionId;
  label: string;
  /** 一句话描述（来自导出目录；未知 id 为空串） */
  description: string;
  /** 所属导出分组（General / AI / Extensions / …；未知 id 兜底 'general'） */
  group: ExportGroup;
  /** 是否为推荐分区（defaultIncluded=true；默认模式全选、高级模式初始勾选） */
  defaultIncluded: boolean;
}

/** host 目录（SyncSectionInfo[]）→ UI 勾选项（保留 id 顺序）。
 *  同步分区必为导出目录（DEFAULT_CATEGORIES）的可移植子集：分组/描述从导出目录
 *  补充（单一事实源，与「导出备份·自定义模式」的目录保持一致），未命中 id 兜底。 */
export function syncSectionOptions(info: readonly SyncSectionInfo[]): SyncSectionOption[] {
  const meta = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
  return info.map((s) => {
    const cat = meta.get(s.id);
    return {
      id: s.id,
      label: s.displayName,
      description: cat?.description ?? '',
      group: cat?.group ?? 'general',
      defaultIncluded: s.defaultIncluded,
    };
  });
}

/** 高级模式勾选目录 → 按导出分组（EXPORT_GROUPS）投影：与「导出备份·自定义模式」同构，
 *  空分组省略；UI 直接渲染 groupCard。 */
export function syncSectionGroups(options: readonly SyncSectionOption[]): {
  group: ExportGroup;
  label: string;
  note?: string;
  items: SyncSectionOption[];
}[] {
  return EXPORT_GROUPS
    .map((g) => ({
      group: g.id,
      label: g.label,
      ...(g.note !== undefined ? { note: g.note } : {}),
      items: options.filter((o) => o.group === g.id),
    }))
    .filter((g) => g.items.length > 0);
}

/** 默认模式的推荐同步分区：默认包含的分区。 */
export function recommendedSyncSections(info: readonly SyncSectionInfo[]): SectionId[] {
  return info.filter((s) => s.defaultIncluded).map((s) => s.id);
}

/* ---------------------------------------------------------------- 变更摘要 */

/** 需要人工决策的 PlanItem 类型（与 SyncEngine.pull 的 needsReview 判定一致）。
 * 注意：'Install' 不在此列 —— 插件安装随同步自动采用（product requirement）。 */
const REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Error',
]);

export interface PullChangeSummary {
  total: number;
  info: number;
  warning: number;
  error: number;
  /** 是否包含需要人工决策的项（冲突/密钥/依赖/安装/错误） */
  needsReview: boolean;
  items: PullChange[];
}

/** 差异摘要：按 severity 计数 + 需人工决策标记（UI 统计徽章与警示横幅的数据源） */
export function summarizePullChanges(changes: readonly PullChange[]): PullChangeSummary {
  let info = 0;
  let warning = 0;
  let error = 0;
  let needsReview = false;
  for (const c of changes) {
    if (c.severity === 'error') error += 1;
    else if (c.severity === 'warning') warning += 1;
    else info += 1;
    if (REVIEW_KINDS.has(c.kind)) needsReview = true;
  }
  return { total: changes.length, info, warning, error, needsReview, items: [...changes] };
}

/** PlanItemKind → 短标签（列表徽章） */
export function kindLabel(kind: PlanItemKind, t: UiT = zhUiT): string {
  switch (kind) {
    case 'Create': return t('sync.kind.create');
    case 'Update': return t('sync.kind.update');
    case 'Skip': return t('sync.kind.skip');
    case 'Conflict': return t('sync.kind.conflict');
    case 'Install': return t('sync.kind.install');
    case 'MissingSecret': return t('sync.kind.missingSecret');
    case 'MissingDependency': return t('sync.kind.missingDependency');
    case 'PathMapping': return t('sync.kind.pathMapping');
    case 'Warning': return t('sync.kind.warning');
    case 'Error': return t('sync.kind.error');
    default: return kind;
  }
}

/** severity → 短标签 */
export function severityLabel(severity: PlanItem['severity'], t: UiT = zhUiT): string {
  switch (severity) {
    case 'error': return t('sync.severity.error');
    case 'warning': return t('sync.severity.warning');
    default: return t('sync.severity.info');
  }
}

/* ---------------------------------------------------------------- 按钮状态 */

/** 远程同步通道类型：git（默认）或 webdav */
export type SyncChannel = 'git' | 'webdav';

/* ---------------------------------------------------------------- 每通道独立状态 */

/**
 * 每个同步通道（git/webdav）各自独立的设置状态：
 * 同步模式（默认/高级 + 分区勾选）两通道互不共享。
 */
export interface ChannelSyncState {
  /** 同步模式：默认（快速导出推荐分区） / 高级（自定义勾选分区） */
  syncMode: SyncMode
  /** 高级模式勾选的同步分区（初始 = 推荐分区；空 = 未勾选任何分区） */
  syncSections: SectionId[]
}

/** 缺省每通道状态（未配置时各字段默认值）。 */
export function defaultChannelSyncState(): ChannelSyncState {
  return {
    syncMode: 'default',
    syncSections: [],
  }
}

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

/* ---------------------------------------------------------------- 报告渲染模型 */

export interface PushReportView {
  kind: 'ok' | 'error';
  headline: string;
  sections: string[];
  warnings: string[];
}

/** push 报告 → 渲染模型（ok 头部带快照 id；失败显示引擎 message；分区与告警透传） */
export function pushReportView(report: SyncPushReport | null, t: UiT = zhUiT): PushReportView | null {
  if (report === null) return null;
  if (!report.ok) {
    return { kind: 'error', headline: report.message ?? t('sync.pushFailed'), sections: report.sections, warnings: report.warnings };
  }
  return {
    kind: 'ok',
    headline: t('sync.pushOk', { id: report.snapshotId }),
    sections: report.sections,
    warnings: report.warnings,
  };
}

export interface PullReportView {
  kind: 'ok' | 'empty' | 'error';
  headline: string;
  /** 本次实际写入本地的分区（ok 时非空） */
  applied: string[];
  /** 远端快照相对本地的变更摘要（应用前计算；仅展示） */
  summary: PullChangeSummary | null;
  /** 失败时是否已整体回滚 */
  rolledBack: boolean;
  /** 回滚入口提示（restoreId 非空时展示） */
  restoreHint: string;
}

/** 拉取结果 → 渲染模型（直接覆盖本地：applied = 写入了什么；失败显示是否已回滚） */
export function pullApplyReportView(report: SyncPullApplyReport | null, t: UiT = zhUiT): PullReportView | null {
  if (report === null) return null;
  if (!report.ok) {
    return {
      kind: 'error',
      headline: report.message ?? t('sync.pullFailed'),
      applied: [],
      summary: report.changes.length > 0 ? summarizePullChanges(report.changes) : null,
      rolledBack: report.rolledBack,
      restoreHint: '',
    };
  }
  if (report.applied.length === 0) {
    return {
      kind: 'empty',
      headline: report.message ?? t('sync.pullEmpty'),
      applied: [],
      summary: report.changes.length > 0 ? summarizePullChanges(report.changes) : null,
      rolledBack: false,
      restoreHint: '',
    };
  }
  return {
    kind: 'ok',
    headline: t('sync.pullOk', { id: report.snapshotId, count: String(report.applied.length) }),
    applied: report.applied,
    summary: summarizePullChanges(report.changes),
    rolledBack: false,
    restoreHint: report.restoreId !== '' ? t('sync.pullRestoreHint') : '',
  };
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
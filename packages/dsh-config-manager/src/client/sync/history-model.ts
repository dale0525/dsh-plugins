/**
 * m-sync-ui (P2b)：SyncHistoryView 的纯函数投影。
 *
 * /sync/history 返回 { entries: SyncHistoryEntry[] }（快照 kind=apply/push/pull/rollback）；
 * 投影做倒序排序 + ISO 格式化。
 */
import type { SyncHistoryEntry } from './sync-api.ts';

/** 兼容旧快照条目（manifest.json 投影）。 */
export interface SnapshotHistoryEntry {
  id: string;
  createdAt: string;
  /** 分区数（manifest.sectionHashes 的 key 数） */
  sectionCount: number;
  /** 关联到该快照的待审项数（待审队列已随合并逻辑删除，当前恒为 0；保留字段兼容契约） */
  reviewCount: number;
}

/** 把快照 entries 排序（createdAt 倒序）并组装展示字段。 */
export function projectHistoryRows(entries: readonly SnapshotHistoryEntry[]): SnapshotHistoryEntry[] {
  return [...entries].sort(byCreatedAtDesc);
}

/** 历史条目按 createdAt 倒序排序。 */
export function projectSyncHistoryEntries(entries: readonly SyncHistoryEntry[]): SyncHistoryEntry[] {
  return [...entries].sort(byCreatedAtDesc);
}

function byCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/** ISO 时间 → 本地可读字符串（短格式） */
export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * ISO 时间 → 完整本地时间字符串（含秒，用于 td 的 title 悬停提示）。
 * 非法/空输入回退 ''（不渲染 title，避免出现无意义的提示）。
 */
export function formatDateTimeFull(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

/* ---------------------------------------------------------------- 展示辅助（UI 重构新增） */
/**
 * 中段省略：保留头尾，中段以 … 替代（尾部才是区分信息，不可被截掉）。
 * 与备份页表格的同名私有函数语义一致；此处导出以便本模块复用 + 单测覆盖
 * （不在组件间跨文件 import 私有函数）。
 */
export function midEllipsis(s: string, max = 26): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** 同步历史统计摘要（列表头部徽章行）。 */
export interface SyncHistorySummary {
  total: number;
  /** 快照类条目数（apply / push / pull / rollback） */
  snapshots: number;
}

/** 统计同步历史条目。基于 projectSyncHistoryEntries 的投影结果（本函数不排序）。 */
export function summarizeSyncHistory(rows: readonly SyncHistoryEntry[]): SyncHistorySummary {
  let snapshots = 0;
  for (const r of rows) {
    if (r.kind === 'apply' || r.kind === 'push' || r.kind === 'pull' || r.kind === 'rollback') snapshots += 1;
  }
  return { total: rows.length, snapshots };
}

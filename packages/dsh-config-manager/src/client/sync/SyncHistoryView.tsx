/**
 * 同步历史视图：列出本地祖先快照目录（kind=apply）。
 *
 * 数据获取：GET /sync/history → { entries: SyncHistoryEntry[] }（按 createdAt 倒序）。
 * 纯函数投影在 ./history-model.ts（node --test 可测），本组件只做装配。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { Badge, Card, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import type { SyncApi, SyncHistoryEntry } from './sync-api.ts'
import {
  formatDateTime, formatDateTimeFull, midEllipsis,
  projectSyncHistoryEntries, summarizeSyncHistory,
} from './history-model.ts'
import type { SnapshotHistoryEntry } from './history-model.ts'
import type { TranslateNS } from '../client-types.ts'
import css from '../config-manager.module.css'

/** 通道徽章：git → GitHub，webdav → WebDAV；未知/缺失不渲染。 */
function ChannelBadge({ transport, t }: { transport?: string; t: TranslateNS<'config-manager-sync'> }): ReactNode {
  if (transport === 'git') return <Badge kind="info">{t('history.channelGit')}</Badge>
  if (transport === 'webdav') return <Badge kind="info">{t('history.channelWebdav')}</Badge>
  return null
}

export interface SyncHistoryViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
}

export function SyncHistoryView(props: SyncHistoryViewProps): ReactNode {
  const { api, t } = props;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<SyncHistoryEntry[]>([]);
  /** 重试计数（错误态点「重试」递增 → 重新加载） */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await api.history();
        if (!cancelled) {
          setEntries(data.entries);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, reloadKey]);

  const rows = useMemo(() => projectSyncHistoryEntries(entries), [entries]);
  const stats = useMemo(() => summarizeSyncHistory(rows), [rows]);
  // 快照类条目（兼容旧投影；仅统计展示）
  const snapshotRows = useMemo<SnapshotHistoryEntry[]>(
    () => rows
      .filter((r) => r.kind === 'apply' || r.kind === 'push' || r.kind === 'pull' || r.kind === 'rollback')
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        sectionCount: r.sectionCount ?? 0,
        reviewCount: r.reviewCount ?? 0,
      })),
    [rows],
  );

  if (loading) return <Spinner label={t('common.loading')} />;
  if (error) {
    return (
      <ErrorBanner
        error={error}
        onRetry={() => { setReloadKey((k) => k + 1) }}
        retrying={loading}
        t={api.t}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <strong>{t('history.empty')}</strong>
        <p>{t('history.emptyHint')}</p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle title={`${t('history.title')}（${rows.length}）`} />
      {/* F：头部统计摘要（先扫结论） */}
      <div className={css.statRow} aria-label={t('history.stats.summary')}>
        <Badge kind="info">{t('history.stats.total', { count: String(stats.total) })}</Badge>
        <Badge kind="info">{t('history.stats.snapshots', { count: String(stats.snapshots) })}</Badge>
      </div>
      {/* A：改用设计系统数据表（.tableWrap > .tableScroll 限高内滚 + .dataTable/.tableFixed/.tableCompact） */}
      <div className={css.tableWrap}>
        <div className={css.tableScroll}>
          <table className={`${css.dataTable} ${css.tableFixed} ${css.tableCompact}`}>
            <thead>
              <tr>
                {/* 时间列 116px（非 92px）：11px 等宽下 "YYYY-MM-DD HH:mm" 实测 96.8px，
                    加 .tableCompact 的左右各 8px padding 需 112.8px；92px 会把时间截成
                    「2026-09-01…」（浏览器实测截图确认），反而比改前更不可读。 */}
                <th style={{ width: 116 }}>{t('history.colTime')}</th>
                <th style={{ width: 96 }}>{t('history.colKind')}</th>
                <th>{t('history.colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const snap = snapshotRows.find((s) => s.id === r.id);
                return (
                  <tr key={r.id}>
                    {/* B：等宽 11px + 固定列宽 → 单行不换行；title 给完整本地时间（含秒） */}
                    <td className={css.dim} title={formatDateTimeFull(r.createdAt)}>
                      <span className={`${css.mono}`} style={{ fontSize: '11px' }}>{formatDateTime(r.createdAt)}</span>
                    </td>
                    <td><Badge kind="info">{t('history.kindSnapshot')}</Badge></td>
                    <td>
                      <div className={css.cellMain}>
                        {/* C：UUID 中段省略（保留头尾，尾部才是区分信息），title 保留全文 */}
                        <span className={`${css.cellTitle} ${css.mono}`} title={r.id}>{midEllipsis(r.id)}</span>
                        <span className={css.cellMeta}>
                          <ChannelBadge transport={r.transport} t={t} />
                          {snap !== undefined && <>{snap.sectionCount} {t('history.sectionCount')}</>}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
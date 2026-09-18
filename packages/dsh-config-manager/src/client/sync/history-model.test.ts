/**
 * m-sync-ui (方案 A)：同步历史投影（含自动同步记录）纯函数测试。
 * TDD：先写失败测试，再实现 history-model.ts 对应函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SyncHistoryEntry } from './sync-api.ts';
import {
  autosyncBadgeKind, autosyncStatusLabel, describeSkipReason, directionLabel, formatDateTime,
  formatDateTimeFull, midEllipsis, projectAutosyncEntry, projectSyncHistoryEntries, summarizeSyncHistory,
} from './history-model.ts';
import type { AutosyncHistoryEntry } from './sync-api.ts';

const autosyncEntry = (overrides: Partial<AutosyncHistoryEntry>): AutosyncHistoryEntry => ({
  direction: 'both',
  status: 'skipped',
  skipReason: 'conflict',
  conflictedSections: ['settings', 'plugins'],
  appliedSections: [],
  failureCountAtRun: 0,
  createdAt: '2026-08-17T10:00:00.000Z',
  ...overrides,
});

test('projectSyncHistoryEntries：快照 + 自动同步 按 createdAt 倒序合并', () => {
  const entries: SyncHistoryEntry[] = [
    { id: 'a', createdAt: '2026-08-17T10:00:00.000Z', kind: 'apply', sectionCount: 3, reviewCount: 0 },
    {
      id: 'b', createdAt: '2026-08-17T12:00:00.000Z', kind: 'autosync',
      autosync: autosyncEntry({ createdAt: '2026-08-17T12:00:00.000Z' }),
    },
    { id: 'c', createdAt: '2026-08-17T11:00:00.000Z', kind: 'apply', sectionCount: 2, reviewCount: 0 },
  ];
  const sorted = projectSyncHistoryEntries(entries);
  assert.equal(sorted[0]!.id, 'b');
  assert.equal(sorted[1]!.id, 'c');
  assert.equal(sorted[2]!.id, 'a');
});

test('directionLabel / autosyncStatusLabel：方向与状态映射', () => {
  assert.equal(directionLabel('pull'), '下载');
  assert.equal(directionLabel('push'), '上传');
  assert.equal(directionLabel('both'), '双向');
  assert.equal(autosyncStatusLabel('success'), '成功');
  assert.equal(autosyncStatusLabel('skipped'), '已跳过');
  assert.equal(autosyncStatusLabel('failed'), '失败');
  assert.equal(autosyncStatusLabel('partial'), '部分成功');
});

test('describeSkipReason：已知原因映射，未知回退原串', () => {
  assert.equal(describeSkipReason('conflict'), '冲突项被跳过');
  assert.equal(describeSkipReason('no-remote'), '远端无快照');
  assert.equal(describeSkipReason('not-configured'), '未配置仓库');
  assert.equal(describeSkipReason('network'), '网络问题');
  assert.equal(describeSkipReason('encrypted'), '远端快照已加密，自动同步跳过（请手动同步）');
  assert.equal(describeSkipReason('weird'), 'weird');
  assert.equal(describeSkipReason(undefined), '未知');
});

// issue #31：宿主统一以 'mutation-locked' 落历史（不细分 LOCKED/STALE）→ 界面不得透出裸 token。
test('describeSkipReason：mutation-locked 必须有可读中文且不再回退原串', () => {
  const text = describeSkipReason('mutation-locked');
  assert.notEqual(text, 'mutation-locked', '绝不透出裸机器 token');
  assert.match(text, /环境锁/);
  // 客户端拿不到细分 reason（活锁 vs 残留锁）→ 文案须同时覆盖两种可能并指向处理方向
  assert.match(text, /残留锁/);
  assert.match(text, /另一项任务/);
});

test('projectAutosyncEntry：摘要行 + 可展开明细（冲突分区 / 应用分区 / 错误）', () => {
  const row = projectAutosyncEntry(autosyncEntry({}));
  assert.equal(row.direction, '双向');
  assert.equal(row.status, '已跳过');
  assert.match(row.summary, /双向/);
  assert.match(row.summary, /已跳过/);
  assert.match(row.summary, /冲突项被跳过/);
  assert.deepEqual(row.conflictedSections, ['settings', 'plugins']);
  assert.equal(row.hasDetail, true);
});

test('projectAutosyncEntry：无冲突/无应用/无错误 → hasDetail=false', () => {
  const row = projectAutosyncEntry(autosyncEntry({
    conflictedSections: undefined, appliedSections: undefined, error: undefined,
  }));
  assert.equal(row.hasDetail, false);
});

test('formatDateTime：合法 ISO → 本地格式；空/非法回退', () => {
  assert.match(formatDateTime('2026-08-17T10:30:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatDateTime(''), '—');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
});

/* ---------------------------------------------------------------- UI 重构新增（需求 4） */

test('formatDateTimeFull：合法 ISO → 含秒的本地时间串；空/非法 → 空串（不渲染 title）', () => {
  const full = formatDateTimeFull('2026-08-17T10:30:45.000Z');
  assert.notEqual(full, '');
  // toLocaleString 含秒字段（本地化格式：年份与秒都存在）
  assert.match(full, /2026/);
  assert.equal(formatDateTimeFull(''), '');
  assert.equal(formatDateTimeFull('not-a-date'), '');
  // 与短格式语义一致：同一条记录两者都能解析出相同日期
  assert.match(formatDateTime('2026-08-17T10:30:45.000Z'), /^2026-08-17 \d{2}:30$/);
});

test('midEllipsis：短串原样返回（未超上限不截断）', () => {
  assert.equal(midEllipsis('short'), 'short');
  assert.equal(midEllipsis(''), '');
  // 恰好等于上限：不截断
  assert.equal(midEllipsis('a'.repeat(26)), 'a'.repeat(26));
});

test('midEllipsis：长串保留头尾且中段以 … 替代', () => {
  const uuid = 'sync-930ceecc-d5cd-4daa-9231-5b837149f527';
  const out = midEllipsis(uuid, 26);
  assert.ok(out.includes('…'), '应含中段省略号');
  assert.equal(out.length, 26, '长度应等于 max');
  // 尾部是唯一区分信息，必须保留
  assert.ok(uuid.endsWith(out.slice(out.indexOf('…') + 1)), '尾部应原样保留');
  assert.ok(uuid.startsWith(out.slice(0, out.indexOf('…'))), '头部应原样保留');
});

test('midEllipsis：长度上限正确（含省略号在内恰好 max 字符；默认上限 26）', () => {
  const long = 'x'.repeat(100);
  assert.equal(midEllipsis(long).length, 26);
  assert.equal(midEllipsis(long, 10).length, 10);
  assert.equal(midEllipsis(long, 40).length, 40);
  // 自定义 max 下头尾分配：head=ceil((max-1)/2)
  const s = '0123456789ABCDEFGHIJ';
  assert.equal(midEllipsis(s, 11), '01234…FGHIJ');
});

test('autosyncBadgeKind：四种状态 → 语义色全覆盖', () => {
  assert.equal(autosyncBadgeKind('success'), 'ok');
  assert.equal(autosyncBadgeKind('skipped'), 'warn');
  assert.equal(autosyncBadgeKind('failed'), 'error');
  assert.equal(autosyncBadgeKind('partial'), 'warn');
});

test('projectAutosyncEntry：badgeKind + skipReasonText（需求 D/E 的第二行小字）', () => {
  const row = projectAutosyncEntry(autosyncEntry({ status: 'skipped', skipReason: 'conflict' }));
  assert.equal(row.badgeKind, 'warn');
  assert.equal(row.skipReasonText, '冲突项被跳过');
  // 摘要串保留（兼容既有调用方/测试）
  assert.match(row.summary, /冲突项被跳过/);

  const noReason = projectAutosyncEntry(autosyncEntry({ status: 'success', skipReason: undefined }));
  assert.equal(noReason.badgeKind, 'ok');
  assert.equal(noReason.skipReasonText, undefined);

  assert.equal(projectAutosyncEntry(autosyncEntry({ status: 'failed' })).badgeKind, 'error');
  assert.equal(projectAutosyncEntry(autosyncEntry({ status: 'partial' })).badgeKind, 'warn');
});

test('summarizeSyncHistory：总数/快照数/自动同步数/失败数/跳过数', () => {
  const rows: SyncHistoryEntry[] = [
    { id: 'a', createdAt: '2026-08-17T10:00:00.000Z', kind: 'apply', sectionCount: 3, reviewCount: 0 },
    { id: 'b', createdAt: '2026-08-17T11:00:00.000Z', kind: 'push', sectionCount: 1, reviewCount: 0 },
    { id: 'c', createdAt: '2026-08-17T12:00:00.000Z', kind: 'rollback', sectionCount: 2, reviewCount: 0 },
    {
      id: 'd', createdAt: '2026-08-17T13:00:00.000Z', kind: 'autosync',
      autosync: autosyncEntry({ status: 'success', createdAt: '2026-08-17T13:00:00.000Z' }),
    },
    {
      id: 'e', createdAt: '2026-08-17T14:00:00.000Z', kind: 'autosync',
      autosync: autosyncEntry({ status: 'skipped', createdAt: '2026-08-17T14:00:00.000Z' }),
    },
    {
      id: 'f', createdAt: '2026-08-17T15:00:00.000Z', kind: 'autosync',
      autosync: autosyncEntry({ status: 'failed', error: 'boom', createdAt: '2026-08-17T15:00:00.000Z' }),
    },
    {
      id: 'g', createdAt: '2026-08-17T16:00:00.000Z', kind: 'autosync',
      autosync: autosyncEntry({ status: 'partial', createdAt: '2026-08-17T16:00:00.000Z' }),
    },
  ];
  assert.deepEqual(summarizeSyncHistory(rows), {
    total: 7, snapshots: 3, autosync: 4, failed: 1, skipped: 2,
  });
});

test('summarizeSyncHistory：空列表 → 全零', () => {
  assert.deepEqual(summarizeSyncHistory([]), {
    total: 0, snapshots: 0, autosync: 0, failed: 0, skipped: 0,
  });
});

test('summarizeSyncHistory：autosync 缺 autosync 子对象 → 计入 autosync 但不计入 failed/skipped（防御）', () => {
  const rows: SyncHistoryEntry[] = [{ id: 'x', createdAt: '2026-08-17T10:00:00.000Z', kind: 'autosync' }];
  assert.deepEqual(summarizeSyncHistory(rows), {
    total: 1, snapshots: 0, autosync: 1, failed: 0, skipped: 0,
  });
});

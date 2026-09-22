/**
 * m-sync-ui：同步历史投影纯函数测试。
 * 覆盖：倒序排序、ISO 时间格式化、UUID 中段省略、历史统计摘要。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SyncHistoryEntry } from './sync-api.ts';
import {
  formatDateTime, formatDateTimeFull, midEllipsis,
  projectSyncHistoryEntries, summarizeSyncHistory,
} from './history-model.ts';

test('projectSyncHistoryEntries：按 createdAt 倒序', () => {
  const entries: SyncHistoryEntry[] = [
    { id: 'a', createdAt: '2026-08-17T10:00:00.000Z', kind: 'apply', sectionCount: 3, reviewCount: 0 },
    { id: 'b', createdAt: '2026-08-17T12:00:00.000Z', kind: 'push', sectionCount: 1, reviewCount: 0 },
    { id: 'c', createdAt: '2026-08-17T11:00:00.000Z', kind: 'apply', sectionCount: 2, reviewCount: 0 },
  ];
  const sorted = projectSyncHistoryEntries(entries);
  assert.equal(sorted[0]!.id, 'b');
  assert.equal(sorted[1]!.id, 'c');
  assert.equal(sorted[2]!.id, 'a');
});

test('projectSyncHistoryEntries：空集合 → 空', () => {
  assert.deepEqual(projectSyncHistoryEntries([]), []);
});

test('formatDateTime：合法 ISO → 本地格式；空/非法回退', () => {
  assert.match(formatDateTime('2026-08-17T10:30:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatDateTime(''), '—');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
});

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

test('summarizeSyncHistory：总数 + 快照类条目数', () => {
  const rows: SyncHistoryEntry[] = [
    { id: 'a', createdAt: '2026-08-17T10:00:00.000Z', kind: 'apply', sectionCount: 3, reviewCount: 0 },
    { id: 'b', createdAt: '2026-08-17T11:00:00.000Z', kind: 'push', sectionCount: 1, reviewCount: 0 },
    { id: 'c', createdAt: '2026-08-17T12:00:00.000Z', kind: 'rollback', sectionCount: 2, reviewCount: 0 },
    { id: 'd', createdAt: '2026-08-17T13:00:00.000Z', kind: 'pull', sectionCount: 4, reviewCount: 0 },
  ];
  assert.deepEqual(summarizeSyncHistory(rows), { total: 4, snapshots: 4 });
});

test('summarizeSyncHistory：空列表 → 全零', () => {
  assert.deepEqual(summarizeSyncHistory([]), { total: 0, snapshots: 0 });
});

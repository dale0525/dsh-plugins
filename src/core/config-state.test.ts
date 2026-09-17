/**
 * Phase 1 地基回归：配置状态采集（config-state.ts）+ 撤销/重做规划（undo.ts）。
 *
 * 覆盖用户可见契约：
 *  - 状态指纹对同一逻辑内容稳定（对象键顺序不影响），内容变化必然改变指纹；
 *  - 文件类分区的字节变化必须被识别（字节在 data.files[].data 里，不在 files 数组）；
 *  - 单分区采集失败只跳过该分区，不使整次采集失败；
 *  - 撤销 = 回退到与当前状态**内容不同**的最新快照（跳过等于当前状态的）；
 *  - 全部相同 → 明确返回「没有可撤销的变化」，不做空操作；
 *  - 撤销后一旦产生更新快照，重做即失效（superseded-by-newer-change）；
 *  - pre-restore 永不作为撤销目标。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureConfigState, diffStates, hashExportSection, stableStringify, stateFromExports, statesEqual, stateSections,
  type ConfigState,
} from './config-state.ts';
import {
  canRedo, canUndo, planRedo, planUndo, sortNewestFirst, steppedIds,
  type UndoCandidate,
} from './undo.ts';
import { makeContext } from '../adapters/test-helpers.ts';
import type { ConfigAdapter, ExportSection, HostContext } from './types.ts';
import type { SectionId } from '../schema/types.ts';

/* ------------------------------------------------------------ 测试替身 */

/** 可编程的最小 adapter：export 返回预置数据，可选抛错。 */
function fakeAdapter(
  id: SectionId,
  exported: ExportSection,
  opts: { failExport?: boolean } = {},
): ConfigAdapter {
  return {
    id,
    displayName: id,
    defaultIncluded: true,
    portability: 'portable',
    async export(): Promise<ExportSection> {
      if (opts.failExport === true) throw new Error(`boom:${id}`);
      return exported;
    },
    async analyzeImport() { return []; },
    async applyItem() { return { ok: true }; },
    async validate() { return { valid: true, issues: [] }; },
  };
}

function section(id: SectionId, data: unknown, files?: { relativePath: string; data: Uint8Array }[]): ExportSection {
  return {
    sectionId: id,
    data,
    ...(files !== undefined ? { files } : {}),
    counts: { n: 1 },
    warnings: [],
  };
}

function ctx(): HostContext {
  return makeContext('win32', 'C:/home/.dsh');
}

function stateOf(sections: { section: SectionId; hash: string }[], capturedAt = '2026-09-13T00:00:00.000Z'): ConfigState {
  return { capturedAt, sections: sections.map((s) => ({ ...s, counts: {}, fileCount: 0 })) };
}

/* ------------------------------------------------------------ stableStringify */

test('stableStringify：对象键顺序不影响结果', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ x: { p: 1, q: 2 } }), stableStringify({ x: { q: 2, p: 1 } }));
});

test('stableStringify：数组顺序影响结果（顺序是语义）', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test('stableStringify：undefined 与函数键被省略，循环引用不炸', () => {
  assert.equal(stableStringify({ a: 1, b: undefined, c: () => 1 }), '{"a":1}');
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.match(stableStringify(cyclic), /"<cycle>"/);
});

test('stableStringify：非有限数字归一为 null，Uint8Array 按内容指纹计入', () => {
  assert.equal(stableStringify({ a: Number.NaN, b: Infinity }), '{"a":null,"b":null}');
  const same = stableStringify({ d: new Uint8Array([1, 2, 3]) });
  const sameAgain = stableStringify({ d: new Uint8Array([1, 2, 3]) });
  const other = stableStringify({ d: new Uint8Array([1, 2, 4]) });
  assert.equal(same, sameAgain);
  assert.notEqual(same, other);
});

/* ------------------------------------------------------------ hashExportSection */

test('hashExportSection：同一逻辑内容稳定，data 变化必然改变指纹', () => {
  const a = hashExportSection(section('settings', { alpha: 1, beta: 2 }));
  const b = hashExportSection(section('settings', { beta: 2, alpha: 1 }));
  const c = hashExportSection(section('settings', { alpha: 1, beta: 3 }));
  assert.equal(a, b, '键顺序不同但内容相同 → 指纹必须一致');
  assert.notEqual(a, c);
});

test('hashExportSection：文件数组顺序不影响，但文件内容变化必须被识别', () => {
  const f1 = { relativePath: 'a.md', data: new Uint8Array([1]) };
  const f2 = { relativePath: 'b.md', data: new Uint8Array([2]) };
  const ordered = hashExportSection(section('skills', { version: 1 }, [f1, f2]));
  const reversed = hashExportSection(section('skills', { version: 1 }, [f2, f1]));
  assert.equal(ordered, reversed, '文件顺序不同 → 指纹一致');
  const changed = hashExportSection(section('skills', { version: 1 }, [f1, { relativePath: 'b.md', data: new Uint8Array([9]) }]));
  assert.notEqual(ordered, changed);
});

test('hashExportSection：文件类分区字节在 data.files[].data 里时也必须被识别（真实 adapter 形态）', () => {
  // 真实 FileCollectionAdapter 把字节放进 data.files[].data，files 字段为 undefined。
  const before = hashExportSection(section('skills', {
    version: 1,
    files: [{ relativePath: 'x.md', contentHash: 'h', data: new Uint8Array([1, 2, 3]) }],
  }));
  const after = hashExportSection(section('skills', {
    version: 1,
    files: [{ relativePath: 'x.md', contentHash: 'h', data: new Uint8Array([1, 2, 4]) }],
  }));
  assert.notEqual(before, after, '内嵌字节变化必须改变分区指纹');
});

/* ------------------------------------------------------------ captureConfigState */

test('captureConfigState：分区按 id 升序输出，便于跨次比较', async () => {
  const adapters = [
    fakeAdapter('ui', section('ui', { v: 1 })),
    fakeAdapter('settings', section('settings', { v: 1 })),
  ];
  const state = await captureConfigState(adapters, ctx());
  assert.deepEqual(state.sections.map((s) => s.section), ['settings', 'ui']);
});

test('captureConfigState：单分区导出失败只跳过该分区，不使整次采集失败', async () => {
  const errors: { section: SectionId; error: unknown }[] = [];
  const adapters = [
    fakeAdapter('settings', section('settings', { v: 1 })),
    fakeAdapter('ui', section('ui', { v: 1 }), { failExport: true }),
  ];
  const state = await captureConfigState(adapters, ctx(), {
    onSectionError: (s, e) => errors.push({ section: s, error: e }),
  });
  assert.deepEqual(state.sections.map((s) => s.section), ['settings']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.section, 'ui');
});

test('captureConfigState：only 过滤生效', async () => {
  const adapters = [
    fakeAdapter('settings', section('settings', { v: 1 })),
    fakeAdapter('ui', section('ui', { v: 1 })),
  ];
  const state = await captureConfigState(adapters, ctx(), { only: ['ui'] });
  assert.deepEqual(state.sections.map((s) => s.section), ['ui']);
});

/* ------------------------------------------------------------ 相等与差异 */

test('statesEqual：null 与任何非 null 不等；同 null 相等', () => {
  assert.equal(statesEqual(null, null), true);
  assert.equal(statesEqual(null, stateOf([{ section: 'settings', hash: 'a' }])), false);
  assert.equal(statesEqual(stateOf([{ section: 'settings', hash: 'a' }]), null), false);
});

test('statesEqual：分区集合或任一 hash 不同即不等', () => {
  const a = stateOf([{ section: 'settings', hash: 'a' }, { section: 'ui', hash: 'b' }]);
  assert.equal(statesEqual(a, stateOf([{ section: 'ui', hash: 'b' }, { section: 'settings', hash: 'a' }])), true);
  assert.equal(statesEqual(a, stateOf([{ section: 'settings', hash: 'a' }, { section: 'ui', hash: 'X' }])), false);
  assert.equal(statesEqual(a, stateOf([{ section: 'settings', hash: 'a' }])), false);
});

test('stateSections：null 得到空 Map', () => {
  assert.equal(stateSections(null).size, 0);
  assert.equal(stateSections(stateOf([{ section: 'ui', hash: 'a' }])).get('ui')?.hash, 'a');
});

/*
 * 回归：statesEqual 必须是**全函数**。
 * meta.state 直接来自磁盘（可能被手改 / 截断 / 版本不符而缺字段），一旦它抛 TypeError，
 * status() 与 undo()/redo() 会整体 500，用户连快照列表都看不见。
 */
test('statesEqual：state 为 undefined / 缺 sections 时不抛（磁盘损坏的 meta 不得炸掉调用方）', () => {
  const good = stateOf([{ section: 'settings', hash: 'a' }]);
  const broken = { capturedAt: '2026-01-01T00:00:00.000Z' } as unknown as ConfigState;

  assert.equal(statesEqual(good, undefined as unknown as ConfigState), false);
  assert.equal(statesEqual(undefined as unknown as ConfigState, good), false);
  assert.equal(statesEqual(good, broken), false, '缺 sections → 与任何可用状态都不等（绝不当成「相同」）');
  assert.equal(statesEqual(broken, broken), true, '同一损坏对象的引用相等仍然成立（保守）');
  assert.equal(statesEqual(broken, { ...broken }), false, '两个不同的损坏对象不得判为相等');
});

test('statesEqual：数组长度不同必不等（含单侧多分区）', () => {
  const wide = stateOf([{ section: 'settings', hash: 'a' }, { section: 'ui', hash: 'b' }]);
  const narrow = stateOf([{ section: 'settings', hash: 'a' }]);
  assert.equal(statesEqual(wide, narrow), false);
  assert.equal(statesEqual(narrow, wide), false);
});

test('stateSections：state 缺 sections 时返回空 Map（不抛）', () => {
  assert.equal(stateSections({ capturedAt: 'x' } as unknown as ConfigState).size, 0);
  assert.equal(stateSections(undefined as unknown as ConfigState).size, 0);
});

/*
 * stateFromExports：与 captureConfigState 必须口径一致（同一份导出 → 同一指纹）。
 * 快照路径直接复用它，若两条路径算法漂移，「当前状态」与「快照状态」就没法比较了。
 */
test('stateFromExports：与 captureConfigState 对同一份导出得到同一状态', async () => {
  const exported = section('settings', { v: 1 });
  const map = new Map<SectionId, ExportSection>([['settings', exported]]);
  const direct = stateFromExports(map);

  const adapters: ConfigAdapter[] = [fakeAdapter('settings', exported)];
  const captured = await captureConfigState(adapters, ctx());

  assert.deepEqual(direct.sections, captured.sections, '两条路径的分区口径必须完全一致');
});

test('stateFromExports：按 section 升序输出（不依赖 Map 插入顺序）', () => {
  const map = new Map<SectionId, ExportSection>([
    ['ui', section('ui', { b: 1 })],
    ['settings', section('settings', { a: 1 })],
  ]);
  assert.deepEqual(stateFromExports(map).sections.map((s) => s.section), ['settings', 'ui']);
});

test('diffStates：区分 changed / added / removed，且顺序确定', () => {
  const before = stateOf([{ section: 'settings', hash: 'a' }, { section: 'ui', hash: 'b' }]);
  const after = stateOf([{ section: 'settings', hash: 'A' }, { section: 'providers', hash: 'c' }]);
  const diff = diffStates(before, after);
  assert.deepEqual(diff.changed, ['settings']);
  assert.deepEqual(diff.added, ['providers']);
  assert.deepEqual(diff.removed, ['ui']);
  assert.equal(diff.identical, false);
});

test('diffStates：无差异时 identical=true 且三个列表皆空', () => {
  const s = stateOf([{ section: 'settings', hash: 'a' }]);
  const diff = diffStates(s, stateOf([{ section: 'settings', hash: 'a' }]));
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.identical, true);
});

/* ------------------------------------------------------------ 撤销规划 */

test('planUndo：跳过「等于当前状态」的更新快照，命中第一个内容不同的快照', () => {
  const current = stateOf([{ section: 'settings', hash: 'CURRENT' }]);
  const snapshots: UndoCandidate[] = [
    { id: 's3', createdAt: '2026-09-13T03:00:00.000Z', kind: 'auto', state: stateOf([{ section: 'settings', hash: 'CURRENT' }]) },
    { id: 's2', createdAt: '2026-09-13T02:00:00.000Z', kind: 'auto', state: stateOf([{ section: 'settings', hash: 'CURRENT' }]) },
    { id: 's1', createdAt: '2026-09-13T01:00:00.000Z', kind: 'auto', state: stateOf([{ section: 'settings', hash: 'OLD' }]) },
  ];
  const plan = planUndo(current, snapshots);
  assert.equal(plan.kind, 'undo');
  if (plan.kind !== 'undo') return;
  assert.equal(plan.targetId, 's1');
  assert.equal(plan.skippedNewer, 2);
  assert.equal(plan.reason, 'content-differs');
});

test('planUndo：全部与当前状态相同 → 明确报告没有可撤销的变化（不做空操作）', () => {
  const current = stateOf([{ section: 'settings', hash: 'SAME' }]);
  const snapshots: UndoCandidate[] = [
    { id: 's1', createdAt: '2026-09-13T01:00:00.000Z', kind: 'auto', state: stateOf([{ section: 'settings', hash: 'SAME' }]) },
  ];
  const plan = planUndo(current, snapshots);
  assert.equal(plan.kind, 'none');
  if (plan.kind !== 'none') return;
  assert.equal(plan.reason, 'already-at-state');
});

test('planUndo：无可用候选 → no-snapshots（旧格式无 state 的快照不可比较）', () => {
  const current = stateOf([{ section: 'settings', hash: 'X' }]);
  const plan = planUndo(current, [
    { id: 'legacy', createdAt: '2026-09-13T01:00:00.000Z', kind: 'auto' },
    { id: 'pre', createdAt: '2026-09-13T02:00:00.000Z', kind: 'pre-restore', state: current },
  ]);
  assert.equal(plan.kind, 'none');
  if (plan.kind !== 'none') return;
  assert.equal(plan.reason, 'no-snapshots');
});

test('planUndo：pre-restore 永不作为撤销目标（否则撤销会撤销掉自己）', () => {
  const current = stateOf([{ section: 'settings', hash: 'NEW' }]);
  const old = stateOf([{ section: 'settings', hash: 'OLD' }]);
  const plan = planUndo(current, [
    { id: 'pre1', createdAt: '2026-09-13T09:00:00.000Z', kind: 'pre-restore', state: old },
    { id: 'auto1', createdAt: '2026-09-13T08:00:00.000Z', kind: 'auto', state: old },
  ]);
  assert.equal(plan.kind, 'undo');
  if (plan.kind !== 'undo') return;
  assert.equal(plan.targetId, 'auto1');
});

test('canUndo：与 planUndo 语义一致', () => {
  const current = stateOf([{ section: 'settings', hash: 'C' }]);
  assert.equal(canUndo(current, [{ id: 'a', createdAt: 't', kind: 'auto', state: current }]), false);
  assert.equal(canUndo(current, [{ id: 'a', createdAt: 't', kind: 'auto', state: stateOf([{ section: 'settings', hash: 'D' }]) }]), true);
});

/* ------------------------------------------------------------ 重做规划 */

test('planRedo：取最新的未消费 pre-restore', () => {
  const snapshots: UndoCandidate[] = [
    { id: 'pre2', createdAt: '2026-09-13T03:00:00.000Z', kind: 'pre-restore' },
    { id: 'auto1', createdAt: '2026-09-13T01:00:00.000Z', kind: 'auto' },
  ];
  const plan = planRedo(snapshots);
  assert.equal(plan.kind, 'redo');
  if (plan.kind !== 'redo') return;
  assert.equal(plan.targetId, 'pre2');
});

test('planRedo：无未消费 pre-restore → no-pre-restore', () => {
  assert.equal(planRedo([]).kind, 'none');
  const consumed = planRedo([{ id: 'pre1', createdAt: '2026-09-13T03:00:00.000Z', kind: 'pre-restore', consumed: true }]);
  assert.equal(consumed.kind, 'none');
  if (consumed.kind !== 'none') return;
  assert.equal(consumed.reason, 'no-pre-restore');
});

test('planRedo：撤销后又产生了新快照 → 重做失效（不被旧状态覆盖新改动）', () => {
  const snapshots: UndoCandidate[] = [
    { id: 'newer', createdAt: '2026-09-13T05:00:00.000Z', kind: 'auto' },
    { id: 'pre1', createdAt: '2026-09-13T04:00:00.000Z', kind: 'pre-restore' },
    { id: 'auto1', createdAt: '2026-09-13T01:00:00.000Z', kind: 'auto' },
  ];
  const plan = planRedo(snapshots);
  assert.equal(plan.kind, 'none');
  if (plan.kind !== 'none') return;
  assert.equal(plan.reason, 'superseded-by-newer-change');
});

test('planRedo：仅存在更旧的快照不构成 supersede（仍可重做）', () => {
  const snapshots: UndoCandidate[] = [
    { id: 'pre1', createdAt: '2026-09-13T04:00:00.000Z', kind: 'pre-restore' },
    { id: 'auto1', createdAt: '2026-09-13T01:00:00.000Z', kind: 'auto' },
  ];
  assert.equal(planRedo(snapshots).kind, 'redo');
});

test('canRedo：与 planRedo 语义一致', () => {
  assert.equal(canRedo([]), false);
  assert.equal(canRedo([{ id: 'p', createdAt: '2026-09-13T01:00:00.000Z', kind: 'pre-restore' }]), true);
});

/* ------------------------------------------------------------ stepped / 排序 */

test('steppedIds：标记比目标更新、且内容等于撤销前状态的快照', () => {
  const beforeState = stateOf([{ section: 'settings', hash: 'BEFORE' }]);
  const otherState = stateOf([{ section: 'settings', hash: 'OTHER' }]);
  const snapshots: UndoCandidate[] = [
    { id: 'target', createdAt: '2026-09-13T01:00:00.000Z', kind: 'auto', state: beforeState },
    { id: 'after1', createdAt: '2026-09-13T02:00:00.000Z', kind: 'auto', state: beforeState },
    { id: 'after2', createdAt: '2026-09-13T03:00:00.000Z', kind: 'auto', state: otherState },
    { id: 'pre', createdAt: '2026-09-13T04:00:00.000Z', kind: 'pre-restore', state: beforeState },
  ];
  assert.deepEqual(steppedIds(snapshots, 'target', beforeState), ['after1']);
});

test('steppedIds：目标不存在 → 空数组', () => {
  assert.deepEqual(steppedIds([], 'nope', stateOf([])), []);
});

test('sortNewestFirst：按 createdAt 倒序，同刻按 id 稳定', () => {
  const sorted = sortNewestFirst([
    { id: 'b', createdAt: '2026-09-13T01:00:00.000Z' },
    { id: 'a', createdAt: '2026-09-13T02:00:00.000Z' },
    { id: 'c', createdAt: '2026-09-13T02:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ['c', 'a', 'b']);
});

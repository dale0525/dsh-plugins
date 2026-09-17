/**
 * 撤销 / 重做语义（Phase 1 P0-2）。
 *
 * 与竞品 dsh-undo-savepoint 的语义对齐（其「撤销不会撤销掉自己」的等价物在本仓库
 * 由两处保证：`pre-restore` 快照自身不参与候选，以及恢复后按内容指纹做回声抑制）：
 *
 *  自动快照在变更**之后**采集，因此「最新快照」通常等于当前状态。
 *  真实撤销 = 回退到与当前状态**内容不同**的最新快照（跳过等于当前状态的那些）。
 *  全部相同 → 明确返回「没有可撤销的变化」，而不是做一次空操作。
 *
 * 重做的护栏：撤销时先落一个 `pre-restore` 快照记录「撤销前状态」；
 * 一旦其后产生任何更新的快照（= 用户又改了），重做即失效——避免把用户的
 * 新改动覆盖回旧状态。
 *
 * 本模块是**纯规划**：不读盘、不写盘、不碰 adapter。执行侧见 config-snapshot.ts。
 */
import { statesEqual, type ConfigState } from './config-state.ts';

/** 快照种类。pre-restore 为撤销/还原自身的记账快照，永不作为撤销目标。 */
export type ConfigSnapshotKind = 'manual' | 'auto' | 'undo' | 'pre-restore' | 'baseline';

/** 规划所需的最小快照视图（携带其采集到的状态） */
export interface UndoCandidate {
  id: string;
  createdAt: string;
  kind: ConfigSnapshotKind;
  /** 该快照采集时的配置状态（缺省 = 旧格式快照，无法参与内容比对） */
  state?: ConfigState;
  /** pre-restore 是否已被重做消费 */
  consumed?: boolean;
}

export type UndoPlan =
  | { kind: 'undo'; targetId: string; skippedNewer: number; reason: 'content-differs' }
  | { kind: 'none'; reason: 'no-snapshots' | 'already-at-state' };

export type RedoPlan =
  | { kind: 'redo'; targetId: string; reason: 'unconsumed-pre-restore' }
  | { kind: 'none'; reason: 'no-pre-restore' | 'superseded-by-newer-change' };

/** 按 createdAt 倒序（新→旧）；同刻按 id 稳定排序保证确定性。 */
export function sortNewestFirst<T extends { createdAt: string; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** 可作为撤销目标/状态基准的快照（剔除 pre-restore 与无 state 的旧格式） */
function comparableCandidates(snapshots: readonly UndoCandidate[]): UndoCandidate[] {
  return sortNewestFirst(snapshots).filter((s) => s.kind !== 'pre-restore' && s.state !== undefined);
}

/**
 * 规划一次撤销：返回第一个内容与 current 不同的快照。
 * `skippedNewer` = 跳过的「与当前状态相同」的更新快照数（通常 ≥1，因为自动快照
 * 落在变更之后）。
 */
export function planUndo(current: ConfigState, snapshots: readonly UndoCandidate[]): UndoPlan {
  const candidates = comparableCandidates(snapshots);
  if (candidates.length === 0) return { kind: 'none', reason: 'no-snapshots' };
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    if (!statesEqual(current, candidate.state!)) {
      return { kind: 'undo', targetId: candidate.id, skippedNewer: i, reason: 'content-differs' };
    }
  }
  return { kind: 'none', reason: 'already-at-state' };
}

/** 是否存在可撤销的变化（供 UI 按钮可用性；等价于 planUndo 是否命中）。 */
export function canUndo(current: ConfigState, snapshots: readonly UndoCandidate[]): boolean {
  return planUndo(current, snapshots).kind === 'undo';
}

/**
 * 规划一次重做：取最新的未消费 pre-restore。
 * 若其后存在任何更新的快照（含未消费的 pre-restore）→ superseded-by-newer-change。
 */
export function planRedo(snapshots: readonly UndoCandidate[]): RedoPlan {
  const ordered = sortNewestFirst(snapshots);
  const pre = ordered.find((s) => s.kind === 'pre-restore' && s.consumed !== true);
  if (pre === undefined) return { kind: 'none', reason: 'no-pre-restore' };
  const superseded = ordered.some(
    (s) => s.createdAt > pre.createdAt && (s.kind !== 'pre-restore' || s.consumed !== true),
  );
  if (superseded) return { kind: 'none', reason: 'superseded-by-newer-change' };
  return { kind: 'redo', targetId: pre.id, reason: 'unconsumed-pre-restore' };
}

/** 是否存在可重做的撤销（供 UI 按钮可用性）。 */
export function canRedo(snapshots: readonly UndoCandidate[]): boolean {
  return planRedo(snapshots).kind === 'redo';
}

/**
 * 撤销后需要标记为「已被跨过」的快照 id 列表。
 * 语义：撤销回退到 targetId 之后，比 targetId 更新、且内容等于**撤销前状态**的那些
 * 快照，代表的是被撤销掉的那一步；重做回到撤销前状态后应清除该标记。
 * 返回 targetId 之后（更旧侧不涉及）需要标记的 id。
 */
export function steppedIds(
  snapshots: readonly UndoCandidate[],
  targetId: string,
  beforeState: ConfigState,
): string[] {
  const target = snapshots.find((s) => s.id === targetId);
  if (target === undefined) return [];
  return snapshots
    .filter((s) => s.kind !== 'pre-restore'
      && s.id !== targetId
      && s.createdAt > target.createdAt
      && s.state !== undefined
      && statesEqual(s.state, beforeState))
    .map((s) => s.id);
}

/**
 * P2c e2e：/sync/apply 完整链路（engine 级，真实 Importer + 内存 transport + 真实 makeContext）。
 *
 * 链路：push（建立基线）→ 塞远端快照（模拟另一台机器改了 settings）→
 *       engine.pull()（只读差异预览）→ engine.preview() + engine.applyItems()（真实
 *       Importer.executeImportPlan 写本地）→ 验证：本地 settings 被写入 +
 *       sync-state.lastSnapshotId 更新。
 *
 * 说明：不启动真实 HTTP server（那需要拉起 DSH 插件运行时）；以 SyncEngine 为边界走
 * 与 Host /sync/sync + /sync/apply-items 路由完全相同的代码路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine } from '../src/sync/sync-engine.ts';
import { loadSyncState } from '../src/sync/sync-state.ts';
import { createAdapters } from '../src/adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../src/adapters/test-helpers.ts';
import { Importer } from '../src/core/importer.ts';
import type { ImportPlan } from '../src/core/types.ts';
import type { SyncSnapshot, SyncTransport, SyncSnapshotMeta } from '../src/sync/transport.ts';
import { computeSnapshotMeta } from '../src/sync/transport.ts';

/** 内存 SyncTransport（与 sync-engine.test.ts 同款） */
class MemTransport implements SyncTransport {
  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  async list(): Promise<SyncSnapshotMeta[]> {
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.snapshots.set(snapshot.id, snapshot);
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }
  async download(id: string): Promise<SyncSnapshot> {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`快照不存在: ${id}`);
    return s;
  }
  async delete(id: string): Promise<void> {
    this.snapshots.delete(id);
  }
}

const NS = ['general', 'theme'];

function makeEngine(
  ctx: ReturnType<typeof makeContext>,
  transport: MemTransport,
  stateDir: string,
  localSnapshotsDir: string,
): SyncEngine {
  const adapters = createAdapters({ namespaces: NS });
  const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
  return new SyncEngine({
    ctx,
    transport,
    stateDir,
    localSnapshotsDir,
    adapters,
    importer,
    now: () => new Date('2026-08-17T00:00:00.000Z'),
  });
}

/** 构造一个仅含 settings 分区的远端快照（模拟另一台机器推的） */
function remoteSnapshot(id: string, theme: string): SyncSnapshot {
  return {
    id,
    createdAt: '2026-08-17T00:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
    sections: {
      settings: {
        version: 1,
        namespaces: { general: { value: { theme }, revision: 5, secrets: [] } },
      },
    },
  };
}

/** 取 preview 计划的非 Skip 项构成子计划（与 Host /sync/apply-items 同款过滤）。 */
function acceptAll(plan: ImportPlan): ImportPlan {
  return { ...plan, items: plan.items.filter((i) => i.kind !== 'Skip') };
}

test('e2e: push 建基线 → 远端改 → pull 预览 → preview/applyItems → 本地 settings 被写', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-apply-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    const transport = new MemTransport();
    const stateDir = path.join(tmp, 'sync');
    const localSnapshotsDir = path.join(tmp, 'snapshots');
    const engine = makeEngine(ctx, transport, stateDir, localSnapshotsDir);

    // ① push：本地 dark → 基线
    const push = await engine.push({ snapshotId: 'sync-base' });
    assert.equal(push.ok, true);
    assert.equal(push.snapshotId, 'sync-base');

    // ② 远端被另一台机器改为 light
    const remote = remoteSnapshot('sync-remote', 'light');
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));

    // ③ pull：只读差异预览（零写入）
    const pull = await engine.pull();
    assert.equal(pull.ok, true);
    assert.ok(pull.changes.some((c) => c.adapter === 'settings'), '差异报告含 settings');
    assert.deepEqual(ctx.settings.ns.get('general')?.value, { theme: 'dark' }, 'pull 不写本地');

    // ④ preview + applyItems（真实 Importer 写本地）
    const preview = await engine.preview();
    assert.ok(preview.plan, 'preview 产出计划');
    const report = await engine.applyItems(preview.zipPath, acceptAll(preview.plan!));
    assert.equal(report.ok, true, 'apply 应成功');
    assert.ok(report.applied.includes('settings'));
    assert.notEqual(report.restoreId, '', 'restoreId 非空');
    assert.equal(report.rolledBack, false);

    // ⑤ 本地 settings 被真实 adapter 写回
    const local = ctx.settings.ns.get('general');
    assert.ok(local, 'general namespace 已存在');
    assert.equal((local!.value as { theme: string }).theme, 'light', '本地 theme 已被应用为远端 light');

    // ⑥ sync-state.lastSnapshotId 已更新（applyItems 内部 recordBaseline）
    const state = await loadSyncState(stateDir);
    assert.notEqual(state.lastSnapshotId, '', 'apply 后基线已更新');
    // ⑦ 本地快照副本目录有内容
    const dirs = await fs.readdir(localSnapshotsDir);
    assert.ok(dirs.length > 0, '本地快照副本已写入');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('e2e: 双侧都改 → 远端值覆盖本地（不合并、不询问）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-conflict-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    const transport = new MemTransport();
    const stateDir = path.join(tmp, 'sync');
    const localSnapshotsDir = path.join(tmp, 'snapshots');
    const engine = makeEngine(ctx, transport, stateDir, localSnapshotsDir);

    // ① push 建基线 dark
    await engine.push({ snapshotId: 'sync-base' });

    // ② 本地改 blue + 远端改 red → 双侧都改
    ctx.settings.ns.set('general', { value: { theme: 'blue' }, revision: 4, secrets: [] });
    const remote = remoteSnapshot('sync-remote', 'red');
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));

    // ③ pull：replace 策略下差异项为 Update，不需人工决策
    const pull = await engine.pull();
    assert.equal(pull.needsReview, false, 'replace 策略不产生待决策项');
    assert.ok(pull.changes.some((c) => c.kind === 'Update'), '双侧差异 → Update');

    // ④ preview + applyItems：远端值覆盖本地
    const preview = await engine.preview();
    const report = await engine.applyItems(preview.zipPath, acceptAll(preview.plan!));
    assert.equal(report.ok, true);
    const local = ctx.settings.ns.get('general');
    assert.equal((local!.value as { theme: string }).theme, 'red', '远端值覆盖本地');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('e2e: 远端无快照 → pull 空报告，preview 明确报错', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-firstsync-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    const transport = new MemTransport();
    const stateDir = path.join(tmp, 'sync');
    const engine = makeEngine(ctx, transport, stateDir, path.join(tmp, 'snapshots'));

    const pull = await engine.pull();
    assert.equal(pull.ok, true);
    assert.deepEqual(pull.changes, [], '远端无快照 → 空差异');
    const preview = await engine.preview();
    assert.equal(preview.ok, false);
    assert.equal(preview.zipPath, '');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

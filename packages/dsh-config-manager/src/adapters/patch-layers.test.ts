/**
 * cordis patch 的**层寻址**契约测试（S1–S5）：
 *  - 导出同时覆盖 home 层与 profile 层，`file` 字段如实标注来源层；
 *  - diff 阶段按行自带的层读目标端（profile 层已有同值 → Skip，不是 Create）；
 *  - 计划项 id / target.ref 是层限定复合键，跨层同名 lineId 各自落各自层；
 *  - 快照与回滚按层落位（回滚 profile 层的行不得污染 home 层）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PluginsAdapter } from './plugins.ts';
import { makeContext, makeImportContext, MemSnapshotStore } from './test-helpers.ts';
import { createSnapshot } from '../core/backup.ts';
import { rollback } from '../core/rollback.ts';
import { HOME_PATCH_FILE, PROFILE_PATCH_FILE, patchLayerKey } from '../core/patch-layers.ts';
import { SECTION_IDS } from '../schema/config.ts';
import type { ImportPlan, PlanItem } from '../core/types.ts';

/** 只含一项的导入计划（estimatedActions 需覆盖全部分区，故按 SECTION_IDS 补零）。 */
function importPlan(item: PlanItem): ImportPlan {
  return {
    items: [item],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: Object.fromEntries(SECTION_IDS.map((id) => [id, 0])) as ImportPlan['estimatedActions'],
  };
}

test('plugins.export: 两层 patch 行都进 section，file 字段区分来源层', async () => {
  const ctx = makeContext('linux', '/home/alice', 'web');
  const layered = ctx.useLayeredPatch();
  layered.set(HOME_PATCH_FILE, 'home-a', { id: 'home-a', disabled: true });
  layered.set(HOME_PATCH_FILE, 'home-b', { id: 'home-b', disabled: true });
  layered.set(PROFILE_PATCH_FILE, 'profile-a', { id: 'profile-a', name: 'pkg-a' });
  layered.set(PROFILE_PATCH_FILE, 'profile-b', { id: 'profile-b', name: 'pkg-b' });

  const out = await new PluginsAdapter().export(ctx, { includeSecrets: false });
  assert.equal(out.data.patch.length, 4, `两层并集必须齐全: ${JSON.stringify(out.data.patch)}`);
  assert.deepEqual(
    [...new Set(out.data.patch.map((p) => p.file))].sort(),
    [HOME_PATCH_FILE, PROFILE_PATCH_FILE].sort(),
    'file 必须区分来源层',
  );
  assert.deepEqual(
    out.data.patch.filter((p) => p.file === PROFILE_PATCH_FILE).map((p) => p.lineId),
    ['profile-a', 'profile-b'],
  );
});

test('plugins.export: profile 层文件缺失时降级为仅 home 层（不产生 error 级告警）', async () => {
  const ctx = makeContext('linux', '/home/alice', 'web');
  const layered = ctx.useLayeredPatch();
  layered.set(HOME_PATCH_FILE, 'home-a', { id: 'home-a', disabled: true });

  const out = await new PluginsAdapter().export(ctx, { includeSecrets: false });
  assert.equal(out.data.patch.length, 1);
  assert.deepEqual([...new Set(out.data.patch.map((p) => p.file))], [HOME_PATCH_FILE]);
  assert.equal(out.warnings.length, 0, `缺 profile 层不是故障: ${out.warnings.join(' | ')}`);
});

test('plugins.analyzeImport: 目标端 profile 层已有同行 → Skip（不是 Create）', async () => {
  const src = makeContext('linux', '/home/alice', 'web');
  const srcLayered = src.useLayeredPatch();
  const raw = { id: 'webserver', config: { port: 3080 } };
  srcLayered.set(PROFILE_PATCH_FILE, 'webserver', raw);

  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  // 目标机 profile 层已有同值行 → Skip（旧实现只读 home 层，会误判成 Create）
  const dst = makeContext('linux', '/home/bob', 'web');
  dst.useLayeredPatch().set(PROFILE_PATCH_FILE, 'webserver', raw);
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const item = items.find((i) => i.id === `patch:${patchLayerKey(PROFILE_PATCH_FILE, 'webserver')}`);
  assert.equal(item?.kind, 'Skip', JSON.stringify(items));

  // 目标机 profile 层同 id 但不同值 → Conflict（旧实现只读 home 层，会误判成 Create）
  const dst2 = makeContext('linux', '/home/bob2', 'web');
  dst2.useLayeredPatch().set(PROFILE_PATCH_FILE, 'webserver', { id: 'webserver', config: { port: 9999 } });
  const items2 = await adapter.analyzeImport(exported.data, makeImportContext(dst2, sections));
  const item2 = items2.find((i) => i.id === `patch:${patchLayerKey(PROFILE_PATCH_FILE, 'webserver')}`);
  assert.equal(item2?.kind, 'Conflict', JSON.stringify(items2));
});

test('plugins: 跨层同名 lineId → 两个独立计划项，各自落各自层', async () => {
  const src = makeContext('linux', '/home/alice', 'web');
  const srcLayered = src.useLayeredPatch();
  srcLayered.set(HOME_PATCH_FILE, 'dup', { id: 'dup', config: { from: 'home' } });
  srcLayered.set(PROFILE_PATCH_FILE, 'dup', { id: 'dup', config: { from: 'profile' } });

  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);
  assert.equal(exported.data.patch.length, 2);

  const dst = makeContext('linux', '/home/bob', 'web');
  dst.useLayeredPatch();
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const patchItems = items.filter((i) => i.id.startsWith('patch:'));
  assert.equal(patchItems.length, 2, `同名 lineId 必须是两个独立项: ${JSON.stringify(items)}`);

  for (const item of patchItems) {
    const r = await adapter.applyItem(item, makeImportContext(dst, sections));
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const layered = dst.patchFile as unknown as { has: (f: string, id: string) => boolean };
  assert.equal(layered.has(HOME_PATCH_FILE, 'dup'), true, 'home 层的行必须落在 home 层');
  assert.equal(layered.has(PROFILE_PATCH_FILE, 'dup'), true, 'profile 层的行必须落在 profile 层');
  assert.deepEqual(
    (dst.patchFile as unknown as { rawOf: (f: string, id: string) => unknown }).rawOf(HOME_PATCH_FILE, 'dup'),
    { id: 'dup', config: { from: 'home' } },
  );
  assert.deepEqual(
    (dst.patchFile as unknown as { rawOf: (f: string, id: string) => unknown }).rawOf(PROFILE_PATCH_FILE, 'dup'),
    { id: 'dup', config: { from: 'profile' } },
  );
});

test('rollback: profile 层 patchLine 回滚写回 profile 层（home 层文件不受影响）', async () => {
  const ctx = makeContext('linux', '/home/bob', 'web');
  const layered = ctx.useLayeredPatch();
  const original = { id: 'webserver', config: { port: 3080 } };
  layered.set(PROFILE_PATCH_FILE, 'webserver', original);
  layered.set(HOME_PATCH_FILE, 'webserver', { id: 'webserver', config: { port: 1111 } });

  const item: PlanItem = {
    id: `patch:${patchLayerKey(PROFILE_PATCH_FILE, 'webserver')}`,
    kind: 'Update',
    adapter: 'plugins',
    description: 'write profile patch row',
    severity: 'info',
    target: { adapter: 'plugins', ref: patchLayerKey(PROFILE_PATCH_FILE, 'webserver') },
  };
  const plan = importPlan(item);
  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({ ctx, plan, sourceZip: '/tmp/x.zip', store, adapters: [] });
  const entry = snapshot.entries.find((e) => e.kind === 'patchLine');
  assert.ok(entry !== undefined, `快照必须登记 patchLine 条目: ${JSON.stringify(snapshot.entries)}`);
  assert.deepEqual(entry.before, original, '快照必须记 profile 层原值（旧实现固定读 home 层，会记成 home 层的值）');

  // 模拟导入改写 profile 层
  await ctx.patchFile.applyPatchChanges(PROFILE_PATCH_FILE, [
    { lineId: 'webserver', raw: { id: 'webserver', config: { port: 9999 } }, action: 'update' },
  ]);
  const report = await rollback({ ctx, snapshot, store, adapters: [] });
  assert.equal(report.full, true, JSON.stringify(report));
  assert.deepEqual(layered.rawOf(PROFILE_PATCH_FILE, 'webserver'), original, '回滚必须写回 profile 层原值');
  assert.deepEqual(
    layered.rawOf(HOME_PATCH_FILE, 'webserver'),
    { id: 'webserver', config: { port: 1111 } },
    'home 层的行不得被 profile 层回滚污染',
  );
});

test('rollback: 旧快照的裸 lineId ref 兼容为 home 层', async () => {
  const ctx = makeContext('linux', '/home/bob', 'web');
  const layered = ctx.useLayeredPatch();
  layered.set(HOME_PATCH_FILE, 'legacy', { id: 'legacy', disabled: false });

  const item: PlanItem = {
    id: 'patch:legacy',
    kind: 'Update',
    adapter: 'plugins',
    description: 'legacy ref',
    severity: 'info',
    target: { adapter: 'plugins', ref: 'legacy' },
  };
  const plan = importPlan(item);
  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({ ctx, plan, sourceZip: '/tmp/x.zip', store, adapters: [] });
  assert.deepEqual(snapshot.entries.find((e) => e.kind === 'patchLine')?.before, { id: 'legacy', disabled: false });

  await ctx.patchFile.applyPatchChanges(HOME_PATCH_FILE, [
    { lineId: 'legacy', raw: { id: 'legacy', disabled: true }, action: 'update' },
  ]);
  const report = await rollback({ ctx, snapshot, store, adapters: [] });
  assert.equal(report.full, true, JSON.stringify(report));
  assert.deepEqual(layered.rawOf(HOME_PATCH_FILE, 'legacy'), { id: 'legacy', disabled: false });
});

test('plugins.export: 存量快照的 file=home token 仍解析到 home 层', async () => {
  const src = makeContext('linux', '/home/alice', 'web');
  const layered = src.useLayeredPatch();
  layered.set(HOME_PATCH_FILE, 'legacy-home', { id: 'legacy-home', disabled: true });

  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.patch[0]?.file, HOME_PATCH_FILE, 'home 层 token 与历史快照取值一致');

  const sections = new Map([['plugins', exported.data]]);
  const dst = makeContext('linux', '/home/bob', 'web');
  dst.useLayeredPatch();
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const item = items.find((i) => i.id.startsWith('patch:'));
  assert.equal(item?.target?.ref, patchLayerKey(HOME_PATCH_FILE, 'legacy-home'));
  await adapter.applyItem(item!, makeImportContext(dst, sections));
  assert.equal((dst.patchFile as unknown as { has: (f: string, id: string) => boolean }).has(HOME_PATCH_FILE, 'legacy-home'), true);
});

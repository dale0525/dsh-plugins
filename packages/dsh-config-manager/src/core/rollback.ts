/**
 * Rollback（规范 §17 / 设计 §8.2）：导入失败时逆序执行快照条目的补偿动作。
 *
 * 诚实原则：
 *  - 尽力回滚：单项失败不停止其余补偿，最终如实报告 full / partial；
 *  - credential 值 DSH 永不回读 → existed=true 的凭据无法自动恢复原值，
 *    如实标记 failed + manualHint（人工补录）；
 *  - settings 回滚仍走 expectedRevision 乐观锁，避免覆盖导入后用户的新修改。
 */
import { resolveFileTarget } from './backup.ts';
import { parsePatchLayerKey } from './patch-layers.ts';
import { msgOf } from './messages.ts';
import { rollbackPlugins, type PluginRollbackPort } from './rollback-plugins.ts';
import type {
  ConfigAdapter, HostContext, RollbackReport, Snapshot, SnapshotEntry, SnapshotStore,
} from './types.ts';

export interface RollbackOptions {
  ctx: HostContext;
  snapshot: Snapshot;
  store?: SnapshotStore;
  adapters?: ConfigAdapter[];
  /** 回滚 WAL（Phase 3）：每补偿完一条 entry 调用，供 Coordinator 记录 rollback.entryDone；
   *   crash during rollback 后 reconcile 从 WAL 判定已补偿/未补偿，避免盲目从头重做。 */
  entryDone?: (entryIndex: number) => Promise<void>;
  /**
   * 插件装卸通道（R11）。不传 = 不恢复插件（老行为），报告里标 `not-requested`。
   *
   * 为什么显式注入而不是在这里 new 一个：装卸要起 pnpm 子进程（几十秒），
   * 单测要能在毫秒级跑完差异矩阵；生产由 sync-engine / analyzer 注入真实通道。
   */
  pluginPort?: PluginRollbackPort;
}

/** 逆序补偿单条快照条目；返回 null=成功，否则为失败原因 */
async function compensateOne(
  entry: SnapshotEntry,
  ctx: HostContext,
  store: SnapshotStore | undefined,
): Promise<{ reason: string; manualHint?: string } | null> {
  switch (entry.kind) {
    case 'settingsNamespace': {
      try {
        if (!entry.existed) {
          // 原目标不存在该 namespace：若导入已创建它，DSH settings 无删除语义 → 无法恢复「不存在」
          let current: unknown = null;
          try {
            current = await ctx.settings.describe(entry.ref);
          } catch {
            current = null;
          }
          if (current === null) return null; // 本来就没有且未创建 → 无需恢复
          return {
            reason: msgOf(ctx)('rollback.ns.createdNoDelete'),
            manualHint: msgOf(ctx)('rollback.ns.manualHint', { ref: entry.ref }),
          };
        }
        // 用当前 revision 作乐观锁基准：读时即锁，冲突则如实失败（不覆盖并发修改）
        const current = await ctx.settings.describe(entry.ref);
        await ctx.settings.replace(entry.ref, entry.before, current.revision);
        return null;
      } catch (err) {
        return { reason: err instanceof Error ? err.message : String(err), manualHint: msgOf(ctx)('rollback.ns.conflictHint', { ref: entry.ref }) };
      }
    }
    case 'credential': {
      if (entry.existed) {
        // 值不可回读：无法自动恢复原值
        return {
          reason: msgOf(ctx)('rollback.cred.noReadback'),
          manualHint: msgOf(ctx)('rollback.cred.manualHint', { ref: entry.ref }),
        };
      }
      try {
        await ctx.credentials.unset(entry.ref);
        return null;
      } catch (err) {
        return { reason: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'patchLine': {
      try {
        // 快照条目的 ref 是层限定复合键（<file>#<lineId>）——必须写回**同一层**，
        // 否则 profile 层的原值会被写进 home 层。旧快照的裸 lineId 兼容为 home 层。
        const { file, lineId } = parsePatchLayerKey(entry.ref);
        await ctx.patchFile.applyPatchChanges(file, [
          { lineId, raw: entry.before, action: entry.before === null ? 'remove' : 'update' },
        ]);
        return null;
      } catch (err) {
        return { reason: err instanceof Error ? err.message : String(err), manualHint: msgOf(ctx)('rollback.patch.manualHint', { ref: entry.ref }) };
      }
    }
    case 'file': {
      try {
        const abs = resolveFileTarget(ctx, entry.adapter, entry.ref);
        if (entry.existed && entry.copiedTo && store) {
          const data = await store.readBlob(entry.snapshotId ?? '', entry.copiedTo);
          await ctx.fs.writeFile(abs, data);
        } else if (!entry.existed) {
          // 原文件不存在 → 删除导入写入的文件
          if (await ctx.fs.exists(abs)) await ctx.fs.remove(abs);
        }
        return null;
      } catch (err) {
        return { reason: err instanceof Error ? err.message : String(err), manualHint: msgOf(ctx)('rollback.file.manualHint', { ref: entry.ref }) };
      }
    }
    case 'workspaceRecord': {
      try {
        if (entry.before === null) {
          await ctx.workspace.removeRecord?.(entry.ref);
        } else {
          await ctx.workspace.writeRecord(entry.before as never);
        }
        return null;
      } catch (err) {
        return { reason: err instanceof Error ? err.message : String(err), manualHint: msgOf(ctx)('rollback.workspace.manualHint', { ref: entry.ref }) };
      }
    }
    default:
      return { reason: msgOf(ctx)('rollback.unknownEntry', { kind: entry.kind }) };
  }
}

/** 回滚：逆序补偿全部条目；返回诚实报告（full / partial） */
export async function rollback(opts: RollbackOptions): Promise<RollbackReport> {
  const { ctx, snapshot, store, adapters, entryDone } = opts;
  const restored: string[] = [];
  const failed: RollbackReport['failed'] = [];

  // 逆序遍历；adapter 自带的 rollback? 优先，否则引擎通用补偿
  const entries = [...snapshot.entries].reverse();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const adapter = adapters?.find((a) => a.id === entry.adapter);
    let error: { reason: string; manualHint?: string } | null = null;
    if (adapter?.rollback) {
      try {
        await adapter.rollback([entry], ctx);
      } catch (err) {
        error = { reason: err instanceof Error ? err.message : String(err) };
      }
    } else {
      error = await compensateOne(entry, ctx, store);
    }
    // 回滚 WAL：每补偿一项记 entryDone（crash 后可判定进度）
    try {
      await opts.entryDone?.(index);
    } catch { /* WAL 写失败不阻断回滚（best-effort） */ }
    if (error === null) {
      restored.push(`${entry.adapter}:${entry.ref}`);
    } else {
      failed.push({ item: `${entry.adapter}:${entry.ref}`, reason: error.reason, manualHint: error.manualHint });
    }
  }

  // 插件补偿（R11）：**放在配置条目之后**。
  //
  // 顺序有讲究：配置先回到导入前，插件再跟上。反过来的话中间会出现
  // 「新插件 + 旧 patch 行」的组合 —— 那正是启动门禁要防的、可能让宿主起不来的状态。
  // 现在这个顺序最坏也只是「旧插件 + 旧配置」，是可启动的。
  //
  // 插件安装不产生快照条目，所以这段不参与上面的逆序遍历；差异来自 snapshot.beforePlugins。
  const pluginReport = opts.pluginPort === undefined
    ? undefined
    : await rollbackPlugins({
      before: snapshot.beforePlugins,
      port: opts.pluginPort,
      profile: ctx.profile ?? 'default',
    });

  if (pluginReport !== undefined) {
    for (const f of pluginReport.failed) {
      failed.push({ item: `plugin:${f.name}`, reason: f.reason, manualHint: f.hint });
    }
    for (const name of pluginReport.removed) restored.push(`plugin:${name} (removed)`);
    for (const entry of pluginReport.downgraded) restored.push(`plugin:${entry}`);
    for (const entry of pluginReport.restored) restored.push(`plugin:${entry}`);
  }

  return {
    full: failed.length === 0,
    restored,
    failed,
    ...(pluginReport === undefined
      ? { plugins: { downgraded: [], removed: [], restored: [], skipped: [], skippedReason: 'not-requested' as const } }
      : {
        plugins: {
          downgraded: pluginReport.downgraded,
          removed: pluginReport.removed,
          restored: pluginReport.restored,
          skipped: pluginReport.skipped,
          ...(pluginReport.skippedReason === undefined ? {} : { skippedReason: pluginReport.skippedReason }),
        },
      }),
  };
}

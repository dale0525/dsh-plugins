/**
 * self 分区 adapter（插件自身配置，设计「self 分区」）：
 * 数据源 = $DSH_HOME/dsh-config-manager/ 下的插件自身配置文件（白名单收集，非递归）：
 *   - sync/sync-config.json     同步通道配置（git repoUrl / webdav url+username；凭据值走 credentials 槽位，不含 secret）
 *   - sync/ui-prefs.json        插件 UI 偏好（如上次选择的同步通道；从 localStorage 迁入）
 *
 * 排除项：market/cache/（缓存）、
 * snapshots/（快照）、tmp/ exports/（临时/导出产物）——只备份「配置」，不备份数据。
 *
 * 实现：继承 FileCollectionAdapter 复用 analyzeImport/applyItem/validate（幂等 hash 比对、
 * 快照/回滚路径一致），仅覆写 export() 为白名单收集（self 目录内存在大量非配置子目录，
 * 不能像 skills/sessions 那样整体递归）。
 *
 * relativePath 一律是「相对 baseDir」的路径（如 sync/sync-config.json），与
 * FileCollectionAdapter 的基准目录语义一致：导入时按 path.join(baseDir, rel) 写回
 * $DSH_HOME/dsh-config-manager/<rel>；ZIP 内位于 self/<rel>。
 *
 * 安全不变量：配置文件本身不含凭据值（同步凭据走 DSH credentials 槽位引用），
 * 且文件类分区不进 SecretScanner（与 pluginFiles/skills 同语义）。
 */
import path from 'node:path';
import { msgOf } from '../core/messages.ts';
import type {
  ApplyResult, ExportOptions, ExportSection, HostContext, ImportContext, PlanItem,
} from '../core/types.ts';
import type { FilesSection } from '../schema/types.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { FileCollectionAdapter } from './file-collection.ts';

/** self 分区白名单文件（相对 baseDir，即 $DSH_HOME/dsh-config-manager/）。 */
export const SELF_CONFIG_FILES: readonly string[] = [
  'sync/sync-config.json',
  'sync/ui-prefs.json',
  // P0-④：导出产物备注清单（exports/.backup-notes.json）——随 self 分区迁移，
  // 换机器后备份列表仍能看到手动导出时填写的备注
  'exports/.backup-notes.json',
];

export class SelfAdapter extends FileCollectionAdapter {
  readonly id = 'self' as const;
  readonly displayName = 'Plugin Self Config';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  /** 插件自身配置目录（相对 homeDir；宿主按 dataDir 解析注入，缺省 dsh-config-manager） */
  readonly baseDir: string;

  constructor(baseDir = 'dsh-config-manager') {
    super();
    this.baseDir = baseDir;
  }

  /** 白名单收集：只导出配置类文件（存在才收），不递归（排除快照/历史/缓存/临时产物）。
   *  relativePath 产出相对 baseDir 的路径（与 analyzeImport/applyItem 的 path.join(baseDir, ref) 匹配）。 */
  override async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const warnings: string[] = [];
    for (const rel of SELF_CONFIG_FILES) {
      // ctx.fs.readFile 语义 = 相对 homeDir 的完整路径 → 拼接 baseDir；产出仍为相对 baseDir
      const data = await ctx.fs.readFile(path.join(this.baseDir, rel)).catch(() => null);
      if (data === null) continue; // 未创建过的配置文件跳过（如从未配置市场/同步）
      files.push({ relativePath: rel, data: stripLocalRole(rel, data), contentHash: sha256Hex(data) });
    }
    if (files.length === 0) {
      warnings.push(msgOf(ctx)('adapter.dirEmpty', { type: this.displayName }));
    }
    return {
      sectionId: this.id,
      data: { version: 1, files },
      counts: { files: files.length },
      warnings,
    };
  }

  /**
   * 导入：通道配置按快照写回，但**本机角色保持本机**。
   *
   * `sync/sync-config.json` 同时装着通道配置（要跨设备）和 `role`（要各设备独立）。
   * 直接整份写回会让一台改成 source 后、其他设备拉取也变 source，于是多台同时 push
   * 互相覆盖——这正是 `src/core/auto-sync.ts` 抬头声明「角色互相独立」时想避免的。
   * 所以这里把快照内容与目标机现有角色合并后再写：快照赢通道字段，本机赢 role。
   */
  override async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (ref === undefined || ref !== SYNC_CONFIG_REL) return super.applyItem(item, ctx);
    const data = ctx.sections.get(this.id) as FilesSection | undefined;
    const file = data?.files.find((f) => f.relativePath === ref);
    if (file === undefined) return super.applyItem(item, ctx);
    const merged = mergeLocalRole(file.data, await ctx.target.fs.readFile(path.join(this.baseDir, ref)).catch(() => null));
    if (merged === null) return super.applyItem(item, ctx);
    const patched: FilesSection = {
      version: data!.version,
      files: data!.files.map((f) => (f.relativePath === ref ? { ...f, data: merged } : f)),
    };
    const patchedCtx: ImportContext = { ...ctx, sections: new Map(ctx.sections).set(this.id, patched) };
    return super.applyItem(item, patchedCtx);
  }
}

/** 同步通道配置文件（相对 baseDir）：唯一一个需要「拆分合并」的文件。 */
const SYNC_CONFIG_REL = 'sync/sync-config.json';

/** 从导出内容里剥掉本机角色；非该文件 / 解析不了 → 原样返回。 */
function stripLocalRole(rel: string, data: Uint8Array): Uint8Array {
  if (rel !== SYNC_CONFIG_REL) return data;
  const parsed = parseObject(data);
  if (parsed === null || !('role' in parsed)) return data;
  delete parsed['role'];
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/**
 * 把快照里的通道配置与本机现有角色合并。
 *
 * @returns 合并后的字节；本机没有角色（全新机器）或快照/本机都不可解析时返回 null，
 *          让调用方退回整份写回（此时本来就没有角色要保护）。
 */
function mergeLocalRole(incoming: Uint8Array, local: Uint8Array | null): Uint8Array | null {
  if (local === null) return null;
  const localParsed = parseObject(local);
  if (localParsed === null || !('role' in localParsed)) return null;
  const incomingParsed = parseObject(incoming);
  if (incomingParsed === null) return null;
  incomingParsed['role'] = localParsed['role'];
  return Buffer.from(`${JSON.stringify(incomingParsed, null, 2)}\n`, 'utf8');
}

/** 解析成普通对象；不是 JSON 对象（含损坏）返回 null。 */
function parseObject(data: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

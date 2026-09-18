/**
 * m-sync-flow：push/pull 编排（SyncEngine）。
 *
 * push：createAdapters 逐个 export（includeSecrets=true，真实值）→ 组装 SyncSnapshot →
 *       本地散文件副本（复用 t2 layout，不写 ZIP）→ transport.upload → 更新 sync-state
 *       （每分区 hash + updatedAt + lastSyncAt + transport 绑定）。
 * pull：transport.list/download 取远端快照 → 转临时标准 ZIP（buildManifest + checksums，
 *       喂给 Importer）→ analyzeImport/createImportPlan 预览差异。
 *       绝不直接写配置、绝不执行导入（executeImportPlan 由上层按用户确认驱动）。
 *
 * 明文同步（产品语义）：同步通道是用户自有的私有通道，勾选即同步——
 * 不加密、不脱敏、不做 diff/合并。快照按实际内容如实标注 manifest.security.containsSecrets。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { defaultSecretScanner } from '../core/exporter.ts';
import { Importer } from '../core/importer.ts';
import type {
  ConfigAdapter, ExportSection, GlobalConflictStrategy, HostContext,
  ImportAnalysis, ImportPlan, ImportResult, PlanItem, PlanItemKind,
} from '../core/types.ts';
import { isFileSection, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import type { FilesSection, Platform, SectionData, SectionId } from '../schema/types.ts';
import { CURRENT_SCHEMA_VERSION } from '../schema/versions.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { writeZip } from '../utils/zip.ts';
import type { ZipWriteEntry } from '../utils/zip.ts';
import { createSnapshotFs, joinFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';
import { writeSnapshotToDir } from './layout.ts';
import { hashSection, loadSyncState, saveSyncState } from './sync-state.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { isEncryptedSections } from './transport.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { createSnapshot } from '../core/backup.ts';
import { rollback } from '../core/rollback.ts';
import { FileSnapshotStore } from '../core/backup.ts';
import type { Snapshot, SnapshotStore, TransactionSnapshotContext } from '../core/types.ts';
import type { PlanItemProgress } from '../core/analyzer.ts';

export interface SyncEngineOptions {
  ctx: HostContext;
  transport: SyncTransport;
  /** sync-state.json 所在目录 */
  stateDir: string;
  /** 分区 adapter 列表（缺省 createAdapters()；宿主应注入 namespaces 等） */
  adapters?: ConfigAdapter[];
  /** pull 需要；不注入则 pull 抛错（push 不受影响） */
  importer?: Importer;
  now?: () => Date;
  /** 快照 id 生成器（缺省 sync-<uuid>；须符合通道安全字符集） */
  snapshotId?: () => string;
  /** 记录到 sync-state.transport.ref（如 git 分支名） */
  transportRef?: string;
  /** 本地散文件快照副本目录（push 落盘审计副本；不传则跳过本地落盘） */
  localSnapshotsDir?: string;
  /** 一键回滚兜底快照目录（apply-items 落盘；缺省 <stateDir>/snapshots，
   *  与 Host /sync/rollback 路由读取的目录保持一致，否则回滚找不到 snapshot.json） */
  rollbackSnapshotsDir?: string;
  /** pull 临时 ZIP 目录（缺省 os.tmpdir()） */
  zipDir?: string;
  exporterVersion?: string;
  fsx?: SnapshotFs;
  /** 消息翻译器（缺省 ctx.msg ?? zh） */
  msg?: MsgFunc;
  /**
   * 同步范围（自定义同步模式持久化配置）：只处理这些分区。
   * 缺省 = 全部推荐分区。应用于 push / pull 等全部链路，供自动同步等后台流程复用
   * 用户选择；手动请求仍可用 push(opts.sections) 覆盖。
   */
  sections?: SectionId[];
}

export interface SyncPushOptions {
  /** 覆盖自动生成的快照 id */
  snapshotId?: string;
  /** 仅同步指定分区（缺省 = 全部推荐分区）。
   *  传入未知分区 → 忽略并告警（不静默吞掉）。 */
  sections?: SectionId[];
}

export interface SyncPullOptions {
  /** 指定远端快照 id（缺省 = 最新） */
  snapshotId?: string;
  /** 冲突全局策略（缺省 replace：勾选即同步，远端值直接覆盖本地，不做 diff/合并） */
  strategy?: GlobalConflictStrategy;
}

export interface SyncPushReport {
  ok: boolean;
  snapshotId: string;
  /** 实际进入同步的分区 */
  sections: SectionId[];
  /** 分区级告警（单项失败不拖垮整体，§34.17 语义） */
  warnings: string[];
  message?: string;
}

/** 差异报告中的单个变更项（PlanItem 摘要，不含敏感细节） */
export interface PullChange {
  id: string;
  adapter: SectionId;
  kind: PlanItemKind;
  description: string;
  severity: PlanItem['severity'];
}

export interface SyncPullReport {
  ok: boolean;
  snapshotId: string;
  changes: PullChange[];
  /** 是否存在需要人工决策的项（Conflict / MissingSecret / MissingDependency / 路径问题）。 */
  needsReview: boolean;
  message?: string;
}

/** push 前只读预览 ——「将推送什么」的单分区摘要（不写远端、不落盘）。 */
export interface SyncPushPreviewSection {
  /** 分区 id（将进入快照的分区） */
  section: SectionId;
  /** 分区内条目计数（adapter.export 的 counts 聚合；无计数时为 0） */
  count: number;
  /** 相对上次基线（sync-state）是否变化：true = 本次会更新该分区；false = 与基线一致 */
  changed: boolean;
}

/** push 前预览结果（零写入）。 */
export interface SyncPushPreview {
  ok: boolean;
  /** 将推送的分区清单（含计数与变化标记） */
  sections: SyncPushPreviewSection[];
  /** 远端现有快照数（0 = 首次推送将创建首个基线） */
  remoteSnapshotCount: number;
  message?: string;
}

/** 一键 sync 预览结果（preview() 返回；临时 ZIP 由调用方持有并负责清理）。 */
export interface SyncPreviewResult {
  ok: boolean;
  /** 临时标准 ZIP 路径（apply-items 复用 executeImportPlan 需要；调用方清理） */
  zipPath: string;
  plan: ImportPlan | null;
  analysis: ImportAnalysis | null;
  snapshotId: string;
  message?: string;
}

/** applyItems 报告（§3.4 ApplyItemsResponse 的服务端形态） */
export interface ApplyItemsReport {
  ok: boolean;
  /** 实际写入的分区 id 列表（去重） */
  applied: string[];
  /** 未采纳的 itemId 列表 */
  skipped?: string[];
  /** 应用前快照 id（UI 一键回滚用；失败时仍透传以便排查） */
  restoreId: string;
  /** 任一失败是否整体回滚 */
  rolledBack: boolean;
  warnings: string[];
  failed: { itemId: string; message?: string }[];
  /** 透传 executeImportPlan 结果 */
  result: ImportResult | null;
  needsRestart?: boolean;
}

/**
 * 远端快照保留数量上限：每次 push 上传成功后对远端裁剪，
 * 保留最新 N 个（按 createdAt 升序的最末 N 个，含刚 push 的），更旧的逐个删除。
 * 只按数量裁剪，不按时间窗口。删除失败只告警（进 push 的 warnings），不上抛阻断主流程。
 */
export const MAX_REMOTE_SNAPSHOTS = 10;

export class SyncEngine {
  private readonly ctx: HostContext;
  private readonly transport: SyncTransport;
  private readonly stateDir: string;
  private readonly adapters: ConfigAdapter[];
  private readonly importer: Importer | undefined;
  private readonly now: () => Date;
  private readonly snapshotIdFn: () => string;
  private readonly transportRef: string;
  private readonly localSnapshotsDir: string | undefined;
  private readonly rollbackSnapshotsDir: string;
  private readonly zipDir: string;
  private readonly exporterVersion: string;
  private readonly fsx: SnapshotFs;
  private readonly msg: MsgFunc;
  private readonly sections: readonly SectionId[] | undefined;

  constructor(opts: SyncEngineOptions) {
    if (opts.ctx === null || typeof opts.ctx !== 'object') throw new Error(zhMsg('sync.missingCtx'));
    if (opts.transport === null || typeof opts.transport !== 'object'
      || typeof opts.transport.upload !== 'function' || typeof opts.transport.list !== 'function'
      || typeof opts.transport.download !== 'function' || typeof opts.transport.delete !== 'function') {
      throw new Error(zhMsg('sync.missingTransport'));
    }
    if (typeof opts.stateDir !== 'string' || opts.stateDir.length === 0) {
      throw new Error(zhMsg('sync.missingStateDir'));
    }
    this.ctx = opts.ctx;
    this.transport = opts.transport;
    this.stateDir = opts.stateDir;
    this.adapters = opts.adapters ?? createAdapters();
    this.importer = opts.importer;
    this.now = opts.now ?? (() => new Date());
    this.snapshotIdFn = opts.snapshotId ?? (() => `sync-${crypto.randomUUID()}`);
    this.transportRef = opts.transportRef ?? '';
    this.localSnapshotsDir = opts.localSnapshotsDir;
    this.rollbackSnapshotsDir = opts.rollbackSnapshotsDir ?? path.join(opts.stateDir, 'snapshots');
    this.zipDir = opts.zipDir ?? os.tmpdir();
    this.exporterVersion = opts.exporterVersion ?? '0.1.0';
    this.fsx = opts.fsx ?? createSnapshotFs();
    this.msg = opts.msg ?? msgOf(opts.ctx);
    this.sections = opts.sections !== undefined && opts.sections.length > 0 ? [...opts.sections] : undefined;
  }

  /** 参与同步的分区全集：构造注入 sections（同步范围）时按注入范围过滤 ——
   *  自动同步等后台流程 push/pull 全链路复用用户选择；手动请求仍可用 push(opts.sections) 覆盖。 */
  private syncAdapters(): ConfigAdapter[] {
    if (this.sections === undefined) return this.adapters;
    const wanted = new Set(this.sections);
    return this.adapters.filter((a) => wanted.has(a.id));
  }

  /** 未显式传 sections 时的默认范围。
   *
   *  - 构造注入 sections（高级模式：用户已在 UI 勾选并持久化）→ 该选择**就是**默认范围，
   *    不再按 defaultIncluded 收窄（否则高级模式勾选的 sessions/pluginFiles 会被悄悄剔除）；
   *  - 未注入（默认模式「快速导出」）→ 只取推荐分区 defaultIncluded。
   *
   *  defaultIncluded=false 的分区（sessions 含历史会话明文、pluginFiles）语义是「用户显式
   *  勾选才同步」；把它们并进默认模式的范围会绕过 UI 勾选与「将同步 N 个推荐分区」计数，
   *  把敏感内容静默推到远端通道。 */
  private defaultTargets(): ConfigAdapter[] {
    if (this.sections !== undefined) return this.syncAdapters();
    return this.adapters.filter((a) => a.defaultIncluded);
  }

  /**
   * push 候选 adapter：
   * - sections 缺省/空 → 全部推荐分区（defaultIncluded）；
   * - sections 显式给出 → 从**全部已挂载分区**取命中项（显式勾选可触达 defaultIncluded=false
   *   的分区，这正是「默认关闭」的含义）；未知分区 → 警告跳过（不静默，用户能看见自己勾了哪个无效项）。
   */
  private pushTargets(sections: readonly SectionId[] | undefined, warnings: string[]): ConfigAdapter[] {
    if (sections === undefined || sections.length === 0) return this.defaultTargets();
    const available = this.syncAdapters();
    const byId = new Map(available.map((a) => [a.id, a]));
    const out: ConfigAdapter[] = [];
    for (const id of sections) {
      const adapter = byId.get(id);
      if (adapter === undefined) {
        warnings.push(this.msg('sync.unknownSection', { section: id }));
        continue;
      }
      out.push(adapter);
    }
    return out;
  }

  /**
   * 快照读取准备（download 后、使用前）：
   * 加密快照（manifest.encrypted）→ 明确拒绝：同步通道已不再产生加密快照，
   * 旧加密快照无法用当前引擎读取（拒绝静默当明文处理）。
   */
  private async prepareSnapshot(snapshot: SyncSnapshot): Promise<void> {
    if (snapshot.manifest.encrypted === true || isEncryptedSections(snapshot.sections)) {
      throw new Error(this.msg('sync.legacyEncryptedSnapshot', { id: snapshot.id }));
    }
  }

  /**
   * push：导出分区（真实值）→ 组装快照 → 本地散文件副本 → transport.upload → 更新 sync-state。
   * 单项分区导出失败只告警跳过（§34.17），全部失败才整体失败。
   * opts.sections：指定仅同步这些分区（自定义模式）；缺省 = 全部推荐分区。
   */
  async push(opts: SyncPushOptions = {}): Promise<SyncPushReport> {
    const warnings: string[] = [];
    const plainSections: Partial<Record<SectionId, SectionData>> = {};
    const targets = this.pushTargets(opts.sections, warnings);
    for (const adapter of targets) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: true });
      } catch (err) {
        warnings.push(this.msg('sync.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      warnings.push(...section.warnings);
      plainSections[adapter.id] = section.data as SectionData;
    }

    if (Object.keys(plainSections).length === 0) {
      return { ok: false, snapshotId: '', sections: [], warnings, message: this.msg('sync.noSections') };
    }

    const nowIso = this.now().toISOString();
    const id = opts.snapshotId ?? this.snapshotIdFn();
    const containsSecrets = sectionsCarrySecrets(plainSections);
    const snapshot: SyncSnapshot = {
      id,
      createdAt: nowIso,
      manifest: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dshVersion: this.ctx.dshVersion,
        platform: this.ctx.platform as Platform,
        sectionIds: Object.keys(plainSections) as SectionId[],
        containsSecrets,
        // 记录触发通道（git/webdav），供同步历史展示「由哪个通道触发」
        transport: this.transport.type,
      },
      sections: plainSections,
    };

    // ① 本地散文件快照副本（审计；复用 t2 layout，不写 ZIP）
    if (this.localSnapshotsDir !== undefined) {
      await writeSnapshotToDir(snapshot, joinFs(this.localSnapshotsDir, id), this.fsx);
    }
    // ② 上传远端（传输通道负责散文件落盘 + 提交推送）
    await this.transport.upload(snapshot);
    // ②·1 裁剪远端快照：保留最新 MAX_REMOTE_SNAPSHOTS 个（含刚 push 的）。
    //      删除失败只告警（进 warnings），不上抛 —— 不阻断 push 主流程。
    await this.pruneRemoteSnapshots(id, warnings);
    // ③ 记录基线：写 sync-state（lastSnapshotId + 每分区 hash/updatedAt + lastSyncAt + transport）
    await this.recordBaseline(id, plainSections, nowIso);

    return { ok: true, snapshotId: id, sections: Object.keys(plainSections) as SectionId[], warnings };
  }

  /**
   * push 前只读预览「将推送什么」—— 零写入、零远端变更：
   *  - 导出目标分区（与 push 同口径：sections 过滤）；
   *  - 逐分区相对上次基线（sync-state.sections hash）的 changed 标记；
   *  - 远端现有快照数（list 只读；首次推送 = 0）。
   * 任何失败都不写任何内容；预览只是 push 的「确认前说明书」。
   */
  async previewPush(opts: SyncPushOptions = {}): Promise<SyncPushPreview> {
    const warnings: string[] = [];
    const targets = this.pushTargets(opts.sections, warnings);
    const plainSections: Partial<Record<SectionId, SectionData>> = {};
    const counts: Partial<Record<SectionId, number>> = {};
    for (const adapter of targets) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: true });
      } catch (err) {
        warnings.push(this.msg('sync.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      plainSections[adapter.id] = section.data as SectionData;
      counts[adapter.id] = section.counts ? Object.values(section.counts).reduce((a, b) => a + b, 0) : 0;
    }
    if (Object.keys(plainSections).length === 0) {
      return { ok: false, sections: [], remoteSnapshotCount: 0, message: this.msg('sync.noSections') };
    }

    // 基线对比：sync-state.sections 存每分区 hash；缺基线分区 → 视为新增
    let baselineHashes: Record<string, string> = {};
    try {
      const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
      baselineHashes = state.sections as Record<string, string>;
    } catch {
      baselineHashes = {};
    }
    const sections: SyncPushPreviewSection[] = Object.keys(plainSections).map((sid) => {
      const id = sid as SectionId;
      const changed = baselineHashes[id] === undefined || baselineHashes[id] !== hashSection(plainSections[id] as SectionData);
      return { section: id, count: counts[id] ?? 0, changed };
    });

    let remoteSnapshotCount = 0;
    try {
      const metas = await this.transport.list();
      remoteSnapshotCount = metas.length;
    } catch {
      // list 失败只影响展示（首次推送提示），不阻断预览
    }
    return { ok: true, sections, remoteSnapshotCount, message: warnings.length > 0 ? warnings.join('; ') : undefined };
  }

  /**
   * 裁剪远端快照：调用 transport.list() 获取全部快照（按 createdAt 升序），
   * 保留最新 MAX_REMOTE_SNAPSHOTS 个（含刚 push 的 pushedId），对更旧的逐个调用 transport.delete()。
   * 只按数量裁剪，不按时间窗口。
   *
   * 失败语义：list/delete 失败均只 push 进 warnings，不上抛 —— 裁剪是「尽力而为」的后台整理，
   * 绝不影响 push 主流程的成功与否（§34.17 分区级告警同款语义）。
   */
  private async pruneRemoteSnapshots(pushedId: string, warnings: string[]): Promise<void> {
    let metas: SyncSnapshotMeta[];
    try {
      metas = await this.transport.list();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(this.msg('sync.pruneListFailed', { reason }));
      return;
    }
    if (metas.length <= MAX_REMOTE_SNAPSHOTS) return;
    // 升序最末 N 个保留；刚 push 的快照（createdAt 最新）必在其中，防御性也把它计入保留集
    const keep = new Set(metas.slice(-MAX_REMOTE_SNAPSHOTS).map((m) => m.id));
    keep.add(pushedId);
    for (const m of metas) {
      if (keep.has(m.id)) continue;
      try {
        await this.transport.delete(m.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        warnings.push(this.msg('sync.pruneDeleteFailed', { id: m.id, reason }));
      }
    }
  }

  /**
   * pull：拉取远端最新（或指定）快照 → 转临时标准 ZIP →
   * 复用 Importer 预览流程（analyzeImport/createImportPlan）产出差异报告。
   * 绝不直接写配置、绝不执行导入；执行由上层按用户确认后走 Importer.executeImportPlan。
   */
  async pull(opts: SyncPullOptions = {}): Promise<SyncPullReport> {
    if (!this.importer) {
      throw new Error(this.msg('sync.missingImporter'));
    }
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { ok: true, snapshotId: '', changes: [], needsReview: false, message: this.msg('sync.remoteEmpty') };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新
    const snapshot = await this.transport.download(targetId);
    await this.prepareSnapshot(snapshot);

    const knownIds = new Set(this.syncAdapters().map((a) => a.id));
    const zipPath = await this.snapshotToZip(snapshot, knownIds);
    try {
      const analysis = await this.importer.analyzeImport(zipPath);
      const plan = await this.importer.createImportPlan(zipPath, {
        strategy: opts.strategy ?? 'replace',
        resolutions: {},
        pathMappings: [],
      });
      const changes: PullChange[] = plan.items.map((i) => ({
        id: i.id,
        adapter: i.adapter,
        kind: i.kind,
        description: i.description,
        severity: i.severity,
      }));
      const needsReview =
        plan.items.some((i) =>
          i.kind === 'Conflict' || i.kind === 'MissingSecret' || i.kind === 'MissingDependency'
          || i.kind === 'Error')
        || analysis.pathIssues.length > 0;
      const message = changes.length === 0
        ? this.msg('sync.unchanged')
        : this.msg('sync.changesSummary', { compatibility: analysis.compatibility, count: String(changes.length) });
      return { ok: analysis.valid, snapshotId: targetId, changes, needsReview, message };
    } finally {
      await fs.rm(path.dirname(zipPath), { recursive: true, force: true });
    }
  }

  /** 列出远端已有快照（按 createdAt 升序）—— 供「选择历史快照」下拉。 */
  async listSnapshots(): Promise<SyncSnapshotMeta[]> {
    return this.transport.list();
  }

  /**
   * 远端是否出现比本地共同祖先（sync-state.lastSnapshotId）更新的快照（§3.2「检测到远端新快照」）。
   * - 远端为空 → false（无物可拉）；
   * - 本地从未同步（lastSnapshotId=''）且远端非空 → true（首次可拉）；
   * - 否则比较远端最新快照 id 与 lastSnapshotId。
   * 只读远端列表（transport.list），不做下载/合并。
   */
  async hasNewRemoteSnapshot(): Promise<boolean> {
    const metas = await this.transport.list();
    if (metas.length === 0) return false;
    const latestId = metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新在末
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    if (state.lastSnapshotId === '') return true;
    return latestId !== state.lastSnapshotId;
  }

  /**
   * 本地配置当前内容与上次基线（sync-state.sections hash）相比是否有变化（§3.1 上传「看变化」）。
   * - 从未同步（sync-state.sections 为空）→ true；
   * - 任一分区当前导出 hash ≠ 基线 hash → true；
   * - 全部一致 → false（无本地改动，不上传）。
   * 只读本地导出 + sync-state，不写任何东西、不碰远端。
   */
  async hasLocalChanges(): Promise<boolean> {
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    if (Object.keys(state.sections).length === 0) return true;
    // 必须与 push 的默认范围同源：基线只记录 push 实际上传的分区，
    // 若此处遍历更大的集合，未上传分区会因「基线缺该分区」恒判为有改动。
    for (const adapter of this.defaultTargets()) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: true });
      } catch {
        continue; // 单项导出失败不影响判定（与 push 单项跳过语义一致）
      }
      const recorded = state.sections[adapter.id];
      if (recorded === undefined) return true; // 基线缺该分区 → 视为有变化
      if (recorded.hash !== hashSection(section.data as SectionData)) return true;
    }
    return false;
  }

  /**
   * 一键同步预览：拉取远端（最新或指定历史快照）→ 转临时 ZIP → Importer 分析出计划。
   * 与 pull 的区别：临时 ZIP **不清理**（由调用方 / 会话持有，供 apply-items 复用），
   * 并返回完整 plan/analysis/snapshotId 供会话登记。
   * 调用方负责在会话消费或取消后清理 zipPath 所在目录。
   */
  async preview(opts: SyncPullOptions = {}): Promise<SyncPreviewResult> {
    if (!this.importer) {
      throw new Error(this.msg('sync.missingImporter'));
    }
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { ok: false, zipPath: '', plan: null, analysis: null, snapshotId: '', message: this.msg('sync.remoteEmpty') };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id;
    const snapshot = await this.transport.download(targetId);
    await this.prepareSnapshot(snapshot);
    const knownIds = new Set(this.syncAdapters().map((a) => a.id));
    const zipPath = await this.snapshotToZip(snapshot, knownIds);
    const analysis = await this.importer.analyzeImport(zipPath);
    const plan = await this.importer.createImportPlan(zipPath, {
      strategy: opts.strategy ?? 'replace',
      resolutions: {},
      pathMappings: [],
    });
    return { ok: analysis.valid, zipPath, plan, analysis, snapshotId: targetId, message: undefined };
  }

  /**
   * 记录基线：写本地快照副本 + 更新 sync-state
   * （lastSnapshotId、每分区 hash/updatedAt、lastSyncAt、transport）。
   * 通常由 push() 在上传成功后调用，也可被上层（apply-items 完成后）显式调用。
   */
  async recordBaseline(
    snapshotId: string,
    sections: SyncSnapshot['sections'],
    nowIso?: string,
  ): Promise<void> {
    const ts = nowIso ?? this.now().toISOString();
    if (this.localSnapshotsDir !== undefined && !isEncryptedSections(sections)) {
      const plain = sections as Partial<Record<SectionId, SectionData>>;
      const snapshot: SyncSnapshot = {
        id: snapshotId,
        createdAt: ts,
        manifest: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          dshVersion: this.ctx.dshVersion,
          platform: this.ctx.platform as Platform,
          sectionIds: Object.keys(plain) as SectionId[],
          containsSecrets: sectionsCarrySecrets(plain),
          // 记录触发通道（git/webdav），供同步历史展示「由哪个通道触发」
          transport: this.transport.type,
        },
        sections: plain,
      };
      await writeSnapshotToDir(snapshot, joinFs(this.localSnapshotsDir, snapshotId), this.fsx);
    }
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    state.lastSnapshotId = snapshotId;
    state.lastSyncAt = ts;
    state.transport = { type: this.transport.type, ref: this.transportRef };
    for (const [sid, data] of Object.entries(sections)) {
      state.sections[sid as SectionId] = { hash: hashSection(data as SectionData), updatedAt: ts };
    }
    await saveSyncState(this.stateDir, state, this.fsx);
  }

  /**
   * applyItems：按用户对差异项的逐项决策执行导入（§3.4/§5.3）。
   *
   * 接收「会话级临时 ZIP + 子计划」，直接执行
   * （backup.createSnapshot 兜底 → importer.executeImportPlan → 成功 recordBaseline / 失败 rollback）。
   *
   * @param zipPath 会话级临时标准 ZIP（由 sync 预览生成，包含采纳项的 payload）
   * @param subPlan 子计划（仅含采纳项的 ImportPlan；globalStrategy/pathMappings/needsRestart 沿用会话 plan）
   * @param opts 执行选项（onItem 进度回调）
   * @returns ApplyItemsReport（ok/applied/restoreId/rolledBack/warnings/result）
   */
  async applyItems(
    zipPath: string,
    subPlan: ImportPlan,
    opts: {
      onItem?: (info: PlanItemProgress) => void;
      /** Phase 4 生产 journal↔snapshot 绑定（deferred；透传给 Importer.executeImportPlan） */
      snapshotBinding?: TransactionSnapshotContext;
      /**
       * 本次应用的**远端快照 id**（preview() 返回值）。
       *
       * 必须传：基线（sync-state.lastSnapshotId）要与「刚刚应用的远端快照」对齐，
       * 否则 `hasNewRemoteSnapshot()` 会把同一个远端快照一直判定为「新的」，
       * 自动同步每轮都会重复拉取同一个快照（空转）。
       * 缺省（不传）时才回退到本地新生成的 id —— 仅适用于「本地产生的快照」语义。
       */
      snapshotId?: string;
    } = {},
  ): Promise<ApplyItemsReport> {
    if (!this.importer) {
      throw new Error('applyItems: SyncEngine 缺少 importer（需在 options 中注入）');
    }
    if (subPlan.items.length === 0) {
      return { ok: true, applied: [], restoreId: '', rolledBack: false, warnings: [], failed: [], result: null };
    }

    // 兜底快照（拿到 restoreId 给 UI 一键回滚用）
    const store: SnapshotStore = new FileSnapshotStore({ dir: this.rollbackSnapshotsDir });
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await createSnapshot({
        ctx: this.ctx,
        plan: subPlan,
        sourceZip: zipPath,
        store,
        adapters: this.adapters,
      });
    } catch (backupErr) {
      return {
        ok: false,
        applied: [],
        restoreId: '',
        rolledBack: false,
        warnings: [`应用前快照失败：${backupErr instanceof Error ? backupErr.message : String(backupErr)}`],
        failed: subPlan.items.map((i) => ({ itemId: i.id })),
        result: null,
      };
    }

    // 真正执行：Importer.executeImportPlan（confirm:true + rollbackOnError:true → 任一失败整体回滚）
    const result = await this.importer.executeImportPlan(zipPath, subPlan, {
      confirm: true,
      rollbackOnError: true,
      secretInputs: undefined,
      decryptedCredentials: undefined,
      onItem: opts.onItem,
      snapshotBinding: opts.snapshotBinding,
    });

    if (!result.ok) {
      // executeImportPlan 已内部回滚（rollbackOnError）；这里再显式 rollback 兜底（幂等）
      try { await rollback({ ctx: this.ctx, snapshot, store, adapters: this.adapters }); } catch { /* noop */ }
      return {
        ok: false,
        applied: [],
        restoreId: snapshot.id,
        rolledBack: true,
        warnings: result.warnings ?? [],
        failed: result.executed.filter((e) => e.status === 'failed').map((e) => ({ itemId: e.itemId, message: e.message })),
        result,
      };
    }

    // 成功：recordBaseline 更新基线（应用后的快照）
    const appliedIds = [...new Set(subPlan.items.map((i) => i.adapter))];
    const mergedSections: Partial<Record<SectionId, SectionData>> = {};
    for (const adapter of this.syncAdapters()) {
      if (!appliedIds.includes(adapter.id)) continue;
      try {
        const section = await adapter.export(this.ctx, { includeSecrets: true });
        mergedSections[adapter.id] = section.data as SectionData;
      } catch {
        // 单个分区导出失败不拖垮 recordBaseline（已应用的分区数据从 subPlan 兜底）
      }
    }
    // 基线指向「刚应用的远端快照」；缺省才回退本地新 id（见 opts.snapshotId 注释）
    const snapshotId = opts.snapshotId !== undefined && opts.snapshotId !== '' ? opts.snapshotId : this.snapshotIdFn();
    await this.recordBaseline(snapshotId, mergedSections);

    return {
      ok: true,
      applied: appliedIds,
      skipped: subPlan.items.filter((i) => i.kind === 'Skip').map((i) => i.id),
      restoreId: snapshot.id,
      rolledBack: false,
      warnings: result.warnings ?? [],
      failed: [],
      needsRestart: result.needsRestart,
      result,
    };
  }

  /** 散文件快照 → 标准导出 ZIP（临时目录，用完即删）：buildManifest + checksums + 平铺分区 */
  private async snapshotToZip(snapshot: SyncSnapshot, knownIds: Set<SectionId>): Promise<string> {
    // 防御：加密快照必须已由调用方拒绝（prepareSnapshot）；此处不处理密文载荷
    if (isEncryptedSections(snapshot.sections)) {
      throw new Error('快照仍为加密载荷，无法转 ZIP');
    }
    const entries: ZipWriteEntry[] = [];
    const sectionFlags = {} as Record<SectionId, boolean>;
    for (const sid of knownIds) {
      const data = snapshot.sections[sid];
      if (data === undefined) continue;
      sectionFlags[sid] = true;
      if (isFileSection(sid)) {
        const prefix = SECTION_FILE_PREFIXES[sid]!;
        const files = (data as FilesSection).files ?? [];
        for (const f of files) {
          entries.push({ name: `${prefix}${f.relativePath}`, data: f.data });
        }
      } else {
        const jsonPath = SECTION_JSON_PATHS[sid];
        if (jsonPath === undefined) continue;
        entries.push({ name: jsonPath, data: Buffer.from(stringifyJsonSafe(data, { space: 2 }), 'utf8') });
      }
    }
    const manifest = buildManifest({
      exporterVersion: this.exporterVersion,
      dshVersion: snapshot.manifest.dshVersion,
      platform: snapshot.manifest.platform as Platform,
      arch: 'unknown', // ManifestSummary 不含 arch；仅影响展示，不影响导入决策
      sections: sectionFlags,
      containsSecrets: snapshot.manifest.containsSecrets === true,
      encrypted: false,
      encryption: null,
      exportedAt: snapshot.createdAt,
    });
    // checksums：覆盖除 manifest/checksums 外全部条目（与 exporter 一致）
    const contentEntries = entries.filter((e) => e.name !== MANIFEST_FILE && e.name !== CHECKSUMS_FILE);
    entries.push({
      name: CHECKSUMS_FILE,
      data: Buffer.from(stringifyJsonSafe(buildChecksums(contentEntries), { space: 2 }), 'utf8'),
    });
    entries.push({ name: MANIFEST_FILE, data: Buffer.from(stringifyJsonSafe(manifest, { space: 2 }), 'utf8') });

    const dir = await fs.mkdtemp(path.join(this.zipDir, 'dsh-sync-pull-'));
    const zipPath = path.join(dir, 'snapshot.zip');
    await writeZip(zipPath, entries);
    return zipPath;
  }
}

/**
 * 快照是否实际携带凭据值：复用 exporter 的敏感字段扫描器（单一真源，不另造字段表）。
 * 用于如实标注 manifest.security.containsSecrets —— 标注必须与内容一致，
 * 否则「含明文却标注 false」会让下游按「无秘密」处理。
 */
export function sectionsCarrySecrets(sections: Partial<Record<SectionId, SectionData>>): boolean {
  const scanner = defaultSecretScanner();
  return Object.values(sections).some((data) => scanner.scanAndRedact(data).hits.length > 0);
}

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
  ConfigAdapter, ExportSection, HostContext,
  ImportAnalysis, ImportPlan, ImportResult, PlanItem, PlanItemKind,
} from '../core/types.ts';
import { credentialsCarryValues, isFileSection, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
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
}

export interface SyncPushOptions {
  /** 覆盖自动生成的快照 id */
  snapshotId?: string;
}

/**
 * 同步范围中恒被排除的分区：
 *  - `workspaces`：平台相关（含绝对路径），换机后无意义；
 *  - `sessions`：设备相关（历史会话，含敏感内容，体积可达数百 MB）。
 * 其余分区一律参与同步（含 pluginFiles 与 plugins 分区携带的 cordis.patch.yml）。
 */
export const EXCLUDED_SYNC_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>([
  'workspaces',
  'sessions',
])

export interface SyncPullOptions {
  /** 指定远端快照 id（缺省 = 最新） */
  snapshotId?: string;
  /** Phase 4 生产 journal↔snapshot 绑定（宿主 gate 注入；透传给 applyItems） */
  snapshotBinding?: TransactionSnapshotContext;
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

/** 拉取预览结果（preview() 返回；临时 ZIP 由调用方持有并负责清理）。 */
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
 * 拉取并直接覆盖本地的报告（「拉取」按钮的唯一语义：远端值覆盖本地，不询问）。
 * 复用 applyItems 的执行结果，并附上「应用前算出的变更摘要」供 UI 如实展示覆盖了什么。
 */
export interface SyncPullApplyReport {
  ok: boolean;
  snapshotId: string;
  /** 本次实际写入本地的分区 */
  applied: SectionId[];
  /** 远端快照相对本地的变更摘要（应用前计算；仅展示用，不含敏感值） */
  changes: PullChange[];
  /** 应用前强制落盘的回滚快照 id（UI 一键回滚用） */
  restoreId: string;
  /** 失败时是否已整体回滚 */
  rolledBack: boolean;
  warnings: string[];
  failed: { itemId: string; message?: string }[];
  needsRestart: boolean;
  message?: string;
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
  }

  /**
   * 参与同步的分区全集（push / pull 全链路唯一范围来源）。
   *
   * 取消同步模式选择后，范围恒为「除 workspaces / sessions 外的全部已挂载分区」：
   * 这两类分别是**平台相关**（含绝对路径，换机无意义）与**设备相关**（历史会话，
   * 含敏感内容且体积可达数百 MB），属于跨设备同步的固有噪声，不随用户配置变化。
   * 其余分区（含 pluginFiles 与 cordis.patch.yml 所在的 plugins 分区）一律同步。
   */
  private syncAdapters(): ConfigAdapter[] {
    return this.adapters.filter((a) => !EXCLUDED_SYNC_SECTIONS.has(a.id));
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
   * 同步范围恒为 syncAdapters()（除 workspaces / sessions 外的全部分区）。
   */
  async push(opts: SyncPushOptions = {}): Promise<SyncPushReport> {
    const warnings: string[] = [];
    const plainSections: Partial<Record<SectionId, SectionData>> = {};
    const targets = this.syncAdapters();
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

    // ① 上传远端（传输通道负责散文件落盘 + 提交推送）
    await this.transport.upload(snapshot);
    // ①·1 裁剪远端快照：保留最新 MAX_REMOTE_SNAPSHOTS 个（含刚 push 的）。
    //      删除失败只告警（进 warnings），不上抛 —— 不阻断 push 主流程。
    await this.pruneRemoteSnapshots(id, warnings);
    // ② 记录基线：写本地散文件副本 + sync-state（lastSnapshotId + 每分区 hash/updatedAt
    //    + lastSyncAt + transport）。本地副本只在这里落一次盘 —— 快照树是 2000+ 文件的
    //    大目录，写两遍等于把 push 的本地 I/O 翻倍，而两份内容逐字节相同。
    await this.recordBaseline(id, plainSections, nowIso);

    return { ok: true, snapshotId: id, sections: Object.keys(plainSections) as SectionId[], warnings };
  }

  /**
   * 拉取并**直接覆盖本地**（「拉取」按钮的唯一语义）：
   * 下载远端最新快照 → 转临时 ZIP → Importer 分析出计划（strategy=replace：冲突项一律
   * 采用远端值）→ applyItems 执行（应用前强制落回滚快照；任一失败整体回滚）。
   *
   * 不询问、不逐项确认：远端值覆盖本地是本插件的产品语义（私有通道自用）。
   * 临时 ZIP 用完即删。
   */
  async pullAndApply(opts: SyncPullOptions = {}): Promise<SyncPullApplyReport> {
    const preview = await this.preview(opts);
    const changes: PullChange[] = (preview.plan?.items ?? []).map((i) => ({
      id: i.id,
      adapter: i.adapter,
      kind: i.kind,
      description: i.description,
      severity: i.severity,
    }));
    if (!preview.ok || preview.plan === null) {
      if (preview.zipPath !== '') {
        await fs.rm(path.dirname(preview.zipPath), { recursive: true, force: true });
      }
      return {
        ok: false, snapshotId: preview.snapshotId, applied: [], changes, restoreId: '',
        rolledBack: false, warnings: [], failed: [], needsRestart: false,
        message: preview.message ?? this.msg('sync.remoteEmpty'),
      };
    }
    try {
      const report = await this.applyItems(preview.zipPath, preview.plan, {
        snapshotId: preview.snapshotId,
        ...(opts.snapshotBinding === undefined ? {} : { snapshotBinding: opts.snapshotBinding }),
      });
      return {
        ok: report.ok,
        snapshotId: preview.snapshotId,
        applied: report.applied as SectionId[],
        changes,
        restoreId: report.restoreId,
        rolledBack: report.rolledBack,
        warnings: report.warnings,
        failed: report.failed,
        needsRestart: report.needsRestart === true,
      };
    } finally {
      await fs.rm(path.dirname(preview.zipPath), { recursive: true, force: true });
    }
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
   * 拉取预览：下载远端快照 → 转临时 ZIP → Importer 分析出计划。
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
    // 恒 replace：远端值直接覆盖本地，不做 diff/合并（本插件的产品语义）
    const plan = await this.importer.createImportPlan(zipPath, {
      strategy: 'replace',
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
      await this.pruneLocalSnapshots(snapshotId);
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
   * 本地散文件快照只保留最新 1 份（**只删本引擎自己的审计副本**）。
   *
   * 该目录里的审计副本每份都是完整快照树（实测 62MB / 2155 文件），只增不减会线性吃满磁盘。
   * 保留策略取「只留最新」而不是远端那样的 N 份：真正的历史在远端。
   *
   * ⚠️ 这个目录**不是本引擎独占**：生产接线里 `localSnapshotsDir = <syncDir>/snapshots`，
   * 而 `rollbackSnapshotsDir` 缺省值是 `<stateDir>/snapshots`，`stateDir` 正是 `syncDir` ——
   * 两者**是同一个目录**。applyItems 会先往这里落「应用前兜底快照」，紧接着成功分支调
   * recordBaseline → 本方法。若按「除 keepId 外全删」执行，就会把刚拿到的 restoreId
   * 删掉，UI 的「撤销本次覆盖」必然以 ENOENT 失败（已复现）。
   *
   * 两种快照靠格式区分，不靠目录名：FileSnapshotStore 的快照根下有 `snapshot.json`
   * （readiness 生命周期标记），本引擎的散文件快照没有。据此跳过全部回滚快照。
   *
   * 新快照写完后才裁剪：任何时刻至少留 1 份完整快照，不存在空窗。
   * 删除失败只告警不上抛 —— 清不掉旧副本不该让一次成功的 push 变成失败。
   */
  private async pruneLocalSnapshots(keepId: string): Promise<void> {
    if (this.localSnapshotsDir === undefined) return;
    // readdir 契约：目录不存在 → []（默认实现自行吞掉 IO 错误）。调用点不重复兜底。
    const names = await this.fsx.readdir(this.localSnapshotsDir);
    for (const name of names) {
      if (name === keepId) continue;
      const dir = joinFs(this.localSnapshotsDir, name);
      // 回滚快照（FileSnapshotStore 格式）绝不参与本地保留裁剪：它是「撤销本次覆盖」的唯一依据
      if (await this.fsx.exists(joinFs(dir, 'snapshot.json'))) continue;
      try {
        await this.fsx.remove(dir);
      } catch (err) {
        this.ctx.log.warn(this.msg('sync.localSnapshotPruneFailed', {
          id: name,
          reason: err instanceof Error ? err.message : String(err),
        }));
      }
    }
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
       * 必须传：基线（sync-state.lastSnapshotId）要与「刚刚应用的远端快照」对齐。
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
  return Object.entries(sections).some(([id, data]) =>
    // 凭据分区按设计携带明文：值可能没有 sk-/ghp_ 这类强形状（如自定密码），
    // 扫描器认不出 → 必须按 hasValue 显式判定，否则会「含明文却标注 false」。
    credentialsCarryValues(id, data) || scanner.scanAndRedact(data).hits.length > 0);
}

/**
 * 回滚的插件补偿（R11）。
 *
 * 为什么需要单独一个模块：`rollback.ts` 的 `compensateOne` 只认 5 种快照条目
 * （settingsNamespace / credential / patchLine / file / workspaceRecord），插件安装
 * 既不产生条目、也没有对应的补偿分支。而 `beforePlugins` 从 M2 起就写进了快照，
 * 却从来没有任何代码读它做回滚 —— 于是「已整体回滚」名不副实：配置回到导入前，
 * 插件却留在导入后的版本。旧 patch 行 + 新插件版本正是启动门禁要防的组合，
 * 这个缺口会直接抵消门禁的安全承诺。
 *
 * 三种差异分别处理：
 *  - 导入期间**新增**的 → remove
 *  - 导入期间**升级**的 → add name@旧版本（降级）
 *  - 导入期间**消失**的 → add name@旧版本（装回来）
 *
 * 设计约束：
 *  - **不直接动文件系统**，一律经 `PluginRollbackPort`（生产实现走官方
 *    `dsh plugin add/remove`）。这样它不会绕过 rollback 的快照 / WAL 语义，
 *    测试也不必真的装包。
 *  - **尽力而为**：单个插件失败不中断其余补偿（与 `rollback.ts` 的诚实原则一致）。
 *  - **不谎报**：降级失败时 `full=false`，并给出可直接粘贴的手动命令 ——
 *    用户必须知道「配置已回滚、插件没跟上」这个混合状态。
 */
import type { PluginInfo } from './types.ts';

/**
 * 插件装卸通道（由调用方注入）。
 *
 * 为什么不复用 `PluginsFacade.install(pkg, spec)`：那条路径会把 registry 版本号
 * 归一成裸包名（装最新版，见 `installSpecFor`），无法表达「降级到 1.0.0」。
 */
export interface PluginRollbackPort {
  /** 安装/降级到**确切版本**（`name@version` 语义，不是 latest） */
  add(name: string, version: string): Promise<void>;
  /** 卸载 */
  remove(name: string): Promise<void>;
  /** 当前已装清单（用于算差异；与快照基线同一来源） */
  list(): Promise<PluginInfo[]>;
}

export interface PluginRollbackInput {
  /** 快照里的导入前清单；`undefined` = 旧快照无基线，此时不动插件 */
  before: PluginInfo[] | undefined;
  port: PluginRollbackPort;
  /** profile 名（只用于拼手动命令） */
  profile: string;
}

export interface PluginRollbackFailure {
  name: string;
  reason: string;
  /** 可直接粘贴的手动补救命令 */
  hint: string;
}

export interface PluginRollbackReport {
  /** 被降级的插件（`name@新 → 旧`） */
  downgraded: string[];
  /** 被卸载的新增插件 */
  removed: string[];
  /** 被装回来的插件（`name@版本`） */
  restored: string[];
  failed: PluginRollbackFailure[];
  /** 跳过的条目及原因（空版本号等） */
  skipped: string[];
  /** 无基线时置 'no-baseline'，供调用方决定文案 */
  skippedReason?: 'no-baseline';
  /** 全部补偿成功（含「本来就没差异」） */
  full: boolean;
}

/** 手动补救命令：带 profile 与确切版本，用户可直接粘贴。 */
function manualHint(profile: string, name: string, version: string): string {
  return `dsh plugin --profile ${profile} add ${name}@${version}`;
}

/**
 * 按快照基线把插件恢复到导入前状态。
 *
 * 无差异时**一个装卸动作都不做**：装卸很贵（pnpm 解析 + 下载），
 * 且会让宿主要求重启，没必要的动作本身就是副作用。
 */
export async function rollbackPlugins(input: PluginRollbackInput): Promise<PluginRollbackReport> {
  const report: PluginRollbackReport = {
    downgraded: [],
    removed: [],
    restored: [],
    failed: [],
    skipped: [],
    full: true,
  };

  const { before, port, profile } = input;
  if (before === undefined) {
    // 旧快照没有基线：无法判断「哪些是导入期间变的」，猜就等于乱删用户的插件。
    //
    // 但必须置 full=false：插件一个都没回退，「完整恢复」是假话。
    // 不置的话 `rollback.ts` 的 `full = failed.length === 0` 仍为 true，
    // 而 `renderRollbackReport` 在 `rr.full` 时直接返回「已完整恢复」，
    // 本模块承诺的「不谎报」就被 UI 提前返回吞掉了。
    report.skippedReason = 'no-baseline';
    report.full = false;
    return report;
  }

  let current: PluginInfo[];
  try {
    current = await port.list();
  } catch (err) {
    // 读不到当前清单就无法算差异 —— 如实报一条失败，不动任何插件
    report.full = false;
    report.failed.push({
      name: '(list)',
      reason: err instanceof Error ? err.message : String(err),
      hint: `dsh plugin --profile ${profile} list`,
    });
    return report;
  }

  const currentByName = new Map(current.map((p) => [p.name, p]));
  const beforeByName = new Map(before.map((p) => [p.name, p]));

  // 1) 新增的 → 卸载
  for (const p of current) {
    if (beforeByName.has(p.name)) continue;
    try {
      await port.remove(p.name);
      report.removed.push(p.name);
    } catch (err) {
      report.full = false;
      report.failed.push({
        name: p.name,
        reason: err instanceof Error ? err.message : String(err),
        hint: `dsh plugin --profile ${profile} remove ${p.name}`,
      });
    }
  }

  // 2) 版本变了的 / 消失了的 → 装回旧版本
  for (const old of before) {
    const now = currentByName.get(old.name);
    const changed = now === undefined || now.version !== old.version;
    if (!changed) continue;
    if (old.version === '') {
      // 空版本号无法钉版本；装成 latest 反而可能引入更新的不兼容，跳过并说明。
      // 同样置 full=false：这个插件没有回到基线版本，不能算完整恢复。
      report.skipped.push(`${old.name}（快照未记录版本号，无法钉版本）`);
      report.full = false;
      continue;
    }
    try {
      await port.add(old.name, old.version);
      if (now === undefined) report.restored.push(`${old.name}@${old.version}`);
      else report.downgraded.push(`${old.name}@${now.version} → ${old.version}`);
    } catch (err) {
      report.full = false;
      report.failed.push({
        name: old.name,
        reason: err instanceof Error ? err.message : String(err),
        hint: manualHint(profile, old.name, old.version),
      });
    }
  }

  return report;
}

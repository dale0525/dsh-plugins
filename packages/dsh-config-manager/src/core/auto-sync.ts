/**
 * 启动时自动同步（AUTO-SYNC）。
 *
 * 为什么不是「无条件拉取」：当前宿主是所有配置修改的发起者。若它也无条件拉取，
 * 「改了配置、重启前忘了推送」就会被线上旧配置覆盖 —— 恰好毁掉本地最新的那份。
 *
 * 用户裁定的语义是**按设备角色决定方向**，不是比「谁更新」：
 *  - `source`（发起者）→ 启动时无条件 **push**（本地覆盖远端）
 *  - `follower`（从属者）→ 启动时无条件 **pull**（远端覆盖本地）
 *
 * 角色存在本机私有文件 `sync-config.json` 里。它不在任何同步分区中（同步范围是
 * `syncAdapters()`，而该文件是 syncDir 下的插件私有状态），所以每台设备的角色
 * 互相独立、不会随配置传播到别的设备。
 *
 * 时序依据（宿主与 Cordis 实现，逐条已核实）：
 *  1. `cordis._execute` 对 apply 返回的 thenable 会 `return effect.then(safeCollect)`，
 *     由 `loader.await()`（等每个 entry 的 fiber inertia）等到它结束；
 *  2. `boot()` 顺序是 `mountRootInclude` → `loader.await()` → `auditStartupEntries`，
 *     所以自动同步写入的配置**在启动判定之前**就已就位；
 *  3. 写盘触发的 HMR 重载走 `runReload`，它先 `await applicationReady`，而该 promise
 *     在 `boot()` 返回之后才 commit，因此重载被排到启动成功之后，不打断启动。
 */
/**
 * 本机在同步中的角色。
 *
 * 定义放在 core 而非 sync：`core/` 不允许依赖 `sync/`（F7 分层守护）。
 * `sync/sync-config.ts` 从本模块 re-export，保持单一来源。
 */
export type SyncRole = 'source' | 'follower';

/** follower 的 pull 尝试次数（含首次）。 */
const MAX_PULL_ATTEMPTS = 3;

/** 递增间隔：2s → 4s。 */
const RETRY_DELAYS_MS = [2000, 4000] as const;

interface PullOutcome {
  ok: boolean;
  rolledBack: boolean;
  message?: string;
}

interface PushOutcome {
  ok: boolean;
  message?: string;
}

export interface AutoSyncDeps {
  /** 是否存在可用同步配置（读不到 / 没有都返回 false） */
  hasSyncConfig: () => Promise<boolean>;
  /** 本机角色（发起者 / 从属者） */
  role: () => Promise<SyncRole>;
  push: () => Promise<PushOutcome>;
  pull: () => Promise<PullOutcome>;
  sleep?: (ms: number) => Promise<void>;
  log: (message: string) => void;
  exit?: (code: number) => void;
}

export type AutoSyncResult =
  | 'skipped'
  | 'pushed'
  | 'push-failed'
  | 'pulled'
  | 'refused';

/** pull 是否真的成功：`ok` 之外还要求没有回滚（回滚 = 配置并未就位）。 */
function pullSucceeded(r: PullOutcome): boolean {
  return r.ok === true && r.rolledBack !== true;
}

/**
 * 启动期自动同步。返回后宿主会继续启动判定。
 *
 * 不抛错：所有失败都已转成日志 + 退出码，避免把「同步失败」表达成未捕获异常。
 */
export async function runAutoSync(deps: AutoSyncDeps): Promise<AutoSyncResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exit = deps.exit ?? ((code: number) => { process.exit(code); });

  // 1) 有没有可用配置。读失败按「没有」处理：无从判断该不该同步，
  //    而阻断启动的风险更大（可能只是磁盘临时问题，宿主本来能正常起来）。
  try {
    if (!(await deps.hasSyncConfig())) return 'skipped';
  } catch (err) {
    deps.log(`配置同步：读取同步配置失败，跳过自动同步（${err instanceof Error ? err.message : String(err)}）`);
    return 'skipped';
  }

  // 2) 角色。读失败按 follower 处理 —— 保守方向：
  //    猜成 source 会把本地状态推到远端、可能污染其他设备；
  //    猜成 follower 最坏只是本机被远端覆盖，不影响别人。
  let role: SyncRole = 'follower';
  try {
    role = await deps.role();
  } catch (err) {
    deps.log(`配置同步：读取本机角色失败，按从属者处理（${err instanceof Error ? err.message : String(err)}）`);
  }

  // 3) 发起者：无条件推，本地覆盖远端。
  //    失败只告警、不阻断启动：本地配置本身是对的，只是没传出去；断网时仍应能用。
  if (role === 'source') {
    try {
      const report = await deps.push();
      if (report.ok) {
        deps.log('配置同步：已推送本地配置（本机为发起者）');
        return 'pushed';
      }
      const detail = report.message ?? '未提供原因';
      deps.log(`配置同步：推送失败，本地配置未上传（${detail}）。本机配置仍可正常使用，联网后可再推送`);
      return 'push-failed';
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log(`配置同步：推送失败，本地配置未上传（${detail}）。本机配置仍可正常使用，联网后可再推送`);
      return 'push-failed';
    }
  }

  // 4) 从属者：无条件拉，远端覆盖本地（这是「从属者」的定义）。失败重试后拒绝启动。
  let lastReason = '';
  for (let attempt = 1; attempt <= MAX_PULL_ATTEMPTS; attempt++) {
    try {
      const report = await deps.pull();
      if (pullSucceeded(report)) {
        deps.log(`配置同步：已拉取远端配置（第 ${attempt} 次尝试）`);
        return 'pulled';
      }
      const detail = report.message ?? '未提供原因';
      lastReason = report.rolledBack === true
        ? `启动校验判定该配置会让下次启动失败，已回滚：${detail}`
        : detail;
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }

    if (attempt < MAX_PULL_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
      deps.log(`配置同步：第 ${attempt} 次拉取失败（${lastReason}），${delay / 1000} 秒后重试`);
      await sleep(delay);
    }
  }

  deps.log(
    `配置同步失败：已重试 ${MAX_PULL_ATTEMPTS} 次仍无法拉取配置，拒绝启动。`
    + `原因：${lastReason}。`
    + '请检查网络与同步通道配置后重试；如本机应是配置发起者，请在同步设置页把本机角色改为「发起者」。',
  );
  exit(1);
  // exit 默认是 process.exit（同步终止），正常到不了这里；但 exit 可注入（测试用）。
  return 'refused';
}

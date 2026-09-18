/**
 * 缓存自动清理：只清「可重建 / 一次性」的临时文件与导出副本。
 *
 * 清理面（保留期内一律不删）：
 *  - `tmp/`：过期 `.zip` 暂存 + SyncEngine 遗留的 `dsh-sync-pull-*` 目录；
 *  - `exports/`：过期的导出产物 ZIP（导出时用户已下载/另存到本地）。
 *
 * **不清理**：`snapshots/`（回滚安全网）与 `sync/`（同步状态/快照）—— 它们是用户数据。
 *
 * 失败语义：任何单项失败只计入 `errors`，不影响主流程（调用方仅记日志）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 临时文件缺省保留期：24h（供刷新恢复等窗口继续消费） */
export const TMP_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000

/** 导出产物缺省保留期：7 天（导出时用户已通过浏览器下载/另存到本地，host 端副本按周回收） */
export const EXPORTS_RETENTION_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000

/** SyncEngine 在 zipDir（即 tmpDir）下 mkdtemp 的目录前缀（用完即删，崩溃残留由清理兜底） */
const SYNC_TMP_DIR_PREFIX = 'dsh-sync-pull-'

export interface CacheCleanupOptions {
  /** 临时目录（$DSH_HOME/dsh-config-manager/tmp） */
  tmpDir: string
  /** 导出产物目录（$DSH_HOME/dsh-config-manager/exports） */
  exportsDir: string
  /** 临时文件保留期（缺省 24h） */
  tmpRetentionMs?: number
  /** 导出产物保留期（缺省 7 天） */
  exportsRetentionMs?: number
  /** 时间源（测试注入；缺省 Date.now） */
  now?: () => number
}

export interface CacheCleanupResult {
  /** 删除条目数（文件 + 目录） */
  removed: number
  /** 释放字节数（仅被删文件的 size 累计；目录删除统计为 0） */
  freedBytes: number
  /** 单项失败数（不影响主流程） */
  errors: number
  /** 每条删除记录（相对 dataDir 的描述 + 字节数），供日志/审计 */
  detail: string[]
}

/** 目录是否超期（stat 失败保守视为未超期 → 不删） */
async function isExpired(target: string, retentionMs: number, nowMs: number): Promise<boolean> {
  try {
    const st = await fs.stat(target)
    return nowMs - st.mtimeMs > retentionMs
  } catch {
    return false
  }
}

/** 删除一个文件/目录并计入报告；目录的 freedBytes 统计为 0（递归统计不划算，用途仅是日志） */
async function removeEntry(target: string, label: string, result: CacheCleanupResult): Promise<void> {
  try {
    let size = 0
    try {
      const st = await fs.stat(target)
      size = st.isFile() ? st.size : 0
    } catch {
      /* stat 失败仍尝试删除（rm 自己会兜底不存在） */
    }
    await fs.rm(target, { recursive: true, force: true })
    result.removed += 1
    result.freedBytes += size
    result.detail.push(`${label} (${size} bytes)`)
  } catch {
    result.errors += 1
  }
}

/**
 * 执行一次缓存清理（幂等；可重复调用）。
 * 只清理超期（超过保留期）的缓存/临时条目，其余一律保留。
 */
export async function cleanupCaches(opts: CacheCleanupOptions): Promise<CacheCleanupResult> {
  const nowMs = (opts.now ?? Date.now)()
  const tmpRetentionMs = opts.tmpRetentionMs ?? TMP_RETENTION_DEFAULT_MS
  const exportsRetentionMs = opts.exportsRetentionMs ?? EXPORTS_RETENTION_DEFAULT_MS
  const result: CacheCleanupResult = { removed: 0, freedBytes: 0, errors: 0, detail: [] }

  // 1) tmpDir：过期 .zip（同步/解密暂存）与 SyncEngine 遗留的 dsh-sync-pull-* 目录
  try {
    const entries = await fs.readdir(opts.tmpDir, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(opts.tmpDir, entry.name)
      const isTmpish =
        (entry.isFile() && entry.name.endsWith('.zip')) ||
        (entry.isDirectory() && entry.name.startsWith(SYNC_TMP_DIR_PREFIX))
      if (!isTmpish) continue
      if (await isExpired(target, tmpRetentionMs, nowMs)) {
        await removeEntry(target, `tmp/${entry.name}`, result)
      }
    }
  } catch {
    // tmpDir 不存在/不可读 → 跳过（尽力而为）
    result.errors += 1
  }

  // 2) exportsDir：过期的导出产物 .zip（导出时已下载/另存到本地，host 端副本按保留期回收）
  try {
    const entries = await fs.readdir(opts.exportsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue
      const target = path.join(opts.exportsDir, entry.name)
      if (await isExpired(target, exportsRetentionMs, nowMs)) {
        await removeEntry(target, `exports/${entry.name}`, result)
      }
    }
  } catch {
    // exportsDir 不存在/不可读 → 跳过
    result.errors += 1
  }

  return result
}

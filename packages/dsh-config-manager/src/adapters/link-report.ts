/**
 * 文件类分区的「链接目录」报告（issue #37）。
 *
 * 背景：备份静默跳过 junction/符号链接，用户拿到的仍是「成功」，却少了整块内容。
 * 修复分两步：① `utils/recursive-walk.ts` 跟随链接收集内容；② 本模块把「跟随了什么、
 * 跳过了什么、为什么跳过」变成备份报告里可见的告警 —— 缺了 ②，用户依然无从察觉缺失。
 *
 * 纯函数（除 listFilesDetailed 的 IO 委托外），两个 adapter 共用，避免文案再次漂移。
 */
import type { FileSystemFacade } from '../core/types.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { RecursiveListing, RecursiveWalkOptions, SkippedLink } from '../utils/recursive-walk.ts';

/** 跳过原因 → 消息 key（与 SkippedLink.reason 一一对应，穷尽映射） */
const REASON_KEY: Record<SkippedLink['reason'], string> = {
  loop: 'adapter.linkReason.loop',
  'outside-home': 'adapter.linkReason.outsideHome',
  broken: 'adapter.linkReason.broken',
  unreadable: 'adapter.linkReason.unreadable',
  'too-deep': 'adapter.linkReason.tooDeep',
}

/** 单条原因下最多列出的路径数（其余折叠为计数，避免把报告撑爆） */
const MAX_PATHS_PER_REASON = 5

/** 取遍历结果：宿主未实现 listRecursiveDetailed（旧版/测试 mock）时回退，行为与旧版一致。 */
export async function listFilesDetailed(
  fs: FileSystemFacade, dir: string, options?: RecursiveWalkOptions,
): Promise<RecursiveListing> {
  if (fs.listRecursiveDetailed !== undefined) return fs.listRecursiveDetailed(dir, options)
  return { paths: await fs.listRecursive(dir), skippedLinks: [], followedLinks: 0, unreadableDirs: [], excludedDirs: [] }
}

/** 把遍历结果转成告警行（无链接时返回空数组 —— 不制造噪音）。 */
export function linkWarnings(msg: MsgFunc, type: string, listing: RecursiveListing): string[] {
  const out: string[] = []
  if (listing.followedLinks > 0) {
    out.push(msg('adapter.linksFollowed', { type, count: String(listing.followedLinks) }))
  }
  if (listing.skippedLinks.length > 0) {
    const byReason = new Map<SkippedLink['reason'], string[]>()
    for (const s of listing.skippedLinks) {
      const arr = byReason.get(s.reason) ?? []
      arr.push(s.path)
      byReason.set(s.reason, arr)
    }
    const detail = [...byReason.entries()].map(([reason, paths]) => {
      const shown = paths.slice(0, MAX_PATHS_PER_REASON).join(', ')
      const more = paths.length > MAX_PATHS_PER_REASON ? ` (+ ${paths.length - MAX_PATHS_PER_REASON})` : ''
      return `${msg(REASON_KEY[reason])} ${paths.length} 个: ${shown}${more}`
    }).join('；')
    out.push(msg('adapter.linksSkipped', { type, count: String(listing.skippedLinks.length), detail }))
  }
  if (listing.excludedDirs.length > 0) {
    const shown = listing.excludedDirs.slice(0, MAX_PATHS_PER_REASON).join(', ')
    const more = listing.excludedDirs.length > MAX_PATHS_PER_REASON
      ? ` (+ ${listing.excludedDirs.length - MAX_PATHS_PER_REASON})` : ''
    out.push(msg('adapter.dirsExcluded', {
      type, count: String(listing.excludedDirs.length), detail: `${shown}${more}`,
    }))
  }
  if (listing.unreadableDirs.length > 0) {
    const shown = listing.unreadableDirs.slice(0, MAX_PATHS_PER_REASON).join(', ')
    const more = listing.unreadableDirs.length > MAX_PATHS_PER_REASON
      ? ` (+ ${listing.unreadableDirs.length - MAX_PATHS_PER_REASON})` : ''
    out.push(msg('adapter.dirsUnreadable', {
      type, count: String(listing.unreadableDirs.length), detail: `${shown}${more}`,
    }))
  }
  return out
}

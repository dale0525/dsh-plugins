/**
 * 递归遍历（跟随 junction / 符号链接）—— 文件类分区（skills / agentPresets / sessions / pluginFiles）
 * 的收集内核（issue #37）。
 *
 * 背景：`fs.readdir(withFileTypes)` 对 **目录 junction / 符号链接** 返回的是
 * `isSymbolicLink() === true`、`isDirectory() === false`。此前调用方只处理
 * `isDirectory() / isFile()` 两个分支，于是链接目录及其**全部真实内容**被静默排除，
 * 备份照样报成功（issue #37：Windows 下 8 个链接目录约 12 MB 内容丢失，且无任何提示）。
 *
 * 本模块的语义：
 *  - **跟随**目录链接（内容进备份），并用 realpath 去重防环（自引用 / 重复链接 / 深度爆炸）；
 *  - 链接目标**越出 homeDir** 或**损坏**时跳过，但**记入 skippedLinks** —— 让「没进备份」
 *    变成备份报告里可见的一行，而不是无声缺失；
 *  - 产出与 `FileSystemFacade.listRecursive` 一致的 **homeDir 相对** 斜杠路径，且已排序。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

/** 遍历中跳过的链接（备份必须能说明「哪些内容没进来」） */
export interface SkippedLink {
  /** homeDir 相对路径（链接本身，不是目标） */
  path: string;
  /** loop=指向已遍历目录（自引用/重复）；outside-home=目标越出 homeDir；
   *  broken=断链；unreadable=目标既非文件也非目录（设备/FIFO 等）；too-deep=超过深度上限 */
  reason: 'loop' | 'outside-home' | 'broken' | 'unreadable' | 'too-deep';
}

/**
 * 遍历选项。
 * `excludeDirs`：**按设计**跳过的目录（缓存 / 历史 / 临时产物），每项是一段路径形状
 * （如 `['.gemini','antigravity-cli','scratch']`），按 homeDir 相对路径的**连续分段**匹配。
 * 与 `skippedLinks` 的区别是语义，不是程度：那些是「本该进来却没进来」的缺失，
 * 这些是「有意不带」的策略 —— 二者绝不能混进同一条告警。
 */
export interface RecursiveWalkOptions {
  excludeDirs?: readonly (readonly string[])[];
}

export interface RecursiveListing {
  /** homeDir 相对、斜杠分隔、已排序的文件路径 */
  paths: string[];
  /** 被跳过的链接（含原因）；空 = 本次遍历无内容缺失 */
  skippedLinks: SkippedLink[];
  /** 成功跟随（内容已收集）的链接数；用于「链接结构不会被还原」的提示 */
  followedLinks: number;
  /** 读取失败的目录（ACL / 竞态删除等）——这些目录下的内容同样没进备份，必须留痕 */
  unreadableDirs: string[];
  /** 按 `excludeDirs` 策略跳过的目录（其内容**有意**不进备份）；空 = 未启用剪枝 */
  excludedDirs: string[];
}

/** 深度上限：防御病态目录树 / realpath 去重失效时的栈爆炸 */
const MAX_DEPTH = 64;

function normalizeSlashes(p: string): string {
  return p.split(path.sep).join('/');
}

/** current 是否等于 base 或位于其下（win32 折叠大小写） */
function isSameOrChild(current: string, base: string): boolean {
  const c = path.resolve(current);
  const b = path.resolve(base);
  const cl = process.platform === 'win32' ? c.toLowerCase() : c;
  const bl = process.platform === 'win32' ? b.toLowerCase() : b;
  return cl === bl || cl.startsWith(bl.endsWith(path.sep) ? bl : bl + path.sep);
}

async function realpathSafe(p: string): Promise<string | null> {
  try { return await fs.realpath(p) } catch { return null }
}

/**
 * 遍历 baseDir 下的所有文件（跟随目录链接）。
 * @param baseDir 绝对路径；不在 homeDir 内则返回空清单（与既有语义一致）
 * @param homeDir 绝对路径；产出相对它，跟随边界也是它
 */
export async function listRecursiveFollowingLinks(
  baseDir: string, homeDir: string, options: RecursiveWalkOptions = {},
): Promise<RecursiveListing> {
  const base = path.resolve(baseDir);
  const home = path.resolve(homeDir);
  const paths: string[] = [];
  const skippedLinks: SkippedLink[] = [];
  const unreadableDirs: string[] = [];
  const excludedDirs: string[] = [];
  let followedLinks = 0;
  /** 已进入过的目录 realpath（防环 / 防同一目标被两条链接重复收集） */
  const visited = new Set<string>();

  const rel = (abs: string): string => normalizeSlashes(path.relative(home, abs));

  /**
   * 路径形状剪枝：把每项模式当作**连续分段**去匹配 homeDir 相对路径的分段序列。
   * 用分段而非子串，避免 `my-scratch` 被 `scratch` 误伤；模式要求多段，
   * 是为了不误伤任意分区下的同名业务目录。
   */
  const excludePatterns = (options.excludeDirs ?? []).map((p) => [...p]);
  const isExcludedByDesign = (entryRel: string): boolean => {
    if (excludePatterns.length === 0) return false;
    const segs = entryRel.split('/');
    return excludePatterns.some((pat) => {
      for (let i = 0; i + pat.length <= segs.length; i++) {
        let hit = true;
        for (let j = 0; j < pat.length; j++) if (segs[i + j] !== pat[j]) { hit = false; break; }
        if (hit) return true;
      }
      return false;
    });
  };

  /** @returns 是否真的进入了该目录（false = 被边界/去重/IO 挡下） */
  const walk = async (dir: string, depth: number, viaLink: string | null): Promise<boolean> => {
    if (!isSameOrChild(dir, home)) return false;
    if (depth > MAX_DEPTH) {
      if (viaLink !== null) skippedLinks.push({ path: viaLink, reason: 'too-deep' });
      return false;
    }
    const real = await realpathSafe(dir);
    // 去重只针对**链接**：链接目标已经进过（自引用 / 两条链接指向同一处）→ 跳过。
    // 普通目录永远遍历（否则「真实目录 + 指向它的链接」会有一边被静默吞掉）。
    if (viaLink !== null && real !== null && visited.has(real)) {
      skippedLinks.push({ path: viaLink, reason: 'loop' });
      return false;
    }
    if (real !== null) visited.add(real);
    let entries: Dirent[];
    try {
      // 排序：让「链接 vs 真实目录」的遍历顺序与去重结果可复现（readdir 顺序依 FS 而异）
      entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      // 目录不可读（ACL / 竞态删除）：不中断整次遍历，但**必须留痕** ——
      // 静默吞掉同样会造成「备份成功但内容缺失」（issue #37 的同类症状）。
      // 根目录不存在（ENOENT）例外：调用方语义是「目录不存在视为空」，不告警。
      if (viaLink !== null) skippedLinks.push({ path: viaLink, reason: 'unreadable' });
      else if ((err as { code?: string } | null)?.code !== 'ENOENT') unreadableDirs.push(rel(dir));
      return false;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const entryRel = rel(abs);
      if (entry.isDirectory()) {
        // 剪枝必须在**进入前**做：遍历成本（3.3s → 0.1s 量级）与清单正确性都取决于此
        if (isExcludedByDesign(entryRel)) { excludedDirs.push(entryRel); continue; }
        await walk(abs, depth + 1, null);
      } else if (entry.isFile()) {
        paths.push(entryRel);
      } else if (entry.isSymbolicLink()) {
        // 目录 junction / 符号链接：跟随（issue #37 的核心修复）。
        // 注意：Dirent 对链接一律 isDirectory()===false，必须显式 stat 目标才知道类型。
        let st;
        try {
          st = await fs.stat(abs); // 跟随链接
        } catch {
          skippedLinks.push({ path: entryRel, reason: 'broken' });
          continue;
        }
        // 链接目标必须落在 homeDir 内——**文件链接同样如此**。
        // 只对目录链接做这个检查会漏掉「skills/link.md → ~/外部文件」：
        // 内容会被读进备份（T2-P3 实测就是这种文件链接，属真实越界读取）。
        const target = await realpathSafe(abs);
        if (target === null || !isSameOrChild(target, home)) {
          skippedLinks.push({ path: entryRel, reason: 'outside-home' });
          continue;
        }
        if (st.isDirectory()) {
          if (isExcludedByDesign(entryRel)) { excludedDirs.push(entryRel); continue; }
          if (await walk(abs, depth + 1, entryRel)) followedLinks += 1;
        } else if (st.isFile()) {
          paths.push(entryRel);
          followedLinks += 1;
        } else {
          skippedLinks.push({ path: entryRel, reason: 'unreadable' });
        }
      }
      // 其余类型（socket / FIFO / 设备）：与既有实现一致，静默忽略
    }
    return true;
  };

  await walk(base, 0, null);
  return { paths: paths.sort(), skippedLinks, followedLinks, unreadableDirs, excludedDirs: excludedDirs.sort() };
}

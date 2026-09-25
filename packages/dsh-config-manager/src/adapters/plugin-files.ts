/**
 * pluginFiles 分区 adapter（可选，设计 §3.3/§1.2）：
 * 数据源 = 插件自有配置文件（相对 ~/.dsh 根）：
 *   1. 白名单固定文件（dsh-ssh.json、pet.json 等，避免扫描整个主目录）；
 *   2. 约定的插件配置目录（collectDir，如 plugin-config/）递归收集其下所有文件。
 * relativePath 一律是「相对 ~/.dsh 根」的完整路径（与白名单文件一致），
 * 导入时按同一相对路径写回原位置。默认关闭（defaultIncluded=false，用户显式勾选才导出）。
 */
import { sha256Hex } from '../utils/hashing.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import { linkWarnings, listFilesDetailed } from './link-report.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { isPathSafe, isReservedInternalRel } from '../utils/paths.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { FilesSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';

export const DEFAULT_PLUGIN_FILE_WHITELIST: readonly string[] = ['dsh-ssh.json', 'pet.json'];

/**
 * collectDir 下**按设计**跳过的目录（路径形状，不是目录名 —— 见 utils/recursive-walk.ts）。
 *
 * 为什么需要：collectDir 是插件共享的跨设备配置容器，但插件会把整个 HOME 塞进它
 * （agy-link 的每个账号一个托管 HOME）。实测 ~/.dsh/plugin-config 遍历出 3,920 MB / 102,582 文件，
 * 其中约 3.9 GB 是缓存、历史与工作现场 —— 收集它们会让一次推送跑几十分钟，且 scratch 内嵌的
 * git pack 单文件 128.5 MB，已超 GitHub 的 100 MiB 硬上限，推送注定失败。
 *
 * 两类被剪内容**后果不同，不可混为一谈**（这是本清单唯一的判断难点）：
 *  - 运行时再生品：下次启动重建，排除无损失。
 *  - agy 的会话历史与工作现场：**不会被重建**，排除即永久丢失。这是有意取舍 —— 跨设备要的是
 *    「账号能直接登录使用」，而这四项合计约 1.4 GB，带过去就会把推送重新推过 100 MiB 上限。
 *    代价是**目标机没有历史会话**，报告必须如实说明（见 messages.ts 的 adapter.dirsExcluded）。
 *    把它们说成「可重新生成」是错的，说成「不影响使用」也是错的。
 *
 * 账号身份一律保留（token / settings.json / .gemini/config/** / Library/Keychains/login.keychain-db /
 * pool.json），否则另一台机器拿到的是个空壳账号。
 *
 * 排除只作用于导出：applyItem 只写快照里存在的文件，从**不删除**本地文件，本机内容不会被清掉。
 *
 * 本清单是权威；docs/spec 与 CHANGELOG 里的枚举只是说明，冲突时以本文件为准。
 */
export const PLUGIN_FILES_EXCLUDED_DIRS: readonly (readonly string[])[] = [
  // ① 可再生：插件把 HOME 当普通目录用产生的缓存（1.7 GB / 77 MB）
  ['Library', 'Caches'],
  ['.npm'],
  // ① 可再生：日志与运行时痕迹，下次启动重建，无身份信息
  ['.gemini', 'antigravity-cli', 'log'],
  ['.gemini', 'antigravity-cli', 'presence'],
  ['.gemini', 'antigravity-cli', 'implicit'],
  ['.gemini', 'antigravity-cli', 'cache'],
  ['.gemini', 'antigravity-cli', 'updater'],
  // ① 可再生：MCP 工具清单（126 个 .json，含本机路径），下次启动按当前环境重写
  ['.gemini', 'antigravity-cli', 'mcp'],
  // ① 可再生：agy 自带的辅助可执行文件（实测本机三份 webm_encoder 各 12.78 MB，
  //    合计 37 MB —— 占整个 pluginFiles 分区 50.9 MB 的 73%）。它们由 CLI 自更新重装，
  //    且**每次内容都不同**（同尺寸不同哈希），因此每份快照都把这 37 MB 重传一遍，
  //    既撑大快照又让分区 hash 恒变（分区级变更检测永远判定「有变化」）。
  ['.gemini', 'antigravity-cli', 'bin'],
  // ② 不可再生：agy 的会话历史与工作现场（合计约 1.4 GB）—— 排除即丢失，报告必须如实说明
  ['.gemini', 'antigravity-cli', 'conversations'],
  ['.gemini', 'antigravity-cli', 'brain'],
  ['.gemini', 'antigravity-cli', 'annotations'],
  ['.gemini', 'antigravity-cli', 'scratch'],
  // ① 可再生：依赖的内容寻址仓库（重新安装依赖即恢复），实测本机 plugin-config 下 63,577 个文件
  ['Library', 'pnpm'],
];

/**
 * collectDir 下**按设计**跳过的文件（按文件名后缀匹配，见 utils/recursive-walk.ts）。
 *
 * 为什么需要：SQLite 的 WAL 边车（`-shm` 索引 / `-wal` 日志）是数据库的**瞬时状态**，
 * 随 DB 进程关闭即被回收或合并进主文件。搬过去有两个真实代价，都不划算：
 *  - 恢复后它与目标机的主 DB 文件不是同一时刻的状态，WAL 回放可能污染数据；
 *  - 32 KB 的文件里只有几十字节非零，却正是「小体积高压缩」形态（见 readEntry 的注释）。
 *
 * 用后缀而不是全名：任何 SQLite 库都会产生同名边车，清单不该跟着库名增长。
 */
export const PLUGIN_FILES_EXCLUDED_FILE_SUFFIXES: readonly string[] = ['-shm', '-wal'];

export class PluginFilesAdapter implements ConfigAdapter<FilesSection> {
  readonly id = 'pluginFiles' as const;
  readonly displayName = 'Plugin Files';
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  private readonly whitelist: string[];
  /** 约定配置目录（相对 ~/.dsh 根，如 'plugin-config'）；递归收集其下所有文件。undefined = 不收集。 */
  private readonly collectDir?: string;

  constructor(whitelist: string[] = [...DEFAULT_PLUGIN_FILE_WHITELIST], collectDir?: string) {
    this.whitelist = whitelist;
    if (collectDir !== undefined && collectDir !== '' && !isPathSafe(collectDir)) {
      throw new Error(`pluginFiles collectDir 非法（须为相对 ~/.dsh 根的安全路径）: ${collectDir}`);
    }
    this.collectDir = collectDir === '' ? undefined : collectDir;
  }

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const seen = new Set<string>();
    // 1) 白名单固定文件（不存在则跳过，dsh-ssh.json 等为按需创建）
    for (const rel of this.whitelist) {
      try {
        const data = await ctx.fs.readFile(rel);
        files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        seen.add(rel);
      } catch {
        /* 白名单文件不存在则跳过 */
      }
    }
    // 2) 约定配置目录递归收集（相对 ~/.dsh 根的完整路径；与白名单文件去重）
    // issue #37：与 skills 等同一条遍历（跟随 junction/符号链接 + 跳过留痕）
    let listing: RecursiveListing = { paths: [], skippedLinks: [], followedLinks: 0, unreadableDirs: [], excludedDirs: [], excludedFiles: [] };
    if (this.collectDir !== undefined) {
      try {
        listing = await listFilesDetailed(ctx.fs, this.collectDir, {
          excludeDirs: PLUGIN_FILES_EXCLUDED_DIRS,
          excludeFileSuffixes: PLUGIN_FILES_EXCLUDED_FILE_SUFFIXES,
        });
      } catch {
        // 目录不存在视为空
      }
      const rels = listing.paths;
      for (const rel of rels) {
        if (seen.has(rel)) continue;
        try {
          const data = await ctx.fs.readFile(rel);
          files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        } catch {
          continue;
        }
      }
    }
    return {
      sectionId: 'pluginFiles',
      data: { version: 1, files },
      counts: { files: files.length },
      warnings: linkWarnings(msgOf(ctx), this.displayName, listing),
    };
  }

  async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const file of data.files) {
      const id = `pluginFile:${file.relativePath}`;
      // F23 修复：不可信 import 不得写内部 control-plane namespace（snapshots/transactions/locks/safe-mode）
      if (isReservedInternalRel(file.relativePath)) {
        items.push({
          id, kind: 'Error', adapter: 'pluginFiles',
          description: msg('adapter.pluginFileReserved', { path: file.relativePath }), severity: 'error',
        });
        continue;
      }
      let current: Uint8Array | null = null;
      try {
        current = await ctx.target.fs.readFile(file.relativePath);
      } catch {
        current = null;
      }
      if (current === null) {
        items.push({
          id, kind: 'Create', adapter: 'pluginFiles',
          description: msg('adapter.pluginFileCreate', { path: file.relativePath }), severity: 'info',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      } else if (sha256Hex(current) === file.contentHash) {
        items.push({ id, kind: 'Skip', adapter: 'pluginFiles', description: msg('adapter.fileSame', { path: file.relativePath }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'pluginFiles',
          description: msg('adapter.fileDiff', { path: file.relativePath }), severity: 'warning',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
    // F23 修复：apply 前拒绝写内部 control-plane namespace（纵深防御，analyzeImport 已标 Error）
    if (isReservedInternalRel(ref)) {
      return { ok: false, message: ctx.msg('adapter.pluginFileReserved', { path: ref }) };
    }
    const data = ctx.sections.get('pluginFiles') as FilesSection | undefined;
    const file = data?.files.find((f) => f.relativePath === ref);
    if (!file) return { ok: false, message: ctx.msg('adapter.dataMissingFile', { ref }) };
    await ctx.target.fs.writeFile(ref, file.data);
    return { ok: true };
  }

  async validate(data: FilesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'pluginFiles' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.files)) {
      issues.push({ path: 'files', message: msg('adapter.validate.array', { subject: 'files' }), severity: 'error' });
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}

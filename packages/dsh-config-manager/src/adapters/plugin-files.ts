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
 * collectDir 下**按设计**跳过的运行时目录（路径形状，不是目录名 —— 见 utils/recursive-walk.ts）。
 *
 * 为什么需要：collectDir 是插件共享的跨设备配置容器，但插件会把整个 HOME 塞进它
 * （agy-link 的每个账号一个托管 HOME）。实测 ~/.dsh/plugin-config 遍历出 3,920 MB / 102,582 文件，
 * 其中约 3.9 GB 是缓存与历史 —— 收集它们会让一次推送跑几十分钟，且 scratch 内嵌的 git pack
 * 单文件 128.5 MB，已超 GitHub 的 100 MiB 硬上限，推送注定失败。
 *
 * 判据是「重建还是复用」：这些目录里没有账号身份，删掉后 agy 会在下次启动时重新生成，
 * 因此**排除它们不损失跨设备可用性**。反之账号身份（token / settings.json / .gemini/config/** /
 * Library/Keychains/login.keychain-db）一律保留，否则另一台机器拿到的是个空壳账号。
 *
 * 排除只作用于导出：applyItem 只写快照里存在的文件，从**不删除**本地文件，
 * 所以本机缓存不会被清掉。
 */
export const PLUGIN_FILES_EXCLUDED_DIRS: readonly (readonly string[])[] = [
  // 插件把 HOME 当普通目录用：Library/Caches（1.7 GB）、.npm（77 MB）
  ['Library', 'Caches'],
  ['.npm'],
  // agy 每个账号的会话历史与工作现场（0.6 GB / 0.5 GB / 0.3 GB）
  ['.gemini', 'antigravity-cli', 'conversations'],
  ['.gemini', 'antigravity-cli', 'scratch'],
  ['.gemini', 'antigravity-cli', 'brain'],
  // 日志与运行时痕迹：重建即可，无身份信息
  ['.gemini', 'antigravity-cli', 'log'],
  ['.gemini', 'antigravity-cli', 'presence'],
  ['.gemini', 'antigravity-cli', 'implicit'],
  ['.gemini', 'antigravity-cli', 'cache'],
  ['.gemini', 'antigravity-cli', 'updater'],
  ['.gemini', 'antigravity-cli', 'annotations'],
  // MCP 工具清单（含本机路径与端口），下次启动按当前环境重写
  ['.gemini', 'antigravity-cli', 'mcp'],
];

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
    let listing: RecursiveListing = { paths: [], skippedLinks: [], followedLinks: 0, unreadableDirs: [], excludedDirs: [] };
    if (this.collectDir !== undefined) {
      try {
        listing = await listFilesDetailed(ctx.fs, this.collectDir, { excludeDirs: PLUGIN_FILES_EXCLUDED_DIRS });
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

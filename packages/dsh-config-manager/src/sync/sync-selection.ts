/**
 * m-sync-selection：远程同步分区选择持久化（sync-selection.json）。
 *
 * 与 sync-config.json 并列独立文件：语义清楚、schema 演进独立。
 * schemaVersion:2 —— 按同步通道拆分（git / webdav 各自独立的分区勾选）：
 * ```
 * { "schemaVersion": 2,
 *   "channels": {
 *     "git":    { mode: 'default'|'advanced', sections: SectionId[] },
 *     "webdav": { ... } } }
 * ```
 * - mode='default'（快速同步）：推送使用全部推荐分区（sections 可空）；
 * - mode='advanced'（自定义同步）：推送只处理勾选的 sections（空 sections 回退全量，
 *   避免勾选状态与范围不一致时同步卡死）。
 *
 * 快照恒为明文：同步通道是用户自有的私有通道，勾选即同步，不加密、不脱敏。
 *
 * **版本号与上游同号是刻意的**：上游 0.1.60 的 `schemaVersion:2` 就是本信封
 * （多出 `encrypt` / `includeSecrets` 两个已废弃字段），上游的 v1 则是**顶层单通道**
 * 形状（`{mode, sections}`，无 channels）。本文件必须能读回上游 v2，否则升级即静默
 * 丢失用户勾选；写出的 v2 上游也仍能读（它接受 ver===2），故回滚到上游不会重置。
 * 若把本信封编号写成 1，就会与上游 v1 的顶层形状撞号：既读不回上游 v2，写出的文件
 * 上游按顶层解析又只得到缺省。
 *
 * 原子写（临时文件 + rename），损坏/不支持 schema 回退缺省（mode='default', sections=[]）。
 * 持久化原因：Host 进程需要读用户选择（浏览器关闭后重开、换浏览器都不能丢），
 * 因此以磁盘为真源，而不是依赖浏览器 localStorage。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { SectionId } from '../schema/types.ts';
import type { SyncTransportType } from './sync-config.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';

export const SYNC_SELECTION_FILE = 'sync-selection.json';
export const SYNC_SELECTION_SCHEMA_VERSION = 2;
/** 可读的版本：1 = 上游顶层单通道（或早期 channels 信封）；2 = 本信封（含上游 0.1.60）。 */
export const SYNC_SELECTION_SUPPORTED_VERSIONS: readonly number[] = [1, 2];

/** 远程同步分区选择模式：default = 全部推荐分区；advanced = 自定义勾选。 */
export type SyncSelectionMode = 'default' | 'advanced';

/** 远程同步分区选择（持久化面；单通道）。 */
export interface SyncSelection {
  schemaVersion: number;
  mode: SyncSelectionMode;
  /** 高级模式勾选分区；default 模式可为空数组 */
  sections: SectionId[];
}

/** 缺省配置（首次无文件 / 损坏 / 不支持 schema 时回退） */
export function defaultSyncSelection(): SyncSelection {
  return { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'default', sections: [] };
}

/**
 * 生效的同步分区范围：
 * - mode='advanced' 且 sections 非空 → sections（自定义同步）；
 * - 其余（default / advanced 但未勾选）→ undefined（= 全部推荐分区）。
 */
export function effectiveSections(sel: SyncSelection): SectionId[] | undefined {
  if (sel.mode === 'advanced' && sel.sections.length > 0) return [...sel.sections];
  return undefined;
}

/** 从单通道对象解析（非法字段回退缺省）。 */
function parseChannelSelection(obj: Record<string, unknown>): SyncSelection {
  const sel = defaultSyncSelection();
  if (obj['mode'] === 'advanced' || obj['mode'] === 'default') sel.mode = obj['mode'];
  if (Array.isArray(obj['sections'])) {
    sel.sections = obj['sections'].filter(
      (s): s is SectionId => typeof s === 'string' && s !== '',
    );
  }
  return sel;
}

/** 读取全部通道的分区选择配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readAllSyncSelections(dir: string): Promise<Record<SyncTransportType, SyncSelection>> {
  const fallback = (): Record<SyncTransportType, SyncSelection> => ({
    git: defaultSyncSelection(),
    webdav: defaultSyncSelection(),
  });
  const file = path.join(dir, SYNC_SELECTION_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return fallback();
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return fallback();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback();
  const obj = parsed as Record<string, unknown>;
  // 缺 schemaVersion 视为 v1（与上游一致）；不支持的版本回退缺省。
  const ver = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  if (!SYNC_SELECTION_SUPPORTED_VERSIONS.includes(ver)) return fallback();
  const channels = obj['channels'];
  if (channels === null || typeof channels !== 'object' || Array.isArray(channels)) {
    // v1 顶层单通道形状：整个对象就是一个通道配置（归 git），与上游迁移语义一致。
    // v2 缺 channels 信封属于损坏 → 回退缺省。
    if (ver === 1) return { git: parseChannelSelection(obj), webdav: defaultSyncSelection() };
    return fallback();
  }
  const ch = channels as Record<string, unknown>;
  const pick = (ns: unknown): SyncSelection =>
    ns !== null && typeof ns === 'object' && !Array.isArray(ns)
      ? parseChannelSelection(ns as Record<string, unknown>)
      : defaultSyncSelection();
  return { git: pick(ch['git']), webdav: pick(ch['webdav']) };
}

/** 读取指定通道的分区选择配置；文件不存在 / 损坏 / 不支持 schema → 缺省值（不抛错）。 */
export async function readSyncSelection(dir: string, channel: SyncTransportType): Promise<SyncSelection> {
  const all = await readAllSyncSelections(dir);
  return all[channel];
}

/** 写入指定通道的分区选择配置（原子写：临时文件 + rename；保留另一通道；自动创建目录）。 */
export async function writeSyncSelection(dir: string, channel: SyncTransportType, sel: SyncSelection): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await readAllSyncSelections(dir);
  const channels: Record<SyncTransportType, SyncSelection> = {
    git: channel === 'git' ? sel : existing.git,
    webdav: channel === 'webdav' ? sel : existing.webdav,
  };
  const payload: Record<string, unknown> = {
    schemaVersion: SYNC_SELECTION_SCHEMA_VERSION,
    channels: {
      git: { mode: channels.git.mode, sections: channels.git.sections },
      webdav: { mode: channels.webdav.mode, sections: channels.webdav.sections },
    },
  };
  const target = path.join(dir, SYNC_SELECTION_FILE);
  const data = stringifyJsonSafe(payload, { space: 2 });
  await atomicWriteFile(target, data, { mode: 0o600 });
}

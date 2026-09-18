/**
 * 配置状态向量（Phase 1 地基：P0-1 自动快照 / P0-2 撤销重做 共用）。
 *
 * 问题：既有 `Snapshot` 是**导入计划驱动**的（只登记本次导入将写入的目标），
 * 因此它无法回答「相对于某个时刻，配置整体有没有变」「变的是哪个分区」。
 * 撤销/重做与自动快照需要的正是后者。
 *
 * 本模块把「当前 DSH 配置」压成一个**可分区的稳定指纹集合**（ConfigState）：
 *  - 每个分区经 `adapter.export(ctx, { includeSecrets: false })` 读取；
 *  - 对分区内容做**稳定序列化**后取 sha256（对象键排序，跨进程/跨机器一致）；
 *  - 文件类分区的文件字节按 sha256 计入，不把二进制塞进哈希输入。
 *
 * 边界：纯计算 + 只读 adapter，零写入；不持久化（持久化见 config-snapshot.ts）。
 * 采集失败的分区**跳过并回调**，绝不因单分区异常而使整次采集失败——否则一个坏
 * adapter 会让自动快照静默停摆。
 */
import { sha256Hex } from '../utils/hashing.ts';
import type { SectionId } from '../schema/types.ts';
import type { ConfigAdapter, ExportSection, HostContext } from './types.ts';

/** 单分区状态：内容指纹 + 计数（counts 仅展示，不参与相等性判定） */
export interface SectionState {
  section: SectionId;
  /** 分区内容的稳定 sha256（hex） */
  hash: string;
  /** adapter 自报计数（展示用；不参与相等判定） */
  counts: Record<string, number>;
  /** 文件类分区的文件条数（非文件分区为 0） */
  fileCount: number;
}

/** 一次配置状态采集结果 */
export interface ConfigState {
  /** ISO 时间戳 */
  capturedAt: string;
  /** 按 section 名升序，保证 stateSections/diff 的确定性 */
  sections: SectionState[];
}

/**
 * 稳定序列化：对象键**排序**后输出，保证同一逻辑内容得到同一字符串。
 * 处理 undefined / 函数 → 省略（与 JSON 语义一致）；Date → ISO；Uint8Array → base64 标记。
 * 不追求通用性：只服务本模块的哈希输入（adapter 导出数据 = JSON 安全结构）。
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v as number) ? String(v) : 'null';
    if (t === 'boolean') return v === true ? 'true' : 'false';
    if (t === 'bigint') return `${String(v)}n`;
    if (t === 'string') return JSON.stringify(v);
    if (t === 'function' || t === 'symbol') return 'undefined';
    // 二进制按内容 sha256 计入，而非 base64 展开：文件类分区的字节就在 data.files[].data 里，
    // 展开成 base64 会让哈希输入膨胀 33% 且对大目录明显变慢；变更检测只需要内容指纹。
    if (v instanceof Uint8Array) return `"sha256:${sha256Hex(v)}"`;
    if (v instanceof Date) return JSON.stringify(v.toISOString());
    const obj = v as object;
    if (seen.has(obj)) return '"<cycle>"';
    seen.add(obj);
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, val]) => val !== undefined && typeof val !== 'function')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${walk(val)}`).join(',')}}`;
  };
  return walk(value);
}

/**
 * 分区内容指纹。
 * data 走 stableStringify；files（文件类分区）按「相对路径 + 内容 sha256」参与，
 * 使文件重命名/内容变化都能被识别，而不必把字节写进哈希输入。
 */
export function hashExportSection(section: Pick<ExportSection, 'data' | 'files'>): string {
  const files = (section.files ?? [])
    .map((f) => ({ path: f.relativePath, hash: sha256Hex(f.data) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(stableStringify({ data: section.data, files }));
}

export interface CaptureConfigStateOptions {
  /** 仅采集这些分区（缺省 = 全部传入的 adapter） */
  only?: readonly SectionId[];
  /** 单分区采集失败回调（该分区被跳过，不进入 state） */
  onSectionError?: (section: SectionId, error: unknown) => void;
}

/**
 * 由**已导出的**分区结果构建状态（按 section 升序）。
 *
 * 单一事实源：`captureConfigState` 与「先导出再落快照」的快照路径都必须走这里，
 * 否则两条路径的分区口径（hash / counts / fileCount）会悄悄漂移。
 */
export function stateFromExports(
  sections: ReadonlyMap<SectionId, ExportSection>,
  capturedAt: string = new Date().toISOString(),
): ConfigState {
  const list: SectionState[] = [];
  for (const [id, exported] of sections) {
    list.push({
      section: id,
      hash: hashExportSection(exported),
      counts: exported.counts ?? {},
      fileCount: exported.files?.length ?? 0,
    });
  }
  list.sort((a, b) => (a.section < b.section ? -1 : a.section > b.section ? 1 : 0));
  return { capturedAt, sections: list };
}

/**
 * 采集当前配置状态。分区按 id 升序输出以保证可比性。
 * 单分区失败 → 跳过（记入 onSectionError），不抛出。
 */
export async function captureConfigState(
  adapters: readonly ConfigAdapter[],
  ctx: HostContext,
  opts: CaptureConfigStateOptions = {},
): Promise<ConfigState> {
  const only = opts.only !== undefined ? new Set(opts.only) : null;
  const collected = new Map<SectionId, ExportSection>();
  for (const adapter of adapters) {
    if (only !== null && !only.has(adapter.id)) continue;
    try {
      collected.set(adapter.id, await adapter.export(ctx, { includeSecrets: false, only: [adapter.id] }));
    } catch (error) {
      opts.onSectionError?.(adapter.id, error);
    }
  }
  return stateFromExports(collected);
}

/** section → SectionState（便于比较与展示）；state 为 null/损坏时返回空表（不抛）。 */
export function stateSections(state: ConfigState | null): Map<SectionId, SectionState> {
  const map = new Map<SectionId, SectionState>();
  const sections = sectionListOf(state);
  if (sections === null) return map;
  for (const s of sections) map.set(s.section, s);
  return map;
}

/**
 * 取出 state.sections；非数组（含 state 为 null/undefined、或旧格式缺字段）→ null。
 * 用于让 statesEqual 成为**全函数**：绝不因一条损坏的持久化快照而抛 TypeError
 * （undo/redo/status 都直接消费磁盘上的 meta.state）。
 */
function sectionListOf(state: ConfigState | null | undefined): SectionState[] | null {
  if (state === null || state === undefined) return null;
  const sections = (state as { sections?: unknown }).sections;
  return Array.isArray(sections) ? (sections as SectionState[]) : null;
}

/**
 * 两个状态的内容是否完全一致（分区集合 + 每分区 hash）。
 *
 * 全函数：null / undefined / 缺 sections 的损坏状态一律**不抛**——
 * 任一侧不可解析时退化为引用相等（null vs null 为 true，其余为 false）。
 */
export function statesEqual(a: ConfigState | null, b: ConfigState | null): boolean {
  const left = sectionListOf(a);
  const right = sectionListOf(b);
  if (left === null || right === null) return a === b;
  if (left.length !== right.length) return false;
  const bySection = new Map<SectionId, SectionState>();
  for (const s of left) bySection.set(s.section, s);
  for (const s of right) {
    const other = bySection.get(s.section);
    if (other === undefined || other.hash !== s.hash) return false;
  }
  return true;
}

export interface ConfigStateDiff {
  /** 两侧都有但 hash 不同 */
  changed: SectionId[];
  /** 仅 after 有 */
  added: SectionId[];
  /** 仅 before 有 */
  removed: SectionId[];
  /** 无任何差异 */
  identical: boolean;
}

/** 分区级差异（before → after）。顺序确定（按 section 升序）。 */
export function diffStates(before: ConfigState | null, after: ConfigState | null): ConfigStateDiff {
  const b = stateSections(before);
  const a = stateSections(after);
  const changed: SectionId[] = [];
  const added: SectionId[] = [];
  const removed: SectionId[] = [];
  for (const [id, as] of a) {
    const bs = b.get(id);
    if (bs === undefined) added.push(id);
    else if (bs.hash !== as.hash) changed.push(id);
  }
  for (const id of b.keys()) {
    if (!a.has(id)) removed.push(id);
  }
  const sortIds = (ids: SectionId[]): SectionId[] => ids.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  sortIds(changed);
  sortIds(added);
  sortIds(removed);
  return { changed, added, removed, identical: changed.length === 0 && added.length === 0 && removed.length === 0 };
}

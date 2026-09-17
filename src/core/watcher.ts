/**
 * 防抖文件监听 + 回声抑制（Phase 1 P0-1：自动快照）。
 *
 * 为什么把监听器做成 core 模块而不是直接在宿主里调 fs.watch：
 *  1. **可测**：watch 工厂与定时器都由调用方注入，测试用假实现即可驱动时序，
 *     不需要真文件系统、不依赖 sleep，避免既有的「负载相关偶发失败」类脆弱测试；
 *  2. **回声抑制是一等公民**：恢复/回滚动作自己会写文件，若不抑制就会立刻产生
 *     一个「等于刚写回内容」的自动快照，把重做通道堵死。本模块提供两层抑制：
 *     `beginSuppress/endSuppress`（写操作窗口内直接丢弃事件）与 `EchoRegistry`
 *     （窗口外按内容指纹识别回声，防「延迟投递的事件」漏网）。
 *  3. **平台差异隔离**：Windows 上被监听目录删除/改名时 FSWatcher 会异步抛 EPERM，
 *     不挂 error 处理器会变成未捕获 'error' 事件直接把进程炸掉——本模块统一接管。
 */
import path from 'node:path';

/** 监听句柄（fs.watch 返回值的结构子集，便于测试伪造） */
export interface WatchHandle {
  close(): void;
}

/** 监听工厂（真实实现注入 fs.watch） */
export type WatchFactory = (
  dir: string,
  onEvent: (eventType: string, filename: string | null) => void,
) => WatchHandle;

/** 定时器注入（测试用假实现驱动时序） */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>); },
};

export interface WatcherEvent {
  /** 事件发生的目录（绝对路径） */
  dir: string;
  /** 文件名（fs.watch 可能给 null） */
  filename: string;
}

export interface DebouncedWatcherOptions {
  /** 要监听的目录（绝对路径；不存在的目录由 watchFactory 抛错，本类记 onError 后跳过） */
  dirs: readonly string[];
  /** 防抖窗口（毫秒） */
  debounceMs: number;
  watchFactory: WatchFactory;
  /** 防抖到期后回调（事件已合并；同一目录同一文件去重） */
  onFlush: (events: WatcherEvent[]) => void;
  /** 监听失败 / 运行时 error 回调（不抛；默认静默） */
  onError?: (dir: string, error: unknown) => void;
  timers?: TimerApi;
}

/** 临时文件 / 编辑器残留：默认忽略，避免「保存一次触发多轮快照」 */
export function isIgnorableFileName(name: string): boolean {
  if (name === '') return true;
  if (name.startsWith('.')) return true;           // .git / .DS_Store / .swp 等
  if (name.endsWith('~')) return true;             // 编辑器备份
  if (name.endsWith('.tmp')) return true;          // 本仓库 atomicWriteFile 的中间产物
  if (name.endsWith('.swp') || name.endsWith('.swo')) return true;
  if (/\.\d{6,}$/.test(name)) return true;         // 版本化临时（file.json.1234567）
  return false;
}

/**
 * 防抖监听器：把高频文件事件合并成一次 `onFlush`。
 *
 * 生命周期：`start()` 建立监听；`stop()` 关闭全部监听并清掉待发定时器；
 * `start()` 可在 `stop()` 后重新调用（幂等重建——宿主改配置后需要重建监听集）。
 */
export class DebouncedWatcher {
  private readonly options: DebouncedWatcherOptions;
  private readonly timers: TimerApi;
  private handles: { dir: string; handle: WatchHandle }[] = [];
  private timer: unknown = null;
  private pending = new Map<string, WatcherEvent>();
  private suppressCount = 0;
  private running = false;

  constructor(options: DebouncedWatcherOptions) {
    this.options = options;
    this.timers = options.timers ?? defaultTimers;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 当前抑制深度（>0 表示正在执行会自写文件的操作） */
  get suppressDepth(): number {
    return this.suppressCount;
  }

  /** 待发事件数（测试与诊断用） */
  get pendingCount(): number {
    return this.pending.size;
  }

  start(): void {
    this.stop();
    this.running = true;
    for (const dir of this.options.dirs) {
      try {
        const handle = this.options.watchFactory(dir, (_eventType, filename) => {
          this.onEvent(dir, filename);
        });
        this.handles.push({ dir, handle });
      } catch (error) {
        this.options.onError?.(dir, error);
      }
    }
  }

  stop(): void {
    for (const { handle } of this.handles) {
      try {
        handle.close();
      } catch {
        // 关闭失败不影响其余清理
      }
    }
    this.handles = [];
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.running = false;
  }

  /**
   * 进入抑制窗口：期间产生的文件事件**直接丢弃**。
   * 调用方必须在 finally 里 `endSuppress()`，否则自动快照会永久停摆。
   */
  beginSuppress(): void {
    this.suppressCount += 1;
  }

  /**
   * 退出抑制窗口：深度归零时**顺带清空待发事件**——那些事件正是被抑制的写操作
   * 自己产生的，若放行会立刻产生一个回声快照（挡住重做）。
   */
  endSuppress(): void {
    if (this.suppressDepth === 0) return;
    this.suppressCount -= 1;
    if (this.suppressDepth === 0) {
      this.pending.clear();
      if (this.timer !== null) {
        this.timers.clearTimeout(this.timer);
        this.timer = null;
      }
    }
  }

  /** 同步便捷包装：抑制窗口内执行 fn，异常也保证退出抑制。 */
  suppressWhile<T>(fn: () => T): T {
    this.beginSuppress();
    try {
      return fn();
    } finally {
      this.endSuppress();
    }
  }

  /** 异步便捷包装（恢复/回滚等长操作）。 */
  async suppressWhileAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.beginSuppress();
    try {
      return await fn();
    } finally {
      this.endSuppress();
    }
  }

  private onEvent(dir: string, filename: string | null): void {
    if (this.suppressDepth > 0) return; // 抑制窗口：自写文件不触发快照
    if (filename === null || typeof filename !== 'string') return;
    if (isIgnorableFileName(filename)) return;
    const basename = path.basename(filename);
    if (isIgnorableFileName(basename)) return;
    // 同目录同文件去重（fs.watch 常对一次保存投递 change+rename 两个事件）
    this.pending.set(`${dir}\u0000${filename}`, { dir, filename });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      const events = [...this.pending.values()];
      this.pending.clear();
      if (events.length === 0) return;
      if (this.suppressDepth > 0) return; // 定时器期间被抑制 → 丢弃
      this.options.onFlush(events);
    }, this.options.debounceMs);
  }
}

/**
 * 回声登记表：记录「我们刚刚写回的内容指纹」，用于识别监听器收到的
 * 「恢复动作自己的写」这一回声。
 *
 * 与 `beginSuppress/endSuppress` 的分工：抑制窗口覆盖**写操作进行中**的事件；
 * 本表覆盖**窗口之后才被投递**的延迟事件（macOS / 网络盘 / 杀毒软件扫描后
 * 重写文件都可能造成事件晚到）。两条防线缺一不可——竞品的注释与 v0.4.6
 * CHANGELOG 都记录了「macOS 延迟投递的回声快照挡住 redo」这一实际事故。
 */
export class EchoRegistry {
  private readonly hashes = new Map<string, string>();

  /** 登记一次写回：key 建议 `${scope}:${relPath}`（如 `config:cordis.patch.yml`） */
  record(key: string, hash: string): void {
    this.hashes.set(key, hash);
  }

  /** 是否仍等于我们写回的内容（= 回声，应忽略） */
  isEcho(key: string, hash: string): boolean {
    return this.hashes.get(key) === hash;
  }

  has(key: string): boolean {
    return this.hashes.has(key);
  }

  get size(): number {
    return this.hashes.size;
  }

  /**
   * 清空。
   * 语义：**真实变更一旦发生就清空整表**——否则后续对同一路径的合法修改
   * 只要恰好等于某次历史写回内容就会被误判为回声而漏拍。
   */
  clear(): void {
    this.hashes.clear();
  }
}

/**
 * 把事件批按「目录 → 文件名」聚合，便于调用方按关注目录分类。
 * 返回 Map<dir, Set<filename>>（顺序无关，便于集合判定）。
 */
export function groupEventsByDir(events: readonly WatcherEvent[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    const set = out.get(e.dir) ?? new Set<string>();
    set.add(e.filename);
    out.set(e.dir, set);
  }
  return out;
}

/** 事件批里是否包含关注的文件名（跨目录；用于「配置目录里出现了被关注的 basename」判定） */
export function hasWatchedBasename(
  events: readonly WatcherEvent[],
  watched: ReadonlySet<string>,
): boolean {
  return events.some((e) => watched.has(path.basename(e.filename)));
}

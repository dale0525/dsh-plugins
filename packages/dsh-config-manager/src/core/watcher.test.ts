/**
 * Phase 1 P0-1 回归：防抖监听 + 回声抑制（watcher.ts）。
 *
 * 全部时序由假定时器驱动 —— 不 sleep、不碰真文件系统，因此不受机器负载影响
 * （本仓库既有套件里有过「负载相关偶发失败」，此处刻意规避同类脆弱性）。
 *
 * 覆盖用户可见契约：
 *  - 高频事件合并成一次 flush（一次保存 = 一次快照，不是多次）；
 *  - 同一文件的 change+rename 双事件去重；
 *  - 临时文件 / 隐藏文件不触发（否则编辑器保存会打出成串快照）；
 *  - **抑制窗口内的自写文件不触发快照**（否则恢复动作会挡住重做）；
 *  - 抑制窗口结束时清空待发事件（延迟投递也不放行）；
 *  - EchoRegistry 识别「等于刚写回内容」的回声，真实变更清空登记表；
 *  - watch 工厂抛错 / 运行时报错只回调 onError，绝不抛出（否则会炸掉宿主启动）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DebouncedWatcher, EchoRegistry, groupEventsByDir, hasWatchedBasename, isIgnorableFileName,
  type TimerApi, type WatchFactory, type WatcherEvent,
} from './watcher.ts';

/* ------------------------------------------------------------ 假定时器 */

/** 虚拟时钟假定时器：`advance(ms)` 推进时钟并按到期时间执行（与真实 setTimeout 同语义） */
class FakeTimers implements TimerApi {
  private seq = 0;
  private now = 0;
  private scheduled = new Map<number, { fn: () => void; deadline: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = ++this.seq;
    this.scheduled.set(handle, { fn, deadline: this.now + ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle);
  }

  /** 推进虚拟时钟 delta 毫秒，按到期顺序执行所有已到点的定时器 */
  advance(delta: number): void {
    this.now += delta;
    for (;;) {
      const due = [...this.scheduled.entries()]
        .filter(([, e]) => e.deadline <= this.now)
        .sort((a, b) => a[1].deadline - b[1].deadline);
      const next = due[0];
      if (next === undefined) break;
      const [handle, entry] = next;
      this.scheduled.delete(handle);
      entry.fn();
    }
  }

  get pending(): number {
    return this.scheduled.size;
  }
}

/** 可编程 watch 工厂：记录监听目录，允许手动投递事件 */
class FakeWatchFactory {
  readonly watched: string[] = [];
  readonly closed: string[] = [];
  failOn = new Set<string>();
  private readonly callbacks = new Map<string, (e: string, f: string | null) => void>();

  readonly factory: WatchFactory = (dir, onEvent) => {
    if (this.failOn.has(dir)) throw new Error(`cannot watch ${dir}`);
    this.watched.push(dir);
    this.callbacks.set(dir, onEvent);
    return { close: () => { this.closed.push(dir); this.callbacks.delete(dir); } };
  };

  emit(dir: string, filename: string | null, eventType = 'change'): void {
    const cb = this.callbacks.get(dir);
    if (cb === undefined) throw new Error(`目录未被监听: ${dir}`);
    cb(eventType, filename);
  }
}

function setup(opts: { dirs?: string[]; debounceMs?: number; failDirs?: string[] } = {}): {
  watcher: DebouncedWatcher;
  timers: FakeTimers;
  factory: FakeWatchFactory;
  flushes: WatcherEvent[][];
  errors: { dir: string; error: unknown }[];
} {
  const timers = new FakeTimers();
  const factory = new FakeWatchFactory();
  if (opts.failDirs !== undefined) for (const d of opts.failDirs) factory.failOn.add(d);
  const flushes: WatcherEvent[][] = [];
  const errors: { dir: string; error: unknown }[] = [];
  const watcher = new DebouncedWatcher({
    dirs: opts.dirs ?? ['C:/home/.dsh', 'C:/home/.dsh/profiles/web'],
    debounceMs: opts.debounceMs ?? 1500,
    watchFactory: factory.factory,
    onFlush: (events) => flushes.push(events),
    onError: (dir, error) => errors.push({ dir, error }),
    timers,
  });
  return { watcher, timers, factory, flushes, errors };
}

/* ------------------------------------------------------------ 文件名过滤 */

test('isIgnorableFileName：忽略隐藏 / 备份 / 临时 / 版本化临时文件', () => {
  for (const name of ['', '.git', '.DS_Store', 'a.swp', 'x~', 'y.tmp', 'settings.yaml.1234567']) {
    assert.equal(isIgnorableFileName(name), true, `${name} 应被忽略`);
  }
  for (const name of ['settings.yaml', 'cordis.patch.yml', 'package.json', 'a.md']) {
    assert.equal(isIgnorableFileName(name), false, `${name} 不应被忽略`);
  }
});

/* ------------------------------------------------------------ 防抖与合并 */

test('start：为每个目录建立监听；stop：全部关闭', () => {
  const { watcher, factory } = setup();
  watcher.start();
  assert.deepEqual(factory.watched, ['C:/home/.dsh', 'C:/home/.dsh/profiles/web']);
  assert.equal(watcher.isRunning, true);
  watcher.stop();
  assert.deepEqual(factory.closed, ['C:/home/.dsh', 'C:/home/.dsh/profiles/web']);
  assert.equal(watcher.isRunning, false);
});

test('高频事件合并成一次 flush（一次保存 = 一次快照）', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  factory.emit('C:/home/.dsh', 'settings.yaml');
  factory.emit('C:/home/.dsh', 'cordis.patch.yml');
  factory.emit('C:/home/.dsh/profiles/web', 'package.json');
  assert.equal(flushes.length, 0, '防抖窗口内不得 flush');
  timers.advance(1500);
  assert.equal(flushes.length, 1, '合并为一次');
  assert.equal(flushes[0]!.length, 3);
});

test('同一文件的 change+rename 双事件去重', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  factory.emit('C:/home/.dsh', 'settings.yaml', 'change');
  factory.emit('C:/home/.dsh', 'settings.yaml', 'rename');
  assert.equal(watcher.pendingCount, 1, '同目录同文件应去重');
  timers.advance(1500);
  assert.equal(flushes[0]!.length, 1);
});

test('防抖窗口被新事件重置（不是固定窗口内的第一次就 flush）', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  factory.emit('C:/home/.dsh', 'settings.yaml');
  timers.advance(1000); // 未到 1500
  factory.emit('C:/home/.dsh', 'package.json');
  timers.advance(1000); // 距上次事件 1000ms，仍未到
  assert.equal(flushes.length, 0, '窗口应被重置');
  timers.advance(600);
  assert.equal(flushes.length, 1);
});

test('临时 / 隐藏文件事件不触发 flush', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  factory.emit('C:/home/.dsh', '.settings.yaml.swp');
  factory.emit('C:/home/.dsh', 'settings.yaml.tmp');
  factory.emit('C:/home/.dsh', 'settings.yaml~');
  timers.advance(5000);
  assert.equal(flushes.length, 0, '不得因编辑器中间产物触发快照');
  assert.equal(timers.pending, 0, '被忽略的事件不应留下定时器');
});

test('filename 为 null 的事件被忽略（fs.watch 会给出 null）', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  factory.emit('C:/home/.dsh', null);
  timers.advance(5000);
  assert.equal(flushes.length, 0);
});

/* ------------------------------------------------------------ 抑制窗口（回声防线 1） */

test('抑制窗口内的事件直接丢弃（恢复动作自写文件不得触发快照）', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  watcher.beginSuppress();
  factory.emit('C:/home/.dsh', 'cordis.patch.yml');
  factory.emit('C:/home/.dsh', 'settings.yaml');
  timers.advance(5000);
  assert.equal(flushes.length, 0);
  assert.equal(watcher.pendingCount, 0);
  watcher.endSuppress();
  assert.equal(watcher.suppressDepth, 0);
});

test('endSuppress 清空待发事件：抑制前排队、抑制期间到期的也不放行', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  factory.emit('C:/home/.dsh', 'settings.yaml'); // 先排队
  watcher.beginSuppress();                        // 抑制前先压住
  timers.advance(5000);                           // 定时器到点
  assert.equal(flushes.length, 0, '抑制期间不得 flush');
  watcher.endSuppress();
  timers.advance(5000);
  assert.equal(flushes.length, 0, '抑制结束也不得补发（那是自写文件的回声）');
  assert.equal(timers.pending, 0, '定时器必须被清掉');
});

test('suppressWhile：正常返回并保证退出抑制；抛错也退出', () => {
  const { watcher, factory, timers, flushes } = setup();
  watcher.start();
  const value = watcher.suppressWhile(() => {
    factory.emit('C:/home/.dsh', 'settings.yaml');
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(watcher.suppressDepth, 0);
  timers.advance(5000);
  assert.equal(flushes.length, 0);
  assert.throws(() => watcher.suppressWhile(() => { throw new Error('boom'); }), /boom/);
  assert.equal(watcher.suppressDepth, 0, '异常路径也必须退出抑制');
});

test('suppressWhileAsync：异步恢复期间抑制，结束后真实变更照常触发', async () => {
  const { watcher, factory, timers, flushes } = setup();
  watcher.start();
  await watcher.suppressWhileAsync(async () => {
    factory.emit('C:/home/.dsh', 'settings.yaml');
    await Promise.resolve();
  });
  assert.equal(watcher.suppressDepth, 0);
  timers.advance(5000);
  assert.equal(flushes.length, 0, '抑制期间的自写不得产生快照');
  factory.emit('C:/home/.dsh', 'settings.yaml');
  timers.advance(5000);
  assert.equal(flushes.length, 1, '真实变更必须照常触发');
});

test('endSuppress 在深度为 0 时是空操作（不会把深度压成负数）', () => {
  const { watcher } = setup();
  watcher.endSuppress();
  assert.equal(watcher.suppressDepth, 0);
});

test('嵌套抑制：内层退出不清空，外层退出才清空', () => {
  const { watcher, timers, factory, flushes } = setup();
  watcher.start();
  watcher.beginSuppress();
  watcher.beginSuppress();
  factory.emit('C:/home/.dsh', 'settings.yaml');
  watcher.endSuppress();
  assert.equal(watcher.suppressDepth, 1);
  timers.advance(5000);
  assert.equal(flushes.length, 0, '仍在内层抑制中');
  watcher.endSuppress();
  assert.equal(watcher.suppressDepth, 0);
  assert.equal(timers.pending, 0);
});

/* ------------------------------------------------------------ 错误容错 */

test('不可监听的目录只回调 onError，不抛出（否则会炸掉宿主启动）', () => {
  const { watcher, errors, factory } = setup({ failDirs: ['C:/home/.dsh/profiles/web'] });
  watcher.start();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.dir, 'C:/home/.dsh/profiles/web');
  assert.deepEqual(factory.watched, ['C:/home/.dsh'], '其余目录照常监听');
});

test('start 幂等重建：重复 start 先关旧监听，不重复订阅', () => {
  const { watcher, factory } = setup({ dirs: ['C:/home/.dsh'] });
  watcher.start();
  watcher.start();
  assert.deepEqual(factory.closed, ['C:/home/.dsh'], '第二次 start 应关闭旧句柄');
  assert.deepEqual(factory.watched, ['C:/home/.dsh', 'C:/home/.dsh']);
});

/* ------------------------------------------------------------ EchoRegistry（回声防线 2） */

test('EchoRegistry：内容相同判回声，内容变化判真实变更', () => {
  const reg = new EchoRegistry();
  reg.record('config:settings.yaml', 'h1');
  assert.equal(reg.isEcho('config:settings.yaml', 'h1'), true);
  assert.equal(reg.isEcho('config:settings.yaml', 'h2'), false, '内容变了 → 真实变更');
  assert.equal(reg.isEcho('config:other.yaml', 'h1'), false, '未登记路径 → 非回声');
  assert.equal(reg.size, 1);
});

test('EchoRegistry：真实变更后 clear 整表（防后续合法修改被误判为回声而漏拍）', () => {
  const reg = new EchoRegistry();
  reg.record('config:settings.yaml', 'h1');
  reg.record('config:package.json', 'h2');
  reg.clear();
  assert.equal(reg.size, 0);
  assert.equal(reg.isEcho('config:settings.yaml', 'h1'), false);
});

test('EchoRegistry：has 区分「登记过」与「内容相等」', () => {
  const reg = new EchoRegistry();
  reg.record('k', 'h');
  assert.equal(reg.has('k'), true);
  assert.equal(reg.has('missing'), false);
  assert.equal(reg.isEcho('k', 'different'), false);
});

/* ------------------------------------------------------------ 事件聚合工具 */

test('groupEventsByDir：按目录聚合去重', () => {
  const grouped = groupEventsByDir([
    { dir: 'A', filename: 'x' },
    { dir: 'A', filename: 'x' },
    { dir: 'A', filename: 'y' },
    { dir: 'B', filename: 'z' },
  ]);
  assert.deepEqual([...grouped.get('A')!].sort(), ['x', 'y']);
  assert.deepEqual([...grouped.get('B')!], ['z']);
});

test('hasWatchedBasename：跨目录匹配关注的 basename', () => {
  const watched = new Set(['settings.yaml', 'cordis.patch.yml']);
  assert.equal(hasWatchedBasename([{ dir: 'A', filename: 'settings.yaml' }], watched), true);
  assert.equal(hasWatchedBasename([{ dir: 'A', filename: 'C:/x/cordis.patch.yml' }], watched), true);
  assert.equal(hasWatchedBasename([{ dir: 'A', filename: 'unrelated.md' }], watched), false);
  assert.equal(hasWatchedBasename([], watched), false);
});

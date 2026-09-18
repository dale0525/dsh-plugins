/**
 * toast-store 单测：状态机行为（去重 / 上限 / 计时 / 手动关闭 / 空文案）。
 *
 * 计时器全部走注​入的假实现（`schedule`/`cancel`），因此测试**零真实等待**、
 * 结果确定（不受 CI 负载影响）。同时用 subscribe 计数验证「无变更不通知订阅者」——
 * 该性质直接决定 React 端不会因悬停暂停而重渲染。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToastStore, DEFAULT_DURATION_MS } from './toast-store.ts'

/** 可控的假计时器：手动 `runDue()` 推进。 */
function makeClock() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number, fn: () => void }>()
  return {
    schedule: (fn: () => void, ms: number): number => {
      const id = ++seq
      pending.set(id, { at: now + ms, fn })
      return id
    },
    cancel: (handle: unknown): void => { pending.delete(handle as number) },
    /** 推进 now 毫秒并触发所有到期任务。 */
    runDue(ms: number): void {
      now += ms
      for (const [id, task] of [...pending]) {
        if (task.at <= now) {
          pending.delete(id)
          task.fn()
        }
      }
    },
    get pendingCount(): number { return pending.size },
  }
}

function makeStore(maxVisible?: number) {
  const clock = makeClock()
  const store = new ToastStore({ maxVisible, schedule: clock.schedule, cancel: clock.cancel })
  return { store, clock }
}

test('toast: push 入队并通知订阅者，getSnapshot 返回该条', () => {
  const { store } = makeStore()
  let notified = 0
  store.subscribe(() => { notified += 1 })

  const id = store.push('ok', '已保存')

  assert.ok(id > 0)
  assert.equal(notified, 1)
  assert.deepEqual(store.getSnapshot().items.map((t) => t.text), ['已保存'])
})

test('toast: 空/纯空白文案被忽略（不入队、不通知）', () => {
  const { store } = makeStore()
  let notified = 0
  store.subscribe(() => { notified += 1 })

  assert.equal(store.push('ok', ''), 0)
  assert.equal(store.push('ok', '   \n\t '), 0)
  assert.equal(store.getSnapshot().items.length, 0)
  assert.equal(notified, 0, '空文案不得触发订阅通知');
})

test('toast: 同 kind+text 重复 push 不新增条目（防连点刷屏）', () => {
  const { store } = makeStore()
  const first = store.push('ok', '已导出')
  const second = store.push('ok', '已导出')

  assert.equal(first, second, '应复用同一条目 id')
  assert.equal(store.getSnapshot().items.length, 1)
})

test('toast: 同文案不同 kind 视为两条（语义不同）', () => {
  const { store } = makeStore()
  store.push('ok', '完成')
  store.push('error', '完成')
  assert.equal(store.getSnapshot().items.length, 2)
})

test('toast: 到期自动消失', () => {
  const { store, clock } = makeStore()
  store.push('ok', '临时提示')
  assert.equal(store.getSnapshot().items.length, 1)

  clock.runDue(DEFAULT_DURATION_MS.ok - 1)
  assert.equal(store.getSnapshot().items.length, 1, '未到期不得消失')

  clock.runDue(1)
  assert.equal(store.getSnapshot().items.length, 0, '到期应自动移除')
})

test('toast: durationMs=0 表示常驻，不自动消失', () => {
  const { store, clock } = makeStore()
  store.push('error', '需手动关闭', 0)

  clock.runDue(10 * 60 * 1000)
  assert.equal(store.getSnapshot().items.length, 1, '常驻通知不得被计时清掉')
  assert.equal(clock.pendingCount, 0, '常驻通知不应占用计时器')
})

test('toast: 超过同屏上限挤掉最旧一条，并释放其计时器', () => {
  const { store, clock } = makeStore(3)
  store.push('ok', 'a')
  store.push('ok', 'b')
  store.push('ok', 'c')
  assert.equal(store.getSnapshot().items.length, 3)

  store.push('ok', 'd')

  assert.deepEqual(store.getSnapshot().items.map((t) => t.text), ['b', 'c', 'd'])
  // 4 条各自排定过计时；a 被挤掉后其计时器必须被取消 → 只剩 3 个
  assert.equal(clock.pendingCount, 3, '被挤掉的条目必须清掉计时器（防泄漏）')
})

test('toast: dismiss 手动关闭并清掉计时器', () => {
  const { store, clock } = makeStore()
  const id = store.push('ok', '关闭我')
  assert.equal(clock.pendingCount, 1)

  store.dismiss(id)

  assert.equal(store.getSnapshot().items.length, 0)
  assert.equal(clock.pendingCount, 0)
  assert.equal(store.dismiss(id), undefined, '重复 dismiss 应为安全 no-op')
})

test('toast: pauseTimer 取消计时但保留条目，resetTimer 重新计时', () => {
  const { store, clock } = makeStore()
  const id = store.push('info', '悬停暂停')
  assert.equal(clock.pendingCount, 1)

  // 悬停：只停表，不动条目、不产生新快照
  let notified = 0
  store.subscribe(() => { notified += 1 })
  store.pauseTimer(id)
  assert.deepEqual(store.getSnapshot().items.map((t) => t.text), ['悬停暂停'])
  assert.equal(clock.pendingCount, 0)
  assert.equal(notified, 0, '暂停不应触发重渲染')

  clock.runDue(10 * 60 * 1000)
  assert.equal(store.getSnapshot().items.length, 1, '暂停期间不得消失')

  // 移开：按原时长重新计时
  store.resetTimer(id)
  assert.equal(clock.pendingCount, 1)
  clock.runDue(DEFAULT_DURATION_MS.info)
  assert.equal(store.getSnapshot().items.length, 0)
})

test('toast: clear 清空全部并释放全部计时器', () => {
  const { store, clock } = makeStore()
  store.push('ok', 'a')
  store.push('warn', 'b')
  assert.equal(clock.pendingCount, 2)

  store.clear()

  assert.equal(store.getSnapshot().items.length, 0)
  assert.equal(clock.pendingCount, 0)
})

test('toast: getSnapshot 引用稳定（相同内容不产生新对象，避免 React 死循环）', () => {
  const { store } = makeStore()
  const before = store.getSnapshot()
  assert.equal(store.getSnapshot(), before, '无变更时快照引用必须一致')

  store.push('ok', 'x')
  const after = store.getSnapshot()
  assert.notEqual(after, before, '有变更时应换新引用')

  store.pauseTimer(store.getSnapshot().items[0]!.id)
  assert.equal(store.getSnapshot(), after, '暂停计时不改变快照')
})

test('toast: 订阅退订后不再收到通知', () => {
  const { store } = makeStore()
  let notified = 0
  const off = store.subscribe(() => { notified += 1 })
  store.push('ok', 'one')
  off()
  store.push('ok', 'two')
  assert.equal(notified, 1)
})

test('toast: 默认时长按语义分级（错误比成功停留更久）', () => {
  assert.ok(DEFAULT_DURATION_MS.error > DEFAULT_DURATION_MS.ok)
  assert.ok(DEFAULT_DURATION_MS.warn > DEFAULT_DURATION_MS.ok)
  assert.equal(DEFAULT_DURATION_MS.ok > 0, true, '成功提示须自动消失')
})

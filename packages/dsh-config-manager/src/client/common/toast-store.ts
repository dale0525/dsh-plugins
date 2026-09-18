/**
 * Toast Store —— 全局通知的纯逻辑状态机（零 DOM、零 React，node 可单测）。
 *
 * 为什么独立成 store：插件里大量「操作完成后临时提示」原先散落在各页的局部 state
 * （`flash` / `feedback` / `saved`）里，只能渲染在页面内容流中、切页即丢失、还会把
 * 页面顶开一块。统一到模块级 store 后可跨页面存活，并集中处理去重、同屏上限与自动消失。
 *
 * 设计要点：
 *   - 订阅式（`subscribe`/`getSnapshot`）对接 `useSyncExternalStore`；snapshot 引用仅在
 *     真正变更时替换，避免 React 无限重渲染。
 *   - 计时器依赖注入（`schedule`/`cancel`）：测试里可用假计时器精确驱动，不必等真实时间。
 *   - 同 `kind + text` 已在屏时**不重复入队**，只重置计时（防连点导致刷屏）。
 *   - 同屏上限 `maxVisible`（默认 4）：超出时挤掉最旧的一条，连其计时器一并清理。
 *   - 空文案（trim 后为空）直接忽略，杜绝空白通知条。
 */
import type { ToastKind } from './toast-types.ts'

export type { ToastKind }

/** 单条通知。 */
export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  /** 自动消失毫秒数；0 = 不自动消失（须手动关闭） */
  durationMs: number
}

/** store 快照（`getSnapshot` 返回的稳定引用）。 */
export interface ToastSnapshot {
  items: ToastItem[]
}

/** 计时器句柄（浏览器为 number，node 为 Timeout，测试可自定义）。 */
export type ToastTimerHandle = unknown

export interface ToastStoreOptions {
  /** 同屏最大条数（默认 4）；超出挤掉最旧。 */
  maxVisible?: number
  /** 排定计时器（默认 setTimeout），测试可注入假实现。 */
  schedule?: (fn: () => void, ms: number) => ToastTimerHandle
  /** 取消计时器（默认 clearTimeout）。 */
  cancel?: (handle: ToastTimerHandle) => void
}

/** 各语义的默认停留时长：成功/普通短、失败/警告长（错误需要更多阅读时间）。 */
export const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  ok: 3200,
  info: 3200,
  warn: 5200,
  error: 6400,
}

/** 同屏上限：超过 4 条会盖住插件画布右下角的大片区域。 */
export const MAX_VISIBLE = 4

const EMPTY: ToastSnapshot = { items: [] }

/**
 * 全局通知状态机。通常只用下方的 `toast` 单例，测试时可直接 new 一个隔离实例。
 */
export class ToastStore {
  private items: ToastItem[] = []
  private readonly timers = new Map<number, ToastTimerHandle>()
  private readonly listeners = new Set<() => void>()
  private nextId = 1
  private snapshot: ToastSnapshot = EMPTY
  private readonly maxVisible: number
  private readonly schedule: (fn: () => void, ms: number) => ToastTimerHandle
  private readonly cancel: (handle: ToastTimerHandle) => void

  constructor(options: ToastStoreOptions = {}) {
    this.maxVisible = options.maxVisible ?? MAX_VISIBLE
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = options.cancel ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): ToastSnapshot => this.snapshot

  /**
   * 推入一条通知。返回该条 id；空文案返回 0（表示未入队）。
   * 同 kind+text 已在屏时复用原条目并重置计时。
   */
  push(kind: ToastKind, text: string, durationMs?: number): number {
    const value = text.trim()
    if (value === '') return 0
    const duration = durationMs ?? DEFAULT_DURATION_MS[kind]

    const existing = this.items.find((t) => t.kind === kind && t.text === value)
    if (existing !== undefined) {
      this.arm(existing.id, duration)
      return existing.id
    }

    const id = this.nextId++
    const next: ToastItem[] = [...this.items, { id, kind, text: value, durationMs: duration }]
    const overflowCount = Math.max(0, next.length - this.maxVisible)
    for (const stale of next.slice(0, overflowCount)) this.disarm(stale.id)
    this.items = next.slice(overflowCount)
    this.arm(id, duration)
    this.commit()
    return id
  }

  /** 关闭指定通知（手动关闭 / 计时到期共用）。 */
  dismiss(id: number): void {
    if (!this.items.some((t) => t.id === id)) return
    this.disarm(id)
    this.items = this.items.filter((t) => t.id !== id)
    this.commit()
  }

  /**
   * 重新计时（悬停暂停用）：取消该条当前计时并按 `durationMs`（缺省沿用原时长）重新排定。
   * 不改变条目位置与内容，因此不产生新快照——避免悬停时触发无谓重渲染。
   */
  resetTimer(id: number, durationMs?: number): void {
    const item = this.items.find((t) => t.id === id)
    if (item === undefined) return
    this.arm(id, durationMs ?? item.durationMs)
  }

  /** 暂停自动消失（悬停）：仅取消计时，条目与位置不变。 */
  pauseTimer(id: number): void {
    if (!this.items.some((t) => t.id === id)) return
    this.disarm(id)
  }

  /** 清空全部通知。 */
  clear(): void {
    if (this.items.length === 0) return
    for (const item of this.items) this.disarm(item.id)
    this.items = []
    this.commit()
  }

  /** 排定 / 重置某条的自动消失计时；durationMs <= 0 表示常驻。 */
  private arm(id: number, durationMs: number): void {
    this.disarm(id)
    if (durationMs <= 0) return
    this.timers.set(id, this.schedule(() => { this.dismiss(id) }, durationMs))
  }

  private disarm(id: number): void {
    const handle = this.timers.get(id)
    if (handle === undefined) return
    this.cancel(handle)
    this.timers.delete(id)
  }

  /** 提交新快照并通知订阅者（仅在真正变化时调用）。 */
  private commit(): void {
    this.snapshot = { items: this.items }
    for (const listener of this.listeners) listener()
  }
}

/** 进程级单例（插件内所有页面共用一套通知队列）。 */
export const toastStore = new ToastStore()

/**
 * 面向业务代码的调用入口。
 *
 *   toast.ok('已保存配置档案')
 *   toast.error(redact(err.message))
 *
 * 约定：文案在调用前完成 i18n 与 `redact()`（本模块不碰翻译与脱敏）。
 */
export const toast = {
  ok: (text: string, durationMs?: number): number => toastStore.push('ok', text, durationMs),
  info: (text: string, durationMs?: number): number => toastStore.push('info', text, durationMs),
  warn: (text: string, durationMs?: number): number => toastStore.push('warn', text, durationMs),
  error: (text: string, durationMs?: number): number => toastStore.push('error', text, durationMs),
  dismiss: (id: number): void => { toastStore.dismiss(id) },
  clear: (): void => { toastStore.clear() },
}

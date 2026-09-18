/**
 * Toast 公共类型 —— 独立成文件是为了让 store（无 React）与视图（React）都能引用，
 * 且不产生「store → 视图」的反向依赖。
 */

/** 通知语义：与 Badge / Banner / StatusDot 的既有四态保持一致。 */
export type ToastKind = 'ok' | 'info' | 'warn' | 'error'

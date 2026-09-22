/**
 * Config Manager 表面文案：zh 为源语言，en 镜像每个键。
 * 字典 namespace 由 client/index.ts 注册（declare module 合并进 LocaleNamespaceMap）。
 * 键集合通过 `ConfigManagerKey` 类型在注册处做编译期校验（缺键/多键即编译错误）。
 * 宽读法精简版：仅保留同步页与基础 Shell/Toast 文案。
 */

export const zh = {
  // 入口
  'section.label': '配置同步',
  'section.description': '远程同步 DSH 配置',
  // 公共
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.unknownError': '未知错误',
  // 全局通知（右下角 Toast）
  'toast.copied': '已复制到剪贴板',
  'toast.copyFailed': '复制失败，请手动选择文本复制',
  'toast.refreshed': '已刷新',
  // 状态栏
  'shell.status.running': '正在同步（{count} 个任务进行中）',
  'shell.status.idle': '就绪',
  'shell.version': 'v{plugin} · DSH {dsh}',
}

export type ConfigManagerKey = keyof typeof zh

export const en: Record<ConfigManagerKey, string> = {
  // Entry
  'section.label': 'Config Sync',
  'section.description': 'Sync DSH configurations remotely',
  // Common
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.unknownError': 'Unknown error',
  // Toasts
  'toast.copied': 'Copied to clipboard',
  'toast.copyFailed': 'Failed to copy, please select text manually',
  'toast.refreshed': 'Refreshed',
  // Status bar
  'shell.status.running': 'Syncing ({count} active task(s))',
  'shell.status.idle': 'Ready',
  'shell.version': 'v{plugin} · DSH {dsh}',
}

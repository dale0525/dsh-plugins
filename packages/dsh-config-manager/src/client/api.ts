/**
 * Config Manager 浏览器半 API 客户端 —— 精简版（仅保留 status 与通用 API 错误类）。
 * 远程同步端点由 ./sync/sync-api.ts 的 SyncApi 承载。
 */
import { zhUiT, type UiT } from '../ui/i18n.ts'

/** Host 半状态响应（plugin 版本 / DSH 版本 / 平台，用于设置页页脚版本行） */
export interface ServiceStatus {
  ready: boolean
  pluginVersion: string
  dshVersion: string
  platform: string
  arch: string
}

export const CONFIG_MANAGER_API = {
  status: '/api/dsh-config-manager/status',
} as const

/** 携带路由 JSON error 消息的错误类型 */
export class ConfigManagerApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigManagerApiError'
  }
}

async function readJson<T>(response: Response, t: UiT): Promise<T> {
  const notMountedMessage = t('error.notMounted')
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.status === 404) throw new ConfigManagerApiError(notMountedMessage)
    throw new ConfigManagerApiError(t('error.httpInvalidJson', { status: String(response.status) }))
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : response.status === 404
          ? notMountedMessage
          : `HTTP ${response.status}`
    throw new ConfigManagerApiError(message)
  }
  return body as T
}

export class ConfigManagerApi {
  public readonly t: UiT

  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  async status(): Promise<ServiceStatus> {
    const response = await fetch(CONFIG_MANAGER_API.status)
    return readJson<ServiceStatus>(response, this.t)
  }
}

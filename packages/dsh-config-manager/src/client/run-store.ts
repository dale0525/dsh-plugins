/**
 * run-store —— dsh-config-manager 浏览器半的同步状态中枢。
 *
 * 宽读法改造：仅保留 sync 相关状态。
 * PanelId 收敛为 'sync'。
 */
import type { SyncChannel } from './sync/sync-view.ts'
import type { ConfigManagerApi } from './api.ts'

/* ---------------------------------------------------------------- 基础类型 */

export type PanelId = 'sync'

export interface StoreStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const STATE_KEY = 'dsh.cfgMgr.state.v1'

/* ----------------------------------------------------------- SyncStoreSlice */

export interface SyncStoreSlice {
  channel: SyncChannel
  repoUrl: string
  /** 仅内存：成功后清空，绝不持久化/回显 */
  token: string
  webdavUrl: string
  webdavUsername: string
  /** 仅内存：成功后清空，绝不持久化/回显 */
  webdavPassword: string
  busy: SyncBusyState
  savingConfig: boolean
  /** 最近一次拉取的回滚快照 id（同步页「撤销本次覆盖」入口；无则 null） */
  lastRestoreId: string | null
  error: string | null
  loadError: string | null
}

export type SyncBusyState = 'push' | 'pull' | 'rollback' | null

export type PersistedSyncState = Omit<SyncStoreSlice, 'token' | 'webdavPassword' | 'busy' | 'savingConfig'>

export interface PersistedState {
  v: 1
  panel: 'sync'
  sync: PersistedSyncState
}

export interface StoreState {
  v: 1
  panel: 'sync'
  sync: SyncStoreSlice
}

export type StorePatch = {
  panel?: 'sync'
  sync?: Partial<SyncStoreSlice>
}

export function defaultSyncStoreSlice(): SyncStoreSlice {
  return {
    channel: 'git',
    repoUrl: '',
    token: '',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    busy: null,
    savingConfig: false,
    lastRestoreId: null,
    error: null,
    loadError: null,
  }
}

export function defaultState(): StoreState {
  return {
    v: 1,
    panel: 'sync',
    sync: defaultSyncStoreSlice(),
  }
}

export function toSyncStoreSlice(s: SyncStoreSlice): SyncStoreSlice {
  return {
    channel: s.channel,
    repoUrl: s.repoUrl,
    token: s.token,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    busy: s.busy,
    savingConfig: s.savingConfig,
    lastRestoreId: s.lastRestoreId,
    error: s.error,
    loadError: s.loadError,
  }
}

export function toPersistedState(state: StoreState): PersistedState {
  const s = state.sync

  return {
    v: 1,
    panel: 'sync',
    sync: {
      channel: s.channel,
      repoUrl: s.repoUrl,
      webdavUrl: s.webdavUrl,
      webdavUsername: s.webdavUsername,
      lastRestoreId: s.lastRestoreId,
      error: s.error,
      loadError: s.loadError,
    },
  }
}

export function parsePersistedState(raw: string): PersistedState | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (typeof obj !== 'object' || obj === null) return null
    if (obj['v'] !== 1) return null

    let syncSlice: PersistedSyncState

    if (typeof obj['sync'] === 'object' && obj['sync'] !== null) {
      const parsedSync = obj['sync'] as Record<string, unknown>

      syncSlice = {
        channel: parsedSync['channel'] === 'webdav' ? 'webdav' : 'git',
        repoUrl: typeof parsedSync['repoUrl'] === 'string' ? parsedSync['repoUrl'] : '',
        webdavUrl: typeof parsedSync['webdavUrl'] === 'string' ? parsedSync['webdavUrl'] : '',
        webdavUsername: typeof parsedSync['webdavUsername'] === 'string' ? parsedSync['webdavUsername'] : '',
        lastRestoreId: typeof parsedSync['lastRestoreId'] === 'string' ? parsedSync['lastRestoreId'] : null,
        error: typeof parsedSync['error'] === 'string' ? parsedSync['error'] : null,
        loadError: typeof parsedSync['loadError'] === 'string' ? parsedSync['loadError'] : null,
      }
    } else {
      syncSlice = toPersistedState(defaultState()).sync
    }

    return {
      v: 1,
      panel: 'sync',
      sync: syncSlice,
    }
  } catch {
    return null
  }
}

export class RunStore {
  private state: StoreState
  private storage: StoreStorage | null
  private listeners = new Set<() => void>()

  constructor(opts?: { storage?: StoreStorage | null }) {
    if (opts && 'storage' in opts) {
      this.storage = opts.storage ?? null
    } else {
      try {
        this.storage = typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null
      } catch {
        this.storage = null
      }
    }
    this.state = defaultState()
    this.load()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): StoreState => this.state

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  patch(patchObj: StorePatch): void {
    this.state = {
      ...this.state,
      panel: 'sync',
      sync: patchObj.sync ? { ...this.state.sync, ...patchObj.sync } : this.state.sync,
    }
    this.notify()
    this.save()
  }

  load(): void {
    if (this.storage === null) return
    let raw: string | null = null
    try {
      raw = this.storage.getItem(STATE_KEY)
    } catch {
      return
    }
    if (raw === null || raw === '') {
      this.state = defaultState()
      return
    }
    const parsed = parsePersistedState(raw)
    if (parsed === null) {
      try {
        this.storage.removeItem(STATE_KEY)
      } catch {
        // ignore
      }
      this.state = defaultState()
      return
    }
    this.applyPersisted(parsed)
  }

  private applyPersisted(parsed: PersistedState): void {
    const def = defaultSyncStoreSlice()
    this.state = {
      v: 1,
      panel: 'sync',
      sync: {
        ...def,
        ...parsed.sync,
        token: '',
        webdavPassword: '',
        busy: null,
        savingConfig: false,
      },
    }
  }

  save(): void {
    if (this.storage === null) return
    try {
      const persisted = toPersistedState(this.state)
      this.storage.setItem(STATE_KEY, JSON.stringify(persisted))
    } catch {
      // ignore storage errors
    }
  }

  async resume(_api: ConfigManagerApi): Promise<void> {}
  stopResume(): void {}
}

export const runStore = new RunStore()

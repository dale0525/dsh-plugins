/**
 * run-store —— dsh-config-manager 浏览器半的同步状态中枢。
 *
 * 宽读法改造：仅保留 sync 相关状态。
 * PanelId 收敛为 'sync'。
 */
import type { SyncPushReport, SyncPullReport, SyncPushPreview } from '../sync/sync-engine.ts'
import type { SyncStartResponse } from './sync/sync-api.ts'
import type { ChannelSyncState, SyncChannel } from './sync/sync-view.ts'
import { defaultChannelSyncState } from './sync/sync-view.ts'
import type { SyncConflictResolution } from './sync/sync-view.ts'
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
  /** git/webdav 通道各自独立的设置状态 */
  byChannel: {
    git: ChannelSyncState
    webdav: ChannelSyncState
  }
  busy: SyncBusyState
  savingConfig: boolean
  pushReport: SyncPushReport | null
  pullReport: SyncPullReport | null
  pushPreview: { preview: SyncPushPreview | null; open: boolean }
  confirmSession: SyncStartResponse | null
  confirmDecisions: SyncConfirmDecisions | null
  lastRestoreId: string | null
  error: string | null
  loadError: string | null
}

export type SyncBusyState = 'sync' | 'push' | 'pull' | 'rollback' | null

export type SyncConfirmDecision = { adopted: boolean; resolution?: SyncConflictResolution }

export type SyncConfirmDecisions = Record<string, SyncConfirmDecision>

export type PersistedChannelSyncState = Omit<
  ChannelSyncState,
  'encryptPassword' | 'encryptPasswordConfirm' | 'decryptPassword'
>

export type PersistedSyncState = Omit<SyncStoreSlice, 'token' | 'webdavPassword' | 'busy' | 'savingConfig' | 'byChannel'> & {
  byChannel: {
    git: PersistedChannelSyncState
    webdav: PersistedChannelSyncState
  }
}

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
    byChannel: {
      git: defaultChannelSyncState(),
      webdav: defaultChannelSyncState(),
    },
    busy: null,
    savingConfig: false,
    pushReport: null,
    pullReport: null,
    pushPreview: { preview: null, open: false },
    confirmSession: null,
    confirmDecisions: null,
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
    byChannel: {
      git: { ...s.byChannel.git, snapshots: Array.isArray(s.byChannel.git?.snapshots) ? [...s.byChannel.git.snapshots] : [] },
      webdav: { ...s.byChannel.webdav, snapshots: Array.isArray(s.byChannel.webdav?.snapshots) ? [...s.byChannel.webdav.snapshots] : [] },
    },
    busy: s.busy,
    savingConfig: s.savingConfig,
    pushReport: s.pushReport,
    pullReport: s.pullReport,
    pushPreview: s.pushPreview,
    confirmSession: s.confirmSession,
    confirmDecisions: s.confirmDecisions,
    lastRestoreId: s.lastRestoreId,
    error: s.error,
    loadError: s.loadError,
  }
}

export function toPersistedState(state: StoreState): PersistedState {
  const s = state.sync
  const def = defaultSyncStoreSlice()
  const git = s.byChannel?.git ?? def.byChannel.git
  const webdav = s.byChannel?.webdav ?? def.byChannel.webdav

  return {
    v: 1,
    panel: 'sync',
    sync: {
      channel: s.channel,
      repoUrl: s.repoUrl,
      webdavUrl: s.webdavUrl,
      webdavUsername: s.webdavUsername,
      byChannel: {
        git: {
          syncSections: Array.isArray(git.syncSections) ? [...git.syncSections] : [],
          syncMode: git.syncMode,
          encrypt: git.encrypt,
          includeSecrets: git.includeSecrets,
          selectedSnapshotId: git.selectedSnapshotId ?? '',
          autosync: git.autosync ?? null,
          autosyncEnabled: git.autosyncEnabled,
          autosyncInterval: git.autosyncInterval,
          snapshots: Array.isArray(git.snapshots) ? [...git.snapshots] : [],
        },
        webdav: {
          syncSections: Array.isArray(webdav.syncSections) ? [...webdav.syncSections] : [],
          syncMode: webdav.syncMode,
          encrypt: webdav.encrypt,
          includeSecrets: webdav.includeSecrets,
          selectedSnapshotId: webdav.selectedSnapshotId ?? '',
          autosync: webdav.autosync ?? null,
          autosyncEnabled: webdav.autosyncEnabled,
          autosyncInterval: webdav.autosyncInterval,
          snapshots: Array.isArray(webdav.snapshots) ? [...webdav.snapshots] : [],
        },
      },
      pushReport: s.pushReport,
      pullReport: s.pullReport,
      pushPreview: s.pushPreview,
      confirmSession: s.confirmSession,
      confirmDecisions: s.confirmDecisions,
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

    const defaultSync = defaultSyncStoreSlice()
    let syncSlice: PersistedSyncState

    if (typeof obj['sync'] === 'object' && obj['sync'] !== null) {
      const parsedSync = obj['sync'] as Record<string, unknown>
      const rawByChannel = (parsedSync['byChannel'] ?? {}) as Record<string, unknown>
      const gitRaw = (rawByChannel['git'] ?? {}) as Record<string, unknown>
      const webdavRaw = (rawByChannel['webdav'] ?? {}) as Record<string, unknown>

      const gitSections = Array.isArray(gitRaw['syncSections'])
        ? (gitRaw['syncSections'] as any[])
        : Array.isArray(parsedSync['syncSections'])
          ? (parsedSync['syncSections'] as any[])
          : [...defaultSync.byChannel.git.syncSections]

      const gitMode = gitRaw['syncMode'] === 'advanced' || gitRaw['syncMode'] === 'default'
        ? (gitRaw['syncMode'] as 'advanced' | 'default')
        : parsedSync['syncMode'] === 'advanced' || parsedSync['syncMode'] === 'default'
          ? (parsedSync['syncMode'] as 'advanced' | 'default')
          : defaultSync.byChannel.git.syncMode

      const webdavMode = webdavRaw['syncMode'] === 'advanced' || webdavRaw['syncMode'] === 'default'
        ? (webdavRaw['syncMode'] as 'advanced' | 'default')
        : defaultSync.byChannel.webdav.syncMode

      syncSlice = {
        channel: parsedSync['channel'] === 'webdav' ? 'webdav' : 'git',
        repoUrl: typeof parsedSync['repoUrl'] === 'string' ? parsedSync['repoUrl'] : '',
        webdavUrl: typeof parsedSync['webdavUrl'] === 'string' ? parsedSync['webdavUrl'] : '',
        webdavUsername: typeof parsedSync['webdavUsername'] === 'string' ? parsedSync['webdavUsername'] : '',
        byChannel: {
          git: {
            ...defaultSync.byChannel.git,
            ...gitRaw,
            syncSections: gitSections,
            syncMode: gitMode,
            snapshots: Array.isArray(gitRaw['snapshots']) ? (gitRaw['snapshots'] as any[]) : [],
          },
          webdav: {
            ...defaultSync.byChannel.webdav,
            ...webdavRaw,
            syncSections: Array.isArray(webdavRaw['syncSections']) ? (webdavRaw['syncSections'] as any[]) : [...defaultSync.byChannel.webdav.syncSections],
            syncMode: webdavMode,
            snapshots: Array.isArray(webdavRaw['snapshots']) ? (webdavRaw['snapshots'] as any[]) : [],
          },
        },
        pushReport: (parsedSync['pushReport'] as any) ?? null,
        pullReport: (parsedSync['pullReport'] as any) ?? null,
        pushPreview: (parsedSync['pushPreview'] as any) ?? { preview: null, open: false },
        confirmSession: (parsedSync['confirmSession'] as any) ?? null,
        confirmDecisions: (parsedSync['confirmDecisions'] as any) ?? null,
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
        byChannel: {
          git: {
            ...def.byChannel.git,
            ...parsed.sync.byChannel.git,
            encryptPassword: '',
            encryptPasswordConfirm: '',
            decryptPassword: '',
          },
          webdav: {
            ...def.byChannel.webdav,
            ...parsed.sync.byChannel.webdav,
            encryptPassword: '',
            encryptPasswordConfirm: '',
            decryptPassword: '',
          },
        },
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

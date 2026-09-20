/**
 * run-store 单测：模块级单例 store + sessionStorage 恢复（同步面板专属）。
 *
 * 覆盖：
 *  - 敏感字段（token/webdavPassword 等）绝不写入 sessionStorage（白名单剔除）；
 *  - 内存瞬态（busy/savingConfig）不写入 sessionStorage，刷新后复位；
 *  - 非敏感状态序列化/反序列化往返（新实例 + 同存储 = 模拟刷新）；
 *  - 损坏/版本不符数据回退默认并清除脏键；
 *  - 旧版顶层 syncMode 载荷向后兼容迁移；
 *  - subscribe/notify 语义与 this 绑定回归（useSyncExternalStore 方式）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { RunStore, STATE_KEY, type StoreStorage } from './run-store.ts'

/* ------------------------------------------------------------- fixtures */

function makeStorage(): { storage: StoreStorage; raw: () => string | null } {
  let value: string | null = null
  return {
    storage: {
      getItem: (key: string) => (key === STATE_KEY ? value : null),
      setItem: (key: string, v: string) => {
        if (key === STATE_KEY) value = v
      },
      removeItem: (key: string) => {
        if (key === STATE_KEY) value = null
      },
    },
    raw: () => value,
  }
}

/* ---------------------------------------------------------- 序列化白名单 */

test('run-store: token 与 webdav 密码绝不写入 sessionStorage', () => {
  const { storage, raw } = makeStorage()
  const store = new RunStore({ storage })
  store.patch({
    sync: {
      channel: 'git',
      repoUrl: 'https://github.com/user/private-sync.git',
      token: 'ghp_SECRET_TOKEN_VALUE',
      webdavUrl: 'https://dav.example.com',
      webdavUsername: 'davuser',
      webdavPassword: 'WEBDAV_SECRET_PASSWORD',
    },
  })

  const text = raw()
  assert.ok(text !== null, 'patch 后已同步持久化')
  assert.ok(!text.includes('ghp_SECRET_TOKEN_VALUE'), 'token 绝不得落盘')
  assert.ok(!text.includes('WEBDAV_SECRET_PASSWORD'), 'webdav 密码绝不得落盘')

  const parsed = JSON.parse(text) as Record<string, unknown>
  const syncObj = parsed['sync'] as Record<string, unknown>
  assert.ok(!('token' in syncObj), 'token 字段已从持久化剔除')
  assert.ok(!('webdavPassword' in syncObj), 'webdavPassword 字段已从持久化剔除')

  // 新实例加载时敏感凭据重置为空串
  const reloaded = new RunStore({ storage })
  assert.equal(reloaded.getSnapshot().sync.token, '')
  assert.equal(reloaded.getSnapshot().sync.webdavPassword, '')
})

test('run-store: byChannel 加密解密密码绝不写入 sessionStorage', () => {
  const { storage, raw } = makeStorage()
  const store = new RunStore({ storage })
  store.patch({
    sync: {
      byChannel: {
        git: {
          syncSections: ['settings'],
          syncMode: 'advanced',
          selectedSnapshotId: '',
          autosync: null,
          autosyncEnabled: false,
          autosyncInterval: '60m',
          snapshots: [],
        },
        webdav: {
          syncSections: ['settings', 'skills'],
          syncMode: 'default',
          selectedSnapshotId: '',
          autosync: null,
          autosyncEnabled: true,
          autosyncInterval: '30m',
          snapshots: [],
        },
      },
    },
  })

  const text = raw()
  assert.ok(text !== null)

  // 刷新后分区选择正确保留（凭据本身走 DSH credentials，不进 UI 状态）
  const reloaded = new RunStore({ storage })
  const snap = reloaded.getSnapshot().sync
  assert.equal('encryptPassword' in snap.byChannel.git, false, 'ChannelSyncState 不再有加密密码字段')
  // 非敏感选项正确保留
  assert.equal(snap.byChannel.git.syncMode, 'advanced')
  assert.deepEqual(snap.byChannel.git.syncSections, ['settings'])
  assert.equal(snap.byChannel.webdav.autosyncEnabled, true)
})

test('run-store: busy 与 savingConfig 为内存瞬态——不写入 sessionStorage、刷新后复位', () => {
  const { storage, raw } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({ sync: { busy: 'push', savingConfig: true } })

  const text = raw()
  assert.ok(text !== null)
  const parsed = JSON.parse(text) as Record<string, unknown>
  const sync = parsed['sync'] as Record<string, unknown>
  assert.ok(!('busy' in sync), 'busy 为瞬态，不得落盘')
  assert.ok(!('savingConfig' in sync), 'savingConfig 为瞬态，不得落盘')

  // 新实例（模拟刷新）：复位为 null 与 false
  const second = new RunStore({ storage })
  assert.equal(second.getSnapshot().sync.busy, null, '刷新后 busy 复位为 null')
  assert.equal(second.getSnapshot().sync.savingConfig, false, '刷新后 savingConfig 复位为 false')
})

test('run-store: 非敏感同步表单状态往返恢复', () => {
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({
    sync: {
      channel: 'webdav',
      webdavUrl: 'https://nextcloud.example.com/remote.php/dav/files/alice',
      webdavUsername: 'alice',
      repoUrl: 'git@github.com:alice/dsh-sync.git',
      lastRestoreId: 'restore-20260919',
      pushPreview: { preview: null, open: true },
      error: '网络波动错误（已脱敏）',
      loadError: '远端连接失败',
    },
  })

  const second = new RunStore({ storage })
  const s = second.getSnapshot().sync
  assert.equal(s.channel, 'webdav')
  assert.equal(s.webdavUrl, 'https://nextcloud.example.com/remote.php/dav/files/alice')
  assert.equal(s.webdavUsername, 'alice')
  assert.equal(s.repoUrl, 'git@github.com:alice/dsh-sync.git')
  assert.equal(s.lastRestoreId, 'restore-20260919')
  assert.equal(s.pushPreview.open, true)
  assert.equal(s.error, '网络波动错误（已脱敏）')
  assert.equal(s.loadError, '远端连接失败')
})

test('run-store: 损坏或版本不符的存储数据回退默认并清除脏键', () => {
  const { storage, raw } = makeStorage()
  storage.setItem(STATE_KEY, 'not valid json')

  const store = new RunStore({ storage })
  assert.equal(store.getSnapshot().panel, 'sync')
  assert.equal(store.getSnapshot().sync.channel, 'git')
  assert.equal(raw(), null, '损坏键已被清除')

  // 版本不符
  storage.setItem(STATE_KEY, JSON.stringify({ v: 999, panel: 'sync' }))
  const store2 = new RunStore({ storage })
  assert.equal(store2.getSnapshot().panel, 'sync')
  assert.equal(raw(), null, '旧版本键已被清除')
})

test('run-store: subscribe/notify: patch 触发监听器，退订后不再通知', () => {
  const { storage } = makeStorage()
  const store = new RunStore({ storage })
  let calls = 0
  const unsubscribe = store.subscribe(() => { calls++ })

  store.patch({ sync: { channel: 'webdav' } })
  assert.equal(calls, 1)

  store.patch({ sync: { repoUrl: 'https://example.com/repo.git' } })
  assert.equal(calls, 2)

  unsubscribe()
  store.patch({ sync: { channel: 'git' } })
  assert.equal(calls, 2, '退订后不应再触发')
})

test('run-store: subscribe/getSnapshot 以裸引用调用时 this 绑定实例（useSyncExternalStore 方式）', () => {
  const { storage } = makeStorage()
  const store = new RunStore({ storage })
  const { subscribe, getSnapshot } = store

  assert.doesNotThrow(() => {
    const snap = getSnapshot()
    assert.equal(snap.panel, 'sync')
  })

  let count = 0
  const unsub = subscribe(() => { count++ })
  store.patch({ sync: { channel: 'webdav' } })
  assert.equal(count, 1)
  unsub()
})

test('run-store: 旧版顶层 syncMode 载荷 → 迁移为 git 通道的 byChannel 状态', () => {
  const { storage } = makeStorage()
  const legacyPayload = {
    v: 1,
    panel: 'sync',
    sync: {
      channel: 'git',
      repoUrl: 'https://github.com/user/repo.git',
      syncMode: 'advanced',
      syncSections: ['settings', 'skills'],
      byChannel: {},
    },
  }
  storage.setItem(STATE_KEY, JSON.stringify(legacyPayload))

  const store = new RunStore({ storage })
  const s = store.getSnapshot().sync
  assert.equal(s.byChannel.git.syncMode, 'advanced')
  assert.deepEqual(s.byChannel.git.syncSections, ['settings', 'skills'])
})

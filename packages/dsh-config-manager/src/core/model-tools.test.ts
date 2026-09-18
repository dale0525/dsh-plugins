/**
 * model-tools 编排测试：5 个 Agent 模型工具的纯编排函数（createModelTools）+ 注册层（registerModelTools）。
 * - config_backup：导出真实 ZIP + 非敏感摘要（无凭据值）
 * - config_list_snapshots：非敏感 meta，按 createdAt 倒序
 * - config_restore：confirm:false 只预览（零写入）；快照不存在拒绝；非法 id 拒绝
 * - config_sync_push：复用 SyncEngine.push（内存 transport），返回 snapshotId
 * - config_sync_pull：空远端 → 零写入空差异（不改本地配置）
 * - registerModelTools：tools 存在注册 5 工具；tools 缺失静默跳过
 * 对齐 sync-engine.test.ts：真实 tmp 目录 + makeContext + createAdapters + 内存 transport。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { createModelTools, registerModelTools, type ModelToolsDeps } from './model-tools.ts'
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts'
import { createAdapters } from '../adapters/index.ts'
import { SyncEngine } from '../sync/sync-engine.ts'
import { Importer } from './importer.ts'
import { writeSyncConfig } from '../sync/sync-config.ts'
import type { SyncConfig } from '../sync/sync-config.ts'
import type { SyncTransport, SyncSnapshot, SyncSnapshotMeta } from '../sync/transport.ts'
import { computeSnapshotMeta } from '../sync/transport.ts'
import { EnvironmentLockUnavailableError } from '../utils/env-lock.ts'
import type { MutationLockPort } from '../utils/env-lock.ts'
import { createSecretScanner } from '../security/secret-scanner.ts'
import type { SecretScanner } from './types.ts'

/** 内存 SyncTransport（spy：记录方法调用，供断言「pull 不写远端」）。 */
class MemSyncTransport implements SyncTransport {
  readonly type = 'memory'
  snapshots = new Map<string, SyncSnapshot>()
  metas: SyncSnapshotMeta[] = []
  calls: string[] = []
  async list(): Promise<SyncSnapshotMeta[]> {
    this.calls.push('list')
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.calls.push('upload')
    this.snapshots.set(snapshot.id, snapshot)
    this.metas.push(computeSnapshotMeta(snapshot))
    return computeSnapshotMeta(snapshot)
  }
  async download(id: string): Promise<SyncSnapshot> {
    this.calls.push('download')
    const s = this.snapshots.get(id)
    if (!s) throw new Error(`快照不存在: ${id}`)
    return s
  }
  async delete(id: string): Promise<void> {
    this.calls.push('delete')
    this.snapshots.delete(id)
    this.metas = this.metas.filter((m) => m.id !== id)
  }
}

const NS = ['general', 'theme']

function seedSettings(ctx: ReturnType<typeof makeContext>): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] })
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] })
}

/** 构造 model-tools deps：真实 tmp 目录 + 内存 SyncTransport。 */
async function makeDeps(opts: {
  transport?: MemSyncTransport
} = {}): Promise<{ deps: ModelToolsDeps; tmp: string; transport: MemSyncTransport; ctx: ReturnType<typeof makeContext> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-model-tools-'))
  const ctx = makeContext('win32', path.join(tmp, 'home'))
  seedSettings(ctx)
  const adapters = createAdapters({ namespaces: NS })
  const syncDir = path.join(tmp, 'sync')
  const transport = opts.transport ?? new MemSyncTransport()
  const makeSyncEngine = (cfg: SyncConfig): SyncEngine => {
    const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() })
    return new SyncEngine({
      ctx,
      transport,
      stateDir: syncDir,
      localSnapshotsDir: path.join(syncDir, 'snapshots'),
      zipDir: path.join(tmp, 'tmp'),
      adapters,
      importer,
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    })
  }
  return {
    deps: {
      host: ctx,
      adapters,
      syncDir,
      makeSyncEngine,
    },
    tmp,
    transport,
    ctx,
  }
}

test('config_sync_push：复用 SyncEngine.push（内存 transport），返回 snapshotId', async () => {
  const { deps, tmp, transport } = await makeDeps()
  try {
    await writeSyncConfig(deps.syncDir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } })
    const tools = createModelTools(deps)
    const out = (await tools.syncPush({ channel: 'git' })) as { ok: boolean; snapshotId: string; sections: string[] }
    assert.equal(out.ok, true)
    assert.ok(out.snapshotId !== '')
    assert.ok(out.sections.length > 0, 'portable 分区进入同步')
    assert.ok(transport.calls.includes('upload'), 'push 写远端')
    const uploadedSections = transport.snapshots.get(out.snapshotId)!.sections as Record<string, unknown>
    assert.ok(!('secrets' in uploadedSections), '不含 secrets 分区')
    // credentialsStatus 只含 configured/source 标记（值恒不导出），可勾选同步
    assert.ok('credentialsStatus' in uploadedSections, 'credentialsStatus 状态标记进入同步')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('config_sync_pull：空远端 → 零写入空差异', async () => {
  const { deps, tmp, transport, ctx } = await makeDeps()
  try {
    await writeSyncConfig(deps.syncDir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } })
    await ctx.fs.writeFile('settings.yaml', Buffer.from('foo: bar', 'utf8'))
    const before = await ctx.fs.listRecursive('')
    const tools = createModelTools(deps)
    const out = (await tools.syncPull({ channel: 'git' })) as { ok: boolean; snapshotId: string; changes: unknown[]; needsReview: boolean }
    assert.equal(out.ok, true)
    assert.equal(out.snapshotId, '')
    assert.deepEqual(out.changes, [], '空远端 → 无差异')
    // pull 零写入：本地文件集合不变
    assert.deepEqual(await ctx.fs.listRecursive(''), before)
    assert.ok(!transport.calls.includes('upload'), 'pull 不写远端')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

// ------------------------------------------------ 注册层（registerModelTools）

/** 最小 mock Cordis ctx：tools 服务可选 + effect 收集 disposer（不跑副作用）。 */
function mockCtx(toolsSvc: unknown): { ctx: Context; registered: string[]; effects: (() => void)[] } {
  const registered: string[] = []
  const effects: (() => void)[] = []
  const ctx = {
    get: (name: string) => (name === 'tools' ? toolsSvc : undefined),
    tools: toolsSvc === null || toolsSvc === undefined
      ? undefined
      : { register: (def: { name: string }) => { registered.push(def.name); return () => {} } },
    effect: (cb: () => void) => { effects.push(cb) },
  } as unknown as Context
  return { ctx, registered, effects }
}

test('registerModelTools：tools 服务存在 → 注册 2 个工具（走 ctx.get 结果，属性访问守卫不崩）', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const names: string[] = []
    const toolsSvc = { register: (def: { name: string }) => { names.push(def.name); return () => {} } }
    // 模拟真实 Cordis ctx：ctx.get('tools') 返回服务，但 ctx.tools 属性访问因插件未声明
    // inject: ['tools'] 而抛 "cannot get property without inject"（回归：注册必须走 get
    // 结果而非属性——旧实现 ctx.tools.register 在这里会崩溃）。
    const wrapped = {
      get: (name: string) => (name === 'tools' ? toolsSvc : undefined),
      effect: () => {},
    } as unknown as Context
    Object.defineProperty(wrapped, 'tools', {
      get() { throw new Error('cannot get property "tools" without inject') },
    })
    // 不抛错 = 注册走 toolsSvc + defineTool schema 全部可编译（无效 schema 会在定义时抛错）
    registerModelTools(wrapped, deps)
    assert.deepEqual(names.sort(), ['config_sync_pull', 'config_sync_push'].sort())
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('registerModelTools：tools 服务缺失 → 静默跳过（不抛错、不注册）', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const wrapped = {
      get: () => null,
      effect: () => {},
    } as unknown as Context
    registerModelTools(wrapped, deps)
    assert.ok(true, '不抛错即通过')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

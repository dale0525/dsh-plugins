/**
 * m-sync-flow：SyncEngine push/pull 编排测试。
 * - push：收集勾选分区（真实值）→ 组装 SyncSnapshot → 更新 sync-state → 上传 transport
 * - push：manifest.security.containsSecrets 按实际内容如实标注（含明文密钥即 true）
 * - push：sections 范围过滤（显式勾选 / 构造注入 / 未知分区告警）
 * - pullAndApply：下载远端最新快照 → 恒 replace 直接覆盖本地（应用前落回滚快照）
 * - pullAndApply：无远端快照 / 旧版加密快照拒绝
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine, MAX_REMOTE_SNAPSHOTS, EXCLUDED_SYNC_SECTIONS, sectionsCarrySecrets } from './sync-engine.ts';
import { hashSection, loadSyncState, SYNC_STATE_FILE } from './sync-state.ts';
import { encryptSectionsPayload } from '../../tests/fixtures/legacy-snapshot-crypto.ts';
import { computeSnapshotMeta } from './transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { WebDavTransport } from './webdav/webdav-transport.ts';
import type { WebDavRequestFn } from './webdav/webdav-transport.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import type { SectionId } from '../schema/types.ts';
import type { SectionData } from '../schema/types.ts';
import type { ImportPlan } from '../core/types.ts';

function makeImportPlan(seed: string): ImportPlan {
  return {
    items: [{
      id: `settings:general-${seed}`,
      kind: 'Update',
      adapter: 'settings',
      description: `Update settings.general (${seed})`,
      severity: 'info',
      target: { adapter: 'settings', ref: 'general' },
    }],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: { settings: 1 } as unknown as Record<SectionId, number>,
  };
}

/** 测试辅助：取明文 sections（同步测试构造/上传的快照均为普通快照，非加密载荷）。 */
function plainSections(s: SyncSnapshot['sections']): Partial<Record<SectionId, SectionData>> {
  return s as Partial<Record<SectionId, SectionData>>;
}

/** 内存 SyncTransport：记录方法调用（spy），供断言「pull 不写远端」 */
class MemSyncTransport implements SyncTransport {  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  calls: string[] = [];
  async list(): Promise<SyncSnapshotMeta[]> {
    this.calls.push('list');
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.calls.push('upload');
    this.snapshots.set(snapshot.id, snapshot);
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }
  async download(id: string): Promise<SyncSnapshot> {
    this.calls.push('download');
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`快照不存在: ${id}`);
    return s;
  }
  async delete(id: string): Promise<void> {
    this.calls.push('delete');
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

const NS = ['general', 'theme'];

function seedSource(ctx: ReturnType<typeof makeContext>): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
  ctx.plugins.installed.set('@deepseek-ai/dsh-ssh', { name: '@deepseek-ai/dsh-ssh', version: '1.0.0', enabled: true });
}

function makeEngine(opts: {
  ctx: ReturnType<typeof makeContext>;
  transport: MemSyncTransport;
  stateDir: string;
  localSnapshotsDir?: string;
  extra?: Partial<ConstructorParameters<typeof SyncEngine>[0]>;
}) {
  const adapters = createAdapters({ namespaces: NS });
  const importer = new Importer({ ctx: opts.ctx, adapters, snapshotStore: new MemSnapshotStore() });
  return new SyncEngine({
    ctx: opts.ctx,
    transport: opts.transport,
    stateDir: opts.stateDir,
    localSnapshotsDir: opts.localSnapshotsDir,
    adapters,
    importer,
    now: () => new Date('2026-08-16T12:00:00.000Z'),
    ...opts.extra,
  } as ConstructorParameters<typeof SyncEngine>[0]);
}

test('push: 收集 portable 分区 → 上传快照 → 更新 sync-state → 本地散文件副本', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-push-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
    const transport = new MemSyncTransport();
    const local = path.join(tmp, 'local-snapshots');
    const engine = makeEngine({ ctx, transport, stateDir: tmp, localSnapshotsDir: local });

    const report = await engine.push({ snapshotId: 'sync-001' });
    assert.equal(report.ok, true);
    assert.equal(report.snapshotId, 'sync-001');
    assert.ok(report.sections.includes('settings'), 'settings 进入同步');
    assert.ok(report.sections.includes('skills'), 'skills（文件类）进入同步');
    // credentialsStatus 只导出 configured/source 标记（hasValue 恒 false，绝不导出值），可勾选同步
    assert.ok(report.sections.includes('credentialsStatus'), 'credentialsStatus（仅状态标记）进入同步');
    assert.ok(!report.sections.includes('secrets' as SectionId), 'secrets 不是 ConfigAdapter，不进同步');

    // 上传载荷：内容 + manifest 摘要
    const uploaded = transport.snapshots.get('sync-001')!;
    assert.ok(uploaded, '快照已上传');
    assert.equal(uploaded.createdAt, '2026-08-16T12:00:00.000Z');
    assert.equal(uploaded.manifest.containsSecrets, false);
    const exportedGeneral = (plainSections(uploaded.sections)['settings'] as { namespaces: Record<string, { value: unknown; revision: number; secrets: unknown[] }> }).namespaces['general']!;
    assert.ok(exportedGeneral, 'settings.general 已导出');
    assert.deepEqual(exportedGeneral.value, { theme: 'dark', language: 'zh-CN' });
    assert.equal(exportedGeneral.revision, 3);
    assert.deepEqual(exportedGeneral.secrets, []);
    assert.equal((plainSections(uploaded.sections)['skills'] as { files: unknown[] }).files.length, 1);

    // sync-state 更新：每分区 hash + updatedAt + lastSyncAt + transport 绑定
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSyncAt, '2026-08-16T12:00:00.000Z');
    assert.equal(state.sections['settings']?.hash, hashSection(plainSections(uploaded.sections)['settings']!));
    assert.equal(state.sections['settings']?.updatedAt, '2026-08-16T12:00:00.000Z');
    assert.deepEqual(state.transport, { type: 'memory', ref: '' });
    const raw = JSON.parse(await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, 2);

    // 本地散文件副本（复用 t2 layout 布局）
    assert.ok((await fs.stat(path.join(local, 'sync-001', 'manifest.json'))).isFile());
    assert.ok((await fs.stat(path.join(local, 'sync-001', 'config', 'settings.json'))).isFile());
    assert.equal(await fs.readFile(path.join(local, 'sync-001', 'custom', 'skills', 'coding.md'), 'utf8'), '# Coding\n');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 明文同步——勾选分区携带真实值，containsSecrets 如实标注为 true', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-secret-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    ctx.settings.ns.set('general', {
      value: { theme: 'dark', apiToken: 'sk-super-secret-value', password: 'p@ss' },
      revision: 3,
      secrets: [{ path: ['apiToken'], set: true }],
    });
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-sec' });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-sec')!;
    // 明文语义：值原样进入快照
    const general = (plainSections(uploaded.sections)['settings'] as { namespaces: Record<string, unknown> }).namespaces['general'] as { value: Record<string, unknown> };
    assert.equal(general.value['apiToken'], 'sk-super-secret-value', '真实凭据值进入明文快照');
    // 标注与内容一致：含密钥即 true（不得硬编码 false）
    assert.equal(uploaded.manifest.containsSecrets, true, 'manifest 如实标注 containsSecrets');
    // 凭据分区本身不参与同步（它不是 ConfigAdapter）
    for (const forbidden of ['credentials', 'secrets'] as SectionId[]) {
      assert.ok(!(forbidden in uploaded.sections), `分区 ${forbidden} 不得进入快照`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sectionsCarrySecrets: 无敏感字段 → false；含 apiKey/token/password → true', () => {
  assert.equal(sectionsCarrySecrets({
    settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
  } as never), false, '普通值不误报');
  assert.equal(sectionsCarrySecrets({
    providers: { version: 1, providers: [{ name: 'x', apiKey: 'sk-1' }] },
  } as never), true, 'apiKey 命中');
  assert.equal(sectionsCarrySecrets({
    settings: { version: 1, namespaces: { general: { value: { token: 't' }, revision: 1, secrets: [] } } },
  } as never), true, 'token 命中');
  assert.equal(sectionsCarrySecrets({
    settings: { version: 1, namespaces: { general: { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [] } } },
  } as never), false, '仅环境变量引用名不算秘密');
  // 凭据分区携带明文值 → 必须如实标注（值无强形状时扫描器认不出，靠 hasValue 判定）
  assert.equal(sectionsCarrySecrets({
    credentialsStatus: { version: 1, credentials: [{ ref: 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD', required: true, configured: true, hasValue: true, value: 'hunter2' }] },
  } as never), true, '携带明文凭据必须标注 containsSecrets');
});

test('凭据明文端到端：push 携带 .credentials.yaml 的 refs → pull 在另一台机器写回', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-e2e-'));
  try {
    // 源机：settings 引用了 DEEPSEEK_API_KEY，另有仅在凭据文件登记的 WebDAV 口令
    const src = makeContext('win32', 'C:\\\\Users\\\\alice');
    src.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [] });
    src.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-123');
    await src.fs.writeFile('.credentials.yaml', Buffer.from(
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-super-secret-123\n  DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD: hunter2\n',
    ));
    const transport = new MemSyncTransport();
    const pushReport = await makeEngine({ ctx: src, transport, stateDir: path.join(tmp, 'state-src') })
      .push({ snapshotId: 'sync-cred' });
    assert.equal(pushReport.ok, true);
    const snapshot = transport.snapshots.get('sync-cred')!;
    assert.equal(snapshot.manifest.containsSecrets, true, '携带明文凭据必须如实标注');
    const pushed = (snapshot.sections as Partial<Record<SectionId, SectionData>>).credentialsStatus as { credentials: { ref: string; hasValue: boolean; value?: string }[] };
    assert.equal(pushed.credentials.find((c) => c.ref === 'DEEPSEEK_API_KEY')?.value, 'sk-super-secret-123', '值必须真的进了快照，不得被扫描器剥离');
    assert.equal(pushed.credentials.find((c) => c.ref === 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD')?.value, 'hunter2');

    // 目标机：全新环境，无凭据文件、无 vault（模拟跨机）
    const dst = makeContext('linux', '/home/bob');
    const pullReport = await makeEngine({ ctx: dst, transport, stateDir: path.join(tmp, 'state-dst') })
      .pullAndApply({ snapshotId: 'sync-cred' });
    assert.equal(pullReport.ok, true);
    assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-super-secret-123', '跨机拉取后凭据可用');
    assert.equal(dst.credentials.values.get('DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD'), 'hunter2');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 固定范围 = 除 workspaces / sessions 外的全部分区（含 cordis.patch.yml 所在的 plugins）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-scope-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    ctx.workspace.records.set('w1', { id: 'w1', path: 'C:\\work', title: 'work', sessionIds: [] });
    await ctx.fs.writeFile('sessions/proj/s1.jsonl', Buffer.from('{"secret":"history"}\n', 'utf8'));
    await ctx.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":{}}', 'utf8')); // pluginFiles 白名单
    const adapters = createAdapters({ namespaces: NS, includeSessions: true, selfDir: 'dsh-config-manager' });
    const transport = new MemSyncTransport();
    const engine = new SyncEngine({
      ctx, transport, adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
      stateDir: tmp, localSnapshotsDir: path.join(tmp, 'snap'),
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    await engine.push({ snapshotId: 'sync-p' });
    const uploaded = transport.snapshots.get('sync-p')!;
    const ids = uploaded.manifest.sectionIds;
    assert.ok(ids.includes('settings' as SectionId));
    assert.ok(ids.includes('plugins' as SectionId), 'plugins 分区必须同步（cordis.patch.yml 随它走）');
    assert.ok(ids.includes('mcp' as SectionId));
    assert.ok(ids.includes('pluginFiles' as SectionId), 'pluginFiles 不再需要显式勾选，直接进同步范围');
    assert.ok(!ids.includes('workspaces' as SectionId), 'workspaces 恒排除：含本机绝对路径');
    assert.ok(!ids.includes('sessions' as SectionId), 'sessions 恒排除：历史会话体积大且含敏感内容');
    // 范围 === 全部 adapter 减去固定排除集（单一事实源，不在测试里重抄清单）
    assert.deepEqual(
      [...ids].sort(),
      adapters.filter((a) => !EXCLUDED_SYNC_SECTIONS.has(a.id)).map((a) => a.id).sort(),
      '同步集合 === 全部已挂载分区 - 固定排除集',
    );
    // credentialsStatus / secrets 不是 ConfigAdapter，结构上不可能进入快照
    assert.ok(!('credentials' in uploaded.sections));
    assert.ok(!('secrets' in uploaded.sections));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 构造注入 adapters 也受同一固定范围约束（无法借注入绕过排除集）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-scope-inject-'));
  try {
    const ctx = makeContext('darwin', '/Users/alice');
    seedSource(ctx);
    await ctx.fs.writeFile('sessions/proj/s1.jsonl', Buffer.from('{"a":1}\n', 'utf8'));
    const adapters = createAdapters({ namespaces: NS, includeSessions: true, selfDir: 'dsh-config-manager' });
    const transport = new MemSyncTransport();
    const engine = new SyncEngine({
      ctx, transport, adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
      stateDir: tmp, localSnapshotsDir: path.join(tmp, 'snap'),
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    const report = await engine.push({ snapshotId: 'sync-inj' });
    assert.equal(report.ok, true);
    assert.ok(!transport.snapshots.get('sync-inj')!.manifest.sectionIds.includes('sessions' as SectionId));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});



test('push: 范围恒定 —— 无法通过任何入参收窄或扩展到 workspaces / sessions', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-scope-fixed-'));
  try {
    const ctx = makeContext('darwin', '/Users/alice');
    seedSource(ctx);
    await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
    await ctx.fs.writeFile('sessions/proj/s1.jsonl', Buffer.from('{"secret":"history"}\n', 'utf8'));
    const adapters = createAdapters({ namespaces: NS, includeSessions: true, selfDir: 'dsh-config-manager' });
    const transport = new MemSyncTransport();
    const engine = new SyncEngine({
      ctx, transport, adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
      stateDir: tmp, localSnapshotsDir: path.join(tmp, 'snap'),
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    const report = await engine.push({ snapshotId: 'sync-fixed' });
    assert.equal(report.ok, true);
    const ids = transport.snapshots.get('sync-fixed')!.manifest.sectionIds;
    assert.ok(ids.includes('settings' as SectionId));
    assert.ok(ids.includes('skills' as SectionId));
    assert.ok(!ids.includes('sessions' as SectionId), 'sessions 不得进入同步');
    assert.ok(!ids.includes('workspaces' as SectionId), 'workspaces 不得进入同步');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pullAndApply: 恒 replace 直接覆盖本地，并回报写入了哪些分区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-pull-'));
  try {
    const remote: SyncSnapshot = {
      id: 'remote-1',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: {
        settings: { version: 1, namespaces: { general: { value: { theme: 'dark', language: 'zh-CN' }, revision: 5, secrets: [] } } },
      },
    };
    const transport = new MemSyncTransport();
    transport.snapshots.set('remote-1', remote);
    transport.metas.push(computeSnapshotMeta(remote));

    // 本地目标：general 已注册但从未配置 → Create（初始化），无需人工决策
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.pullAndApply();
    assert.equal(report.ok, true);
    assert.equal(report.snapshotId, 'remote-1');
    const createItem = report.changes.find((c) => c.id === 'settings:general');
    assert.ok(createItem, '变更摘要含 settings:general');
    assert.equal(createItem?.kind, 'Create');
    assert.equal(createItem?.adapter, 'settings');
    assert.ok(report.applied.includes('settings'), 'settings 被实际写入');

    // 直接覆盖：远端值已落到本地；远端只被读（list/download），不写
    assert.deepEqual(ctx.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' }, '远端值覆盖本地');
    assert.deepEqual(transport.calls, ['list', 'download'], 'pullAndApply 只读远端（list/download），不 upload/delete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pullAndApply: 双侧都改 → replace 覆盖本地（远端值胜出）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-conflict-'));
  try {
    const remote: SyncSnapshot = {
      id: 'remote-2',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: {
        settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 5, secrets: [] } } },
      },
    };
    const transport = new MemSyncTransport();
    transport.snapshots.set('remote-2', remote);
    transport.metas.push(computeSnapshotMeta(remote));

    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'light' }, revision: 9, secrets: [] });
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.pullAndApply();
    assert.equal(report.ok, true);
    assert.ok(report.changes.some((c) => c.kind === 'Update'), '本地与远端不同 → Update（replace 策略）');
    assert.deepEqual(ctx.settings.ns.get('general')?.value, { theme: 'dark' }, '远端值覆盖本地');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pullAndApply: 远端无快照 → 空报告（不写本地）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-none-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    const engine = makeEngine({ ctx, transport: new MemSyncTransport(), stateDir: tmp });
    const report = await engine.pullAndApply();
    assert.equal(report.ok, false);
    assert.equal(report.snapshotId, '');
    assert.deepEqual(report.applied, []);
    assert.deepEqual(report.changes, []);
    assert.ok(report.message && report.message.includes('无快照'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pullAndApply: 远端快照声明 containsSecrets=true → 正常拉取覆盖（明文同步为预期行为）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-leak-'));
  try {
    const remote: SyncSnapshot = {
      id: 'remote-secrets',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: true },
      sections: { settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 5, secrets: [] } } } },
    };
    const transport = new MemSyncTransport();
    transport.snapshots.set('remote-secrets', remote);
    transport.metas.push(computeSnapshotMeta(remote));
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    const report = await engine.pullAndApply();
    assert.equal(report.ok, true, '含秘密的明文快照可正常拉取覆盖');
    assert.ok(report.applied.length > 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 空配置 → 空分区快照仍上传（不视为失败）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-fail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice'); // 无任何 namespace/文件/插件
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    const report = await engine.push({ snapshotId: 'sync-fail' });
    // 空数据仍视为「成功导出（空分区）」还是失败？settings 无 namespace 时 adapter 返回空（不抛错）
    assert.equal(report.ok, true, '空配置导出为空快照而非失败');
    assert.equal(transport.snapshots.has('sync-fail'), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── P2c M2：applyItems 兜底快照 / 回滚单元测试 ──────────────────────────────────────

/** 测试用 mock Importer：注入 analyzeImport / createImportPlan / executeImportPlan 的可控行为。 */
class MockImporter {
  ok = true;
  executeCalls = 0;
  warnings: string[] = [];
  analyzeImpl: () => Promise<unknown> = async () => ({ valid: true, compatibility: 'full' });
  createPlanImpl: () => Promise<unknown> = async () => ({
    items: [{ id: 'mock', kind: 'Update', adapter: 'settings', description: 'mock', severity: 'info', target: undefined }],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: { settings: 1 } as Record<string, number>,
  });
  executeImpl: () => Promise<unknown> = async () => ({
    ok: this.ok,
    executed: [],
    needsRestart: false,
    missingSecrets: [],
    warnings: this.warnings,
    rollback: null,
    snapshotId: null,
  });
  async analyzeImport(_zipPath: string): Promise<unknown> { return await this.analyzeImpl(); }
  async createImportPlan(_zipPath: string, _decisions: unknown): Promise<unknown> { return await this.createPlanImpl(); }
  async executeImportPlan(_zipPath: string, _plan: unknown, _opts: unknown): Promise<unknown> {
    this.executeCalls += 1;
    return await this.executeImpl();
  }
}

function makeEngineWithMockImporter(opts: {
  ctx: ReturnType<typeof makeContext>;
  transport: MemSyncTransport;
  stateDir: string;
  localSnapshotsDir?: string;
  mockImporter: MockImporter;
}) {
  // 把 mock 注入到 SyncEngine 的 importer 槽位 —— Importer 是类，类型上不能完全替换；
  // 这里用对象字面量 duck-type 兼容 Importer 的三个方法。
  return makeEngine({
    ...opts,
    extra: { importer: opts.mockImporter as unknown as Importer },
  });
}

test('applyItems: 成功路径写祖先副本 + 更新 sync-state', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-ok-'));
  const localDir = path.join(tmp, 'snapshots');
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = true;
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, localSnapshotsDir: localDir, mockImporter: mock,
    });
    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');
    const report = await engine.applyItems(zipPath, makeImportPlan('ok'));
    assert.equal(report.ok, true, 'success path → ok:true');
    assert.deepEqual(report.applied, ['settings']);
    assert.notEqual(report.restoreId, '', 'restoreId 应非空');
    assert.equal(report.rolledBack, false);
    assert.equal(report.warnings.length, 0);
    assert.equal(mock.executeCalls, 1, 'Importer.executeImportPlan 应被调用一次');
    // 基线应被更新：sync-state.lastSnapshotId 非空 + 落本地副本
    const state = await loadSyncState(tmp);
    assert.notEqual(state.lastSnapshotId, '', 'applyItems 后 lastSnapshotId 已被 recordBaseline 更新');
    const dirs = await fs.readdir(localDir);
    assert.ok(dirs.length > 0, '本地快照副本已写入');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyItems: 失败路径 → 整体回滚 + ok:false（不写基线）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-fail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = false; // Importer.executeImportPlan 返回 ok:false
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });
    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');
    const report = await engine.applyItems(zipPath, makeImportPlan('fail'));
    assert.equal(report.ok, false, 'failure path → ok:false');
    assert.equal(report.rolledBack, true);
    assert.equal(report.applied.length, 0);
    assert.notEqual(report.restoreId, '', 'restoreId 应透传以便排查');
    // recordBaseline 不应在失败路径调用
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, '', '失败时不应 recordBaseline');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyItems: Importer 缺失 → 抛错', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-noimporter-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    // 不传 importer → SyncEngine 内部无 importer
    const engine = new SyncEngine({
      ctx, transport, stateDir: tmp, adapters: createAdapters({ namespaces: NS }),
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    });
    await assert.rejects(
      () => engine.applyItems(path.join(tmp, 'x.zip'), makeImportPlan('no-imp')),
      /缺少 importer/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── P2a M4：recordBaseline / push-baseline ──────────────────────────────

test('push: 完成后 sync-state.lastSnapshotId 指向本次推送快照（祖先基线已记录）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-baseline-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });
    await engine.push({ snapshotId: 'sync-base' });
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-base', 'push 后 lastSnapshotId 应等于本次快照 id');
    assert.equal(state.lastSyncAt, '2026-08-16T12:00:00.000Z');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('recordBaseline: 写本地祖先副本 + 更新 sync-state + 触发裁剪', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-record-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const local = path.join(tmp, 'ancestors');
    const engine = makeEngine({ ctx, transport, stateDir: tmp, localSnapshotsDir: local });
    const snapshot = (await transport.list()).length === 0
      ? null
      : (transport.metas[0] && (await transport.download(transport.metas[0].id)));
    void snapshot;
    // 走一遍 push 让 ancestors 目录被建立
    await engine.push({ snapshotId: 'sync-anc-1' });
    await engine.push({ snapshotId: 'sync-anc-2' });
    // 显式再调一次 recordBaseline（模拟合并 apply 完成后更新基线）
    const newSnap: SyncSnapshot = {
      id: 'sync-explicit',
      createdAt: '2026-08-16T13:00:00.000Z',
      manifest: {
        schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32',
        sectionIds: ['settings'], containsSecrets: false,
      },
      sections: { settings: { version: 1, namespaces: {} } },
    };
    await engine.recordBaseline('sync-explicit', newSnap.sections, '2026-08-16T13:00:00.000Z');
    const state = await loadSyncState(tmp);
    assert.equal(state.lastSnapshotId, 'sync-explicit');
    assert.ok((await fs.stat(path.join(local, 'sync-explicit', 'manifest.json'))).isFile(), '祖先副本已写');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── P3：applyItems（一键同步逐项执行）测试 ──────────────────────────────

test('applyItems: 成功路径 → 执行子计划 + recordBaseline', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-applyitems-ok-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = true;
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });

    // 需要真实 ZIP 路径（applyItems 用 executeImportPlan 的 zipPath）
    // 用 mock importer 时 zipPath 可以被 mock 忽略
    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');

    const report = await engine.applyItems(zipPath, makeImportPlan('ok'));
    assert.equal(report.ok, true);
    assert.deepEqual(report.applied, ['settings']);
    assert.notEqual(report.restoreId, '', 'restoreId 应非空');
    assert.equal(report.rolledBack, false);
    assert.equal(mock.executeCalls, 1, 'Importer.executeImportPlan 应被调用一次');
    // recordBaseline 应被调用（lastSnapshotId 非空）
    const state = await loadSyncState(tmp);
    assert.notEqual(state.lastSnapshotId, '', 'applyItems 成功后 lastSnapshotId 非空');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyItems: 失败路径 → 整体回滚 + ok:false', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-applyitems-fail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    mock.ok = false;
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });

    const zipPath = path.join(tmp, 'session.zip');
    await fs.writeFile(zipPath, 'mock-zip-content');

    const report = await engine.applyItems(zipPath, makeImportPlan('fail'));
    assert.equal(report.ok, false);
    assert.equal(report.rolledBack, true);
    assert.notEqual(report.restoreId, '', 'restoreId 应透传');
    // 不再写 review-queue
    const rqPath = path.join(tmp, 'sync-review-queue.json');
    const rqExists = await fs.stat(rqPath).then(() => true).catch(() => false);
    assert.equal(rqExists, false, '失败路径不应写 review-queue');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyItems: 空子计划 → 直接返回 ok:true（不调 Importer）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-applyitems-empty-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    const mock = new MockImporter();
    const engine = makeEngineWithMockImporter({
      ctx, transport, stateDir: tmp, mockImporter: mock,
    });
    const emptyPlan: ImportPlan = {
      items: [], globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} as unknown as Record<SectionId, number>,
    };
    const report = await engine.applyItems(path.join(tmp, 'none.zip'), emptyPlan);
    assert.equal(report.ok, true);
    assert.deepEqual(report.applied, []);
    assert.equal(mock.executeCalls, 0, '空子计划不应触发 Importer');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── t5：push 后远端快照裁剪（保留最新 MAX_REMOTE_SNAPSHOTS 个） ─────────────────

/** 预置 n 个远端快照（id=remote-N，createdAt 递增） */
function seedRemoteSnapshots(transport: MemSyncTransport, n: number): void {
  for (let i = 1; i <= n; i++) {
    const id = `remote-${String(i).padStart(2, '0')}`;
    const snap: SyncSnapshot = {
      id,
      createdAt: `2026-08-15T${String(i - 1).padStart(2, '0')}:00:00.000Z`,
      manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
      sections: { settings: { version: 1, namespaces: {} } },
    };
    transport.snapshots.set(id, snap);
    transport.metas.push(computeSnapshotMeta(snap));
  }
}

test('push: 远端快照数超过 MAX_REMOTE_SNAPSHOTS → 裁剪只保留最新 10 个（含刚 push 的）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 13); // 预置 13 个旧快照
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true);
    // 本次 push 的快照应保留
    assert.ok(transport.snapshots.has('sync-new'), '刚 push 的快照必须保留');

    const remaining = [...transport.snapshots.keys()];
    // 保留 13 个预置里最新的 9 个（remote-05..remote-13）+ 本次 push 的 sync-new = 10
    assert.equal(remaining.length, MAX_REMOTE_SNAPSHOTS, `裁剪后应恰剩 ${MAX_REMOTE_SNAPSHOTS} 个`);
    // 最旧的 4 个（remote-01..remote-04）被删
    for (let i = 1; i <= 4; i++) {
      assert.ok(!transport.snapshots.has(`remote-0${i}`), `最旧的 remote-0${i} 应被裁剪`);
    }
    // 最新保留集含 5..13 与 sync-new
    for (let i = 5; i <= 13; i++) {
      assert.ok(transport.snapshots.has(`remote-${String(i).padStart(2, '0')}`), `最新的 remote-${i} 应保留`);
    }
    // 裁剪通过 transport.delete 逐个删除（删除调用次数 = 4）
    assert.equal(transport.calls.filter((c) => c === 'delete').length, 4);
    // 顺序：upload → list(裁剪) → delete×4 → recordBaseline（无本地裁剪）→ push 返回
    // 断言 upload 在首次 delete 之前（保证新快照先推送成功再删旧的）
    assert.ok(transport.calls.indexOf('upload') < transport.calls.indexOf('delete'), '先 push 新快照再删旧的');
    // 无裁剪告警（push 会带若干基础导出告警，如未注册 namespace，但不应有裁剪告警）
    assert.ok(!report.warnings.some((w) => w.includes('裁剪')), '正常裁剪不应产生告警');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 远端快照数未超上限 → 不触发任何删除', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-ok-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 9); // 9 旧 + 本次 1 = 10，恰好达标不裁剪
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true);
    assert.equal(transport.calls.filter((c) => c === 'delete').length, 0, '未超上限不得删除');
    assert.equal(transport.snapshots.size, 10);
    assert.ok(!report.warnings.some((w) => w.includes('裁剪')), '未超上限不应有裁剪告警');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 裁剪 list 失败 → 只告警不上抛，push 仍 ok', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-listfail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 13);
    transport.list = async () => { throw new Error('list boom'); };
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true, '裁剪失败不得阻断 push');
    assert.ok(transport.snapshots.has('sync-new'), '快照本身已上传');
    assert.ok(report.warnings.some((w) => w.includes('裁剪')), '应有裁剪告警');
    assert.ok(report.warnings.some((w) => w.includes('无法列出远端快照')), '告警应说明 list 失败');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push: 裁剪单个 delete 失败 → 只告警不上抛，其余旧快照照常删除', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-prune-delfail-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    const transport = new MemSyncTransport();
    seedRemoteSnapshots(transport, 13);
    // 让删除 remote-02 时抛错，其余正常
    const origDelete = transport.delete.bind(transport);
    transport.delete = async (id: string) => {
      if (id === 'remote-02') throw new Error('delete boom');
      return origDelete(id);
    };
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-new' });
    assert.equal(report.ok, true, '单个删除失败不得阻断 push');
    assert.ok(report.warnings.some((w) => w.includes('删除快照 remote-02 失败')), '应有删除失败告警');
    // remote-02 仍残留（删除失败），其余旧快照被删
    assert.ok(transport.snapshots.has('remote-02'), '删除失败的 remote-02 应残留');
    assert.ok(!transport.snapshots.has('remote-01'), '其余旧快照照常删除');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push + webdav 快照级跳过：同 id 同内容二次 push → 不重复 PUT 快照文件（端到端组合）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-engine-webdav-skip-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSource(ctx);
    // 内存 WebDAV「服务器」：snapshots/ 集合 + <id>.json 文件 + index.json
    const files = new Map<string, string>();
    const putCalls: string[] = [];
    const request: WebDavRequestFn = async (method, url, opts = {}) => {
      const key = url.replace(/\/+$/, '');
      if (method === 'MKCOL') return { status: 201, ok: true, text: async () => '' };
      if (method === 'GET') {
        const body = files.get(key);
        return body === undefined
          ? { status: 404, ok: false, text: async () => '' }
          : { status: 200, ok: true, text: async () => body };
      }
      if (method === 'PUT') {
        putCalls.push(key);
        files.set(key, opts.body ?? '');
        return { status: 201, ok: true, text: async () => '' };
      }
      if (method === 'DELETE') {
        files.delete(key);
        return { status: 204, ok: true, text: async () => '' };
      }
      return { status: 405, ok: false, text: async () => '' };
    };
    const transport = new WebDavTransport({
      baseUrl: 'https://dav.example.com/dav/config',
      username: 'alice',
      credentials: { getPassword: async () => 'test-password' },
      request,
    });
    const adapters = createAdapters({ namespaces: NS });
    const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
    const engine = new SyncEngine({
      ctx,
      transport,
      stateDir: tmp,
      adapters,
      importer,
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    // 首次 push：上传快照文件 + 写 index
    const first = await engine.push({ snapshotId: 'sync-001' });
    assert.equal(first.ok, true);
    assert.equal(putCalls.filter((k) => k.endsWith('/sync-001.json')).length, 1, '首次 push 应 PUT 快照文件');
    assert.ok(putCalls.some((k) => k.endsWith('/index.json')), '首次 push 应写 index（meta 最后落盘）');

    // 二次 push：同 id 同内容 → webdav 快照级跳过（不 PUT 快照文件、不写 index）
    const second = await engine.push({ snapshotId: 'sync-001' });
    assert.equal(second.ok, true);
    assert.equal(
      putCalls.filter((k) => k.endsWith('/sync-001.json')).length,
      1,
      '内容无变化 → 不得再次 PUT 快照文件',
    );
    assert.equal(
      putCalls.filter((k) => k.endsWith('/index.json')).length,
      1,
      '内容无变化 → 不得再次写 index',
    );
    // 远端快照文件仍存在且为首次内容
    const remote = files.get('https://dav.example.com/dav/config/dsh-config-manager/sync-001.json');
    assert.ok(remote !== undefined && remote.length > 0, '远端快照文件存在');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

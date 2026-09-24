/**
 * RecoveryOrchestrator 测试（issue #31 聚焦）。
 *
 * 背景：残留环境锁**不是** journal —— 进程死在 `op=autosync` 期间时 `journalId: null`、
 * `transactions/active/` 为空，因此 status() 的 incidents 恒为 []，恢复面板对纯锁
 * 残留恒空，而 423 文案却让用户去那个面板处理。本测试锁定三件事：
 *  ① status() 必须附带环境锁分类，让面板能显示可执行的锁事项；
 *  ② 锁分类**只上报 state/attention**，绝不把 owner pid/op 等内部诊断放进响应体；
 *  ③ recoverStaleLock() 必须要求显式确认，且**绝不**在未证明 stale 时谎称成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRecoveryOrchestrator } from './recovery-orchestrator.ts';
import type { RecoveryOrchestratorDeps } from './recovery-orchestrator.ts';
import { JournalStore, createJournalEntry } from './journal.ts';
import { RunRegistry } from './run-registry.ts';
import { nullLogger } from '../utils/logger.ts';
import { zhMsg } from './messages.ts';
import type { HostContext } from './types.ts';

/** 记录注入依赖的调用次数（断言「拒绝时不得调用回收」用）。 */
interface RecoverSpy {
  calls: number;
  result: { ok: boolean; removed: boolean; state: string; detail?: string };
}

async function makeOrchestrator(opts: {
  lockState?: string;
  lockDetail?: string;
  lockThrows?: boolean;
  recoverResult?: { ok: boolean; removed: boolean; state: string; detail?: string };
} = {}): Promise<{
  orchestrator: ReturnType<typeof createRecoveryOrchestrator>
  spy: RecoverSpy
  store: JournalStore
  clearCalls: () => number
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-orch-'));
  let clearCalls = 0;
  const store = new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
  const spy: RecoverSpy = {
    calls: 0,
    result: opts.recoverResult ?? { ok: true, removed: true, state: 'STALE_LOCK_DETECTED', detail: '已移除 stale ownership (op=autosync, pid=24140)' },
  };
  const deps: RecoveryOrchestratorDeps = {
    store,
    runs: new RunRegistry(),
    snapshotsDir: path.join(dir, 'snapshots'),
    host: { log: nullLogger() } as unknown as HostContext,
    msg: zhMsg,
    snapshotExists: async () => false,
    getEnvironmentFingerprint: () => 'fp-test',
    clearSafeMode: async () => { clearCalls += 1; },
    inspectLockState: async () => {
      if (opts.lockThrows === true) throw new Error('probe failed');
      return { state: opts.lockState ?? 'FREE', ...(opts.lockDetail !== undefined ? { detail: opts.lockDetail } : {}) };
    },
    recoverStaleLock: async () => {
      spy.calls += 1;
      return spy.result;
    },
  };
  return { orchestrator: createRecoveryOrchestrator(deps), spy, store, clearCalls: () => clearCalls };
}

// ---------- ① 纯锁残留场景：incidents 为空，但锁事项必须可见 ----------

test('status：无 journal（纯残留锁）时 incidents 为空，但仍上报锁分类供面板显示', async () => {
  const { orchestrator } = await makeOrchestrator({ lockState: 'STALE_LOCK_DETECTED' });
  const r = await orchestrator.status();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body['incidents'], [], '残留锁不是 journal → incidents 恒空（#31 根因 C）');
  assert.deepEqual(r.body['lock'], { state: 'STALE_LOCK_DETECTED', attention: true });
});

test('status：LOCKED（另一任务活跃持有）→ attention=false，不催用户回收', async () => {
  const { orchestrator } = await makeOrchestrator({ lockState: 'LOCKED' });
  const r = await orchestrator.status();
  assert.deepEqual(r.body['lock'], { state: 'LOCKED', attention: false });
});

test('status：UNKNOWN_STATE（无法判定）→ attention=true', async () => {
  const { orchestrator } = await makeOrchestrator({ lockState: 'UNKNOWN_STATE' });
  const r = await orchestrator.status();
  assert.deepEqual(r.body['lock'], { state: 'UNKNOWN_STATE', attention: true });
});

test('status：锁探测抛错 → 不阻断 status，保守上报 UNKNOWN_STATE/attention', async () => {
  const { orchestrator } = await makeOrchestrator({ lockThrows: true });
  const r = await orchestrator.status();
  assert.equal(r.status, 200, '探测失败不得让整个恢复面板加载失败');
  assert.deepEqual(r.body['lock'], { state: 'UNKNOWN_STATE', attention: true });
});

// ---------- ② 响应体不得含内部诊断（pid/op） ----------

test('status：锁分类只上报 state/attention，绝不泄漏 owner pid/op（detail 只进日志）', async () => {
  const { orchestrator } = await makeOrchestrator({
    lockState: 'STALE_LOCK_DETECTED',
    lockDetail: 'owner pid=24140 确证不存在 (heartbeat expired)',
  });
  const r = await orchestrator.status();
  const serialized = JSON.stringify(r.body);
  assert.equal(serialized.includes('24140'), false, 'owner pid 不得进入响应体');
  assert.equal(serialized.includes('heartbeat'), false, '判定依据细节不得进入响应体');
  assert.deepEqual(r.body['lock'], { state: 'STALE_LOCK_DETECTED', attention: true });
});

// ---------- ②b 共享锁摘要：同步页徽章与恢复面板必须同一套 attention 判据 ----------

test('lockState()：同步页可直接取同一份锁摘要（不再自造 attention 规则）', async () => {
  const stale = await makeOrchestrator({ lockState: 'STALE_LOCK_DETECTED' });
  assert.deepEqual(await stale.orchestrator.lockState(), { state: 'STALE_LOCK_DETECTED', attention: true });
  const live = await makeOrchestrator({ lockState: 'LOCKED' });
  assert.deepEqual(await live.orchestrator.lockState(), { state: 'LOCKED', attention: false });
  const broken = await makeOrchestrator({ lockThrows: true });
  assert.deepEqual(await broken.orchestrator.lockState(), { state: 'UNKNOWN_STATE', attention: true });
});

test('lockState()：与 status().body.lock 恒等（同一投影，禁止两处漂移）', async () => {
  const { orchestrator } = await makeOrchestrator({ lockState: 'STALE_LOCK_DETECTED', lockDetail: 'owner pid=24140' });
  const direct = await orchestrator.lockState();
  const viaStatus = (await orchestrator.status()).body['lock'];
  assert.deepEqual(direct, viaStatus);
});

// ---------- ③ 显式回收：需确认、不谎称成功 ----------

test('recoverStaleLock：未携带 userConfirmed=true → 400 且不调用回收', async () => {
  const { orchestrator, spy } = await makeOrchestrator();
  const r = await orchestrator.recoverStaleLock(false);
  assert.equal(r.status, 400);
  assert.equal(spy.calls, 0, '未确认不得触碰锁文件');
});

test('recoverStaleLock：确认后成功 → ok/removed，且响应体不含内部诊断', async () => {
  const { orchestrator, spy } = await makeOrchestrator();
  const r = await orchestrator.recoverStaleLock(true);
  assert.equal(spy.calls, 1);
  assert.equal(r.status, 200);
  assert.equal(r.body['ok'], true);
  assert.equal(r.body['removed'], true);
  assert.equal(JSON.stringify(r.body).includes('24140'), false, 'pid 只进日志');
});

test('recoverStaleLock：未被判定为 stale → ok=false（绝不谎称成功），且不改动任何东西', async () => {
  const { orchestrator, spy } = await makeOrchestrator({
    recoverResult: { ok: false, removed: false, state: 'LOCKED', detail: '非 stale，拒绝 recovery' },
  });
  const r = await orchestrator.recoverStaleLock(true);
  assert.equal(r.status, 200, '拒绝是正常结果而非服务错误');
  assert.equal(r.body['ok'], false);
  assert.equal(r.body['removed'], false);
  assert.equal(r.body['state'], 'LOCKED');
  assert.equal(spy.calls, 1);
});

// ---------- 源码守卫：回收路由的接线形态（#31 的关键不变量） ----------

/**
 * 为什么必须守卫：若要回收的正是那把挡住 acquire 的残留锁，把回收路由改成
 * `runWithMutationLock`/`withMutationGate` 包裹后，acquire 必然返回 STALE_LOCK_DETECTED
 * → 抛 423 → **回收永远无法执行**（正是本 issue 报告的那类「入口存在但结构上不可达」）。
 * 同时锁分支必须排在 :operationId 解析之前——'lock' 不是 UUID，否则会被 400 挡掉。
 * 按文本解析源码前先归一化行尾（Windows 工作区 CRLF / CI LF），否则守卫只在一边通过。
 */

// ---------- 源码守卫：回收路由的接线形态（#31 的关键不变量） ----------

/**
 * 为什么必须守卫：若要回收的正是那把挡住 acquire 的残留锁，把回收路由改成
 * `runWithMutationLock`/`withMutationGate` 包裹后，acquire 必然返回 STALE_LOCK_DETECTED
 * → 抛 423 → **回收永远无法执行**（正是本 issue 报告的那类「入口存在但结构上不可达」）。
 * 按文本解析源码前先归一化行尾（Windows 工作区 CRLF / CI LF），否则守卫只在一边通过。
 */
test('源码守卫：/sync/lock/recover 路由不经 mutation gate（否则回收被自己的 423 挡死）', async () => {
  const src = (await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const path = '/api/dsh-config-manager/sync/lock/recover';
  assert.ok(src.includes(`syncLockRecover: '${path}'`), 'API 常量必须登记回收路由');
  const at = src.indexOf('path: API.syncLockRecover,');
  assert.ok(at > 0, '路由表必须注册回收路由');
  // 路由对象字面量：从 path 到该对象在 4 空格缩进处的收尾（内层闭合缩进更深，不会提前截断）。
  const route = src.slice(at, src.indexOf('\n    },', at));
  assert.equal(route.includes('withMutationGate'), false, '回收路由绝不能被 withMutationGate 包裹（acquire 必失败 → 回收恒 423）');
  assert.equal(route.includes('runWithMutationLock'), false, '回收路由绝不 acquire 锁');
  assert.ok(route.includes('recoverStaleLock(true)'), '必须显式以 userConfirmed=true 调用回收');
  assert.ok(route.includes("guard(req, res, 'POST')"), '必须走 loopback + method 围栏');
});

// ---------- issue #32：dismiss 是 SAFE MODE 的唯一出口 ----------
// 已发生故障：sync-push 中断留下 state=NEEDS_ATTENTION、snapshotId=null 的 journal，
// SAFE MODE 因此阻断所有 mutation（423），而该 incident 无 trusted snapshot 可回滚 ——
// 唯一出路是 dismiss；若 dismiss 不解除 SAFE MODE，闸门就没有出口。

test('dismiss：放弃未解决 incident 后必须解除 SAFE MODE（无 snapshot incident 的唯一出口）', async () => {
  const { orchestrator, store, clearCalls } = await makeOrchestrator();
  const opId = '19059e36-f3a8-434e-ba71-a94c5c00a5e6';
  const j = createJournalEntry('sync-push', {
    operationId: opId, ownerInstanceId: 'o1', lockId: 'l1', packageVersion: '0.1.65', environmentFingerprint: 'fp-test',
  }, '2026-09-24T05:53:04.000Z');
  await store.create({ ...j, state: 'NEEDS_ATTENTION' });

  assert.equal(clearCalls(), 0, '前置：尚未 dismiss 时不得解除阻断');
  const r = await orchestrator.dismiss(opId, true);
  assert.equal(r.status, 200);
  assert.equal(r.body['dismissed'], true);
  assert.equal(clearCalls(), 1, 'dismiss 成功后必须解除 SAFE MODE —— 否则该 incident 永久 423');
  assert.deepEqual(await store.scanActive(), [], 'incident 必须已 quarantine（否则仍算未解决，阻断不该解除）');
});

test('dismiss：未显式确认（userConfirmed!==true）→ 400 且绝不解除阻断', async () => {
  const { orchestrator, store, clearCalls } = await makeOrchestrator();
  const opId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const j = createJournalEntry('sync-push', {
    operationId: opId, ownerInstanceId: 'o1', lockId: 'l1', packageVersion: '0.1.65', environmentFingerprint: 'fp-test',
  }, '2026-09-24T05:53:04.000Z');
  await store.create({ ...j, state: 'NEEDS_ATTENTION' });

  const r = await orchestrator.dismiss(opId, false);
  assert.equal(r.status, 400);
  assert.equal(clearCalls(), 0, '未确认时不得解除阻断');
  assert.deepEqual(await store.scanActive(), [opId], 'incident 必须原样保留');
});

test('源码守卫：/sync/recovery/dismiss 路由不经 mutation gate（它就是解除该闸门的机制）', async () => {
  const src = (await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const path = '/api/dsh-config-manager/sync/recovery/dismiss';
  assert.ok(src.includes(`syncRecoveryDismiss: '${path}'`), 'API 常量必须登记解除保护路由');
  const at = src.indexOf('path: API.syncRecoveryDismiss,');
  assert.ok(at > 0, '路由表必须注册解除保护路由');
  const route = src.slice(at, src.indexOf('\n    },', at));
  assert.equal(route.includes('withMutationGate'), false, '解除保护路由绝不能被 withMutationGate 包裹（必 423 → 出口不可达）');
  assert.equal(route.includes('runWithMutationLock'), false, '解除保护路由绝不 acquire 锁（残留锁与 SAFE MODE 可并存）');
  assert.ok(route.includes('dismiss(operationId, true)'), '必须以 userConfirmed=true 调用 dismiss');
  assert.ok(route.includes("guard(req, res, 'POST')"), '必须走 loopback + method 围栏');
});


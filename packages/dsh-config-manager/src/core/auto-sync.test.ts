/**
 * 启动时自动同步（AUTO-SYNC）。
 *
 * 为什么不是「无条件拉取」：当前宿主是所有配置修改的发起者。若它也无条件拉取，
 * 「改了配置、重启前忘了推送」就会被线上旧配置覆盖 —— 恰好毁掉本地最新的那份。
 *
 * 用户裁定的语义是**按设备角色决定方向**，不是比「谁更新」：
 *  - `source`（发起者，只应是那台改配置的机器）→ 启动时无条件 **push**（本地覆盖远端）
 *  - `follower`（从属者，其余设备）        → 启动时无条件 **pull**（远端覆盖本地）
 *
 * 角色存在本机私有文件 `sync-config.json` 里。它不在任何同步分区中，
 * 所以每台设备的角色互相独立、不会随配置传播。
 *
 * 其余策略（用户已裁定）：
 *  - 没有可用同步配置 → 不介入
 *  - follower 的 pull：失败重试 3 次，仍失败则拒绝启动
 *  - source 的 push：失败只告警、**不阻断启动**（本地配置本身是对的，只是没传出去；
 *    断网时仍应能正常用）
 *  - follower 本地改动 → 无条件覆盖（这是「从属者」的定义）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoSync, type AutoSyncDeps, type SyncRole } from './auto-sync.ts';

interface Harness {
  deps: AutoSyncDeps;
  log: string[];
  exits: number[];
  counter: { push: number; pull: number };
}

/** 构造可控依赖；默认「有配置、follower、首次即成功」。 */
function makeDeps(over: Partial<AutoSyncDeps> = {}): Harness {
  const log: string[] = [];
  const exits: number[] = [];
  const counter = { push: 0, pull: 0 };
  const deps: AutoSyncDeps = {
    hasSyncConfig: async () => true,
    role: async () => 'follower',
    push: async () => ({ ok: true }),
    pull: async () => ({ ok: true, rolledBack: false }),
    sleep: async () => {},
    log: (m) => log.push(m),
    exit: (code) => { exits.push(code); },
    ...over,
  };
  const innerPush = deps.push;
  const innerPull = deps.pull;
  deps.push = async () => { counter.push += 1; return innerPush(); };
  deps.pull = async () => { counter.pull += 1; return innerPull(); };
  return { deps, log, exits, counter };
}

test('S-01 没有可用同步配置 → 完全不介入（不分角色）', async () => {
  for (const role of ['source', 'follower'] as SyncRole[]) {
    const h = makeDeps({ hasSyncConfig: async () => false, role: async () => role });
    const result = await runAutoSync(h.deps);
    assert.equal(result, 'skipped', `${role}：没有配置必须跳过`);
    assert.equal(h.counter.push + h.counter.pull, 0, '不许发生任何同步动作');
    assert.deepEqual(h.exits, []);
  }
});

test('S-02 source 角色 → 只 push，绝不 pull（这是本机不被旧配置覆盖的关键）', async () => {
  const h = makeDeps({ role: async () => 'source' });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'pushed');
  assert.equal(h.counter.push, 1);
  assert.equal(h.counter.pull, 0, 'source 一旦 pull 就会覆盖本地最新配置');
  assert.deepEqual(h.exits, []);
});

test('S-03 follower 角色 → 只 pull，绝不 push', async () => {
  const h = makeDeps({ role: async () => 'follower' });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'pulled');
  assert.equal(h.counter.pull, 1);
  assert.equal(h.counter.push, 0);
  assert.deepEqual(h.exits, []);
});

test('S-04 source 的 push 失败 → 只告警，不阻断启动', async () => {
  // 本地配置本身是对的，只是没传出去。断网时仍应能正常用。
  const h = makeDeps({
    role: async () => 'source',
    push: async () => { throw new Error('ECONNREFUSED remote'); },
  });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'push-failed');
  assert.deepEqual(h.exits, [], 'source 推送失败不许拒绝启动');
  const text = h.log.join('\n');
  assert.match(text, /推送失败|未推送/, '要说清是推送失败');
  assert.match(text, /ECONNREFUSED remote/, '要带原始原因');
});

test('S-05 source 的 push 返回 ok:false → 同样只告警', async () => {
  const h = makeDeps({ role: async () => 'source', push: async () => ({ ok: false, message: 'remote rejected' }) });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'push-failed');
  assert.deepEqual(h.exits, []);
});

test('S-06 follower 的 pull 失败 → 重试 3 次后拒绝启动', async () => {
  const h = makeDeps({ pull: async () => { throw new Error('network down'); } });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'refused');
  assert.equal(h.counter.pull, 3, '必须重试满 3 次');
  assert.deepEqual(h.exits, [1]);
  assert.match(h.log.join('\n'), /配置同步失败/);
});

test('S-07 follower 的 pull 前两次失败、第三次成功 → 不退出', async () => {
  let n = 0;
  const h = makeDeps({
    pull: async () => {
      n += 1;
      if (n < 3) throw new Error(`flaky #${n}`);
      return { ok: true, rolledBack: false };
    },
  });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'pulled');
  assert.deepEqual(h.exits, []);
});

test('S-08 follower 的 pull「成功但已回滚」→ 算失败并重试', async () => {
  // 回滚说明启动门禁判定这份配置起不来、已退回原位 —— 配置并未就位。
  const h = makeDeps({ pull: async () => ({ ok: false, rolledBack: true, message: '启动校验失败' }) });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'refused');
  assert.equal(h.counter.pull, 3);
  assert.deepEqual(h.exits, [1]);
});

test('S-09 重试间隔递增', async () => {
  const waits: number[] = [];
  const h = makeDeps({
    pull: async () => { throw new Error('boom'); },
    sleep: async (ms) => { waits.push(ms); },
  });
  await runAutoSync(h.deps);
  assert.equal(waits.length, 2, '3 次尝试之间只该有 2 次等待');
  assert.ok(waits[1]! > waits[0]!, `间隔应递增：${waits.join(',')}`);
});

test('S-10 角色读取失败 → 按 follower 处理（保守：不去覆盖远端）', async () => {
  // 读不到角色时，若猜成 source 就会把本地状态推到远端，可能污染其他设备。
  // 按 follower 处理最坏只是被远端覆盖，不会影响别人。
  const h = makeDeps({ role: async () => { throw new Error('EACCES'); } });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'pulled');
  assert.equal(h.counter.push, 0, '角色不可知时不许推');
});

test('S-11 判定「有配置」本身抛错 → 按无配置处理，不阻断启动', async () => {
  const h = makeDeps({ hasSyncConfig: async () => { throw new Error('EACCES'); } });
  const result = await runAutoSync(h.deps);
  assert.equal(result, 'skipped');
  assert.deepEqual(h.exits, []);
});

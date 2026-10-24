/**
 * 回滚的插件补偿（R11）。
 *
 * 背景：`beforePlugins` 从 M2 起就被写进快照，但**从来没有任何代码读它来做回滚**——
 * `compensateOne` 只认 5 种条目，插件安装根本不产生快照条目。于是「已整体回滚」名不副实：
 * 配置回到导入前，插件却留在导入后的版本。旧 patch 行 + 新插件版本正是启动门禁要防的组合，
 * 所以这个缺口会直接抵消门禁的安全承诺。
 *
 * 三种差异都要处理：
 *  - 导入期间**新增**的插件 → remove（回到「没有它」）
 *  - 导入期间**升级**的插件 → add name@旧版本（降级）
 *  - 导入期间**消失**的插件 → add name@旧版本（装回来）
 *
 * 降级失败不谎报：配置确实回滚了，插件没跟上，如实报「混合状态」并给手动命令。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rollbackPlugins, type PluginRollbackPort } from './rollback-plugins.ts';
import type { PluginInfo } from './types.ts';

function plugin(name: string, version: string): PluginInfo {
  return { name, version, enabled: true };
}

/** 可控的插件装卸替身：记录调用序列，可指定哪些操作失败。 */
function makePort(current: PluginInfo[], opts: { failOn?: string[] } = {}) {
  const calls: { op: 'add' | 'remove'; name: string; version?: string }[] = [];
  const installed = new Map(current.map((p) => [p.name, p]));
  const port: PluginRollbackPort = {
    async add(name, version) {
      calls.push({ op: 'add', name, version });
      if (opts.failOn?.includes(name)) throw new Error(`npm error 404 ${name}@${version}`);
      installed.set(name, plugin(name, version));
    },
    async remove(name) {
      calls.push({ op: 'remove', name });
      if (opts.failOn?.includes(name)) throw new Error(`remove failed ${name}`);
      installed.delete(name);
    },
    async list() {
      return [...installed.values()];
    },
  };
  return { port, calls, installed };
}

test('P-01 导入期间新增的插件 → 卸载（回到「没有它」）', async () => {
  const { port, calls } = makePort([plugin('a', '1.0.0'), plugin('newbie', '2.0.0')]);
  const report = await rollbackPlugins({
    before: [plugin('a', '1.0.0')],
    port,
    profile: 'web',
  });
  assert.deepEqual(calls, [{ op: 'remove', name: 'newbie' }]);
  assert.deepEqual(report.removed, ['newbie']);
  assert.equal(report.full, true);
});

test('P-02 导入期间升级的插件 → 降级回快照里的版本', async () => {
  const { port, calls } = await makePort([plugin('a', '2.0.0')]);
  const report = await rollbackPlugins({
    before: [plugin('a', '1.0.0')],
    port,
    profile: 'web',
  });
  assert.deepEqual(calls, [{ op: 'add', name: 'a', version: '1.0.0' }]);
  assert.deepEqual(report.downgraded, ['a@2.0.0 → 1.0.0']);
  assert.equal(report.full, true);
});

test('P-03 导入期间消失的插件 → 装回来', async () => {
  const { port, calls } = makePort([]);
  const report = await rollbackPlugins({
    before: [plugin('gone', '1.2.3')],
    port,
    profile: 'web',
  });
  assert.deepEqual(calls, [{ op: 'add', name: 'gone', version: '1.2.3' }]);
  assert.deepEqual(report.restored, ['gone@1.2.3']);
  assert.equal(report.full, true);
});

test('P-04 版本与清单都没变 → 一个装卸动作都不做', async () => {
  const { port, calls } = makePort([plugin('a', '1.0.0'), plugin('b', '2.0.0')]);
  const report = await rollbackPlugins({
    before: [plugin('a', '1.0.0'), plugin('b', '2.0.0')],
    port,
    profile: 'web',
  });
  assert.deepEqual(calls, [], '无差异时不许动插件（装卸很贵，且会触发重启要求）');
  assert.equal(report.full, true);
});

test('P-05 降级失败 → 如实报混合状态 + 手动命令，不谎报完整回滚', async () => {
  const { port } = makePort([plugin('a', '2.0.0')], { failOn: ['a'] });
  const report = await rollbackPlugins({
    before: [plugin('a', '1.0.0')],
    port,
    profile: 'web',
  });
  assert.equal(report.full, false, '降级失败必须让 full=false');
  assert.equal(report.failed.length, 1);
  const failure = report.failed[0]!;
  assert.equal(failure.name, 'a');
  // 手动命令必须能直接粘贴：带 profile 与目标版本
  assert.match(failure.hint, /dsh plugin --profile web add a@1\.0\.0/);
  assert.match(failure.reason, /404/, '保留原始错误，便于判断是撤版还是网络');
});

test('P-06 卸载失败 → 同样如实报告，不中断其余补偿', async () => {
  const { port, calls } = makePort(
    [plugin('a', '2.0.0'), plugin('newbie', '1.0.0')],
    { failOn: ['newbie'] },
  );
  const report = await rollbackPlugins({
    before: [plugin('a', '1.0.0')],
    port,
    profile: 'web',
  });
  // 一个失败不影响另一个被处理（尽力而为 + 诚实报告）
  assert.deepEqual(calls.map((c) => `${c.op}:${c.name}`).sort(), ['add:a', 'remove:newbie']);
  assert.equal(report.full, false);
  assert.deepEqual(report.downgraded, ['a@2.0.0 → 1.0.0']);
  assert.equal(report.failed[0]!.name, 'newbie');
});

test('P-07 快照没有 beforePlugins（旧快照）→ 不动插件，也不报错', async () => {
  const { port, calls } = makePort([plugin('a', '2.0.0')]);
  const report = await rollbackPlugins({ before: undefined, port, profile: 'web' });
  assert.deepEqual(calls, [], '旧快照没有基线，无法判断差异，不许猜');
  // full 必须为 false：插件一个都没回退，「完整恢复」是假话。
  // 否则 rollback.ts 的 full = failed.length === 0 仍为 true，
  // renderRollbackReport 会在 rr.full 时提前返回「已完整恢复」，把提示吞掉。
  assert.equal(report.full, false, '无基线时插件未回退，不能报完整恢复');
  assert.equal(report.skippedReason, 'no-baseline');
});

test('P-08 读当前清单失败 → 不动插件，如实记一条失败', async () => {
  const port: PluginRollbackPort = {
    async add() { throw new Error('should not be called'); },
    async remove() { throw new Error('should not be called'); },
    async list() { throw new Error('profile unreadable'); },
  };
  const report = await rollbackPlugins({
    before: [plugin('a', '1.0.0')],
    port,
    profile: 'web',
  });
  assert.equal(report.full, false);
  assert.match(report.failed[0]!.reason, /profile unreadable/);
});

test('P-09 版本号缺失的条目 → 不尝试降级（无法构造 add name@version）', async () => {
  const { port, calls } = makePort([plugin('a', '2.0.0')]);
  const report = await rollbackPlugins({
    before: [{ name: 'a', version: '', enabled: true }],
    port,
    profile: 'web',
  });
  assert.deepEqual(calls, [], '空版本号无法钉版本，跳过而不是装成 latest');
  assert.equal(report.skipped.some((s) => s.includes('a')), true);
});

test('P-11 基线是空数组但当前有插件 → 会全部卸载（所以「读取失败」绝不能退化成空数组）', async () => {
  // 这条测试钉住一个危险的耦合：空数组的语义是「导入前一个插件都没有」，
  // 因此当前所有插件都会被判为「导入期间新增」而卸载。
  // 所以 backup.ts 在 listInstalled() 抛错时必须写 undefined（无基线），不能留 []。
  const { port, calls } = makePort([plugin('a', '1.0.0'), plugin('b', '2.0.0')]);
  const report = await rollbackPlugins({ before: [], port, profile: 'web' });
  assert.deepEqual(calls.map((c) => `remove:${c.name}`).sort(), ['remove:a', 'remove:b']);
  assert.deepEqual(report.removed.sort(), ['a', 'b']);
});

test('P-10 真实文件系统不参与（本模块只经 port 操作，不直接读写盘）', async () => {
  // 防回归：这个模块一旦自己动 fs，就会绕过 rollback 的快照/WAL 语义
  const source = await fs.readFile(
    path.join(import.meta.dirname, 'rollback-plugins.ts'),
    'utf8',
  );
  assert.equal(/from 'node:fs/.test(source), false, '不许直接 import node:fs');
  void os;
});

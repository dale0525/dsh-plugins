/**
 * 启动前门禁单测。
 *
 *  - G-01..G-04  纯逻辑：关闸环境变量、子进程脚本路径、报告解析（形状不符一律 null）
 *  - G-05        两份「宿主必需启动行」清单一致（TS 侧 vs 子进程 .mjs 侧，无法互相 import）
 *  - G-06..G-09  PluginsAdapter.afterApply 的四种结论：未注入 / 无相关项 / 通过 / 关闸
 *  - G-10..G-12  判定只有两态：通过，或整体失败（门禁**不写盘**）。
 *                早期「丢掉本次写过的行再判一次」已删除：宿主的启动口径里只有必修行会拒绝启动，
 *                而必修行恰恰不许丢（丢 connection 等于关掉局域网信任围栏），该分支不可达。
 *  - G-13        patch 文件读不了（YAML 坏）→ 硬失败（宿主下次启动同样读不了）
 *  - G-14        宿主 schema 自身不完整（x-cordis.complete=false）→ 告警，不凭它回滚
 *  - G-15        计划项是 Skip / 未决策 Conflict → 引擎没写过它，门禁也不动
 *  - G-16        重复 id（duplicate）→ 只告警，不阻断（宿主 `store[id] ??=` 后写覆盖前写，不会崩）
 *
 * 端到端（真起子进程校验真 profile）不在此文件：它需要宿主安装树，属 `pnpm run check:host`
 * 与人工验证的范围（`node scripts/boot-gate-child.mjs` 直接可跑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BOOT_GATE_OFF_ENV,
  REQUIRED_STARTUP_ENTRY_IDS,
  bootGateChildPath,
  bootGateDisabled,
  createBootGate,
  type BootGateHook,
  type GateReport,
} from './boot-gate.ts';
import { PluginsAdapter } from '../adapters/plugins.ts';
import { HOME_PATCH_FILE, PROFILE_PATCH_FILE, patchLayerKey } from './patch-layers.ts';
import { makeContext, makeImportContext } from '../adapters/test-helpers.ts';
import type { PluginsSection } from '../schema/types.ts';
import type { PlanItem } from './types.ts';

/* ---------------------------------------------------------------- 夹具 */

const PROFILE = 'web';

/** 一行 patch 计划项（afterApply 只关心 `patch:` 前缀 + target.ref）。 */
function patchItem(file: string, lineId: string, kind: PlanItem['kind'] = 'Create'): PlanItem {
  return {
    id: `patch:${patchLayerKey(file, lineId)}`,
    kind,
    adapter: 'plugins',
    description: `patch ${lineId}`,
    severity: 'info',
    target: { adapter: 'plugins', ref: patchLayerKey(file, lineId) },
  };
}

/** 构造 adapter + import 上下文；patch 层用 MemLayeredPatch（两层可各放同名行）。 */
function setup(items: PlanItem[], bootGate?: BootGateHook) {
  const target = makeContext('darwin', '/home/u', PROFILE);
  const layered = target.useLayeredPatch();
  const section: PluginsSection = {
    version: 1,
    plugins: [],
    patch: items
      .filter((item) => item.id.startsWith('patch:'))
      .map((item) => {
        const { file, lineId } = { file: item.target!.ref.split('#')[0]!, lineId: item.target!.ref.split('#')[1]! };
        return { file: file as typeof HOME_PATCH_FILE, lineId, raw: { id: lineId, config: {} } };
      }),
  };
  for (const pl of section.patch) layered.set(pl.file, pl.lineId, pl.raw);
  const ctx = makeImportContext(target, new Map([['plugins', section]]), { onLog: () => {} });
  return { adapter: new PluginsAdapter('dsh-config-manager', undefined, bootGate), ctx, layered, section };
}

function report(bad: GateReport['bad'], extra: Partial<GateReport> = {}): GateReport {
  return { bad, warnings: [], checked: 4, skipped: 1, rows: 215, schemaComplete: true, schemaErrors: [], ...extra };
}

/** 门禁钩子返回「正常报告」的包装（契约是 BootGateResult，不是裸 GateReport）。 */
function asHook(fn: () => Promise<GateReport>): BootGateHook {
  return async () => ({ kind: 'report', report: await fn() });
}

/* ---------------------------------------------------------------- G-01..G-04 纯逻辑 */

test('G-01 关闸环境变量：off/0/false/no 关闭，其余与缺省不关闭', () => {
  assert.equal(bootGateDisabled({}), false);
  assert.equal(bootGateDisabled({ [BOOT_GATE_OFF_ENV]: '' }), false);
  assert.equal(bootGateDisabled({ [BOOT_GATE_OFF_ENV]: 'on' }), false);
  for (const value of ['off', 'OFF', ' off ', '0', 'false', 'False', 'no']) {
    assert.equal(bootGateDisabled({ [BOOT_GATE_OFF_ENV]: value }), true, `${JSON.stringify(value)} 应关闭门禁`);
  }
});

test('G-02 子进程脚本路径指向包内 scripts/（开发与发布同一相对路径）', () => {
  const p = bootGateChildPath();
  assert.ok(path.isAbsolute(p), `应为绝对路径: ${p}`);
  assert.equal(path.basename(p), 'boot-gate-child.mjs');
  assert.equal(path.basename(path.dirname(p)), 'scripts');
});

test('G-03 报告解析：形状不符一律 null（当作无法校验，不猜）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-gate-parse-'));
  try {
    const cases: [string, string][] = [
      ['not-json', 'this is not json'],
      ['array', '[]'],
      ['no-bad', '{"checked":1,"skipped":0,"rows":3}'],
      ['bad-not-array', '{"bad":"x","checked":1,"skipped":0,"rows":3}'],
    ];
    for (const [name, body] of cases) {
      const script = path.join(tmp, `${name}.mjs`);
      await fs.writeFile(script, `process.stdout.write(${JSON.stringify(body)})\n`);
      const gate = createBootGate({ scriptPath: script, timeoutMs: 20_000 });
      assert.equal(await gate({ homeDir: '/home/u', profile: PROFILE }), null, `${name} 应判为无法校验`);
    }
    // 合法报告：数字缺省补 0，未知 kind 归 invalid（不因单个字段异常丢掉整份报告）
    const script = path.join(tmp, 'ok.mjs');
    await fs.writeFile(script, `process.stdout.write(${JSON.stringify(JSON.stringify({
      bad: [{ id: 'connection', kind: 'weird', message: 'm' }, { id: 5 }],
      checked: 2,
    }))})\n`);
    const gate = createBootGate({ scriptPath: script, timeoutMs: 20_000 });
    const parsed = await gate({ homeDir: '/home/u', profile: PROFILE });
    assert.deepEqual(parsed, {
      kind: 'report',
      report: {
        bad: [{ id: 'connection', kind: 'invalid', message: 'm' }],
        warnings: [],
        checked: 2,
        skipped: 0,
        rows: 0,
        // 老版本子进程不报这两项 → 按「完整」处理，不能因此把所有校验判成不可信
        schemaComplete: true,
        schemaErrors: [],
      },
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('G-04 子进程非零退出 / 超时 → 不抛错、不阻断导入', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-gate-exit-'));
  try {
    const failing = path.join(tmp, 'fail.mjs');
    await fs.writeFile(failing, `process.stderr.write('boom'); process.exit(3)\n`);
    // 非零退出（非 EXIT_BROKEN_CONFIG）→ child-failed：带回 stderr 交给调用方经 onLog 输出，
    // 不再直写 process.stderr（那条出口绕过脱敏与级别控制）。
    assert.deepEqual(
      await createBootGate({ scriptPath: failing, timeoutMs: 20_000 })({ homeDir: '/home/u', profile: PROFILE }),
      { kind: 'child-failed', detail: 'boom' },
    );

    const hanging = path.join(tmp, 'hang.mjs');
    await fs.writeFile(hanging, `setTimeout(() => {}, 60000)\n`);
    const started = Date.now();
    assert.equal(
      await createBootGate({ scriptPath: hanging, timeoutMs: 300 })({ homeDir: '/home/u', profile: PROFILE }),
      null,
    );
    assert.ok(Date.now() - started < 15_000, '超时后必须尽快返回（子进程被 SIGKILL）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('G-05 两份「宿主必需启动行」清单一致（TS 侧与子进程 .mjs 侧各留一份）', async () => {
  const source = await fs.readFile(bootGateChildPath(), 'utf8');
  const block = /const REQUIRED_STARTUP_ENTRY_IDS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(block !== null, '子进程脚本里应有 REQUIRED_STARTUP_ENTRY_IDS');
  const ids = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual([...ids].sort(), [...REQUIRED_STARTUP_ENTRY_IDS].sort());
});

test('G-05b 清单与已装宿主的 requiredStartupEntryIds 逐字一致（宿主新增必修行时这里必须红）', async (t) => {
  // 宿主未导出该常量，只能读源码。这是唯一能钉住「宿主漂移」的判据：
  // 只比较我们自己的两份副本时，宿主新增一个必修行不会有任何测试变红，门禁会静默漏判。
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const os = await import('node:os');
  // 宿主包只在 profile 的解析范围内可见（本包不依赖它），所以要挨个 profile 试。
  // 一个都解析不到 = 本机没装宿主（CI 就是这种情况），此时显式 skip，不假装通过。
  const home = process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh');
  const candidates: string[] = [];
  try {
    for (const name of await fs.readdir(path.join(home, 'profiles'))) {
      candidates.push(path.join(home, 'profiles', name, 'package.json'));
    }
  } catch { /* 无 profiles 目录 */ }
  let hostEntry: string | undefined;
  for (const base of candidates) {
    try {
      hostEntry = createRequire(base).resolve('@deepseek-ai/dsh-app-boot');
      break;
    } catch { /* 换下一个 profile */ }
  }
  if (hostEntry === undefined) {
    t.skip(`本机未安装宿主（${home}/profiles/* 均解析不到 @deepseek-ai/dsh-app-boot），无法核对`);
    return;
  }
  const libDir = path.dirname(hostEntry);
  const source = await fs.readFile(path.join(libDir, 'index.js'), 'utf8');
  const block = /const requiredStartupEntryIds = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(block !== null, '宿主源码里应有 requiredStartupEntryIds');
  const hostIds = [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...REQUIRED_STARTUP_ENTRY_IDS].sort(),
    [...hostIds].sort(),
    '我们的清单与宿主不一致 —— 宿主改了必修行集合，必须同步 boot-gate.ts 与 boot-gate-child.mjs',
  );
});

/* ---------------------------------------------------------------- G-06..G-09 afterApply 结论 */

test('G-06 未注入门禁 → 完全跳过（改造前行为）', async () => {
  const { adapter, ctx } = setup([patchItem(PROFILE_PATCH_FILE, 'connection')], undefined);
  assert.equal(await adapter.afterApply?.(ctx, [patchItem(PROFILE_PATCH_FILE, 'connection')]), undefined);
});

test('G-07 本次导入没碰 patch 行/插件 → 不启动子进程（省 10 秒）', async () => {
  let called = 0;
  const gate: BootGateHook = async () => {
    called += 1;
    return { kind: 'report', report: report([]) };
  };
  const { adapter, ctx } = setup([], gate);
  const items: PlanItem[] = [{
    id: 'settings:general', kind: 'Update', adapter: 'settings', description: 'x', severity: 'info',
  }];
  assert.equal(await adapter.afterApply?.(ctx, items), undefined);
  assert.equal(called, 0);
});

test('G-08 门禁通过 → 无结论（不打扰用户）', async () => {
  const gate: BootGateHook = async () => ({ kind: 'report', report: report([]) });
  const items = [patchItem(PROFILE_PATCH_FILE, 'connection')];
  const { adapter, ctx } = setup(items, gate);
  assert.equal(await adapter.afterApply?.(ctx, items), undefined);
});

test('G-09 关闸环境变量 → 不调子进程，直接放过', async () => {
  const prev = process.env[BOOT_GATE_OFF_ENV];
  process.env[BOOT_GATE_OFF_ENV] = 'off';
  try {
    let called = 0;
    const gate: BootGateHook = async () => {
      called += 1;
      return { kind: 'report', report: report([{ id: 'connection', kind: 'invalid', message: 'bad' }]) };
    };
    const items = [patchItem(PROFILE_PATCH_FILE, 'connection')];
    const { adapter, ctx } = setup(items, gate);
    assert.equal(await adapter.afterApply?.(ctx, items), undefined);
    assert.equal(called, 0);
  } finally {
    if (prev === undefined) delete process.env[BOOT_GATE_OFF_ENV];
    else process.env[BOOT_GATE_OFF_ENV] = prev;
  }
});

/* ---------------------------------------------------------------- G-10..G-14 两态处置 */

test('G-10 坏行 → 整体失败，且**不写盘**（早期「丢掉坏行再试」已删除：该分支在宿主语义下不可达）', async () => {
  // 宿主 auditStartupEntries 只在必修行失效时抛错，子进程也只校验必修行 ⇒ 坏行必属必修行集合，
  // 恰恰是最不该丢的那批。所以这里既不许丢行，也不许调用 applyPatchChanges。
  const items = [patchItem(PROFILE_PATCH_FILE, 'connection')];
  const gate: BootGateHook = async () => ({
    kind: 'report',
    report: report([{ id: 'connection', kind: 'invalid', message: 'connection: /cookieMaxAgeDays must be integer' }]),
  });
  const { adapter, ctx, layered } = setup(items, gate);
  const outcome = await adapter.afterApply?.(ctx, items);
  assert.equal(outcome?.severity, 'error');
  assert.match(outcome?.message ?? '', /cookieMaxAgeDays/);
  assert.equal(layered.has(PROFILE_PATCH_FILE, 'connection'), true, '坏行必须留在盘上（由整体回滚处理，不由门禁删）');
});

test('G-11 必修行坏 → 失败文案带上 profile 与逃生阀', async () => {
  const items = [patchItem(PROFILE_PATCH_FILE, 'webserver')];
  const gate: BootGateHook = async () => ({
    kind: 'report',
    report: report([{ id: 'webserver', kind: 'invalid', message: 'webserver: /host must be string' }]),
  });
  const { adapter, ctx } = setup(items, gate);
  const outcome = await adapter.afterApply?.(ctx, items);
  assert.equal(outcome?.severity, 'error');
  assert.match(outcome?.message ?? '', /webserver/);
  assert.match(outcome?.message ?? '', new RegExp(BOOT_GATE_OFF_ENV));
});

test('G-12 子进程无法执行 → 降级为 warning，不阻断导入', async () => {
  const items = [patchItem(PROFILE_PATCH_FILE, 'connection')];
  const gate: BootGateHook = async () => null;
  const { adapter, ctx } = setup(items, gate);
  const outcome = await adapter.afterApply?.(ctx, items);
  assert.equal(outcome?.severity, 'warning');
  assert.match(outcome?.message ?? '', /启动校验未能执行/);
});

test('G-13 patch 文件已坏（broken-config）→ 硬失败，不许当作「无法校验」放行', async () => {
  // 宿主 loadOptionalPatches 对非 ENOENT 的解析错误直接 throw → boot() 报 plugin tree failed to load。
  // 即：此时已经确定起不来，fail-open 会把用户送进「起不来、又只能在能启动的宿主里开配置管理器」的死锁。
  const items = [patchItem(PROFILE_PATCH_FILE, 'connection')];
  const gate: BootGateHook = async () => ({ kind: 'broken-config', detail: 'YAMLException: bad indentation' });
  const { adapter, ctx } = setup(items, gate);
  const outcome = await adapter.afterApply?.(ctx, items);
  assert.equal(outcome?.severity, 'error');
  assert.match(outcome?.message ?? '', /bad indentation/);
  assert.match(outcome?.message ?? '', /patch 文件/);
});

test('G-14 宿主 schema 不完整（complete=false）→ 不据此拦截，但如实告警', async () => {
  // 宿主在 x-cordis.complete=false 或有 level=error 的 diagnostics 时明说这是「部分结果」，
  // 逐行结论不可信；此时既不能当通过，也不该凭它回滚。
  const items = [patchItem(PROFILE_PATCH_FILE, 'connection')];
  const gate: BootGateHook = async () => ({
    kind: 'report',
    report: report([], { schemaComplete: false, schemaErrors: ['/186 unrecognized Loader tree carrier'] }),
  });
  const { adapter, ctx } = setup(items, gate);
  const outcome = await adapter.afterApply?.(ctx, items);
  assert.equal(outcome?.severity, 'warning');
  assert.match(outcome?.message ?? '', /部分结果/);
  assert.match(outcome?.message ?? '', /unrecognized Loader tree carrier/);
});

test('G-15 全部项都是 Skip → 不启动子进程（省 6–20 秒）', async () => {
  let called = 0;
  const gate: BootGateHook = async () => {
    called += 1;
    return { kind: 'report', report: report([]) };
  };
  const items = [patchItem(PROFILE_PATCH_FILE, 'connection', 'Skip')];
  const { adapter, ctx } = setup(items, gate);
  assert.equal(await adapter.afterApply?.(ctx, items), undefined);
  assert.equal(called, 0, '没有真写入的项就不该花两轮子进程');
});

test('G-16 重复 id 只作告警，不阻断（宿主不会崩：后写覆盖前写）', async () => {
  const items = [patchItem(PROFILE_PATCH_FILE, 'connection')];
  const gate: BootGateHook = async () => ({
    kind: 'report',
    report: report([], { warnings: ['connection: duplicate loader entry id (2 entries; the later one wins)'] }),
  });
  const { adapter, ctx } = setup(items, gate);
  assert.equal(await adapter.afterApply?.(ctx, items), undefined, '重复 id 不阻断导入');
});

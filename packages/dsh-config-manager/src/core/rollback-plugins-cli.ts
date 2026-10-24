/**
 * 插件回滚通道的**生产实现**：走官方 `dsh plugin add/remove`。
 *
 * 与 `rollback-plugins.ts`（纯算法、只经 port 操作）分离的理由：
 *  - 算法要能在测试里跑 10 种差异组合而不真的装卸包（每次 pnpm 解析要几十秒）；
 *  - 这里只负责「把一次装卸变成一次子进程」，失败分类复用 `plugin-cli` 既有能力。
 *
 * 为什么不能用 `PluginsFacade.install(pkg, spec)` 降级：那条路径会把 registry
 * 版本号归一成裸包名（装最新版，见 `installSpecFor`），表达不了「钉到 1.0.0」。
 * 官方 CLI 的 `add <name>@<version>` 是支持的（`parseInstallSpec` 认这种形状）。
 */
import {
  classifyDshPluginFailure,
  listInstalledPlugins,
  resolveProfileDir,
  runDshPlugin,
} from './plugin-cli.ts';
import type { PluginRollbackPort } from './rollback-plugins.ts';
import type { PluginInfo } from './types.ts';

/** 装卸失败的诊断：优先用 CLI 的分类结论（能给出可操作建议），否则退回输出尾部。 */
function describeFailure(action: string, name: string, result: Awaited<ReturnType<typeof runDshPlugin>>): string {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  const classified = classifyDshPluginFailure(output);
  if (classified !== null) return `${classified.code}: ${classified.message}`;
  if (result.spawnError !== undefined) return `spawn failed: ${result.spawnError}`;
  if (result.timedOut) return `${action} ${name} timed out`;
  const tail = output.split('\n').filter((l) => l.trim() !== '').slice(-4).join(' / ');
  return tail === '' ? `${action} ${name} failed (exit ${String(result.exitCode)})` : tail;
}

/**
 * 构造生产 port。
 *
 * `signal` 可选：用户取消整个回滚时能中止正在跑的 pnpm（`runDshPlugin` 会杀进程树）。
 */
export function createPluginRollbackPort(
  homeDir: string,
  profile: string,
  signal?: AbortSignal,
): PluginRollbackPort {
  const profileDir = resolveProfileDir(homeDir, profile);
  return {
    async add(name, version) {
      const result = await runDshPlugin(profileDir, profile, ['add', `${name}@${version}`], undefined, signal);
      if (result.exitCode !== 0) throw new Error(describeFailure('add', name, result));
    },
    async remove(name) {
      const result = await runDshPlugin(profileDir, profile, ['remove', name], undefined, signal);
      if (result.exitCode !== 0) throw new Error(describeFailure('remove', name, result));
    },
    async list(): Promise<PluginInfo[]> {
      // 与快照基线同一来源（readInstalled），否则差异会算错
      return listInstalledPlugins(homeDir, profile);
    },
  };
}

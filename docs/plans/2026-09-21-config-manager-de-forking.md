# dsh-config-manager 去 fork 化（改为自制插件）

> 状态：待实施。目标 = 让本包成为**自制插件**：不再从上游 `xiajiajun516/dsh-config-manager` fork，不再有定时上游同步。

## 1. 判据（为什么可以停同步）

与 `ctx-mem` 去 fork 化（`6bbf3b1`）同一判据：

| 事实 | 证据 |
|---|---|
| 上游引入后**从未跑过一次同步** | `git log --merges --grep="git-subtree-dir: packages/dsh-config-manager"` 只有收养提交 `6cf5a6d`，无 `git subtree pull` 合并 |
| 主体已与上游无等价物 | 上游 v0.1.60 的导出/导入/加密/市场/档案子系统在本包已整体删除；`sync-policy.json` 为 `owned=83 / deleted=151 / added=5` |
| 继续 fork 的代价 | 每次人工重拷都会丢失改造；同步 PR 恒为大面积冲突 |

**保留**：subtree 祖先提交、`LICENSE`（MIT 归属义务随衍生作品存续）、来源记录。不重写历史。

## 2. 切片（一次可独立验证的改动）

| # | 切片 | 归属 | 判据 |
|---|---|---|---|
| 1 | 去 fork 机制：删 `packages/dsh-config-manager/sync-policy.json` + 删 CI matrix 的 config-manager 条目 + 删测试 `EXPECTED_IDS` 条目 | **Root** | 共享可变状态：`sync-upstream.test.mjs:815` 断言 matrix ↔ 已提交 policy 集合 `deepEqual`，两处必须同一次提交 |
| 2 | 身份文案：包内 `AGENTS.md` / `DEVELOPERS.md` / `DESIGN.md` / `.gitignore` 与仓库根 `AGENTS.md` 形态图 | Root | 单一真源投影的归属处 |
| 3 | 验证：`pnpm test` + `node scripts/aggregate.mjs --check` + `pnpm typecheck` | Root | 门禁三条全绿 |
| 4 | 里程碑盲审（跨文件不变量：matrix ↔ policy 集合、文档口径） | 子代理 | 独立只读审查 |

## 3. 不做的（边界）

- 不删除 subtree 祖先提交、不重写历史。
- 不删除 `scripts/sync-upstream.mjs` 与 workflow 本身（另有 5 个 fork 在用）。
- 不改包名 / 版本线 / 发布链路。
- 不批量改写 `docs/spec/` 里指向上游历史产物的「上游」表述 —— 那是**格式兼容语义**（识别上游历史产物），与 fork 机制无关；仅改「本 fork」这类自指称谓。

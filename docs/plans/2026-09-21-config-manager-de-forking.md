# dsh-config-manager 去 fork 化（改为自制插件）

> 状态：**已实施**（切片 1–3 落地，见提交 `2ed966c`；切片 4 盲审记录见 §4）。目标 = 让本包成为**自制插件**：不再从上游 `xiajiajun516/dsh-config-manager` fork，不再有定时上游同步。

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
- 不批量改写 `docs/spec/` 里指向上游历史产物的「上游」表述 —— 那是**格式兼容语义**（识别上游历史产物），与 fork 机制无关；只改「本 fork」这类自指称谓（`bundle-format-v1.md` 7 处、`known-gaps.md` 3 处）。

## 4. 评审记录（切片 4）

独立盲审席位（只读，未见本计划与背景），审查对象 `2ed966c` / `2f86f40`，维度：重复 / 冲突 / 矛盾 / 遗漏 / 过度设计。

| # | 条目 | 裁定 | 处置 |
|---|---|---|---|
| 1a | `scripts/sync-upstream.test.mjs:29` 的 `EXPECTED_IDS` 是第二份手写登记处，且**已漂移**：漏 `agy-link`（实际 5 个 fork）；本次改动还顺手抹掉了注释里的数字，掩盖了不一致 | **采纳** | 补回 `agy-link`（5 项）并恢复注释里的数字。该 id 早在 `1956084` 收编 agy-link 时就该加 —— 属既有缺陷，本次一并订正 |
| 1b | 「谁参与同步」在两处手工维护（`AGENTS.md:24` vs policy 存在性 + matrix 行） | 已知边界 | `AGENTS.md:24` 是判据式泛称，非清单；matrix ↔ policy 已有 `sync-upstream.test.mjs:815` 的 deepEqual 钉住。不修 |
| 2 | `.codex-plugin/plugin.json`（**被跟踪**）仍写上游 `author` / `homepage` / `repository`，版本停在 `0.1.45`（实际 `0.1.62`） | **采纳** | 改为本仓库身份与当前版本，描述同步为「远程同步」口径 |
| 3 | matrix ↔ policy、测试自洽、聚合登记 —— 无缺陷 | 确认 | 无需处置 |
| 4a | `docs/spec/` 的「本 fork」自指只改了 1 处、漏 10 处 | **采纳** | `bundle-format-v1.md` 7 处 + `known-gaps.md` 3 处，`本 fork` → `本实现` |
| 4b | 根 `AGENTS.md:19` 的「自制（无上游）」与同文件 :48 的判据（改造自独立外部仓库即有上游）自相矛盾 | **采纳** | 改为事实描述「衍生自上游，已去 fork 化 → 不参与同步」 |
| 4c | 本文件 :3 引用「见 §4」，而当时无 §4 | **采纳** | 补本节 |
| 4d | `src/index.ts:164-165` 的注释自称 `STAR_PROMPT_REPO_URL` 与 `package.json#repository` 一致，实为假 | **部分采纳** | 只改注释（陈述假事实）。`STAR_PROMPT_REPO_URL` 的值不改：它指向**衍生来源上游**，是该引导弹窗的既有产品意图，且与 :257 的「一键上传」目标仓库同源；改指本仓库会让 Star 引导指向一个非本插件的仓库 |
| 5 | 过度设计 —— 无缺陷 | 确认 | 无需处置 |

> 4d 的「部分采纳」经辩论收口：盲审的最小修法给了「改指向本仓库或删除」两个选项，二者都会**改变产品行为**（Star 引导的落点），超出「停止 fork 与上游同步」的目标边界。采纳其中**零行为变更**的那一半（订正注释），值本身按已知边界结案。

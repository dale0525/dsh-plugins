---
name: dsh-plugin-lifecycle
description: 要在本仓库新增或移除一个子插件、判断某个 `packages/<name>` 该不该是上游 fork、或把上游仓库收养为 git subtree 时加载。
---

# 子插件的增删与形态判据

本技能只讲「把一个包放进本仓库」与「把一个包拿出去」这两条对称流程，以及某个目录该不该是 fork 的判据。仓库整体结构见 `AGENTS.md` 的「📦 仓库形态」。

**子插件的来源决定它要不要 fork**：`packages/<name>/` 有两种合法形态，选哪种由**它有没有上游**决定。

- **改造自别人的上游仓库** → 必须是该上游的 `git subtree` fork。不能是「把安装副本拷进来」的普通目录：没有 subtree 祖先就没有三方合并基准，该插件**永久无法自动同步**，且我方改造在每次人工重拷时都会丢失。
- **我们自制的插件**（无上游）→ **不 fork，也不该硬套**。直接把目录放进 `packages/<name>/` 即可，不需要 `upstream.json`，也不参与上游同步。

判断有无上游：该插件是否发布自、或改造自一个**独立的外部仓库**。有则走 fork，没有则走自制。

**已去 fork 化的包是第三种状态**：衍生自上游、但主体已重写，且同步已无法安全承载我方改造（同步从未跑过；
或同步会静默丢弃上游改动），继续 fork 只会让每次人工重拷继续丢失改造，
经裁定后按自制形态维护 —— 不建 `upstream.json`、不参与同步，**保留** LICENSE 与来源记录、不重写历史。

**fork 的判据**（自制插件不适用；fork 场景下空输出即未收养，**不要继续下一步**）：

```bash
git log --oneline --grep="git-subtree-dir: packages/<name>" | head -1
```

收养必须在**目录还不存在**时做；已用普通提交导入的上游目录补不回来（`git subtree pull` 报 `fatal: refusing to merge unrelated histories`），只能整套收养，配方见 `docs/plans/2026-09-19-multi-upstream-subtree-sync.md` §5。

## ➕ 新增子插件

**顺序不可颠倒**：先收养（有上游时）→ 放进 `packages/` → 登记 → 生成校验 → 首发。

四条每次都成立的硬约束：

- **两节都要登记**：`packages/all/aggregate.yml` 的 `patchFrom` 决定 profile 里出现哪些行，`deps` 决定装哪些包。只写一节会发出「包不存在」的行，或行根本不出现。
- **patch 行 `id` 全仓库唯一**，且等于该插件宿主半边的 `export const name`。撞车即宿主启动硬崩；唯一性由 `pnpm run check:host` 查，名称相等**无人检查**。
- **客户端产物 entry `id` 等于包名**，否则浏览器半边加载失败，无任何脚本检查。
- **新包首发只能由用户人工执行**：`npm publish` 需要 OTP，Agent 跑不了。

完整五步（安装链路、收养命令、`aggregate.yml` 写法、生成校验、首发交接）、验收表，见 `references/add-child-plugin.md`——只在真的要新增一个子插件时读。

## ➖ 移除子插件

与「新增」对称，但**没有任何脚本会替你校验**：下列几处必须同时改，漏掉任何一处的后果都是**静默**的
（不报错、看似成功）。

| 改动 | 漏掉的后果 |
|---|---|
| 删 `packages/<name>/` 整目录 | — |
| 从 `packages/all/aggregate.yml` 的 `patchFrom` **和** `deps` 各摘一行 | 发出的包引用一个不存在的包，或凭空多出一行（理由见本技能「3. 在 `packages/all/aggregate.yml` 登记」） |
| 手工改 `packages/all/package.json` 的 `version` | CI 判重跳过，**看似发布成功、实则没发**（见 `dsh-plugin-release` 技能） |
| 重跑 `node scripts/aggregate.mjs` | 生成物与清单 drift，`--check` 报错 |

然后按 `AGENTS.md` 的「✅ 验证命令」跑四条门禁，按 `dsh-plugin-release` 技能走 CI/CD。

**本机也要清**：`~/.dsh/profiles/<p>/cordis.patch.yml` 里该插件的行会变成指向不存在包的悬空行，
须手工摘除；`$DSH_HOME` 下由该插件自己写的运行状态文件，等它停止运行后一并删除
（先确认宿主已不再持有这些文件的句柄，否则删了会被重新写回）。

> 删包后跑测试若有**与本次改动无关**的包失败，先读 `dsh-test-judgement` 技能里那条并行配对的判据，
> 不要当成自己改坏了。
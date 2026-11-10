# AGENTS.md — dsh-plugins 仓库协作指南

> 术语表见根 `CONTEXT.md`（若存在）。

本文件只放**每条任务都成立**的约定：仓库结构、单一真源、合并前必过的门禁、边界。
改动前必知的具体规则按需加载——先用 `skill` 加载对应技能，未触发不读。

## 📦 仓库形态

```
dsh-plugins/
├── package.json            # 根包（private）：dsh.bundle.patch → ./packages/all/cordis.patch.yml
├── pnpm-workspace.yaml     # packages/*
├── packages/
│   ├── all/                # 聚合载体 @logictan/dsh-plugins-all（唯一被安装的那个包）
│   │   ├── aggregate.yml   # 手写清单（patchFrom / deps）
│   │   ├── cordis.patch.yml# 生成物，勿手改
│   │   └── package.json    # dependencies 由脚本生成；version 手工改（见 dsh-plugin-release）
│   ├── dsh-fakeip-fetch/       # 自制（无上游）→ 不 fork
│   ├── dsh-config-manager/     # 衍生自上游，已去 fork 化 → 不参与同步
│   ├── dsh-easyrewrite/        # 衍生自上游，已去 fork 化 → 不参与同步
│   ├── dsh-imagegen/           # 衍生自上游，已去 fork 化 → 不参与同步
│   └── <pkg>/upstream.json     # 该 fork 的上游身份（仅 fork 有）
├── scripts/
│   ├── aggregate.mjs       # aggregate.yml → patch + deps
│   ├── publish.mjs         # 按依赖边拓扑推导发布顺序（子插件 → 聚合包）
│   └── sync-upstream.mjs   # 上游同步的只读工具（--list / --changed / --preflight）
└── packages/dsh-config-manager/scripts/dev-watch.mjs   # 源 → 产物自动重建（子包内）
```

**单一真源**：每个子插件自己的 `cordis.patch.yml` 决定它的 patch 行（id / name / config）；聚合 patch 由 `scripts/aggregate.mjs` 逐字拼接，**绝不改写行**。改行名改子包自己的 patch 文件，然后跑 `node scripts/aggregate.mjs`。

**patch 行 `id` 必须全仓库唯一**，且等于该插件宿主半边的 `export const name`。撞车时宿主启动硬崩
（`cordis-plugin-loader`：`duplicate loader entry id: <id>`），而 `aggregate.mjs --check` **不校验**
行 id 唯一性（只校验 `deps` 重复包名）—— **唯一性**用 `pnpm run check:host` 查（见「✅ 验证命令」），
**「等于宿主半边 `export const name`」这半仍靠人工核对**（脚本不读 `src/`）。

**构建产物不入版本控制**：每个 `packages/<name>/lib/` 由各自 `.gitignore` 忽略，由该包自己的构建脚本生成。
各包的触发时机**不统一**：多数用 `prepare`（`pnpm install` 即构建），`dsh-imagegen` 只有 `prepack`——
**别假设 `pnpm install` 之后每个包的 `lib/` 都已就绪**，
用某个包的产物前先确认它的 `scripts` 里哪个钩子会构建（`node -p "require('./packages/<name>/package.json').scripts"`）。

**可发布的包必须有一个发布期构建钩子**（`prepack` 或 `prepare`）：CI 只跑 `pnpm install` + typecheck + test，
不单独构建；包只有 `build` 时 `npm publish` 会把 `files` 里不存在的 `lib/` 静默丢掉，
发出一个「装得上、加载不了」的空包（`dsh-imagegen` 2.0.0 就这样发过一次）。

## 🧩 项目技能索引

技能正文按需加载：用 `skill` 工具按名字调用（这是唯一生效的加载方式）。名字与触发条件由每轮注入的 skill catalog 给出，不在此重复；需要直接读文件核对时，在 `.agents/skills/<name>/SKILL.md`。

## ✅ 验证命令

安装与日常构建命令见 `README.md` 的「开发」。以下四条是**合并前必过的验收门禁**：

```bash
node scripts/aggregate.mjs --check            # 聚合 patch / deps 与清单一致（发版时 CI 才跑）
pnpm test                                     # 全仓测试：根 scripts/*.test.mjs + 每个子包
pnpm typecheck                                # 全仓 typecheck（pnpm -r --if-present）
pnpm run check:host                           # 宿主世代兼容 + patch 行 id 唯一（升级宿主后必跑）
```

> **这四条都不会在合并前自动跑**：本仓库只有一个 workflow（`.github/workflows/publish.yml`），
> 只在推 tag 或 main 上手动 `dry_run=false` 时触发 —— **`main` 的日常提交没有任何 CI 门禁**。
> 前三条在**发版那一刻**才跑（门禁排在 publish 步骤之前），第四条 `check:host` 则从不跑：
> CI 的 runner 没装 `dsh`，装了也不该为一个只读自检去拉整个宿主。
> 所以四条全是**本地人工门禁** —— 提交前各跑一次，**没有任何自动化会在你忘记时替你跑**。
> 实测代价：两条坏测试在 `main` 上躺了一整天无人发现，直到 `v0.5.57` 打 tag 才暴露，发布直接失败。
>
> 它查三类缺陷：两类会让插件行**静默禁用**（宿主包误写 `dependencies`、peer 不接受当前宿主）、
> 一类会让宿主启动**硬崩**（聚合 patch 行 `id` 重复）。这三类里**只有 R2 需要宿主**：
> R1 是纯 manifest 检查、R4 是纯文本检查，无宿主的机器上也照跑（R1 挡的正是本次真实发生过的
> `mcp-stitch` 事故，所以它不能依赖宿主在场）。本机没宿主时 R2 会明说「未检查」并以 0 退出，
> **不会假装通过**。

## 🧭 边界

- **同步渠道必须指向独立的私有仓库**，与本仓库物理分离：本仓库是 public，fork 的插件源码公开无妨，但同步快照携带明文凭据。
- 同步通道是明文语义（私有通道自用）：不加密、不脱敏、不做 diff/合并，勾选即同步。`manifest.security.containsSecrets` 必须按实际内容**如实标注**。

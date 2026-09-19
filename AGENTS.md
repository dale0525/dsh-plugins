# AGENTS.md — dsh-plugins 仓库协作指南

> 术语表见根 `CONTEXT.md`（若存在）。本文件只写**改动前必知**的约定与生效门禁。

## 📦 仓库形态

```
dsh-plugins/
├── package.json            # 根包（private）：dsh.bundle.patch → ./packages/all/cordis.patch.yml
├── pnpm-workspace.yaml     # packages/*
├── packages/
│   ├── all/                # 聚合载体 @logictan/dsh-plugins-all（唯一被安装的那个包）
│   │   ├── aggregate.yml   # 手写清单（patchFrom / deps）
│   │   ├── cordis.patch.yml# 生成物，勿手改
│   │   └── package.json    # 生成物，勿手改
│   └── dsh-config-manager/ # git subtree fork 自上游 v0.1.60
├── scripts/
│   ├── aggregate.mjs       # aggregate.yml → patch + deps
│   ├── publish.mjs         # 按依赖边拓扑推导发布顺序（子插件 → 聚合包）
│   └── sync-upstream.mjs   # 上游同步（policy 应用）
├── sync-policy.json        # 声明 owned / deleted / upstream
├── docs/adding-a-child-plugin.md   # 新增子插件的完整步骤与验收
└── packages/dsh-config-manager/scripts/dev-watch.mjs   # 源 → 产物自动重建（子包内）
```

**单一真源**：每个子插件自己的 `cordis.patch.yml` 决定它的 patch 行（id / name / config）；聚合 patch 由 `scripts/aggregate.mjs` 逐字拼接，**绝不改写行**。改行名改子包自己的 patch 文件，然后跑 `node scripts/aggregate.mjs`。

**patch 行 `id` 必须全仓库唯一**，且等于该插件宿主半边的 `export const name`。撞车时宿主启动硬崩
（`cordis-plugin-loader`：`duplicate loader entry id: <id>`），而 `aggregate.mjs --check` **不校验**
行 id 唯一性（只校验 `deps` 重复包名）—— 新增子插件时须人工比对。完整步骤见
`docs/adding-a-child-plugin.md`。

**构建产物不入版本控制**：每个 `packages/<name>/lib/` 由各自 `.gitignore` 忽略；安装时靠 `prepare` 脚本构建。

## 🚀 生效门禁（哪类改动需要重启）

**实测结论（2026-09-18，dsh-web PID 未变的前提下逐条验证）**：

| 改动类型 | 是否需重启 | 机制 |
|---|---|---|
| `cordis.patch.yml`（MCP 条目、插件挂载行、config） | **否** | `@deepseek-ai/dsh-hmr` 监听 `<profile>/cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml`，改动即 reconcile |
| `settings.yaml` / `.credentials.yaml` | **否** | `dsh-settings-file` / `dsh-credentials-local` 各有独立 watcher |
| 插件**客户端产物** `lib/client.js` | **否** | `@deepseek-ai/dsh-client-hmr` 每 500ms stat-poll 各插件 client bundle 的 mtime/size，变化即推 SSE 原位替换 fiber（浏览器无需刷新） |
| 插件**包代码**同版本覆盖安装 | **是** | `dsh-plugin-manager` 的 `restart-required` 路径：磁盘文件被替换但模块缓存仍是旧代码 |
| 插件**宿主半边源码**（`src/**` 非 client） | **是**（默认） | `dsh-base` 的 hmr 行是 `config.root: []` —— module watch 默认**关闭** |

**因此**：
- 改 `src/client/**` → 跑 `pnpm --filter @logictan/dsh-config-manager dev:watch`（脚本在**子包** `packages/dsh-config-manager/scripts/dev-watch.mjs`），浏览器不刷新即见新 UI（已实测：改源码 → 重建 `lib/client.js` → mtime/size 变化）。
- 改宿主半边 → 需重启（`dsh-web restart`），或自行在 profile patch 的 hmr 行开 `config.root`。
- **不要**把 `lib/` 纳入 `dev-watch` 监听：产物变化会触发重建，自激成死循环。

**验收**：`dsh-web status` 输出 `Verdict:  OK`（作业 PID == 端口 owner PID）。

## 🔀 上游同步（fork 自 dsh-config-manager）

`packages/dsh-config-manager` 是 `git subtree`，保留上游历史。同步**只开 PR，绝不直接推 main**。

policy 顺序是**铁律**（顺序反了会让我们的改造被上游覆盖）：

```
git subtree pull --prefix=packages/dsh-config-manager <upstream> <ref>   # 产生冲突
git checkout --theirs -- packages/dsh-config-manager                     # 1) 先全取上游
git checkout --ours  -- <sync-policy.json 的 owned 列表>                  # 2) 再恢复我方改造
git rm -f --ignore-unmatch <sync-policy.json 的 deleted 列表>             # 3) 重删我方删除
git commit
```

用 `node scripts/sync-upstream.mjs --dry-run` 先看计划。真实价值边界：上游一天 1-2 个版本、我们砍掉了大部分代码，**这个同步不会带来「版本对齐」**，它只把上游在「我们保留的文件」里的 bug 修复拉进来。

**改了 fork 的文件集就必须重算清单**：第 2 步 `--theirs` 会取回上游全部文件，只有登记在
`owned` 里的才会被恢复成我方版本。**新增一个我方文件却忘了登记，下一次同步就被上游版本静默覆盖**
（`env-lock.ts` 的修复就差点这样丢掉）。跑 `node scripts/sync-upstream.mjs --refresh-policy`
按当前 fork 状态重算 `owned` / `deleted` / `added`。

## 📤 发布（OIDC，无长期 token）

推 `v*` tag → `.github/workflows/publish.yml`。认证走 **trusted publishing (OIDC)**，
不存 npm token：npm 正在移除 bypass-2FA token 的直接发布能力（官方 targeting 2027-01），
且 write token 需定期轮换。

**顺序铁律**：子插件必须先上线，聚合包才能解析到它的依赖版本。顺序由
`scripts/publish.mjs` 从各包 `dependencies` 边**拓扑推导**，不写死包名 ——
新增子插件/聚合包无需改脚本。跑 `npm run publish:plan` 预览。

**每个新包都要人工配一次 trusted publisher**（否则 CI 发布被拒）：

```sh
npm trust github <pkg> --file publish.yml --repo dale0525/dsh-plugins --allow-publish
```

> `--allow-publish` **不可省**：2026-09-03 之后创建的配置默认只允许 `npm stage publish`，
> 不给这个 flag 时 CI 直接发布会被拒。

**首次发布只能人工**（两个独立原因，均来自 npm 官方文档）：trusted publisher 配在
**已存在包**的设置页上；staged publishing 明确排除全新包（"you cannot stage a brand-new
package"）。新包流程：人工 `npm publish --access public` → 配 trusted publisher → 之后交给 CI。

## ✅ 验证命令

```bash
pnpm install                                  # 工作区安装（子包 prepare 会构建）
node scripts/aggregate.mjs --check            # 聚合 patch / deps 与清单一致
pnpm --filter @logictan/dsh-config-manager typecheck
pnpm --filter @logictan/dsh-config-manager test
```

> **测试的 TMPDIR 陷阱（macOS）**：`src/utils/recursive-walk.test.ts` 与
> `tests/cli/*` 建真实符号链接，而 macOS 的 `/var/folders/...` 是 `/private/var/...` 的
> 符号链接 —— `realpath` 会把 home 解析到 `/private/...`，导致「home 内」判定失败。
> 跑测试前先 `mkdir -p /private/tmp/realhome` 并 `TMPDIR=/private/tmp/realhome/ node --test ...`。

> **平台专属路径只在 CI 覆盖**：`src/utils/env-lock.ts` 的进程身份探测**只有 Linux 真正实现**
> （读 `/proc/<pid>/stat` 的 starttime）；darwin / win32 的默认 probe 返回 `null`（不校验 PID 复用，
> 留待宿主注入）。**Linux 分支在 macOS 上完全不走**，本地全绿不代表它正确。改到该文件或任何
> 平台分支代码后，必须让 CI 在 ubuntu 上跑过一次再判定通过。

## 🧭 边界

- **同步渠道必须指向独立的私有仓库**，与本仓库物理分离：本仓库是 public，fork 的插件源码公开无妨，但同步快照携带明文凭据。
- 同步通道是明文语义（私有通道自用）：不加密、不脱敏、不做 diff/合并，勾选即同步。`manifest.security.containsSecrets` 必须按实际内容**如实标注**。

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
│   ├── ctx-mem/                # 自制（无上游）→ 不 fork
│   ├── dsh-fakeip-fetch/       # 自制（无上游）→ 不 fork
│   ├── dsh-agy-link/           # 有上游 → git subtree fork
│   ├── dsh-config-manager/     # 衍生自上游，已去 fork 化 → 不参与同步
│   ├── dsh-easyrewrite/        # 有上游 → git subtree fork
│   ├── dsh-imagegen/           # 有上游 → git subtree fork
│   ├── dsh-market/             # 有上游 → git subtree fork
│   ├── dsh-workbuddy-connect/  # 有上游 → git subtree fork
│   └── <pkg>/sync-policy.json  # 该 fork 的上游身份与同步清单（仅 fork 有）
├── scripts/
│   ├── aggregate.mjs       # aggregate.yml → patch + deps
│   ├── publish.mjs         # 按依赖边拓扑推导发布顺序（子插件 → 聚合包）
│   └── sync-upstream.mjs   # 上游同步（policy 应用）
└── packages/dsh-config-manager/scripts/dev-watch.mjs   # 源 → 产物自动重建（子包内）
```

**单一真源**：每个子插件自己的 `cordis.patch.yml` 决定它的 patch 行（id / name / config）；聚合 patch 由 `scripts/aggregate.mjs` 逐字拼接，**绝不改写行**。改行名改子包自己的 patch 文件，然后跑 `node scripts/aggregate.mjs`。

**patch 行 `id` 必须全仓库唯一**，且等于该插件宿主半边的 `export const name`。撞车时宿主启动硬崩
（`cordis-plugin-loader`：`duplicate loader entry id: <id>`），而 `aggregate.mjs --check` **不校验**
行 id 唯一性（只校验 `deps` 重复包名）—— 新增子插件时须人工比对。

**构建产物不入版本控制**：每个 `packages/<name>/lib/` 由各自 `.gitignore` 忽略，由该包自己的构建脚本生成。
各包的触发时机**不统一**：多数用 `prepare`（`pnpm install` 即构建），`dsh-imagegen` 只有 `build`、
`dsh-workbuddy-connect` 只有 `prepack`——**别假设 `pnpm install` 之后每个包的 `lib/` 都已就绪**，
用某个包的产物前先确认它的 `scripts` 里哪个钩子会构建（`node -p "require('./packages/<name>/package.json').scripts"`）。

**子插件的来源决定它要不要 fork**：`packages/<name>/` 有两种合法形态，选哪种由**它有没有上游**决定。

- **改造自别人的上游仓库** → 必须是该上游的 `git subtree` fork。不能是「把安装副本拷进来」的普通目录：没有 subtree 祖先就没有三方合并基准，该插件**永久无法自动同步**，且我方改造在每次人工重拷时都会丢失。
- **我们自制的插件**（无上游）→ **不 fork，也不该硬套**。直接把目录放进 `packages/<name>/` 即可，不需要 `sync-policy.json`，也不参与上游同步。

判断有无上游：该插件是否发布自、或改造自一个**独立的外部仓库**。有则走 fork，没有则走自制。

**已去 fork 化的包是第三种状态**：衍生自上游、但主体已重写且同步从未跑过（继续 fork 只会让每次人工重拷丢失改造），
经裁定后按自制形态维护 —— 不建 `sync-policy.json`、不参与同步，**保留** LICENSE 与来源记录、不重写历史。

**fork 的判据**（自制插件不适用；fork 场景下空输出即未收养，**不要继续下一步**）：

```bash
git log --oneline --grep="git-subtree-dir: packages/<name>" | head -1
```

收养必须在**目录还不存在**时做；已用普通提交导入的上游目录补不回来（`git subtree pull` 报 `fatal: refusing to merge unrelated histories`），只能整套收养，配方见 `docs/plans/2026-09-19-multi-upstream-subtree-sync.md` §5。

## ➕ 新增子插件

把一个可发布的 DSH 插件加进本仓库，并让它随聚合包一起被安装。**顺序不可颠倒**：先收养（有上游时）→ 放进 `packages/` → 登记 → 生成校验 → 首发。

### 安装链路（改动前先理解）

```
dsh plugin --profile <p> add @logictan/dsh-plugins-all   # 用户安装的入口（聚合包）
  └─ dsh.bundle.patch → cordis.patch.yml                 # 聚合 patch，逐字拼接各子插件的 patch
       └─ - id: <row-id>  name: '@scope/pkg'             # 子插件行；name 从 profile 根解析
            └─ dependencies: '@scope/pkg': ^x.y.z        # 子插件作为聚合包的普通依赖装进 profile
```

判据（`dsh-plugin-manager` 的 `bundleManifest()`）：manifest 的 `dsh.bundle.patch` 为 `undefined` 时该包不是 bundle，CLI 只当普通依赖并告警
（`declares no dsh.bundle — installed as a plain dependency, not a profile layer`）。「是不是 bundle」由这个字段决定，不看包名。

### 1. 有上游就先收养为 `git subtree`

分类判据与「未收养」的后果见上文「📦 仓库形态」，不重复。自制插件跳过本节。

收养在**目录还不存在**时做最省事（一个命令）：

```bash
git subtree add --prefix=packages/<name> <上游仓库 URL> <基线 tag>
```

收养后建 `packages/<name>/sync-policy.json`（声明 `target` / `owned` / `deleted` / `added`）。
**不要**另建上游总表：`node scripts/sync-upstream.mjs --list` 从各 policy 汇总，policy 就是唯一登记处。

### 2. 放进 `packages/<name>/`

子插件自带 `cordis.patch.yml`，它决定该插件在 profile 里的那一行（`id` / `name` / `config`）。
聚合 patch 由 `scripts/aggregate.mjs` **逐字拼接、不改写行** —— 改行名改子插件自己的 patch 文件。

两条硬约束：

| 约束 | 违反后果 | 谁在检查 |
|---|---|---|
| patch 行 `id` 全仓库唯一，且等于该插件宿主半边的 `export const name` | 重复即硬崩：`duplicate loader entry id: <id>`（`cordis-plugin-loader`） | **无人自动检查**，须人工核对 |
| 客户端产物 entry `id` 等于包名 | `window.__ModuleLoader__.load({ id })` 与包名不符 → 浏览器半边加载失败 | 无 |

### 3. 在 `packages/all/aggregate.yml` 登记

```yaml
patchFrom:
  - ../<name>      # 该子插件的 patch 行会被拼进聚合 patch
deps:
  - ../<name>      # 该子插件以 ^<version> 写进聚合包 dependencies
```

两节是两件事：`patchFrom` 决定 profile 里出现哪些行，`deps` 决定装哪些包。
**两节都要登记**：只写 `patchFrom` 会发出一个「包在新 profile 里根本不存在」的行；只写 `deps`
则行不会出现在 patch 里。`ctx-mem` 两节都在（见 `aggregate.yml` 里的就地注释）。

### 4. 生成并校验

```bash
node scripts/aggregate.mjs           # 生成 packages/all/cordis.patch.yml 与 package.json
node scripts/aggregate.mjs --check   # 校验生成物与清单一致（CI 会跑）
```

### 5. 首发：人工 `npm publish` + 配 trust（**由用户执行**）

新包不能走 CI 首发，必须先由用户人工发一次并配好 trusted publisher——**顺序、命令与理由见「📤 发布」**，
那里是发布规则的唯一真源，本节不重复。

配好 trust 之后，该包**后续所有更新**都走 CI/CD，不再人工发布。

**闭环：聚合包必须跟着升版并发出去。** 子插件首发只把它自己放上 npm；此时线上的
`@logictan/dsh-plugins-all` 还是不含它的旧版本，`dsh plugin add …@latest` 自然带不出它。
所以还要：升聚合包版本（`packages/all/package.json` 是生成物，改它的来源）→ 跑
`node scripts/aggregate.mjs` → 走 CI/CD 发布。顺序由 `scripts/publish.mjs` 保证子插件在前。

### 验收

| 检查 | 判据 |
|---|---|
| **上游祖先已建立**（仅限有上游的） | `git log --oneline --grep="git-subtree-dir: packages/<name>"` 有输出（§1）；自制插件此条不适用 |
| **该包有 sync-policy**（仅限有上游的） | `packages/<name>/sync-policy.json` 存在且 `target` / `owned` / `deleted` / `added` 齐备；自制插件不需要 |
| 聚合生成物与清单一致 | `node scripts/aggregate.mjs --check` 无 drift |
| patch 行 `id` 未撞车 | 人工比对全仓库 `cordis.patch.yml` 的行 `id`（无自动检查） |
| 发布顺序正确 | `npm run publish:plan` 中该子插件在聚合包之前 |
| 从 registry 全新安装 | 干净 `DSH_HOME` 下 `dsh plugin --profile <p> add @logictan/dsh-plugins-all@latest`，依赖链带出该子插件 |
| 客户端产物可加载 | `lib/client.js` 按 loader 协议注册 1 次，注册 `id` 等于包名 |
| profile 内该行可解析 | patch 行的 `name` 从 profile 根可解析出该子插件 |

### 雷区

- **registry 404 不等于未发布**：发布后短时间内查询会命中 CDN 缓存。核验时带
  `Cache-Control: no-cache` 与时间戳查询串，并以 npm 日志的 `PUT 200` / 退出码 0 为准。
- **换包一律先删再加，不要并存**：两个包若声明同一个 patch 行 `id`，全新启动即
  `duplicate loader entry id` 硬崩；运行中并存则只有先加载的那个在服务。
- **`pnpm/action-setup` 必须显式给 `version`**：本仓库没有 `packageManager` 字段，
  两者都缺时该 action 直接失败。
- **根测试用 `pnpm test`，不用 `pnpm -r run test`**：`-r` 只覆盖 workspace 子项目，
  会跳过根包自己的 `scripts/*.test.mjs`。
- **provenance 需要 `repository`**：包的 `package.json` 缺 `repository`（指向本仓库且
  `directory` 正确）时，OIDC 发布的 provenance 生成被拒。已发布的旧版本无法补，只能等下一个版本。
- **`@deepseek-ai/dsh-client-ui-slots` 的版本必须全仓库一致**：宿主用 `declare module`
  往 `SlotMap` / `LocaleNamespaceMap` 里合并槽位契约，合并只对**同一个物理模块**生效。工作区里
  各子插件自带不同版本的 `dsh-client-ui-slots` 时，pnpm 会各留一份，合并落进另一份，消费方的
  `keyof SlotMap` 就塌成 `never` —— 症状是 `typecheck` 报
  `'"plugins.row.config"' does not satisfy the constraint 'never'`，而**运行时完全正常**
  （浏览器只加载一份实例）。把每个子插件的 `dsh-client-ui-slots` 对齐到宿主当前世代即可；
  同理，参与 `Context` 声明合并的宿主包（如 `dsh-attachment`）也要收敛到同一版本，
  否则插件通过 `ctx.get(...)` 拿到的类型与自己的 import 不是同一个符号。

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

## 🔀 上游同步

每个 fork 子包自带一份 `packages/<pkg>/sync-policy.json`，声明**它自己**的上游身份与清单；
`scripts/sync-upstream.mjs` glob 出全部 policy 并逐个同步，**policy 跟随它的包**。同步**只开 PR，绝不直接推 main**。

```bash
node scripts/sync-upstream.mjs --list                  # 列出全部目标与计数
node scripts/sync-upstream.mjs --dry-run               # 看计划，零写入
node scripts/sync-upstream.mjs --target <id>           # 只同步一个目标
```

policy 顺序是**铁律**（顺序反了会让我们的改造被上游覆盖）：

```
git subtree pull --prefix=packages/<pkg> <target.url> <ref>   # 产生冲突
git checkout --theirs -- packages/<pkg>                       # 1) 冲突条目取上游
git checkout <pull 前的 HEAD> -- <owned 列表>                  # 2) 再恢复我方改造
git rm -f --ignore-unmatch <deleted 列表>                      # 3) 重删我方删除
git commit
```

> **第 2 步必须按 commit 取，不能写 `git checkout --ours`**：`--ours/--theirs` 只对**未合并的
> 索引条目**生效。git 对「双方都改、但改在不同区域」的文件会干净地三方合并 —— 既无冲突标记，
> 索引里也没有 stage 1/2/3，此时 `--ours` 是**空操作**，我方版本会被上游内容静默污染
> （`package.json` 的版本号、我方改过的文案都会这样丢）。以 pull **之前**的 HEAD 为唯一真源覆盖，
> 才对冲突与非冲突路径一视同仁。脚本用 `restoreOwned()` 实现，并有针对性测试钉住这条契约。

> **第 3 步的陷阱**：上游若跟踪了被我方 `.gitignore` 的路径（workbuddy / easyrewrite 的 `lib/`、
> imagegen 的 `docs/images/`），`git rm -f` 会连**磁盘上的构建产物与 README 配图**一起删掉。
> 脚本对这类路径改用 `git rm --cached` 并在 merge 后恢复磁盘内容；手改时同理。

真实价值边界：上游一天 1-2 个版本、我们砍掉了大部分代码，**这个同步不会带来「版本对齐」**，它只把上游在「我们保留的文件」里的 bug 修复拉进来。

**改了 fork 的文件集就必须重算清单**：第 2 步 `--theirs` 会取回上游全部文件，只有登记在
`owned` 里的才会被恢复成我方版本。**新增一个我方文件却忘了登记，下一次同步就被上游版本静默覆盖**
（`env-lock.ts` 的修复就差点这样丢掉）。跑 `node scripts/sync-upstream.mjs --refresh-policy`
按当前 fork 状态重算 `owned` / `deleted` / `added`。

## 📤 发布

认证走 **trusted publishing (OIDC)**，不存 npm token：npm 正在移除 bypass-2FA token 的直接发布能力
（官方 targeting 2027-01），且 write token 需定期轮换。

**顺序铁律**：子插件必须先上线，聚合包才能解析到它的依赖版本。顺序由
`scripts/publish.mjs` 从各包 `dependencies` 边**拓扑推导**，不写死包名 ——
新增子插件/聚合包无需改脚本。跑 `npm run publish:plan` 预览。

### 新增包：人工首发 + 配 trust（**由用户执行**）

新包**不能**走 CI 首发，两个独立原因均来自 npm 官方文档：

1. trusted publisher 只能配在**已存在包**的设置页上；
2. staged publishing 明确排除全新包（`you cannot stage a brand-new package`）。

所以新包必须先由用户人工发一次，再配 trust，之后才交给 CI。**命令见 `README.md` 的「发布」。**

**Agent 不得代为执行新包发布**：本机 `npm publish` 需要 OTP，会以 `npm error code EOTP` 失败。
把命令原样交给用户，等用户确认 trust 配好后再进 CI/CD。

### 更新已发布包：走 CI/CD，**禁止手动发布**

**规则**：本地测试通过后，一律由 CI/CD 发布，**不跑 `npm publish`**。CI 的 publish 步骤带
`npm view "$name@$version"` 判重，已在线版本自动跳过，所以整仓发布是幂等的、可放心重跑。

两条触发路径（`.github/workflows/publish.yml`）：

| 路径 | 命令 | 用途 |
|---|---|---|
| 推 tag（正式发版） | `git tag v<x.y.z> && git push origin v<x.y.z>` | 常规发版，tag 记录发版点 |
| main 手动触发 | `gh workflow run publish.yml --ref main -f dry_run=false` | 补发/重发；**tag 指向的提交不含门禁修复时用这条** |

发布步骤的门禁是 `github.event_name == 'push' || (github.ref == 'refs/heads/main' && !inputs.dry_run)`
—— 只有 tag push 或 main 上的显式 `dry_run=false` 才能换取 OIDC 凭证。

> 发布门禁用**真值**判定而非 `== true`：经 CLI/REST 触发时 `inputs` 可能以字符串传入，
> 而 `==` 会两侧转数字（`Number("true")=NaN`），`"true" == true` 实为 `false`，
> 那样真发布会被静默跳过。已实测 `-f dry_run=false` 能正常发布（run `35508114244`：
> Publish 步骤 success、Dry run notice skipped），无需改用 `gh api`。

**发布前必过**：先跑完「✅ 验证命令」的三条门禁，再确认发布顺序：

```bash
npm run publish:plan                 # 确认顺序：子插件在聚合包之前
```

> **改了版本号才能发出去**：npm 拒绝覆盖已发布版本，版本没升的包会被 CI 判重跳过（看似成功、实则没发）。
> 子插件升版后聚合包也要升版，否则聚合包解析到的还是旧的子插件 range。

## ✅ 验证命令

安装与日常构建命令见 `README.md` 的「开发」。以下三条是**合并前必过的验收门禁**：

```bash
node scripts/aggregate.mjs --check            # 聚合 patch / deps 与清单一致（CI 会跑）
pnpm test                                     # 全仓测试：根 scripts/*.test.mjs + 每个子包
pnpm typecheck                                # 全仓 typecheck（pnpm -r --if-present）
```

> **测试的 TMPDIR 陷阱（macOS，仅 `dsh-config-manager`）**：该包的符号链接类测试
> （`packages/dsh-config-manager/src/**/*.test.ts`，如 `utils/recursive-walk.test.ts`、
> `utils/atomic-write.test.ts`）建真实符号链接，而 macOS 的 `/var/folders/...` 是
> `/private/var/...` 的符号链接 —— `realpath` 会把 home 解析到 `/private/...`，
> 导致「home 内」判定失败。跑该包测试前先 `mkdir -p /private/tmp/realhome` 并带
> `TMPDIR=/private/tmp/realhome/`。其余子包不受影响。

> **平台专属路径只在 CI 覆盖**：`packages/dsh-config-manager/src/utils/env-lock.ts` 的进程身份探测**只有 Linux 真正实现**
> （读 `/proc/<pid>/stat` 的 starttime）；darwin / win32 的默认 probe 返回 `null`（不校验 PID 复用，
> 留待宿主注入）。**Linux 分支在 macOS 上完全不走**，本地全绿不代表它正确。改到该文件或任何
> 平台分支代码后，必须让 CI 在 ubuntu 上跑过一次再判定通过。

> **不要用 `/proc/...` 当「不可写路径」**：`/proc` 只存在于 Linux。macOS 上该路径仅是不存在
> （快速失败，测试为错误的原因通过），Linux 上 `mkdir` 不返回，整个测试套件挂死并撞 CI 的
> `timeout-minutes`。用「父路径是普通文件」的可移植写法：`mkdir` / `writeFile` 在三个平台都
> 稳定抛 `ENOTDIR` / `EEXIST`。

## 🧭 边界

- **同步渠道必须指向独立的私有仓库**，与本仓库物理分离：本仓库是 public，fork 的插件源码公开无妨，但同步快照携带明文凭据。
- 同步通道是明文语义（私有通道自用）：不加密、不脱敏、不做 diff/合并，勾选即同步。`manifest.security.containsSecrets` 必须按实际内容**如实标注**。

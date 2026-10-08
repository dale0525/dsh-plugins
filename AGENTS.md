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
│   │   └── package.json    # dependencies 由脚本生成；version 手工改（见「📤 发布」）
│   ├── dsh-fakeip-fetch/       # 自制（无上游）→ 不 fork
│   ├── dsh-config-manager/     # 衍生自上游，已去 fork 化 → 不参与同步
│   ├── dsh-easyrewrite/        # 衍生自上游，已去 fork 化 → 不参与同步
│   ├── dsh-imagegen/           # 衍生自上游，已去 fork 化 → 不参与同步
│   ├── dsh-workbuddy-connect/  # 有上游 → git subtree fork
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
各包的触发时机**不统一**：多数用 `prepare`（`pnpm install` 即构建），`dsh-imagegen` 用 `prepack`、
`dsh-workbuddy-connect` 只有 `prepack`——**别假设 `pnpm install` 之后每个包的 `lib/` 都已就绪**，
用某个包的产物前先确认它的 `scripts` 里哪个钩子会构建（`node -p "require('./packages/<name>/package.json').scripts"`）。

**可发布的包必须有一个发布期构建钩子**（`prepack` 或 `prepare`）：CI 只跑 `pnpm install` + typecheck + test，
不单独构建；包只有 `build` 时 `npm publish` 会把 `files` 里不存在的 `lib/` 静默丢掉，
发出一个「装得上、加载不了」的空包（`dsh-imagegen` 2.0.0 就这样发过一次）。

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

收养后建 `packages/<name>/upstream.json`（声明 `id` / `url` / `prefix`）。
**不要**另建上游总表：`node scripts/sync-upstream.mjs --list` 从各 `upstream.json` 汇总，它就是唯一登记处。

### 2. 放进 `packages/<name>/`

子插件自带 `cordis.patch.yml`，它决定该插件在 profile 里的那一行（`id` / `name` / `config`）。
聚合 patch 由 `scripts/aggregate.mjs` **逐字拼接、不改写行** —— 改行名改子插件自己的 patch 文件。

两条硬约束：

| 约束 | 违反后果 | 谁在检查 |
|---|---|---|
| patch 行 `id` 全仓库唯一，且等于该插件宿主半边的 `export const name` | 重复即硬崩：`duplicate loader entry id: <id>`（`cordis-plugin-loader`） | 唯一性：`pnpm run check:host`；名称相等：**无**，人工核对 |
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
则行不会出现在 patch 里。

### 4. 生成并校验

```bash
node scripts/aggregate.mjs           # 生成 packages/all/cordis.patch.yml 与 package.json
node scripts/aggregate.mjs --check   # 校验生成物与清单一致（发版时 CI 才跑）
```

### 5. 首发：人工 `npm publish` + 配 trust（**由用户执行**）

新包不能走 CI 首发，必须先由用户人工发一次并配好 trusted publisher——**顺序、命令与理由见「📤 发布」**，
那里是发布规则的唯一真源，本节不重复。

配好 trust 之后，该包**后续所有更新**都走 CI/CD，不再人工发布。

**闭环：聚合包必须跟着升版并发出去。** 子插件首发只把它自己放上 npm；此时线上的
`@logictan/dsh-plugins-all` 还是不含它的旧版本，`dsh plugin add …@latest` 自然带不出它。
所以还要：**手工改 `packages/all/package.json` 的 `version`** → 跑
`node scripts/aggregate.mjs` → 走 CI/CD 发布。顺序由 `scripts/publish.mjs` 保证子插件在前。

> **聚合包的 `version` 没有「来源」，只能手工改。** `aggregate.mjs` 只重写
> `dependencies`（把每个子包钉成 `^<子包版本>`），其余字段原样保留 ——
> `aggregate.yml` 里根本没有 `version` 这一项，脚本也不生成它。
> 所以别去找「生成物对应的来源」：改 `aggregate.yml` 不会影响版本号，
> 版本没升则该包被 CI 判重跳过，**看似发布成功、实则没发**。

### 验收

| 检查 | 判据 |
|---|---|
| **上游祖先已建立**（仅限有上游的） | `git log --oneline --grep="git-subtree-dir: packages/<name>"` 有输出（§1）；自制插件此条不适用 |
| **该包有上游身份**（仅限有上游的） | `packages/<name>/upstream.json` 存在且 `id` / `url` / `prefix` 齐备；自制插件不需要 |
| 聚合生成物与清单一致 | `node scripts/aggregate.mjs --check` 无 drift |
| patch 行 `id` 未撞车 | `pnpm run check:host` 报 0 重复（只覆盖唯一性；名称相等仍人工核对） |
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
- **`inject` 是「必需」，只监听事件就不要 inject 那个服务**：`inject` 里的服务缺失时
  cordis **不调用该插件的 `apply`**，整个插件静默失效（实测：`inject: ['svc']` 且 svc 未提供
  → `apply` 从不执行；去掉 `inject` 即正常）。所以给插件加一条
  `ctx.on('some/event', ...)` 监听**不需要**把该事件的宿主服务写进 `inject` ——
  写进去只会让「宿主没装那个服务」从「少一个功能」升级成「插件整体消失」。
  宿主自己的监听方也这么写（`dsh-agent-preset-registry`、`dsh-session-reference` 都监听
  `system-prompt/assemble` 而不 inject `systemPrompt`）。
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
- **宿主包一律写 `peerDependencies`，绝不写 `dependencies`**：`dependencies` 里钉的宿主包
  范围一旦不被当前宿主满足（如 `^0.1.6-alpha.2` 遇上宿主 `0.2.0-rc.2`），pnpm 会**另装一份
  实体副本**进 profile。该副本遮蔽指向宿主安装树的共享软链（`~/.dsh/profiles/node_modules`），
  patch 行于是按副本的 peer 被宿主兼容门禁拒绝 —— **静默禁用该行**，功能无声消失。
  实测：`dsh-desktop-agent` 曾把 `@deepseek-ai/dsh-mcp-client` 写成 `dependencies`，令全局
  patch 的 `mcp-stitch` 行被禁用。patch 行只写包名、不钉版本，故修法就是改成 optional peer：
  profile 从宿主安装树解析，**跟着宿主升级自动走，无需改任何 patch 文件**。
- **devDeps 的世代滞后会制造假绿**：`devDependencies` 里的宿主包是**编译期**类型来源，
  钉在旧世代意味着 `tsc` 校验的是**旧 API 表面** —— typecheck 全绿，但校验了错的对象。
  对齐到宿主世代后暴露的类型错误是**真实的**（实测 `dsh-imagegen` 对齐后暴露 7 个：
  宿主已删除 `SettingsScope` / `SettingsScopeSnapshot` / `SettingsSectionHooks`）。
  症状与上面 slots 那条相反：那条是「编译失败、运行正常」，这条是「编译通过、校验错对象」。

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

> **该命令靠 `lsof` 找端口 owner，而 `lsof` 在 `/usr/sbin`**：调用方 PATH 缺 `/usr/sbin` 时
> `port_pid` 取空，输出 `owner pid none` 与 `==NOT LISTENING==`——**服务其实是好的**。
> 实测同一进程同一秒：PATH 无 `/usr/sbin` 判 NOT LISTENING，补上即 `Verdict: OK`。
> 见到 NOT LISTENING 先用 `lsof -nP -iTCP:10000 -sTCP:LISTEN`（绝对路径）复核，别直接重启。

## 🔀 上游同步

**同步是手工的。** 仓库只保留 `git subtree` 祖先和一个**只读**的查询工具：没有定时任务、
没有自动应用、没有自动 PR。每个 fork 子包自带一份 `packages/<pkg>/upstream.json`，
只声明它的上游身份（`id` / `url` / `prefix`）。

```bash
node scripts/sync-upstream.mjs --list              # 各 fork 的上游、上游最新 tag、我们相对它的状态
node scripts/sync-upstream.mjs --changed <id>      # 上游从真正的同步点到最新 tag 改了什么
node scripts/sync-upstream.mjs --preflight <id>    # 预演这次同步会撞哪些冲突，并按裁定难度分好类
```

脚本不 pull、不 checkout、不 rm、不 commit（`scripts/sync-upstream.test.mjs` 钉住这条契约）。
`--changed` 把 tag fetch 到 `refs/dsh-sync/<id>` 再 `git diff --stat`，不动工作区。

> **同步点是 `merge-base(HEAD, 上游 tag)`，不是 subtree trailer。** 手工同步的合并提交不带
> `git-subtree-split:` trailer（它只出现在**收养**提交里），拿它当同步点等于把收养点当成上次同步点，
> `--changed` 会把已经合并进来的历史再报一遍（实测 bre：48 文件 / 5185 行）。
>
> **fetch 到自己的 ref 命名空间，绝不复用上游 tag 名。** 本仓的发布 tag 也叫 `v0.5.2`，
> 直接 `git fetch <url> tag v0.5.2` 会撞车，以 `! [rejected] would clobber existing tag` 失败（实测）。
> 但**加 `--force` 就不再失败，而是静默改写**——本仓 121 个 tag 里有 29 个与上游同名
> （`git ls-remote --tags --refs <上游>` 与本仓 `git tag -l` 取交集），实测 `--force` 把本仓的
> `v0.5.2`、`v0.5.0` 直接指向了上游提交，**报错都没有**。要探上游 tag，一律 fetch 进
> `refs/dsh-sync/<id>`，永不写 `refs/tags/`。
>
> `--preflight` 用 `git merge-tree -X subtree=<prefix>` 复现 `subtree pull` 的三方合并，**只报告不落地**：
> 把我方已故意删除的构建产物 / 锁文件（维持 `git rm`，机械可裁定）与真正要人看的冲突分开列。
> 实测它与真 pull 的冲突集**完全一致**（bre 4 处、workbuddy 11 处）；不带 `-X subtree` 会多报假冲突。
> 它只把「机械的那部分」直接给出命令，**不替人裁定**，也不改工作区。

### 手工同步一个 fork

```bash
git subtree pull --prefix=packages/<pkg> <url> <tag>
```

然后**逐个冲突手工裁定**，`git commit`。没有「我方文件清单」这回事。

> **为什么删掉了 `owned` / `deleted` / `added` 清单**：那套清单把「可三方合并」压成「整文件二选一」。
> 上游与我们改在同一文件的**不同区域**时，git 本来能干净三方合并，清单却用
> `git checkout <pull 前的 HEAD> -- <owned>` 把整个文件覆盖回我方版本 —— 上游在该文件里的改动被
> **静默丢弃**，连冲突标记都不出现。实测 workbuddy v0.5.4 → v0.6.2：`locales.ts` 干净自动合并，
> `WorkBuddyPluginCard.tsx` 3 处冲突、`index.ts` 7 处冲突，全部可见、可逐处裁定。

### 手工同步要自己盯住的三件事

| 事项 | 判据 |
|---|---|
| 我方架构与上游冲突 | 上游把功能加进我方也改过的文件时，取上游的**内容**、留我方的**架构** |
| 宿主依赖世代 | 上游按新世代宿主写的代码，需要把 `package.json` 的宿主依赖抬到同世代 |
| 上游新增的导出 | 上游在 `src/index.ts` 里新增的导出不会自己出现在我方版本里，要手工补 |

真实价值边界：上游一天 1-2 个版本、我们砍掉了大部分代码，**这个同步不会带来「版本对齐」**，
它只把上游在「我们保留的文件」里的 bug 修复拉进来。代价是没有自动通知了 —— 靠人记得跑 `--list`。

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

> **`--workspace-concurrency=2` 不是性能旋钮，别调大**：`node --test` 与 vitest 各自按
> CPU 数开 worker，pnpm 再并发跑多个包，两个乘数叠起来会在 10 核机器上拉起 ~30 个测试进程，
> 把 `dsh-better-reasoning-effort` 的 jsdom 用例饿到撞 5000ms 默认超时（实测：默认并发
> 峰值净增 30 进程，本机三次运行均失败；限到 2 后净增 15 进程、通过且更快）。它是为了给 jsdom 留 CPU，
> 不是省时间。
>
> **增删子插件会改变并行配对，可能让「与本次改动无关」的包测试失败——别当成自己改坏了。**
> `--workspace-concurrency=2` 每次挑两个包同时跑，挑谁取决于工作区里有哪些包。删掉一个轻包后队列前移，
> `dsh-better-reasoning-effort` 可能改与 `dsh-config-manager`（1184 个测试）配对而被饿到超时
> （实测：删掉 `dsh-agy-link` 后本机 5/5 失败，失败用例名每次都不同，报 `Test timed out in 5000ms`；
> 把并发限到 1 即全绿，单独只跑这两个包稳定复现，换成轻包搭伴稳定通过）。该包源码可**逐字节未改**，
> 属调度副作用而非回归。判据：先 `git diff <base> -- <该包>/` 确认未改，再看并发限 1 是否转绿。

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

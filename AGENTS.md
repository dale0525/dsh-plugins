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

**做完这一节不等于交付完成**：还要按「📤 发布 → 首发交接」把两条命令按实际包名填好交给用户。
本节只讲仓库侧要改什么，交接格式在那边。

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

- **插件自己的 `/api/...` 路由会绕过宿主信任围栏，别再自造访问控制**：宿主
  `dsh-host-webserver` 匹配路由时**先查 exact 表、再查 prefix 表**，而信任围栏
  `connection`（`@deepseek-ai/dsh-client-connection`）注册的是 `/api` **prefix** 路由。
  于是插件注册的 exact `/api/dsh-*/...` 排在围栏**之前**，围栏根本没机会执行。
  实测：四个插件各自手写「只允许 loopback」检查（认来源 IP 与 `Host` 是 localhost），
  不认识 profile 里 `connection` 声明的 `trustedHosts` 局域网地址，把合法局域网浏览器
  全部拒掉 —— 症状是局域网打开 DSH 时这些插件报「读取失败」，而 `127.0.0.1` 一切正常。
  修法：删掉自造检查，**每次请求**向 `connection.requestRejection(req)` 要结论
  （`undefined` 放行 / `401` / `403`；服务缺失时一律 `403` 拒绝）。
  两个必须遵守的点：① `connection` **按请求现取**，不要写进 `inject` —— 写进去会让
  「宿主没装该服务」从「少一个功能」升级成**整个插件静默消失**；② 浏览器半边不要
  用 `connection.isLoopback` 自行判断要不要发请求，它只认 `localhost` / `[::1]` / `127/8`，
  同样会拒掉围栏已放行的局域网页面（被拒时让请求失败并降级为 `unavailable` 即可）。
- **registry 404 不等于未发布**：发布后短时间内查询会命中 CDN 缓存。核验时带
  `Cache-Control: no-cache` 与时间戳查询串，并以 npm 日志的 `PUT 200` / 退出码 0 为准。
- **发布时的 `PUT ... E404` 是「缺 trusted publisher」，不是缓存**：与上面那条相反 ——
  缓存只会让人**读到**旧版本，不会让**写入**被拒；且同一次 run 里其余包都正常处理。
  判据是发布者身份：`npm view <pkg>@<ver> _npmUser` 显示
  `GitHub Actions <npm-oidc-no-reply@github.com>` 才说明该包走过 CI，
  显示人名则是人工发的。实测 `dsh-stitch-designer` 1.0.0 由人工发布、从未走过 CI，
  于是 CI 首次发它时 `PUT` 被拒 —— 这是**当初漏配 trust**，不是 CDN。
  修法：让用户在该包设置页补配 trusted publisher，然后 `gh run rerun <id> --failed` 续跑。
- **换包一律先删再加，不要并存**：两个包若声明同一个 patch 行 `id`，全新启动即
  `duplicate loader entry id` 硬崩；运行中并存则只有先加载的那个在服务。
- **`pnpm/action-setup` 必须显式给 `version`**：本仓库没有 `packageManager` 字段，
  两者都缺时该 action 直接失败。
- **根测试用 `pnpm test`，不用 `pnpm -r run test`**：`-r` 只覆盖 workspace 子项目，
  会跳过根包自己的 `scripts/*.test.mjs`。
- **监听 waterfall 事件前先确认「有没有 peer 不调用 `next()`」，有就必须 `prepend: true`**：
  cordis 的 waterfall 里，监听器不调用 `next()` 就等于**截断**链条，注册在它后面的监听器
  **一次都不会执行**（不是拿到旧值，是完全不跑）。这类「决定者」在宿主里是常态：
  `fs-observation-policy` 的 `fs/write-intent` / `fs/edit-intent` 监听器
  （`(target, actor) => Promise.resolve().then(() => gate.writeIntent(target, actor))`）决定完直接返回，
  而插件行的加载顺序**不由你控制**（按 profile patch 的行序）。于是「逻辑写得对、测试也绿、
  真实部署里永不触发」——测试替身里没有那个 peer，所以永远复现不出来。
  `dsh-workspace-changes` 监听同一对事件时正是为此加的 `{ prepend: true }`。
  判据：注册时读一遍该事件的每个已知监听方，任一不调 `next()` 就 prepend；并补一条断言
  `listener.options?.prepend === true` 的测试，否则这条线没人守。
- **`inject` 是「必需」，只监听事件就不要 inject 那个服务**：`inject` 里的服务缺失时
  cordis **不调用该插件的 `apply`**，整个插件静默失效（实测：`inject: ['svc']` 且 svc 未提供
  → `apply` 从不执行；去掉 `inject` 即正常）。所以给插件加一条
  `ctx.on('some/event', ...)` 监听**不需要**把该事件的宿主服务写进 `inject` ——
  写进去只会让「宿主没装那个服务」从「少一个功能」升级成「插件整体消失」。
  宿主自己的监听方也这么写（`dsh-agent-preset-registry`、`dsh-session-reference` 都监听
  `system-prompt/assemble` 而不 inject `systemPrompt`）。
- **HTTP 路由处理器里读服务必须用 `ctx.get(name)`，不能用 `ctx.<name>`**：cordis 的 context 是
  Proxy，属性读只对**声明在 inject 里的服务**成立，否则抛 `cannot get property "<name>" without
  inject`。而路由处理器由宿主 HTTP 服务器在**另一个 fiber** 里调用，不是 `apply` 里 `ctx.inject`
  那个 fiber，于是同一个 `ctx` 在事件监听里能用、在路由里抛错。
  症状：`dsh-host-webserver` 把逃出的处理器异常兜成**空 body 的 400**（`lib/index.js:403`），
  前端只看 `response.ok`，于是任何非 2xx 都显示成「读取失败」——看不出是抛错。
  实测 2026-10-19 `dsh-worktree-session` 0.1.4：状态路由只在请求带 `sessionId` 时读
  `ctx.sessions`，所以不带参数的探测返回 200，界面永远失败。
  **测试替身必须与真实 context 一样严格**：该包的 `makeCtx` 曾直接在 stub 上挂
  `sessions: { get }` 属性，路由在测试里永远读得到会话，52 个用例全绿而浏览器必挂。
  stub 不应提供任何「真实 context 上拿不到」的属性。
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
- **MCP 服务端自己会说 streamable HTTP 时，不要给它套 stdio 代理**：`dsh-mcp-client` 的
  `stdio` 分支每个挂载点起一个 Node 子进程，而插件通常按 root agent 挂载 —— 进程数与
  会话数成正比，与真正不同的 peer 数无关。实测 `dsh-openviking` 按 25 个活跃 agent 挂载，
  得到 **26 个 `mcp-proxy` 进程 / 705 MB `phys_footprint`**，只为 5 个不同 peer 服务；
  单个空闲代理约 17 MB footprint，而它 10 小时只花 0.6–2.5 s CPU —— **成本全在内存**。
  改法是把 `transport` 换成 `streamable-http` 并直连 `<endpoint>/mcp`，进程归零。
  换传输时**协议头要留给 transport**（`content-type` / `accept` / `mcp-protocol-version` /
  `mcp-session-id` 由它按交换过程推导），只补它不拥有的认证、身份、actor peer 与 UA。
  这些头**必须复用运行时那条 header builder**（`buildOvHeaders`），否则工具面与 recall 路径
  会在 actor peer 上漂移，表现为工具查到别的项目、recall 查到本项目的割裂。
  另外，若代码里存在「直连不行」的既有注释，先实测再采信：本项目 README 曾记录
  「服务端返回空闲 SSE 会让 `tools/list` 永不返回」，而 SDK 2.2.0 上该机制已不成立
  （90 秒 23 轮 `tools/list` + `callTool` 零失败，独立 `GET /mcp` 仍挂 8 秒，但 SDK 只在
  `initialized` 得到 202 时才去开那条流）。
- **往侧边栏会话行塞图标会抹掉它的视觉缩进**：会话行与它所属的工作区行同处一个
  `groupSection`，两者的 `padding-inline-start` 都取自同一个 `--dsh-workspace-indent`，
  所以「会话看着比工作区缩进一级」**不是靠 padding 实现的**，而是靠行首那格固定 16px 的
  `span.slot`：空着看不见，于是第一眼的最左内容是文字（实测 x=40）；一旦那格有内容，
  第一眼的最左内容就变成图标（实测 x=20），与工作区行的图标对齐、看起来成了同一层级。
  实测：`sidebar.session.row.leading` 槽位常驻一个 16x16 图标后，工作树下的会话行与工作区行
  左边缘齐平。宿主在会话忙碌时会**抢占**这一格显示转圈/状态点（`showStatus`），此时插件图标
  不显示 —— 所以该症状只在会话空闲时出现，忙碌时表现为宿主自己的图标同样齐平。
  结论：想让会话行保持缩进，就不要在这一格常驻图标；要标识会话属性，改用行的其他位置。
  **可行位置已实测**：挂在那一格的 `::after` 上并给 `left:100%`（绝对定位，不改槽位内容），
  图标便落在槽位右侧、缩进仍由空着的槽位提供；标题再用 `margin-left` 让出图标宽度
  （**不要用 `padding-left`**——标题的 hover 走马灯按 padding 盒裁剪，padding 会让长标题
  的文字滑到图标底下，margin 才把裁剪边正好留在图标右缘）。

- **插件的 `<style>` 注入不能写成「已存在就跳过」**：客户端 HMR 替换的是插件 fiber，
  不会重新执行整段启动逻辑，于是「已存在就跳过」的守卫让新构建的 CSS 永远注不进页面，
  样式改动直到手动刷新才可见 —— 违反「改 client 源码后不刷新即见新 UI」的承诺。
  正确做法是每次激活都重写已有标签的 `textContent`（复用标签，不重复追加）。
  实测症状：新加的规则在页面样式表里 0 处命中，而测试全绿。

- **要替换宿主渲染的元素，只能用纯 CSS，换 DOM 节点会被 React 重建回去**：宿主渲染的元素都带
  `__reactFiber$*` / `__reactProps$*`，React 按自己的 fiber 调和，不认 DOM 里实际是谁。实测
  （2026-10-22，侧边栏 `svg[data-state='ongoing']`）：把 3 个转圈 `replaceChild` 成自制元素，
  起初成功；连点 6 次展开/收起后自制元素剩 0 个、宿主 SVG 又变回 3 个。判据：取
  `Object.keys(el)` 里以 `__reactFiber` 开头的键，非空即 React 拥有，任何 DOM 手术都只是临时的。
  可行做法是「藏掉宿主元素 + 在父级用伪元素重画」：`svg[data-state='ongoing']{display:none}` 配
  `span:has(> svg[data-state='ongoing'])::after{content:'';…}`，实测重渲染后 `display` 与伪元素
  `animationName` 都不变。伪元素**不能**直接挂在 SVG 上（SVG 元素不生成伪元素），所以必须用
  `:has()` 反向选父格 —— 那一格的类名是构建哈希、`data-state` 在里层，除 `:has()` 没有别的锚点。

- **要拦截宿主的 RPC 请求，只能在 head 注入里做，插件侧包 `globalThis.fetch` 永远无效**：
  RPC 传输层在**模块初始化时**就绑定了 `globalThis.fetch`，插件后加载，它的包装器看不到
  已经绑定好的那次调用。实测：插件侧包装器只捕获到 4 次无关的轮询请求，真正的
  `session/list` 原样通过。唯一赢下这个竞态的位置是 `webserver/index-inject` 钩子的
  `kind: 'script'` + `placement: 'head'`，它渲染进 `<head>`、排在所有应用脚本之前。
  排查时注意：核对注入是否生效要 grep **注入脚本里的实际字符串**（如 `const KEEP`），
  不是源码里的常量名（如 `SESSION_LIST_KEEP`）—— 按后者搜会得出「没注入」的错误结论。

- **优先改请求参数，而不是收下大响应再裁**：`session/page` 这类端点把预算作为参数接收
  （`maxMessages` / `turnWindow`），改小后重发让服务端只生成小页，请求与响应同时变小、
  宿主也少做功。改响应只能省带宽，宿主已经付过计算的代价。
  改请求体时**认不出的形状必须原样转发**（解析失败、缺 `payload.args.request`、
  字段类型不对、重编码抛错）：吞掉一个翻页请求会让用户完全无法回看历史，
  代价远大于一次大页。实测数据与预算曲线见
  `docs/research/2026-10-21-session-payload-reduction.md`。

- **首屏预算在出站帧里，`maxMessages` 却可能是死参数**（2026-10-25 修正了此前
  「首屏插件改不到」的错误结论）：首屏走 `session/follow` 流，页大小随 `open` 帧发出
  （`payload.args.request.maxMessages` / `.turnWindow`），包一层 `WebSocket.prototype.send`
  就能改。但 `paginate` 从最新往回扫，遇到 `turn/start` 时先判
  `count >= minMessages && turns >= minTurns` 才允许截断，遇到 message 才用
  `count >= maxMessages` 兜底 —— **当最近某个 Turn 的 message 数小于 `minMessages` 时，
  那个 Turn 边界永远不算数**，扫描会耗尽历史、`maxMessages` 一次都不触发。
  实测：一个 Turn 为 `[91, 11, 1]` 条 message 的会话，`120/50` 与 `500/50` 都是 6313 KB
  （完全没变），把 `minMessages` 降到 12 才变成 566 KB，拐点在 15→12 之间。
  所以「压了 `maxMessages` 却没变小」时，先数各 Turn 的 message 条数，别怀疑改写没生效。
  `assistantStream` 不能用来减负：宿主声明为必需 `const true`，传 `false` 直接被拒。

- **长会话「远程打不开」要在限速下才复现，判据是首帧是否到达**：局域网 6 MB 一两秒就传完，
  一切正常；慢链路（Tailscale/外网）上它决定会话能不能打开。症状链是
  「一直载入历史…→ socket 断开 →『重新连接中』→ 重连后列表未加载全显示『未命名』→
  恢复标题 → 再次打开 → 再次超时」的循环。用 CDP
  `Network.emulateNetworkConditions`（2 Mbit/s / 80 ms）复现，看**首帧有没有到达、
  socket 何时被关**：未修复时首帧 `null`、约 16 s 被以 1006 关闭。
  别用「首帧多大」当判据，也别在局域网下反复测 —— 测不出来。

- **裁响应字段前，先把该字段的每个读取点都找全，并确认「删掉」比「置空」安全**：
  删字段是**破坏性**的，只要有一个读取点没判空，整条数据流就会断。实测 2026-10-25：
  把 `assistant/message` 的 `data.stream` 删掉后，所有长会话变成空白屏、「加载更早」也
  点了没反应，控制台只有一句
  `[session-controller] event feed subscriber failed: TypeError: stream is not iterable`。
  成因是 `assistantStreamFirstTokenTime`（`dsh-client-ui-trajectory`）直接
  `for (const record of stream)`，**没有任何判空**；而 chat 侧那两处读取都有
  `?? state.sample` / `event.data.usage ??` 短路保护 —— 只查 chat 会得出「安全」的错误结论。
  判据：`grep -rn "data\.<字段>" --include=client.js` 把**所有** bundle 的读取点列出来
  （当时 4 处：chat 2、trajectory 1、experimental-session-inspector 1），逐个看有没有守卫。
  **更稳的默认做法是置空而不是删除**：`data.stream = []` 让所有读取方都安全
  （`for...of []` 零次迭代、`lastAssistantStreamChunk` 返回 `undefined`），体积收益不变
  （该字段占首屏 1685 KB）。同帧里 `assistant/attempt` 的 `stream` 只有 6 KB，不必动它。

- **判断「某字段是否可裁」不能只按体积，要按「渲染路径是否真的走不到」**：
  同一个字段，一个视图读、另一个视图不读。若该视图被主题隐藏（如本仓库隐藏了轨迹面板），
  裁掉看似安全，但**订阅者异常是全局面**：它不属于某个视图，一旦抛出就中断整个事件流，
  被隐藏的视图反而成了整屏空白的根因。

- **本地验证脚手架发布后要清三处，漏一处就还在读本地**：`pnpm-workspace.yaml` 的
  `overrides:` 块、`package.json` 里聚合包的 `file:` 指针、以及重装后的 `pnpm-lock.yaml`。
  判据：`grep "<仓库绝对路径>" pnpm-lock.yaml` 无输出，且包目录是真目录（非软链）、
  版本等于线上版本。只删 overrides 而不改 `package.json` 的 `file:`，聚合包仍指向本地目录。

- **`dsh plugin add` 还会往 `dsh.profile.bundles` 追加一行 —— 装聚合包时那是第 4 处要清的地方**：
  `dsh plugin --profile <p> add file:<本地包>` 同时写 `dependencies` 与 `bundles`，而聚合包的 patch
  已经带着该子插件的挂载行，于是同一 `id` 有了两个来源（机制见「换包一律先删再加，不要并存」）。
  实测 2026-10-18：装 `file:…/dsh-better-reasoning-effort` 后 `bundles` 多出该项；摘掉它、只留
  `dependencies` 里的 `file:` 指针后安装与加载都正常。**未验证**不摘是否会硬崩——本次在重启前就摘了。

- **插件里漏掉的 `'error'` 监听会杀死整个宿主进程，不是一个功能坏掉**：`EventEmitter` 对
  `error` 事件没有监听者时直接抛出，而宿主把它兜成 `dsh: fatal uncaught exception` 后退出。
  于是「连不上某台机器」这种日常失败会变成用户要重启 DSH。**`once('error')` 是最危险的写法**：
  一次失败可能连发多个 `error`（实测 `ssh2` 对一条被对端 `destroy` 的连接发两个，第二个是
  `Connection lost before handshake`），第一个被 `once` 消费掉，第二个无人接管即崩。
  一律用常驻的 `on('error')`，并在回调里自己保证幂等。判据：连一个「接受后立刻 `socket.destroy()`」
  的本地 `net` 服务器，装 `process.on('uncaughtException')` 收集器，断言它为空——这条测试在改回
  `once` 后必须转红，否则它没在守这条线。

- **设置 UI 保存会重写整个 `<profile>/cordis.patch.yml` 行，把该行里的注释全部丢掉**：
  官方设置表单按行重新序列化 config，不是就地改一个值。实测 2026-10-18（pi-ai 的
  `maxRequestImageBytes` 经插件卡片保存一次）：全文注释 134 → 127 行，缺的正是 `llm-pi-ai`
  行内那段理由注释；其他行的注释块原样保留，被改的键还从 profile 中部挪到了 profile 块末尾。
  所以**理由不要写在可被设置 UI 编辑的行里**——那里只放值，因果写进代码注释、README 或记忆；
  写进 patch 行的注释是一次性消耗品。

- **同一个 `Menu` 原语渲染出的两个座位，只能靠 `[data-slot]` 区分，形状认不出来**：输入框里
  `conversation.input.left`（工作树选择）与 `conversation.input.model`（模型选择）都用
  `Primitives.Menu`，都渲染成 `div[role="menu"]`、都紧跟在 `button[aria-haspopup="menu"]` 之后。
  于是「按形状找菜单」（`previousElementSibling` 是不是那个按钮）在另一个座位打开时会**命中别人的
  菜单**——实测 2026-10-19 `dsh-better-reasoning-effort`：手机点分支按钮，弹出的分支列表里混进了
  推理等级滑块和模型行。形状相同不是巧合，是同一个原语；判据只能是宿主的座位包装：
  内核给每个座位包 `<div data-slot="<slot>" style="display:contents">`，用
  `element.closest('[data-slot]')` 取座位名即可。注意 `display:contents` 让该包装不产生盒，
  但它**在 DOM 树里**，所以 `closest` 有效、`getBoundingClientRect` 无效。
  模型座位的弹层会 portal 到 `body`（此时没有 `[data-slot]` 祖先），所以这条要写成
  「有座位就按座位判，没座位才退回形状」，不能反过来。

- **槽位渲染崩溃在页面上是「空的」，原因只在控制台**：`plugins.row.config` 这类槽位的渲染
  抛错时，宿主把它换成 `<div data-slot-error="<slot>">`（空元素，无文案），页面表现为
  「插件标题在、下面什么都没有」，看起来像没配字段而不是报错。诊断只能去浏览器控制台取
  `slot entry crashed in '<slot>':` 后的原始 Error，别对着 DOM 猜。实测两个成因：
  ① 迁移后消费端仍在读已删除的字段，抛 `settings card has no field <x>`；
  ② `useSyncExternalStore` 的 `getSnapshot()` 每次返回新对象、或 handle 在渲染体内新建，
  抛 React error #185（最大更新深度）——**引用不稳定即无限重渲染**。
  这两个都不是「没渲染出内容」，而是渲染失败，加字段或改样式永远修不好。

> **`npm trust list <pkg>` 无法免交互核验**：它要求 OTP（`npm error code EOTP`），
> Agent 跑不了。所以「trust 是否配好」不能靠它判定 —— 真正的判据是**看该包历史版本的发布者身份**：
> `npm view <pkg>@<ver> _npmUser` 显示 `GitHub Actions <npm-oidc-no-reply@github.com>` 即已走过 CI，
> 显示人名则只被人工发过。新包在人工首发+配 trust 后，判据只能是**下一次 CI 发布是否成功**。

## ➖ 移除子插件

与「新增」对称，但**没有任何脚本会替你校验**：下列几处必须同时改，漏掉任何一处的后果都是**静默**的
（不报错、看似成功）。

| 改动 | 漏掉的后果 |
|---|---|
| 删 `packages/<name>/` 整目录 | — |
| 从 `packages/all/aggregate.yml` 的 `patchFrom` **和** `deps` 各摘一行 | 发出的包引用一个不存在的包，或凭空多出一行（理由见「3. 在 `packages/all/aggregate.yml` 登记」） |
| 手工改 `packages/all/package.json` 的 `version` | CI 判重跳过，**看似发布成功、实则没发**（见「📤 发布」） |
| 重跑 `node scripts/aggregate.mjs` | 生成物与清单 drift，`--check` 报错 |

然后按「✅ 验证命令」跑四条门禁，按「📤 发布」走 CI/CD。

**本机也要清**：`~/.dsh/profiles/<p>/cordis.patch.yml` 里该插件的行会变成指向不存在包的悬空行，
须手工摘除；`$DSH_HOME` 下由该插件自己写的运行状态文件，等它停止运行后一并删除
（先确认宿主已不再持有这些文件的句柄，否则删了会被重新写回）。

> 删包后跑测试若有**与本次改动无关**的包失败，先读「✅ 验证命令」里那条并行配对的判据，
> 不要当成自己改坏了。

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

> **核对「宿主下发的 client bundle 是否已是新构建」，URL 里的 `??` 不能省，省了恒 404**：
> 页面 HTML 里该插件自带一条预载条目 `/plugins/??<pkg>/client.js&rev=<rev>`（`??` 是批次分隔符；
> 另有几条把整批包名逗号相连的条目，取单包那条即可，它带自己的 `rev`）。把这条 URL 原样
> `curl` 下来 `grep` 新逻辑的字符串才是证据，`rev` 变化即产物已重新发布；把 `??` 去掉变成
> `/plugins/<pkg>/client.js` 一律 404，别据此判定「没生效」。实测 2026-10-24：
> 去 `??` 404，带 `??` 200 / 38284 B 且含新代码。

> **重启后核对「新代码是否真的进了提示词」，要读会话日志里最后一条 `request/header`。**
> 同一会话里每条请求都留一份，第一条是**重启前**的旧快照。实测按第一条判定，得出「改动没生效」
> 的错误结论，实际最新那条已是新工具清单（133 工具/220,287 字符 → 77 工具/106,064 字符）。
> 工具清单在 **`data.header.tools`**，不在 `data.tools` 也不在 `data.request.tools` ——
> 按后两个路径取会得到 0 条，看起来像「插件没挂上」，实际是路径写错。判据是
> `data.header.tools[0]` 的键为 `name,description,parameters`。

> **该命令靠 `lsof` 找端口 owner，而 `lsof` 在 `/usr/sbin`**：调用方 PATH 缺 `/usr/sbin` 时
> `port_pid` 取空，输出 `owner pid none` 与 `==NOT LISTENING==`——**服务其实是好的**。
> 实测同一进程同一秒：PATH 无 `/usr/sbin` 判 NOT LISTENING，补上即 `Verdict: OK`。
> 见到 NOT LISTENING 先用 `lsof -nP -iTCP:10000 -sTCP:LISTEN`（绝对路径）复核，别直接重启。

> **同一端口上可能有两个监听者，`lsof -t | head -1` 会抓错**：宿主 0.2.1 起拒绝通配地址
> （`host "0.0.0.0" is an unspecified (wildcard) address`），一个监听无法同时覆盖回环与局域网，
> 于是回环靠一个独立的转发进程补齐。此时 `lsof` 返回两行，谁先返回不确定；`port_pid` 若只取
> 第一行，就会把转发进程当成端口 owner，输出 `==SPLIT== job pid != port owner` 并提示重启 ——
> **重启修不好，因为作业本身是好的**。修法是让 `port_pid` 优先在 `lsof` 结果里找作业自己的 pid，
> 找不到才退回第一行。判据：`lsof` 有两行、但其中一行等于 `launchctl print` 里的作业 pid 时，
> 服务健康。

> **监听地址是推导出来的，三处共用同一套规则，别写回字面量**：`~/.dsh/bin/local-address.mjs`
> 问默认路由走哪张网卡、取该网卡非内部 IPv4、问不到再枚举、兜底 `127.0.0.1`；`dsh-web` 用它定
> `HOST`（`DSH_WEB_HOST` 仍可覆盖），loopback 转发器接受字面量 `auto` 走同一函数（launchd 的
> plist 不能做命令替换）。profile 里 `webserver.host` 那行**故意不 import 它**——那行要随
> config-manager 同步到别的设备，而那些设备没有 `~/.dsh/bin`，所以那边留了一份等价的 `!!js`
> 内联副本。看到「两处重复的推导逻辑」不要合并，那是同步边界，不是冗余。

> **`~/.dsh/dsh-web.err` 是跨启动追加的，禁用行必须对得上进程启动时间才算数**：兼容门禁打的是
> `disabling profile plugin row "<row>": Plugin <pkg>@<ver> is incompatible with dsh <ver>`，里面的
> `<ver>` 是**当时**装的版本。升级插件后旧行仍在文件里，直接 `grep` 会得出「还在被禁用」的错误
> 结论（实测：8 条禁用行全部指向 `dsh-openviking@0.4.8` / `dsh-loop-guard@1.1.7` /
> `dsh-reasoning-strip@0.1.0`，而当次启动装的是 0.4.9 / 1.1.8 / 0.1.1，该次启动后 0 条）。
> 判据：先用 `ps -o lstart= -p <作业 pid>` 定出本次启动的时刻，只认那之后的行；再直接问宿主
> `evaluatePluginCompatibility(manifest, {}, <当前宿主版本>)`（`@deepseek-ai/dsh-app-boot` 导出），
> 它才是门禁本身。

> **新增启动期自动执行路径时，必须把路由层同名操作的全部护栏抄一遍**：路由层的 destructive 操作
> 走 `withMutationGate(op, …)` 统一封装（全局互斥锁 + SAFE MODE 谓词 + journal + snapshot 绑定），
> 而启动期路径是另写的一段代码，**不继承**这些封装。实测 2026-10-24 `dsh-config-manager` 的
> 启动期自动同步：初版直接 `makeSyncEngine(cfg).pullAndApply({})`，不取锁、不查
> `host.safeModeIsBlocked`、不传 `snapshotBinding` —— 于是「上次 destructive 操作崩溃残留、
> 待显式恢复」时它仍会改写配置与插件，**把可恢复状态变成不可恢复**；同时与另一个持锁进程
> 并发写同一批文件。判据：新路径落盘前，先列出同名路由的 handler 里调用了哪些封装，
> 逐条确认启动路径也有等价调用。

> **`apply` 返回 Promise 是让宿主「等它」的唯一办法，fire-and-forget 不会被执行完**：
> Cordis 的 `_execute` 对 apply 返回的 thenable 会 `return effect.then(safeCollect)`，
> 由 `loader.await()`（等每个 entry 的 fiber inertia）等到结束；`boot()` 的顺序是
> `mountRootInclude` → `loader.await()` → `auditStartupEntries`，所以启动期写入的配置
> 在启动判定之前就已就位。实测对照：返回 Promise 得到
> `apply-called → async-work-done → inertia-settled`；改成不 await 的版本得到
> `apply-called → inertia-settled → async-work-done-BUT-NOT-AWAITED`。
> 写盘触发的 HMR 重载不会打断启动：`runReload` 先 `await applicationReady`，该 promise
> 在 `boot()` 返回之后才 commit。

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

### 首发交接：必须把两条命令原样给用户

新插件做完、门禁全绿之后，**Agent 的交付不算完成**，直到它把下面两条命令按实际包名填好、
逐字交给用户执行。不要只说「请你人工发布一次」——用户需要能直接粘贴的命令：

```sh
cd packages/<name> && npm publish --access public
npm trust github @logictan/<name> --file publish.yml --repo dale0525/dsh-plugins --allow-publish
```

交付消息里要同时给出：① 这两条命令；② 一句「执行完告诉我，我再升聚合包版本走 CI」；
③ 该包的版本号，因为用户要确认发出去的是哪一个。缺任何一项，用户就得回头问。

> `--allow-publish` 不可省：2026-09-03 之后创建的 trust 配置默认只允许 `npm stage publish`，
> 少了这个 flag，CI 首次直接发布会被拒（`PUT ... E404`）。
>
> **两条命令的顺序也不能反**：trusted publisher 只能配在已存在的包上，
> 先 `npm trust` 会因包不存在而失败。

用户确认 trust 配好之后，Agent 才继续：升 `packages/all` 版本 → 聚合包走 CI/CD。
在此之前聚合包不能发——它会把 `^<子包版本>` 写成一个 registry 上还不存在的版本，
`pnpm install --frozen-lockfile` 在 CI 第一步就解析失败。

### 更新已发布包：走 CI/CD，**禁止手动发布**

**规则**：本地测试通过后，一律由 CI/CD 发布，**不跑 `npm publish`**。CI 的 publish 步骤带
`npm view "$name@$version"` 判重，已在线版本自动跳过，所以整仓发布是幂等的、可放心重跑。

> **失败的 run 可能已经发出去一部分**：发布按依赖顺序逐个包进行，任何一个包失败都会让整条
> run 红掉，但它**前面的包已经上线了**。实测 v0.5.73：子插件 `0.5.3` 发布成功、聚合包在
> `npm error code IDENTITY_TOKEN_READ_ERROR`（取 OIDC 身份令牌失败，瞬时故障）上失败，
> run 整体 success=**false**。此时**先查线上实际版本再决定动作**——
> `gh run rerun <id> --failed` 即可续跑，判重会跳过已发布的包；
> 看到红 run 就重新升版，会白白多发一个版本。

> **`gh run rerun --failed` 对「作业被超时取消」无效，改用 `gh workflow run` 续跑**：取消的 run
> 没有失败步骤，`--failed` 会直接报没有可重跑的作业。实测 v0.5.90：整个 `publish` 作业撞
> `timeout-minutes: 30` 被 `cancelled`，17 个包里只发完 7 个；`gh workflow run publish.yml
> --ref main -f dry_run=false` 起一条新 run，判重跳过已发布的 7 个、从第 8 个继续。
> 判据是 run 的 `conclusion`：`failure` 用 `--failed`，`cancelled` 用 `workflow run`。

> **`+ <pkg>@<ver>` 不是「已上线」，只是 npm 受理了请求**：`npm publish` 输出 `+ @scope/pkg@1.2.3`
> 之后，CI 会轮询 registry 直到该版本可解析，超时就以
> `@scope/pkg@1.2.3 is still not resolvable after 15 minutes` 失败，并提示
> `Usually a publish held for approval (staged)`。**这是已发布包也会撞上的情况**，与上文
> 「新包不能 staged」是两件事：staged publishing 对新包是「不支持」，对已存在的包是
> 「默认开着、需人工批准」。实测 v0.5.99：`dsh-better-reasoning-effort@0.5.7` 正常上线
> （`_npmUser` 为 GitHub Actions），而 `dsh-openviking@0.4.10` 停在 staged，聚合包因依赖
> `^0.4.10` 解析不到而整条 run 失败。
>
> **判据只能是 registry，不是 CI 日志**：`npm view <pkg> version` 与
> `curl -H 'Cache-Control: no-cache' https://registry.npmjs.org/<urlencoded-pkg>?t=<ts>`
> 里查 `versions` / `dist-tags`。`npm view <pkg>@<ver>` 报 404 即确认未上线。

> **staged 记录可能是「孤儿」：`npm stage list` 为空**≠**没有 staged 版本，此时只能跳号。**
> 别把「列表为空」当成「不是 staged」去另找原因。判据是**发布时**的报错文本，不是列表：
> ```
> npm error code E409
> 409 Conflict - PUT https://registry.npmjs.org/<pkg>
> Cannot publish over previously staged version "<ver>".
> ```
> 这句话证明 registry 侧**确实存在**该版本的 staged 记录。而实测它同时满足：
> `npm stage list <pkg>` 报 `No staged versions`、`GET /-/stage` 三页翻完 `total: 0`
> （`--json` 也是 `[]`）—— **记录存在却不出现在任何队列里，于是拿不到 stageId**：
> `DELETE /-/stage/<pkg>@<ver>` 报 `"stageId" must be a valid GUID`，没有 id 可删；
> 页面上也没有条目可批准。`gh workflow run` 续跑会撞**同一个 E409**（已实测），
> 所以它不是瞬时故障、重跑无意义。**唯一出路是跳过这个版本号**（`0.4.10` → `0.4.11`）。
> 代价为零：该版本从未落库，没有客户端解析过它。
>
> **不要因为撞到 staged 就转去手动 `npm publish`**：本规则开头「一律走 CI/CD、不跑
> `npm publish`」在这里同样成立。手动发要 OTP（本机认证走浏览器轮询，实测三次均以
> `E404 GET /-/v1/done?authId=` 收场），且**撞的是同一个 E409**——绕远路而已。
> 实测 v0.5.99：我在这一步误判成「registry 丢了版本、须手动重发」，让用户去终端操作，
> 白白耗时；正确动作是直接改版本号重走 CI（v0.5.100 一次通过）。

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

> **升版后必须重生成 `pnpm-lock.yaml`，否则 CI 在装依赖那步就红**：CI 用
> `pnpm install --frozen-lockfile`，而 `pnpm-lock.yaml` 的 `importers` 里逐条记着每个 workspace
> 依赖的 `specifier`。`node scripts/aggregate.mjs` 只改 `packages/all/package.json` 的
> `dependencies`，**不动锁文件**；漏跑 `pnpm install --lockfile-only` 时，锁文件仍是
> `^<旧版本>` 而清单已是 `^<新版本>`，发布 run 在 `Setup pnpm` 之后的安装步骤直接失败，
> 一个包都发不出去。实测 2026-10-19 升 `dsh-worktree-session` 0.1.7→0.1.8 时复现：
> 把锁文件改回 `^0.1.7` 跑 `pnpm install --frozen-lockfile`，报
> `specifiers in the lockfile don't match specifiers in package.json` 并点名
> `in importers["packages/all"]: @logictan/dsh-worktree-session (lockfile: ^0.1.7, manifest: ^0.1.8)`。
> 顺序固定为：改两个 `version` → `node scripts/aggregate.mjs` → `pnpm install --lockfile-only` → 提交，
> 锁文件那一行和两个 `package.json` 进同一个 release 提交。

> **一个包的版本号不止写在 `package.json` 里**：`dsh-openviking` 在 `config.mjs` 有 `PLUGIN_VERSION`
> 常量，且 `bundle.test.mjs` 同时钉住它与包自带 `package-lock.json` 的两处 `version`。
> 只改 `package.json` 会让该包测试红，而**本地单包测试若在升版前跑过就发现不了**——
> 实测 v0.5.84 因此被 CI 的 Test 步骤拦下。升版前先 `grep -rn '"<旧版本>"' packages/<pkg>/`
> 找出所有落点，改完再跑一次该包测试。

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

> **`pnpm test` 在本地会因为「完整克隆」而红，而 CI 的浅克隆反而绿**：`scripts/sync-upstream.test.mjs`
> 的 `--preflight 对已同步的目标如实报告` 用例先判输出里有没有「浅克隆」，有就只要求
> `fetch --unshallow`，没有才要求 `/已同步/`。CI 的 checkout 默认 `fetch-depth: 1`，走的是浅克隆分支；
> 本地是完整克隆，于是真的去算共同祖先，一旦某个 fork 落后上游就报「落后：共同祖先 …」，
> 断言失败。**这不是回归**：判据是 `node scripts/sync-upstream.mjs --preflight <id>` 的输出
> ——状态是「落后」即属预期，只有它报「已同步」而测试仍红才是真问题。让该 fork 追上上游
> 或把本地克隆变浅才能消掉这条红，两者都不该为「让测试绿」而做。

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

> **偶发失败的归属只能靠「改动前后同次数对比」判定，不能靠单次复跑**：一条测试时红时绿，
> 跑一次通过说明不了任何事——它本来就有失败概率。判据是把改动 stash 掉，在干净 HEAD 上以**同样的次数**
> 重复跑同一文件，比较两边的失败次数：相等即既有问题（本次实测 `dsh-ssh` 的
> `recordHostKey` 写文件与断言之间的竞态、`utils.parseKey(...).getPublicSSH` 的偶发失败，
> 改动前后各 12 次/20 次，失败次数分别为 3/3、1/1）。次数不同才可能是回归，再去查机制。
> 直接读代码猜「我是不是引入了竞态」不可靠：这两处的写盘本来就是 fire-and-forget，
> 竞态在改动前就存在，只看代码会误判成自己刚写坏。

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

> **不要用哈希比对「本机构建产物」与「安装下来的产物」**：`dsh-config-manager` 与 `dsh-imagegen`
> 的 client 半边用 lightningcss 编译 CSS Modules，而它的类名哈希由**文件绝对路径**派生
> （`tsdown.config.ts` 把 `resolve(base, source)` 当 `filename` 传给 `transform`）—— 同一份 CSS
> 在 CI（`/home/runner/work/...`）与本机（如 `/Volumes/LogicExt/...`）构建出的 `lib/client.js`
> 必然不同。实测同一份 `config-manager.module.css`：本机得到 `Wcetya_*`，CI 得到 `A55DgG_*`；
> 两侧产物屏蔽掉类名哈希与内嵌路径后**逐字节相同**。所以「发布后本地安装」核验时看到
> `lib/client.js` 哈希不一致，是构建环境的必然差异，**不是装错版本**；要逐字节比对就先抹掉
> 类名哈希与路径，或改比 `lib/index.js`（宿主半边由 `tsc` 产出，不含哈希）。

## 🧭 边界

- **同步渠道必须指向独立的私有仓库**，与本仓库物理分离：本仓库是 public，fork 的插件源码公开无妨，但同步快照携带明文凭据。
- 同步通道是明文语义（私有通道自用）：不加密、不脱敏、不做 diff/合并，勾选即同步。`manifest.security.containsSecrets` 必须按实际内容**如实标注**。

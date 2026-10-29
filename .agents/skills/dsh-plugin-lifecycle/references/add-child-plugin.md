# 新增子插件：五步与验收

只在真的要把一个新包加进本仓库时读。

把一个可发布的 DSH 插件加进本仓库，并让它随聚合包一起被安装。**顺序不可颠倒**：先收养（有上游时）→ 放进 `packages/` → 登记 → 生成校验 → 首发。

## 安装链路（改动前先理解）

```
dsh plugin --profile <p> add @logictan/dsh-plugins-all   # 用户安装的入口（聚合包）
  └─ dsh.bundle.patch → cordis.patch.yml                 # 聚合 patch，逐字拼接各子插件的 patch
       └─ - id: <row-id>  name: '@scope/pkg'             # 子插件行；name 从 profile 根解析
            └─ dependencies: '@scope/pkg': ^x.y.z        # 子插件作为聚合包的普通依赖装进 profile
```

判据（`dsh-plugin-manager` 的 `bundleManifest()`）：manifest 的 `dsh.bundle.patch` 为 `undefined` 时该包不是 bundle，CLI 只当普通依赖并告警
（`declares no dsh.bundle — installed as a plain dependency, not a profile layer`）。「是不是 bundle」由这个字段决定，不看包名。

## 1. 有上游就先收养为 `git subtree`

分类判据与「未收养」的后果见本技能末尾「fork 形态判据」，不重复。自制插件跳过本节。

收养在**目录还不存在**时做最省事（一个命令）：

```bash
git subtree add --prefix=packages/<name> <上游仓库 URL> <基线 tag>
```

收养后建 `packages/<name>/upstream.json`（声明 `id` / `url` / `prefix`）。
**不要**另建上游总表：`node scripts/sync-upstream.mjs --list` 从各 `upstream.json` 汇总，它就是唯一登记处。

## 2. 放进 `packages/<name>/`

子插件自带 `cordis.patch.yml`，它决定该插件在 profile 里的那一行（`id` / `name` / `config`）。
聚合 patch 由 `scripts/aggregate.mjs` **逐字拼接、不改写行** —— 改行名改子插件自己的 patch 文件。

两条硬约束：

| 约束 | 违反后果 | 谁在检查 |
|---|---|---|
| patch 行 `id` 全仓库唯一，且等于该插件宿主半边的 `export const name` | 重复即硬崩：`duplicate loader entry id: <id>`（`cordis-plugin-loader`） | 唯一性：`pnpm run check:host`；名称相等：**无**，人工核对 |
| 客户端产物 entry `id` 等于包名 | `window.__ModuleLoader__.load({ id })` 与包名不符 → 浏览器半边加载失败 | 无 |

## 3. 在 `packages/all/aggregate.yml` 登记

```yaml
patchFrom:
  - ../<name>      # 该子插件的 patch 行会被拼进聚合 patch
deps:
  - ../<name>      # 该子插件以 ^<version> 写进聚合包 dependencies
```

两节是两件事：`patchFrom` 决定 profile 里出现哪些行，`deps` 决定装哪些包。
**两节都要登记**：只写 `patchFrom` 会发出一个「包在新 profile 里根本不存在」的行；只写 `deps`
则行不会出现在 patch 里。

## 4. 生成并校验

```bash
node scripts/aggregate.mjs           # 生成 packages/all/cordis.patch.yml 与 package.json
node scripts/aggregate.mjs --check   # 校验生成物与清单一致（发版时 CI 才跑）
```

## 5. 首发：人工 `npm publish` + 配 trust（**由用户执行**）

新包不能走 CI 首发，必须先由用户人工发一次并配好 trusted publisher——**顺序、命令与理由见 `dsh-plugin-release` 技能**，
那里是发布规则的唯一真源，本节不重复。

**做完这一节不等于交付完成**：还要按 `dsh-plugin-release` 技能「首发交接」把两条命令按实际包名填好交给用户。
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

## 验收

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

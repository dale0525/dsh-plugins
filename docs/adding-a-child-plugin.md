# 新增子插件

把一个可发布的 DSH 插件加进本仓库，并让它随聚合包一起被安装。
发布机制（OIDC、顺序推导、trusted publisher）见 `../AGENTS.md`，本文件不重复。

## 安装链路（改动前先理解）

```
dsh plugin add @logictan/dsh-plugins-all        # 用户安装的入口（聚合包）
  └─ dsh.bundle.patch → cordis.patch.yml        # 聚合 patch，逐字拼接各子插件的 patch
       └─ - id: <row-id>  name: '@scope/pkg'    # 子插件行；name 从 profile 根解析
            └─ dependencies: '@scope/pkg': ^x.y.z   # 子插件作为聚合包的普通依赖装进 profile
```

判据（`dsh-plugin-manager` 的 `bundleManifest()`）：manifest 的 `dsh.bundle.patch` 为
`undefined` 时该包不是 bundle，CLI 只当普通依赖并告警
（`declares no dsh.bundle — installed as a plain dependency, not a profile layer`）。
「是不是 bundle」由这个字段决定，不看包名。

## 步骤

### 1. 放进 `packages/<name>/`

子插件自带 `cordis.patch.yml`，它决定该插件在 profile 里的那一行（`id` / `name` / `config`）。
聚合 patch 由 `scripts/aggregate.mjs` **逐字拼接、不改写行** —— 改行名改子插件自己的 patch 文件。

两条硬约束：

| 约束 | 违反后果 | 谁在检查 |
|---|---|---|
| patch 行 `id` 全仓库唯一，且等于该插件宿主半边的 `export const name` | 重复即硬崩：`duplicate loader entry id: <id>`（`cordis-plugin-loader`） | **无人自动检查**，须人工核对 |
| 客户端产物 entry `id` 等于包名 | `window.__ModuleLoader__.load({ id })` 与包名不符 → 浏览器半边加载失败 | 无 |

> `aggregate.mjs` 只校验 `deps` 的重复包名，**不校验** patch 行 `id` 的唯一性。
> 新子插件的行 `id` 撞上已有插件时，`--check` 仍会通过，故障要到宿主启动才暴露。

### 2. 在 `packages/all/aggregate.yml` 登记

```yaml
patchFrom:
  - ../<name>      # 该子插件的 patch 行会被拼进聚合 patch
deps:
  - ../<name>      # 该子插件以 ^<version> 写进聚合包 dependencies
```

两节是两件事：`patchFrom` 决定 profile 里出现哪些行，`deps` 决定装哪些包。只登记其一即失效。

### 3. 生成并校验

```bash
node scripts/aggregate.mjs           # 生成 packages/all/cordis.patch.yml 与 package.json
node scripts/aggregate.mjs --check   # 校验生成物与清单一致（CI 会跑）
```

### 4. 首发走人工，之后交给 CI

新包**不能**交给 CI 首发（缘由见 `../AGENTS.md` 发布节），顺序固定为：

```bash
cd packages/<name> && npm publish --access public    # 人工首发
npm trust github <pkg> --file publish.yml --repo dale0525/dsh-plugins --allow-publish
git tag v<x.y.z> && git push origin v<x.y.z>         # 之后交给 CI
```

发布顺序由 `scripts/publish.mjs` 从各包 `dependencies` 边拓扑推导，新增包**无需改脚本**；
`npm run publish:plan` 预览（子插件必然排在聚合包之前）。

## 验收

| 检查 | 判据 |
|---|---|
| 聚合生成物与清单一致 | `node scripts/aggregate.mjs --check` 无 drift |
| patch 行 `id` 未撞车 | 人工比对全仓库 `cordis.patch.yml` 的行 `id`（无自动检查） |
| 发布顺序正确 | `npm run publish:plan` 中该子插件在聚合包之前 |
| 从 registry 全新安装 | 干净 `DSH_HOME` 下 `dsh plugin --profile <p> add @logictan/dsh-plugins-all@latest`，依赖链带出该子插件 |
| 客户端产物可加载 | `lib/client.js` 按 loader 协议注册 1 次，注册 `id` 等于包名 |
| profile 内该行可解析 | patch 行的 `name` 从 profile 根可解析出该子插件 |

## 雷区

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

# dsh-plugins

DSH 插件 monorepo：一次安装装上全部插件。

## 安装

```sh
dsh plugin --profile web add @logictan/dsh-plugins-all@latest
```

被安装的入口是**聚合包** `@logictan/dsh-plugins-all`：它的 `dsh.bundle.patch` 指向自己的
`cordis.patch.yml`，该 patch 由各子插件自己的 patch 逐字拼接而成，子插件再由它的
`dependencies` 带进 profile。

根包 `dsh-plugins` 是工作区壳（`private: true`，**不发布**）：它同样声明 `dsh.bundle.patch`
指向 `packages/all/cordis.patch.yml`，但仓库内开发用。注意 npm 上已存在一个**无关的**
同名包 `dsh-plugins`（另一个作者），`private: true` 保证本仓库的根包不会与它冲突。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `packages/all/` | 聚合载体 `@logictan/dsh-plugins-all`；`aggregate.yml` 手写，`cordis.patch.yml` 与 `package.json` 是生成物 |
| `packages/dsh-config-manager/` | 配置远程同步插件（`@logictan/dsh-config-manager`，git subtree fork 自上游 v0.1.60） |
| `scripts/aggregate.mjs` | 由 `aggregate.yml` 生成聚合 patch 与 dependencies |
| `scripts/publish.mjs` | 按依赖边推导发布顺序（子插件 → 聚合包）；`npm run publish:plan` 预览 |
| `scripts/sync-upstream.mjs` | 按 `sync-policy.json` 把上游改动合进来（只开 PR） |
| `packages/dsh-config-manager/scripts/dev-watch.mjs` | 改源码 → 自动重建产物（客户端半边不刷新即生效） |
| `sync-policy.json` | 上游同步的三类清单：`owned` / `deleted` / `upstream` |
| `docs/adding-a-child-plugin.md` | 新增子插件的完整步骤、验收与雷区 |

## 开发

```bash
pnpm install
node scripts/aggregate.mjs --check     # 校验生成物与清单一致
node scripts/aggregate.mjs             # 重新生成
```

改子插件的 patch 行：编辑该子包自己的 `cordis.patch.yml`，再跑 `node scripts/aggregate.mjs`。
新增一个子插件见 `docs/adding-a-child-plugin.md`。

## 发布

推 `v*` tag 触发 `.github/workflows/publish.yml`，认证走 **trusted publishing (OIDC)**，
不存任何长期 npm token。手动预览发布计划：

```bash
npm run publish:plan          # dir<TAB>name<TAB>version，顺序即发布顺序
```

**顺序由依赖边推导**，不写死包名：子插件必须先上线，聚合包才能解析到它的依赖版本。
新增子插件/聚合包时无需改脚本，但**每个新包都要在 npmjs.com 配一次 trusted publisher**
（`npm trust github <pkg> --file publish.yml --repo dale0525/dsh-plugins --allow-publish`）。

> **首次发布必须人工**：trusted publisher 配在**已存在包**的设置页上，staged publishing
> 也明确排除全新包（"you cannot stage a brand-new package"）。所以新包要先人工
> `npm publish --access public` 一次，再配 OIDC，之后才交给 CI。

## 生效方式（改动要不要重启）

| 改动 | 需要重启吗 |
|---|---|
| `cordis.patch.yml` / `settings.yaml` | 不需要，宿主自行热重载 |
| 插件客户端产物（`lib/client.js`） | 不需要，跑 `dev:watch` 后浏览器原位替换 |
| 插件包代码同版本覆盖安装 | **需要** |
| 插件宿主半边源码 | **需要**（默认关闭 module watch） |

细节与实测依据见 `AGENTS.md`。

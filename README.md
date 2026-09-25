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
| `packages/<pkg>/` | 各个子插件。有上游的走 `git subtree` fork，自制的直接放这里——判据见 `AGENTS.md` |
| `packages/<pkg>/upstream.json` | 仅 fork 有：该包的上游身份（`id` / `url` / `prefix`） |
| `scripts/aggregate.mjs` | 由 `aggregate.yml` 生成聚合 patch 与 dependencies |
| `scripts/publish.mjs` | 按依赖边推导发布顺序（子插件 → 聚合包）；`npm run publish:plan` 预览 |
| `scripts/sync-upstream.mjs` | 上游同步的只读工具：`--list` 看各 fork 上游到哪、`--changed <id>` 看改了什么。同步本身手工做 |

## 开发

```bash
pnpm install
node scripts/aggregate.mjs --check     # 校验生成物与清单一致
node scripts/aggregate.mjs             # 重新生成
```

改子插件的 patch 行：编辑该子包自己的 `cordis.patch.yml`，再跑 `node scripts/aggregate.mjs`。
新增一个子插件见 `AGENTS.md` 的「➕ 新增子插件」。

## 发布

认证走 **trusted publishing (OIDC)**，不存任何长期 npm token。手动预览发布计划：

```bash
npm run publish:plan          # dir<TAB>name<TAB>version，顺序即发布顺序
```

**顺序由依赖边推导**，不写死包名：子插件在前，聚合包在后——聚合包要解析子插件的依赖版本。

### 新增包：由用户人工首发

全新包不能走 CI：trusted publisher 只能配在已存在包上，staged publishing 也明确排除全新包。
所以先由用户人工发一次，再配 trust：

```sh
cd packages/<name> && npm publish --access public
npm trust github <pkg> --file publish.yml --repo dale0525/dsh-plugins --allow-publish
```

`--allow-publish` 不可省——2026-09-03 之后创建的配置默认只允许 `npm stage publish`，
不给这个 flag 时 CI 直接发布会被拒。配好 trust 后，该包后续更新都走 CI/CD。

### 已发布包：走 CI/CD

本地测试通过后由 CI/CD 发布，推 `v*` tag，或在 main 上手动触发：

```bash
gh workflow run publish.yml --ref main -f dry_run=false
```

细节见 `AGENTS.md` 的「📤 发布」。

## 生效方式

改完之后要不要重启宿主，取决于改动落在哪一层。这张表是硬门禁与实测依据，
维护在 `AGENTS.md` 的「🚀 生效门禁」；以那里为准。

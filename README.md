# dsh-plugins

DSH 插件 monorepo：一次安装装上全部插件。

## 安装

```sh
dsh plugin --profile web add @logictan/dsh-plugins-all@latest
```

根包（`dsh-plugins`）是聚合载体：它的 `dsh.bundle.patch` 指向 `packages/all/cordis.patch.yml`，
该 patch 由各子插件自己的 patch 逐字拼接而成。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `packages/all/` | 聚合载体 `@logictan/dsh-plugins-all`；`aggregate.yml` 手写，`cordis.patch.yml` 与 `package.json` 是生成物 |
| `packages/dsh-config-manager/` | 配置远程同步插件（`@logictan/dsh-config-manager`，git subtree fork 自上游 v0.1.60） |
| `scripts/aggregate.mjs` | 由 `aggregate.yml` 生成聚合 patch 与 dependencies |
| `scripts/sync-upstream.mjs` | 按 `sync-policy.json` 把上游改动合进来（只开 PR） |
| `scripts/dev-watch.mjs` | 改源码 → 自动重建产物（客户端半边不刷新即生效） |
| `sync-policy.json` | 上游同步的三类清单：`owned` / `deleted` / `upstream` |

## 开发

```bash
pnpm install
node scripts/aggregate.mjs --check     # 校验生成物与清单一致
node scripts/aggregate.mjs             # 重新生成
```

改子插件的 patch 行：编辑该子包自己的 `cordis.patch.yml`，再跑 `node scripts/aggregate.mjs`。

## 生效方式（改动要不要重启）

| 改动 | 需要重启吗 |
|---|---|
| `cordis.patch.yml` / `settings.yaml` | 不需要，宿主自行热重载 |
| 插件客户端产物（`lib/client.js`） | 不需要，跑 `dev:watch` 后浏览器原位替换 |
| 插件包代码同版本覆盖安装 | **需要** |
| 插件宿主半边源码 | **需要**（默认关闭 module watch） |

细节与实测依据见 `AGENTS.md`。

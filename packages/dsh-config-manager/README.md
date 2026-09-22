# 🔄 DSH Config Manager

**DeepSeek Harness 配置远程同步插件。**

在你的多台机器之间，通过**自有的私有通道**（Git 仓库或 WebDAV）同步完整的 DSH 配置 ——
设置、模型 provider、插件清单、MCP server、技能、Agent 预设、工作区，以及 provider 密钥。

- ☁️ **Git / WebDAV** 双通道，各自独立配置
- 📄 **明文快照** —— 私有通道自用，勾选即同步，不加密、不脱敏、不做 diff/合并
- 🧩 分区可勾选：设置 / provider / 插件 / MCP / 技能 / 预设 / 工作区 / 凭据 等
- ↩️ 应用前自动落回滚快照，失败整体回滚
- 🔐 通道凭据走 DSH credentials 槽位，值永不回传浏览器

---

## 它解决什么

DSH 把配置散落在 `$DSH_HOME` 的多个文件里（`settings.yaml`、`.credentials.yaml`、
`cordis.patch.yml`、插件清单、技能目录…）。换一台机器就要重配一遍。

本插件把这些分区打包成**快照**推到你自己配置的私有通道，另一台机器拉下来覆盖写入。
**不加密、不脱敏** —— 这是刻意的产品选择：通道是你自己的私有仓库，明文自用比丢配置更划算。
因此**绝不要**把同步通道指向公开仓库。

---

## 安装

```sh
dsh plugin --profile web add @logictan/dsh-config-manager@latest
```

> 也可通过聚合包一次装上本仓库的全部插件：`@logictan/dsh-plugins-all`。

## 使用

设置 → 插件 → **DSH Config Manager**（只有一个「同步」标签页）：

1. **通道**：选 Git（私有仓库地址 + token）或 WebDAV（地址 + 用户名 + 口令）；
   两者配置**互相独立**。
2. **同步范围**：默认模式同步全部推荐分区；高级模式手动勾选。
3. **推送**：把本地配置直接覆盖到远端（无预览、无确认）。
4. **拉取**：把远端最新快照直接覆盖到本地（应用前自动落回滚快照，失败整体回滚）。

---

## 安全边界

| 项 | 说明 |
|---|---|
| 快照内容 | **明文**，含 provider 密钥等一切隐私信息（`manifest.security.containsSecrets` 按实际内容如实标注） |
| 通道要求 | 必须是你自有的**私有**仓库；本插件不会、也无法阻止你把它指向公开仓库 |
| 通道凭据 | 存于 DSH credentials（Git 用 `DSH_CONFIG_MANAGER_SYNC_TOKEN`，WebDAV 用 `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD`）。**这些值会随「凭据」分区明文进入同步快照**（跨机恢复的前提），但绝不回传浏览器、绝不写入日志 |
| 凭据分区 | 同步快照携带 `.credentials.yaml` 的 `refs` 明文值，拉取时直接写回目标机；普通备份 ZIP 仍然不含任何凭据值 |
| 日志 | 全程脱敏（`security/redaction.ts`） |
| 导入 | 应用前强制落回滚快照；任一失败整体回滚 |

---

## 架构

双面 Cordis 插件：

- **宿主半边** `src/index.ts` —— `/api/dsh-config-manager/sync/*` 路由族 + 同步引擎
  （`src/sync/sync-engine.ts`）+ Agent 工具（`config_sync_push` / `config_sync_pull`）
- **浏览器半边** `src/client/` —— 设置页里唯一的「同步」标签

`src/core/` 与 DSH 解耦（`ConfigAdapter` / `HostContext` + 内存 mock），
业务逻辑放 `src/ui/`，React 壳只做装配。

传输通道：`src/sync/git/` 与 `src/sync/webdav/`，共同的 `SyncTransport` 契约在 `src/sync/transport.ts`。

---

## 开发

```bash
npm install --legacy-peer-deps   # 部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit
npm test                         # node --test
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm run dev:watch                # 改 src/client/** 自动重建产物（浏览器原位替换）
```

- 无 lint/format 脚本，只以 typecheck 兜底。
- 样式全在 `src/client/config-manager.module.css`（CSS Modules，tsdown 编译为内联注入）。
- **import 一律带 `.ts` 后缀**（Deno-style）。

### 测试的 TMPDIR 陷阱（macOS）

`src/utils/recursive-walk.test.ts` 建真实符号链接，而 macOS 的 `/var/folders/...` 是
`/private/var/...` 的符号链接 —— `realpath` 会把 home 解析到 `/private/...`，导致
「home 内」判定失败。跑测试前：

```bash
mkdir -p /private/tmp/realhome
TMPDIR=/private/tmp/realhome/ node --test "src/**/*.test.ts" "tests/**/*.test.ts"
```

---

## 许可证

MIT

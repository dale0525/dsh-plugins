---
name: dsh-plugin-runtime
description: 改完插件代码要确认是否生效：判断该重启还是走 HMR、核对宿主下发的 client bundle 是不是新构建、重启后核对新代码有没有进提示词，或 `dsh-web status` 报 NOT LISTENING / SPLIT 时加载。
---

# 改动如何生效与如何核验

「改了没生效」在本仓库有一半是判据错了，不是改动错了。

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

## 核验证据

`dsh-web status` 的 `Verdict:  OK` 只是「作业与端口 owner 是同一个进程」，它不证明你要的改动进了页面或提示词。按改动类型取证：

| 改动 | 证据 |
| --- | --- |
| 客户端产物 `lib/client.js` | 原样 `curl` 页面里那条 `/plugins/??<pkg>/client.js&rev=<rev>`，`rev` 变化即已重新发布 |
| 宿主提示词（工具清单、指令） | 会话日志里**最后一条** `request/header` 的 `data.header.tools` |
| 服务是否健康 | `dsh-web status`；报 NOT LISTENING 或 SPLIT 时先复核再决定重启 |

每条判据的具体命令、以及 `lsof` 在 `/usr/sbin`、同端口两个监听者、监听地址推导、`.err` 跨启动追加、启动期护栏、`apply` 返回 Promise 等陷阱，见 `references/verify.md`——只在核对生效时读。

# 🛠️ DSH Config Manager — 开发者 / 维护者文档

> 面向开发者与维护者。**用户请看 [README.md](README.md)。**
> 仓库级约定（聚合、生效门禁、上游同步）见仓库根 `../AGENTS.md`。

---

## 📦 开发命令

```bash
npm install --legacy-peer-deps   # 部分 DSH 核心包未发布公共 registry，需跳过 peer 解析
npm run typecheck                # 类型检查（tsc --noEmit）
npm run build                    # Host 半 lib/（tsc）+ client bundle lib/client.js（tsdown）
npm run bundle                   # 仅重建 client bundle（tsdown）
npm test                         # 全部测试（node --test）
npm run dev:watch                # 改 src/client/** 自动重建产物
npm run smoke                    # 仅核心引擎冒烟测试
```

> **macOS 跑测试前**：`mkdir -p /private/tmp/realhome && TMPDIR=/private/tmp/realhome/ npm test`
> —— `/var/folders/...` 是 `/private/var/...` 的符号链接，会让符号链接类用例的 realpath 判定失败。

## 🏗️ 架构

```
src/
├── core/       核心引擎（与 DSH 运行时解耦；ConfigAdapter / HostContext 接口 + 内存 mock 可测）
│               exporter / analyzer(三段式) / importer / backup(快照) / rollback(逆序补偿)
│               journal(事务) / reconcile(崩溃归因) / run-registry(进度)
├── schema/     领域类型 / Manifest / 版本判定（CURRENT_SCHEMA_VERSION=1）
├── security/   secret-scanner / redaction（日志脱敏）/ zip-security / vault
├── adapters/   ConfigAdapter 实现（settings/ui/providers/plugins/mcp/prompts/skills/
│               agentPresets/agentInstructions/workspaces/credentialsStatus/pluginFiles/self[/sessions]）
├── migrations/ schema 迁移链（registry + v1→v2 占位）
├── sync/       SyncEngine + Git/WebDav 传输 + AutoSyncScheduler + config/state/history/selection
├── ui/         框架无关 UI 逻辑层（纯函数，node 可测）
├── client/     React 界面（settings.section 挂载，经 sync-api 调 Host）
└── index.ts    Host 半 Cordis 插件入口（name='config-manager'）
```

**安全不变量**：通道凭据不回传 / 导入前强制快照 / Dry Run 零写入 / ZIP 视为不可信输入 / 日志全程脱敏。

**同步语义**：明文快照（私有通道自用），勾选即同步，不加密、不脱敏、不做 diff/合并；
`manifest.security.containsSecrets` 按实际内容如实标注。

## 🧪 测试

`node:test`（零额外依赖），同目录 `*.test.ts`。逻辑放 `src/ui/`（纯函数）与 `src/core/`（引擎）以便单测；
React 无组件测试框架，因此组件逻辑必须提炼到 `src/ui/`。

集成测试在 `tests/`：`conformance/`（对外格式往返）、`core/`、`security/`、`migrations/`、`schema/`、`route/`。

## 🚀 发布

本 fork 由 `dsh-plugins` monorepo 统一发布（见仓库根 `AGENTS.md`），
不在本包内单独打 tag —— 上游的 `.github/workflows/publish.yml` 已随 fork 删除。

## 📋 技术限制

1. Workspace 只能创建/改标题（DSH 无整体覆盖写通道）
2. MCP 无管理 API —— 以组合 patch 行写入，由宿主热重载生效
3. 插件**包代码**同版本覆盖安装需重启（`restart-required` 路径）
4. 浏览器 localStorage UI 状态不迁移（Host 无通道）
5. keybindings / workflows / commands / rules —— DSH 无此概念，不实现假分区
6. 凭据值无法回滚（DSH 不回读值，回滚需人工补录）
7. 新建项无法回滚删除（settings 无删除语义）
8. Schema 迁移 v1→v2 为占位（CURRENT=1）
9. 旧版加密快照无法读取（同步通道已改为明文，遇到 `manifest.encrypted=true` 明确拒绝）

## 📌 常见坑

- **同步渠道必须指向独立的私有仓库**：本仓库是 public，而同步快照携带明文凭据。
- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**：只搬 `pnpm-workspace.yaml` 文本会让目标机 pnpm 拒绝**一切** `add`。
- **`@latest` 装到旧版 = pnpm 发布年龄策略**（`minimumReleaseAge` 默认排除发布不足 30 天的版本）：
  精确版本装一次即自动白名单，或在 profile 的 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（`tsdown.config.ts`）；改 format/入口会破坏加载器。
- **`src/client/` 不 import node 模块**。

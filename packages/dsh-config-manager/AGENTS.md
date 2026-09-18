# AGENTS.md — dsh-config-manager（fork）

> 本包是 `dsh-plugins` monorepo 的成员，git subtree fork 自上游 `xiajiajun516/dsh-config-manager` v0.1.60。
> 仓库级约定（聚合、生效门禁、上游同步）见仓库根 `../AGENTS.md`；本文件只写本包特有的约定。

## 🌐 语言

与用户交流用中文；代码注释 / commit 用中文，技术术语可保留英文。

## 📦 用途与形态

DSH 配置的**远程同步**插件。双面 Cordis 插件：

- 宿主半边 `src/index.ts`：`/api/dsh-config-manager/sync/*` 路由族、同步引擎、自动同步调度器、
  Agent 工具（`config_sync_push` / `config_sync_pull`）。
- 浏览器半边 `src/client/`：设置页里**唯一的「同步」标签**。

技术栈：TS 5.9（strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`）、Node≥22、React 18 + CSS Modules、`node:test` 零依赖、tsdown + lightningcss 打包 client。

## 🗂️ 分层

```
src/index.ts   host 入口（name='config-manager'；路由注册与 ctx 接线）
src/core/      引擎（exporter/importer/analyzer/backup/rollback/journal…），与 DSH 解耦
src/schema/    类型 / Manifest / 版本（CURRENT_SCHEMA_VERSION）
src/security/  secret-scanner / redaction（日志脱敏）/ zip-security / vault
src/adapters/  ConfigAdapter 实现（settings/ui/providers/plugins/mcp/prompts/skills/
               agentPresets/agentInstructions/workspaces/credentialsStatus/pluginFiles/self[/sessions]）
src/sync/      SyncEngine + Git/WebDav 传输 + AutoSyncScheduler + config/state/history/selection
src/ui/        框架无关 UI 逻辑（纯函数，node 可测）  ← 业务逻辑必须在此
src/utils/     paths / zip / hashing / json / logger / atomic-write / env-lock / recursive-walk
src/client/    React 壳（浏览器半）  ← 只做装配
tests/         集成测试（node --test）
docs/design/   上游设计依据（写给本仓库）
docs/spec/     对外契约（写给第三方实现者）
```

### UI 分层铁律

1. **逻辑放 `src/ui/`**（纯函数/控制器）——禁止在 React 组件里写可测试业务逻辑。
2. **React 壳只装配**（`src/client/` 只渲染 + 交互状态，模型来自 `src/ui/`）。

### 页面落位

- 容器：`src/client/index.ts`（`settings.section` 注册）+ `ConfigManagerSection.tsx`
- 同步页：`src/client/sync/SyncSettingsView.tsx`（+ `SyncConfirmView` / `SyncHistoryView` / `sync-view`）
- 共享原语：`src/client/common/ui.tsx`（Button/Badge/Banner/Card/Spinner/Field/Checkbox 等）
  + `ErrorBanner.tsx` / `Modal.tsx` / `Icon.tsx` / `ToastViewport.tsx`
- 状态中枢：`run-store.ts`（模块级单例 + sessionStorage 白名单）
- 数据访问：`src/client/sync/sync-api.ts`（类型化 api 类）
- 文案字典：`src/client/locales.ts`（外壳）/ `src/client/sync/sync-locales.ts`（同步页），zh 源 / en 镜像
- 样式：**全部**在 `src/client/config-manager.module.css`

## 🔢 版本三处必须同步（最易漏）

`package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION`。
bump 后跑 `npm run typecheck` 确认。

## 🔐 安全不变量（硬约束，不得破坏）

- **凭据不可回读**：`ctx.credentials` 永不回读值；只经 `HostContext.fs` 文件级读 `.credentials.yaml`。
- **通道凭据不回传**：token / WebDAV 口令只写 DSH credentials 槽位，响应里只出现 `configured` 布尔。
- **日志全程脱敏**：`redactValue` 掩码敏感值；UI 渲染前所有错误/报告再过 `redact()`。
- **ZIP 视为不可信**：条目数上限、checksum、Zip Slip 拒绝（`src/security/zip-security.ts`）。
- **导入前强制快照**（可回滚）、Dry Run 零写入、冲突不默认覆盖。
- **sessionStorage 白名单**：`run-store.ts` 的 `toPersistedState()` 显式剔除敏感字段；新敏感字段不显式放行即不落盘。

### 同步通道的明文语义（产品选择，不是缺陷）

同步通道是**用户自有的私有通道**：勾选即同步，**不加密、不脱敏、不做 diff/合并**。

- `SyncEngine.push` 以 `includeSecrets: true` 导出真实值；
- `manifest.security.containsSecrets` 必须按**实际内容如实标注**（`sectionsCarrySecrets`，复用 exporter 的敏感字段扫描器）——标注与内容不符会让下游按「无秘密」处理；
- `pull` 恒 `replace`：远端值覆盖本地，不询问；
- 旧版加密快照（`manifest.encrypted=true`）**明确拒绝**，不静默当明文读。

## 🏗️ 架构心智

- **新功能优先加 `src/core/`**，适配器 / UI 只做薄壳。
- **import 一律带 `.ts` 后缀**（Deno-style）。
- **文件类分区收集一律走 `utils/recursive-walk.ts`**：`readdir` 对目录 junction/符号链接返回
  `isSymbolicLink()===true`（`isDirectory()` 为 false），自己写 `if (isDirectory())` 分支会
  **静默丢掉整块内容**且备份仍报成功。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（`tsdown.config.ts`）；改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`。
- **`src/client/` 不 import node 模块**。
- 设计决策看 `docs/design/`（上游依据）；对外契约看 `docs/spec/`。**改格式行为必须同步 `docs/spec/`，并重跑 `tests/conformance/`。**

## 🛠️ 开发规范

### TS / 命名

- **import type**（`verbatimModuleSyntax` 强制）；类型合并用 `declare module` + `import type {}`。
- React：函数组件 + hooks，无 class / 高阶组件；props 显式 `XxxProps`。
- 命名：组件/类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，CSS 类名 camelCase。

### 状态管理

- 高频可恢复流程状态在 `run-store.ts`；新视图需「切 tab 不丢 / 刷新恢复」就入 runStore。
- 低频面板组件自持（state + ref）+ 非敏感切片镜像 runStore；状态变更统一走 `commit(next)`。
- 控制器由 runStore 缓存复用，**禁止每次渲染 new**。

### 数据访问 / 错误

- 一律走类型化 api 类，实现 `src/ui/types.ts` 的 port 契约；**组件禁止直接 fetch**。
- 错误链：`toActionableError()` → `ErrorBanner`；**展示文本渲染前过 `redact()`**。

### i18n

- 文案进字典，**禁止硬编码用户可见字符串**。
- 判断「某 key 是否存在」前必须先确认 `t` 的来源（编译校验 vs `api.t`/props 注入），
  否则会系统性误报 —— 注入式 `t` 要取全部字典的并集再下结论。

### 测试

- `node:test` + `node:assert`（零依赖），同文件 `*.test.ts` 同目录。
- `src/ui/` 纯函数与 `src/core/` 引擎必须有单测；React 无组件框架，逻辑提炼到 `src/ui/` 保证可测。
- **macOS TMPDIR 陷阱**：`src/utils/recursive-walk.test.ts` 建真实符号链接，而 macOS 的
  `/var/folders/...` 是 `/private/var/...` 的符号链接，`realpath` 会让「home 内」判定失败。
  跑测试前：`mkdir -p /private/tmp/realhome && TMPDIR=/private/tmp/realhome/ node --test "src/**/*.test.ts" "tests/**/*.test.ts"`

## 🧪 命令

```bash
npm install --legacy-peer-deps   # 必须带：部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit
npm test                         # node --test
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm run dev:watch                # 改 src/client/** 自动重建产物（浏览器原位替换）
npm run smoke                    # 仅 core 冒烟
```

无 lint / format 脚本，只以 typecheck 兜底。

## 🎨 UI / 设计系统

> `DESIGN.md` 是 UI/样式决策的唯一权威。涉及 UI/Layout/CSS/颜色/字体/间距/图标/动效前必读。

**硬性规则：**

1. 颜色/字体/阴影必走 `--dsw-*` token；**禁止 hardcode**；tint 用 `color-mix(in srgb, <token> <pct>%, transparent)`。
2. 样式只能进 `src/client/config-manager.module.css`；禁止新增 css / 内联 `<style>` / 第三方 css；
   类名用 CSS Modules 引用（`css.xxx`），**勿写字符串 class**。
3. 复用 `src/client/common/ui.tsx` 原语 + Common 的 `ErrorBanner/ToastViewport`；已有公共组件能解决禁止重建。
4. **默认不引入第二套视觉体系**（Tailwind/CSS-in-JS/Sass/UI 库/图标库/动画库）。
5. 按钮语义：`variant="primary"`（主）/ 默认 ghost（次）/ `variant="danger"`（危险）；勿用 primary 做危险操作。
6. 徽章：`Badge kind="ok|info|warn|error"` 与 `Banner` 四态一一对应。
7. 文案走 i18n 字典；展示文本渲染前进 `redact()`。
8. 长列表/大报告限高内滚，禁止撑长整页。

### 已落地的第三方库（按准入流程评估通过）

- `lucide-react`（图标）+ `@radix-ui/react-dialog`（弹窗 a11y）——**无样式/行为级**原语，
  视觉仍走 `--dsw-*` token。**devDependencies**（经 `tsdown.config.ts` 打进单文件 cjs，已被内联故非运行时依赖）。
  封装层 `common/Icon.tsx` / `common/Modal.tsx`。

### 复用优先

新建 Component/Hook/Utility/Style/Type/API 前按序：①Reuse ②Extend ③Refactor ④Create。
检查顺序：`src/client/common/*` → `src/ui/*` → `src/core/*` → `src/utils/*` → `src/security/*` → `DESIGN.md`。

## 📚 文档同步

| 代码变化 | 更新 |
|---|---|
| 新 Design Pattern / Shared Component / Token / 主题 | `DESIGN.md` |
| 新目录约定 / 架构 Pattern / 开发规范 | 本文件 |
| 对外格式 / schema / 兼容区间 | `docs/spec/` |

代码与文档冲突时**以代码为准**修正文档。

## 📌 常见坑

- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**：只搬 `pnpm-workspace.yaml` 文本会让目标机 pnpm 拒绝**一切** `add`。
- **journal step 的 `skipped` 只能表示「用户主动跳过」**：`warning`（非致命失败）与 `failed` 都必须记 `attention`。
- 根目录勿提交：`lib/`、`dist/`、`node_modules/` 均已 gitignore。
- **同步凭据走 DSH credentials 槽位引用**，`passwordConfigured` 仅布尔标记。

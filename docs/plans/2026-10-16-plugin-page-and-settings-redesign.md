# 插件页与统一设置组件层 —— 方案（事前冻结）

状态：**方案已获同意**（2026-10-17），按推荐选项执行：共享组件层独立成包；下拉自建。本文冻结「要做什么、边界在哪、验收判据」。

## 1. 问题

三件事各自独立，但共用同一套视觉规格：

1. 宿主「插件」页（`@deepseek-ai/dsh-client-ui-plugin-manager`）的卡片与行列表样式不由本仓库控制，插件只能以槽位贡献内容。
2. 本仓库 8 个插件各自注册 `plugins.row.config`，每套卡片样式都是手搓的：`dsh-config-manager` 与 `dsh-imagegen` 各带一份 1500–2700 行的 CSS Modules，另外 6 个（browser-agent / desktop-agent / easyrewrite / loop-guard / macos-theme / stitch-designer）在 `src/client.js` 里各自写内联样式。同一个「开关 + 说明文字」在 8 个地方有 8 种写法。
3. 新增一个插件要手工做四件事：写 `cordis.patch.yml`、登记 `aggregate.yml` 两节、注册槽位、再手搓一遍卡片。没有模板，也没有任何一处能自动生成配置摘要。

## 2. 可实现边界（实测结论，非推测）

### 2.1 宿主插件页能改什么

宿主 DOM 带稳定锚点，**不依赖哈希类名**：`data-plugin-panel`、`data-plugin-package`、`data-plugin-status`、`data-plugin-detail`、`data-plugin-row`、`data-plugin-row-detail`、`data-plugin-rows`、`data-plugin-group`、`data-plugin-count`、`data-plugin-name`、`data-plugin-config`、`data-plugin-item`、`data-plugin-item-detail`、`data-window-drag`。

因此可以做的：
- 用 `body` 前缀选择器覆写卡片/行的**颜色、边框、圆角、间距**（几何与配色）。
- 在以下槽位贡献内容：`plugins.row.config`（keyed，key = `<bundle 包名>#<rowId>`）、`plugins.detail.actions` / `plugins.detail.badge` / `plugins.detail.section`（list，收到 `PluginsSubject`）、`plugins.bundle.activation`（keyed，按包名）。

**做不到的**（设计稿中不得出现）：
- 改宿主卡片的**结构与信息层级**（比如把行尾按钮换位置、给行加二级展开区）——只能靠 CSS 覆写视觉。
- 从插件里跨包导航到 bundle 详情页：`setView` 只存在于宿主自己的 `navigation-store`，插件拿不到。
- 在插件页顶部加一段说明区：`data-plugin-panel` 内插件贡献只渲染在**详情页**。
- 新增页面级 tab 或顶栏动作。

### 2.2 插件能 `require` 什么（实测）

客户端模块加载器 `makeRequire(spec)` 的解析顺序是：平台 seed（react / react-dom / react/jsx-runtime）→ `loadCache` → `graphRows` 里已注册的包 → 抛 `missed the module table`。

- `require("@deepseek-ai/dsh-client-ui-primitives")` **抛错**。该包没有 `lib/client.js`，只以 seed 形式暴露给宿主自己的 bundle；`dsh.client.external` 字段只在宿主 `prune()` 里被读，不参与运行时解析。
- 因此**跨插件共享 UI 组件库必须自带 client bundle**：走 `import(spec)` → `stripClientSuffix` → `graphRows` → 加载该包的 client 半边。这是下面方案 C 成立的唯一依据。
- `window.__DSH_BOOT__.entries[].external` 会被 `arriveGraphRow` 提前注册（对每个 `external` 请求 `stripClientSuffix` 后查 `graphRows` 并先加载）。这是让共享库在消费者之前就位的机制。

## 3. 方案

### A. 插件页视觉（不新增页面）

在 `dsh-macos-theme` 里追加一节 `body` 前缀 CSS，按上面的稳定锚点覆写宿主插件页的卡片、行、状态点、分组标题与详情页头部，使它与设计稿一致。上限约 14 条规则，**不写任何结构假设**（只碰颜色/边框/圆角/间距/字号）。

设计稿（亮色，设计系统 `assets/17773324429603702670`）：`docs/design/465e8660aaa5426cb4a5ea7d84c6d6cf.html`（插件中心）。

不做的事：不新建插件页，不改宿主包，不给宿主提 PR。

### B. 统一设置组件层（新建 `@logictan/dsh-plugins-shared-client`）

一个纯客户端包，只导出 React 组件与样式，不含宿主逻辑：

- `SettingsCard`（可折叠卡片：标题 / 说明 / 可选标签 / 展开区）
- `Field`（标签 + 说明 + 控件 + 错误文字的行布局）
- `TextField` / `SecretField` / `NumberField` / `TextArea`
- `Select`（宿主没有 Select 组件，需自建；用 `Menu` 语义或原生 `select`）
- `Switch` / `Checkbox` / `Radio` / `Segmented`
- `Button`（primary / secondary / ghost / danger / icon / compact）
- `StatusDot` / `Tag` / `Banner` / `EmptyState` / `Skeleton` / `ReadonlySummary`
- `ListEditor`（可增删的字符串列表，如模型目录）

样式用 TailwindCSS 编译进该包自己的 `lib/client.js`（各包构建期内联，和现有 client 半边一致），颜色全部走 `--dsw-*` token，因此自动跟随 `dsh-macos-theme` 的亮/暗切换。

消费方式：在插件 `package.json` 里声明 `dsh.client.external: ["@logictan/dsh-plugins-shared-client"]`，源码里 `import { SettingsCard } from '@logictan/dsh-plugins-shared-client'`，构建期作为 external 保留，运行时由 `arriveGraphRow` 提前加载。

设计稿（亮色，设计系统 `assets/17773324429603702670`）：`docs/design/f2228ebf716346cca640c775c6cf8c5f.html`（设置页模板）、`docs/design/c1b092a676ca4255acdc081ecf52b0f3.html`（控件与状态规范）。

**迁移范围**：8 个注册 `plugins.row.config` 的插件全部改用该层；`dsh-config-manager` 与 `dsh-imagegen` 的两份自建组件（`common/ui.tsx`、`settings-form.ts` 等）删除。

### C. 接入流程

1. 新建插件时用一个模板目录（`templates/plugin/`）：`package.json`（含 `dsh.bundle.patch` + `dsh.client` + external）、`cordis.patch.yml`、`src/index.ts`（`export const name`）、`src/client.tsx`（注册 `plugins.row.config`，用 B 的组件）。
2. `aggregate.yml` 两节登记 + `node scripts/aggregate.mjs` 不变。
3. 「提供配置项」的推荐路径：插件在宿主半边声明 `export const Config = Schema.object({...})`，浏览器半边用 `form` 无头渲染宿主表单（`PluginConfigViewProps.form`），**不再手写每个字段**。这样新增一个配置项只改 schema。
   - 前提：宿主的 `SettingsSchemaService` + `ConfigForm.mutate(ops, expectedRevision)` 可用。
   - 现状：只有 `dsh-macos-theme`、`dsh-better-reasoning-effort`、`dsh-loop-guard` 有 `Config` schema，且没有一个插件用 `form` 无头渲染。
4. 摘要 helper：`plugins.row.config` 的 `summary` 视图按 `role` + `label` 自动生成只读摘要行（设计稿里那张浅灰底两列区），插件只需给出「标签 → 值」的取数函数。

## 4. 暗色适配

暗色稿与亮色稿同结构，只是换一套 token，依据 `dsh-macos-theme` 的 `TOKENS` 表（每个 token 一对 `{light, dark}`）：

| 用途 | 亮色 | 暗色 |
|---|---|---|
| 画布底 | #F8FAFC | #0B101D |
| 窗口底 / 侧栏 | #F8FAFC | #0F1626 |
| 卡片 | #FFFFFF | #121927 |
| 卡片内嵌区 | #F8FAFC | #151D2E |
| 悬停 / 浮层 | #F1F5F9 | #1E293B |
| 卡片描边 | rgba(15,23,42,0.08) | rgba(255,255,255,0.07) |
| 分隔线 | rgba(15,23,42,0.08) | rgba(255,255,255,0.08) |
| 内部弱线 | rgba(15,23,42,0.05) | rgba(255,255,255,0.06) |
| 正文 | #0F172A / #1E293B | #E2E8F0 |
| 次要 | #64748B / #475569 | #94A3B8 |
| 三级 | #94A3B8 | #64748B |
| 主色 | #2563EB | #3B82F6 |
| 主色悬停 | #1D4ED8 | #60A5FA |
| 浅蓝底 | #EFF6FF | #1E293B |
| 链接 / 文字按钮 | #2563EB | #60A5FA |
| 成功 | #10B981 / 底 #ECFDF5 | #10B981（字 #34D399）/ 底 #12291F |
| 警告 | #F59E0B / 底 #FFFBEB | #F59E0B（字 #FBBF24）/ 底 #2A2113 |
| 危险 | #EF4444 | #EF4444（字 #F87171）/ 底 rgba(239,68,68,0.12) |
| 空闲 / 已禁用 | #CBD5E1 | #475569 |
| 开关圆钮 | #FFFFFF | #E2E8F0 |
| 卡片圆角 | 16px | 14px |

由于组件层颜色全部走 `--dsw-*` token，**暗色不需要第二套组件代码**——同一个组件在 `html.dark` 下自动取暗色值。暗色设计稿只用于校对 token 是否齐备。

暗色稿（设计系统 `assets/7359635440322593309`）：`docs/design/56dcfca607ae4eaa9bf6542c72ff44b0.html`（插件中心）、`docs/design/c3835d5a62cc40beb2fc73afc4b4c1eb.html`（设置页模板）、`docs/design/a06085c459bb4fadafff52587e83bb4d.html`（控件与状态规范）。

## 5. 验收判据

- 插件页与设计稿在亮色下逐项对齐：卡片圆角 16px、边框 `rgba(15,23,42,0.08)`、行高 44px、状态点三态、分组标题字号。
- 8 个插件的设置卡在亮/暗两种主题下视觉一致；同一控件在不同插件里像素级相同。
- `dsh-config-manager` 与 `dsh-imagegen` 不再有自己的按钮/输入框实现（搜索 `common/ui.tsx` 里的 Button 定义无命中）。
- 新建一个空插件，从模板到「在插件页出现一行、点开有配置项」不需要手写任何 CSS。
- 四条本地门禁通过：`node scripts/aggregate.mjs --check`、`pnpm test`、`pnpm typecheck`、`pnpm run check:host`。

## 6. 已裁定

- 共享组件层独立成包 `@logictan/dsh-plugins-shared-client`（不并入 `dsh-macos-theme`）。
- `Select` 自建，不用原生 `<select>`；键盘与 ARIA 自己实现。
- `logictan/dsh-packages-all` 系口误，实指本仓库聚合包 `@logictan/dsh-plugins-all`（`packages/all`）。

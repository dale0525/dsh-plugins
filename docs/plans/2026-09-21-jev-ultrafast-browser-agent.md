# jev-ultrafast 浏览器 Agent 子插件方案

> 状态：**本地实施完成，A1–A7d 已验收通过；A8 已用真实 Key 端到端跑通**（见 §10.8）；A9–A11 待人工首发与聚合包重新发布（§6.2）。
> 首发已发生（`0.1.0`，2026-09-21T12:40Z），但**该版本带缺陷 6**（见 §10.8），必须升 `0.1.1` 后重发；trust 尚未配置（`npm trust list` 需 OTP，Agent 不能代跑）。
> **T6 剩余的唯一动作在用户侧**：配置 trust，然后由 CI 发布 `0.1.1` 与升版后的聚合包。
> 上游评估对象：`https://github.com/browser-use/jev-ultrafast`（MIT，Python 3.12，未发布 PyPI）。

## 1. 问题与目标

### 1.1 问题

`browser-use/jev-ultrafast` 是一个「动态索引动作空间」的浏览器 Agent：每次观测生成一张带编号的元素表，用一次 TypeSafe 请求同时决定 **操作**（CLICK / TYPE_TEXT / SELECT / SCROLL_* / WAIT / DONE / BLOCKED）与 **目标**（元素编号），只有操作为 `TYPE_TEXT` 时才调用一个小模型生成要输入的字符串。它的公开证据是单任务中位耗时 9.450s → 7.092s、浏览器协议调用 1092 → 101。

它不能被原样封装成 DSH 子插件，因为它依赖三样无法随配置过境的东西：

| 依赖 | 事实 |
| --- | --- |
| TypeSafe 托管 API | `POST https://api.typesafe.ai/v1/systemone`，Key 从 console 取，不可自托管 |
| Python 运行时 | `pyproject.toml` 要求 `>=3.12`，未发 PyPI；`uv tool install git+https://github.com/browser-use/jev-ultrafast` 实测可装（16 包，出 `jev` 可执行文件） |
| 本地 Chrome CDP | 经 `browser-harness` 连 9222/9223，共用用户现有 profile |

三者的过境边界见 §3.2。

### 1.2 目标

在 `dsh-plugins` 仓库内新增一个**自制子插件**，把 jev 的**决策协议**用 TypeScript 重实现，浏览器执行改为**插件直连 CDP**（`playwright-core` 的 `connectOverCDP`），从而：

- 新设备经 config-manager 同步后，插件**自动安装、工具自动出现、零额外下载**；
- 使用用户真实 Chrome 的**登录态**（这是 launch 模式结构上做不到的，见 §3.1）；
- 不引入 Python、不引入第二个浏览器运行时。

### 1.3 明确的非目标

本插件**不**追求复刻 jev 的性能数字。jev 的 7.1s 是在它自己的 benchmark（单站点单任务、三次重复）上测得的，且依赖焦点仿真、几何遮挡复检、语义新鲜度守卫等一整套实现。本插件先求**协议正确与链路可复现**，性能优化留给后续切片。

## 2. 范围

### 2.1 In scope（v1）

1. 插件包骨架：`packages/dsh-browser-agent/`，自制形态（**不 fork、无 `sync-policy.json`**）。
2. 设置命名空间 `browser-agent`，含一个 `role('secret')` 的 TypeSafe Key 字段、TypeSafe endpoint、`TYPE_TEXT` 的 provider/model/reasoning-effort、步数上限。
3. 客户端半边：注册进 `plugins.row.config`（key `<bundle 包名>#browser-agent`）的设置卡，只编辑上述非密钥字段与 Key；模型下拉取自 `ctx.remote.session.modelCatalog()`。
4. 一个模型可见工具 `browser_agent`，入参 `{ url, goal }`，同步等待任务结束并返回结构化轨迹。
5. TypeSafe 决策客户端：`POST /v1/systemone`，`operation` + 每个候选操作的 `*_target` 两个 head 一次请求；响应校验通过后**才**执行（校验契约见 §4.6）。
6. 元素表构建：从 CDP 读取可见控件（role / name / value / checked / selected / expanded / options），生成带编号的候选表与「每操作独立目标集」。
7. 执行器：CLICK / TYPE_TEXT / SELECT / SCROLL_UP / SCROLL_DOWN / WAIT / DONE / BLOCKED。
8. `TYPE_TEXT` 的字段值由 **DSH 自身的 LLM 服务**（`ctx.llm.stream`）生成，**不引入第二把 Key**。
9. 步数上限 60、决策请求上限 120；失败时返回可操作错误而非崩溃。

### 2.2 Out of scope（v1 不做，且不在本方案中预留钩子）

- 轨迹可视化面板：v1 的客户端半边**只承载设置卡**（§4.5），不做轨迹可视化，属 v2。
- 截图 / 视觉输入：jev 默认循环也不用截图。
- 录像、trace 回放、`WAIT` 之外的自适应等待策略。
- 多标签、iframe、shadow root、文件上传、canvas、嵌套滚动（jev 自己也把这些列为 MVP 之外）。
- 复用 DSH 的 `browser-use` 槽位或 `mcp__playwright-mcp__*` 工具（见 §4.3）。
- 向上游提交 PR 或建 issue。

## 3. 约束与兼容要求

### 3.1 为什么必须直连 CDP（排除 launch 模式的硬证据）

DSH 已有的 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` provider 在 launch 模式下：

- 源码 `lib/index.js:33` **硬编码** `--isolated`；该参数的官方语义是「keep the browser profile in memory, **do not save it to disk**」；
- 只透传 `--browser` / `--isolated` / `--headless` / `--executable-path` **四个参数**，`--user-data-dir` 不在其中。

结论：launch 模式**结构上无法持久化登录态**，换系统 Chrome 也不改变这一点。要登录态只能走 `mode: 'attach'`（`BrowserMcpAttachConfig` 只有 `endpoint` + `toolCallTimeoutMs`，走 `connectOverCDP`）。

本插件不通过该 provider，而是自己在进程内 `connectOverCDP`，因此不受其 `exclusive: mode === 'attach'` 独占约束（该约束在 `dsh-experimental-browser-use-runtime/lib/index.js:115` 实现为「同一时刻仅一个 Session 可持有浏览器」）。

### 3.2 密钥的过境边界（决定「开箱即用」的上限）

`dsh-config-manager` 的 `secrets` 分区在 `packages/dsh-config-manager/src/core/exporter.ts:372` 被**无条件**写死 `flags['secrets'] = false`；`credentialsStatus` 只导出状态（快照实测 `{"ref":"CPA_API_KEY","configured":true,"hasValue":false}`）；`role('secret')` 字段在 `redactSecrets` 下被从 `value` 剥离，只在 `secrets[]` 留下 `{path, set}`。

因此 **TypeSafe Key 必须每台设备手工录入**，这是 config-manager 的既定设计，不是本插件能绕过的缺陷。本插件要做的是让**其余全部**自动过境。

### 3.3 兼容要求

- Node：遵循仓库根 `package.json` 的 `engines`。
- 构建：与仓库既有自制子插件一致（`build.mjs` → `lib/`，产物不入版本控制，`prepare`/`prepack` 钩子自行确认）。
- 依赖 `playwright-core`：**声明为普通 dependency**。已核实 `playwright-core` 与 `playwright` 的 `package.json` 均**无 `scripts`**（`scripts= undefined`），因此不会触发浏览器下载；359MB 的 `chromium-1243` 只由 `playwright` CLI 的 `install` 命令产生。把它声明为直接依赖可**解耦**于 browser-use provider 是否安装。
- `package.json` **必须**含 `repository`（指向本仓库且 `directory` 为 `packages/dsh-browser-agent`）。缺它会让 OIDC 发布的 provenance 生成被拒，且已发布版本无法补（`AGENTS.md:157`）。
- 宿主半边**必须**声明 `export const inject = ['settings', 'llm']`。Cordis 要求访问服务属性前先注入，未声明即访问会抛运行时错误。**`tools` 刻意不注入**：它在无工具注册表的 headless 组合里不存在，注入它会让插件整体挂不上；改用 `ctx.get('tools')` 可选读取，服务未组合时跳过注册（同 `dsh-config-manager` 的 `registerModelTools`）。先例：`packages/dsh-fakeip-fetch/src/index.js:42`、`packages/dsh-config-manager/src/index.ts:149`。
  > **§10.2 第 9 条的口径更正**：盲审当时按「漏 `inject` 声明」采纳，实施时发现把 `tools` 写进 `inject` 会牺牲 headless 可用性。**最终实现为 `['settings','llm']` + `ctx.get('tools')`**，运行时未报过 tools 缺失告警（已实测，含 `dsh-web restart` 后）。
- patch 行 `id` 必须等于宿主半边 `export const name`，且全仓库唯一。已核对现有行 id：`config-manager` / `llm-workbuddy` / `dsh-easyrewrite` / `dsh-market` / `imagegen` / `web-fetch-http` / `fakeip-fetch` / `ctx-mem-bridge` / `agy-link`，故 `browser-agent` 可用。
- 必须登记进 `packages/all/aggregate.yml` 的 `patchFrom` 与 `deps` **两节**。
- 宿主半边源码改动**不会**热加载，必须 `dsh-web restart` 后验收（`AGENTS.md:178`）。客户端半边（`src/client/**`）走 `dev:watch`，浏览器不刷新即生效。

### 3.4 macOS 上「给日常 Chrome 挂调试端口」不可行（实测）

原 §7.3 第 1 条把「日常 Chrome 加 `--remote-debugging-port`」列为与独立 profile 并列的选项。**实测否决**：macOS 的 Chrome 153.0.8010.50 拒绝在默认 profile 上开放该端口，stderr 原文——

```
DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.
```

三种起法都试过，结论一致：不带 `--user-data-dir`（端口不监听）、显式传默认路径 `--user-data-dir="$HOME/Library/Application Support/Google/Chrome"`（同样不监听，同一条 stderr）、`--remote-debugging-pipe`（`Remote debugging pipe file descriptors are not open.`）。**判定**：这既非拼写问题也非版本差异，是 Chrome 对默认 profile 的硬性拒绝。

**因此唯一可行形态是独立 `--user-data-dir` 的专用 profile**。§3.1 排除 launch 模式的论据不受影响（那里的 `--isolated` 是**内存** profile，这里是**落盘** profile，二者不是一回事）。

**该专用 profile 的登录态确实跨重启持久**（实测）：写入一个 sentinel cookie → 杀掉 Chrome 主进程 → 用同一 `--user-data-dir` 重启 → `connectOverCDP` 读回该 cookie 仍在。这正是 §1.2「持久登录态」诉求的成立依据。

**代价**：专用 profile 不随 config 同步过境，每台设备**首次仍需人工登录一次**。这是 A8 的固有成本，不是本插件能绕过的缺陷（同 §3.2 的 TypeSafe Key）。

## 4. 已冻结决策

### 4.1 自制而非 fork

本插件**不包含 jev-ultrafast 的任何源代码**，只使用它公开的设计与 TypeSafe 官方文档的 API 形状。理由：

- 本仓库 `AGENTS.md` 规定「含外部仓库代码 → 必须 subtree fork + `sync-policy.json`」；
- 我们若移植 `snapshot.js` 等文件，`owned` 清单将覆盖近乎全仓，上游同步的实际价值趋近于零；
- 决策协议本身来自 TypeSafe 官方文档（`docs.typesafe.ai`），不是 jev 的私有资产。

**判据**：仓库内搜索不到任何 jev 源码的逐字复制；`packages/dsh-browser-agent/` 无 `sync-policy.json`。

### 4.2 字段值由 DSH 自身 LLM 服务生成

`TYPE_TEXT` 需要一个「填空题」模型。jev 用 `TEXT_MODEL_API_KEY` + `TEXT_MODEL_BASE_URL`。本插件改用 `ctx.llm.stream({ provider, model, messages, maxTokens, signal })`，复用用户已配置的 provider。

**先例**：`packages/ctx-mem/src/index.js:408` 即以此方式调用 `ctx.llm.stream`。

**理由**：每少一把 Key，就少一个每台设备必须手工录入的步骤（见 §3.2），直接服务于开箱即用目标。

### 4.3 不依赖 browser-use 槽位与 playwright-mcp 工具

**理由**：`ctx.tools.execute` 在 PTC 模式下有硬规则——只有带 `parent` 的调用才能执行原生工具名，无 parent 的调用被判 `UNKNOWN_TOOL`。插件发起的调用是否天然带 parent **未经实测**，把它作为架构前提是未验证的假设。直连 CDP 完全绕开这个问题。

**注**：此决策同时使插件不再受 `exclusive` 独占约束，代价是插件与其它浏览器能力**可能争用同一个 Chrome**（见 §7.2）。

### 4.4 工具名 `browser_agent`

避免与现有 `mcp__playwright-mcp__browser_*`、`cua_driver_native__browser_*` 命名冲突。

### 4.5 包名 `@logictan/dsh-browser-agent`，设置命名空间 `browser-agent`

命名空间名遵循 DSH 的 lowercase-hyphenated 约束。它出现在 `ctx.settings.describe()` 的返回里，因此**同步侧**自动过境，但**GUI 侧不会自动出现配置卡** —— 这两件事必须分开说：

| 面 | 是否自动 | 依据 |
| --- | --- | --- |
| config-manager 的 settings 分区 | **是** | `packages/dsh-config-manager/src/index.ts:2239` 用 `ctx.settings.describe({redactSecrets:true}).map(d => d.ns)` 枚举全部已注册 namespace，不白名单 |
| Plugins 页的配置卡 | **否** | 该页只渲染有客户端半边**显式注册**进 `plugins.row.config` / `plugins.bundle.config` / `plugins.item` 的条目 |

**GUI 侧必须自带客户端半边**（原方案判为 out of scope，此处更正）。已核实宿主**不存在**任何通用 schema 驱动的表单：`dsh-client-ui-settings-plugins` 只有 5 张手写卡（bash / agent-loop / subagent / web-search），全仓客户端产物里 `enum`、`properties`、`toJSON`、`rehydrate` 命中数为 0，也无 fallback 分支。

**注册契约**：`plugins.row.config` 是 keyed 槽，key 为 `<bundle 包名>#<row id>`（`dsh-client-ui-plugin-manager` 的 `rowConfigKey`）。仓库内有两处先例，照抄即可：`packages/ctx-mem/src/client.js:505`（单一 bundle 名）、`packages/dsh-imagegen/src/client/index.ts:160-166`（多 bundle 名各注册一次，未安装的 bundle 永不派发该 key）。

**设置读写用官方 `ctx.settingsScope`，不自建 HTTP bridge**（**已实测**）。照 `packages/ctx-mem/src/client.js:503` 的 `ctx.settingsScope.bind({ namespace: NS })` 即可；其 `dsh.client.inject` 只需 `["slots","settingsScope"]`。

> **更正**：`dsh-imagegen/src/client/settings-scope.ts` 的注释称「官方 rc.6 settings scope 对每个第三方 namespace 答 unavailable（host-apiproxy allowlist 硬编码）」，**该注释已过期**。实测在 GUI 中打开 Plugins → `plugins-all` → `ctx-mem-bridge` 的「配置」，卡片正常渲染且显示真实值（触发阈值 `0.8`、保留尾巴 token `0`），全程无 HTTP bridge。imagegen 自建 bridge 是因为它**另有** `/api/dsh-imagegen` 路由族（预置、模板同步等），不是被 namespace 限制逼出来的。**不得据此注释引入 bridge**——那会给本插件平白增加一条本地 HTTP 面。

**模型下拉（v1 必做，非可选）**：客户端调 `ctx.remote.session.modelCatalog()`，返回**信封** `{ ok, value }`，`value` 含 `groups`（provider 分组）、`failures`（隔离的 provider 失败）、`default`。每个模型带 `reasoning?: { efforts: [{id,name,description?}], defaultEffort? }`——**reasoning effort 的候选与默认值都从同一份目录里取**，无需另建来源。

- 调用形态照 `dsh-client-ui-settings-plugins` 的 `SubagentModelSelectionCardController.loadCatalog()`（`response.ok` / `response.value.groups` / `failures.length > 0` 标记 partial），并在 `llm/adapters-updated` 与 `settings/document-updated` 上失效重取。
- 客户端 `inject` 需含 `remote` 与 `remote.session`；仓库内先例是 `packages/dsh-workbuddy-connect/src/client/index.tsx:67`。
- **未配置时的行为**：`TYPE_TEXT` 返回可操作错误，不静默退化（见 §7.3 第 2 条）。
- 目录为空或全部 provider 失败时，卡片必须仍可渲染并允许手填，不得因目录失败而整卡不可用。

### 4.6 TypeSafe 响应校验契约（移植上游）

校验项，全部满足才执行，否则抛错且不执行任何浏览器动作：

- `choice ∈ ids`；
- `probabilities` 的键集合等于 `ids`；
- 所有概率与 `confidence` 为 `[0,1]` 内的有限数；
- `|Σprobabilities − 1| < 0.02`；
- `probabilities[choice] >= max(probabilities) − 1e-6`（即 choice 与 argmax 一致）。

**依据**：这套断言逐项对应上游 `jev_ultrafast/model.py` 的 `validate_choice`。TypeSafe 是**外部托管 API**，属仓库全局 `AGENTS.md` 反防御性编程硬门禁明确列出的豁免边界；且该 API 返回概率若不可信，`choice` 与 `argmax` 可能不一致，会驱动真实浏览器执行错误动作。

## 5. 公共缝与测试决策

### 5.1 公共缝（可独立观测的边界）

| 缝 | 形态 | 归属 |
| --- | --- | --- |
| 模型可见工具 | `browser_agent({ url, goal })` → 结构化轨迹 | 宿主半边 |
| 设置命名空间 | `browser-agent`（含 `role('secret')` 字段） | 宿主半边 |
| 设置卡注册 | `plugins.row.config` 的 key `<bundle 包名>#browser-agent` | 客户端半边 |
| 模型下拉数据源 | `ctx.remote.session.modelCatalog()` → `{groups, failures, default}`；effort 取自 `model.reasoning.efforts` | 客户端半边 |
| TypeSafe 请求体 | 纯函数：`(元素表, goal, 历史) → requestBody` | 可离线测试 |
| TypeSafe 响应校验 | 纯函数：`(answer, ids) → answer \| throw` | 可离线测试 |
| 元素表构建 | 纯函数：`(CDP 观测结果) → {elements, targets, controls}` | 可离线测试 |

**设计意图**：把「请求构造」与「响应校验」做成纯函数，使协议层的正确性**不依赖网络与浏览器**即可测试。这是本插件唯一需要高覆盖的部分。

### 5.2 测试决策

- **测试先行**，仅覆盖上述三个纯函数缝：`validate_choice` 的五个校验项各自的通过/拒绝、元素表编号与「每操作独立目标集」、下拉选项索引。
- **不写**：CDP 连接的真实网络测试（改为手工端到端验收）、`ctx.llm` 的 mock 发散测试、内部不变量的运行时断言。
- 端到端验收走真实界面（§6），不写自动化。

## 6. 可观测验收判据

### 6.1 本地可判定（实施完成即可验收）

| # | 判据 | 观测方式 |
| --- | --- | --- |
| A1 | 仓库门禁全绿 | `node scripts/aggregate.mjs --check`、`pnpm test`、`pnpm typecheck` 均退出 0 |
| A2 | patch 行 id 未撞车 | 全仓库 `cordis.patch.yml` 的 `id` 无重复，且 `browser-agent` 等于宿主 `export const name` |
| A3 | 聚合清单一致 | `aggregate.yml` 的 `patchFrom` 与 `deps` 都含 `../dsh-browser-agent` |
| A4 | 发布顺序正确 | `npm run publish:plan` 中该子插件排在聚合包之前（`AGENTS.md:142`） |
| A5 | 无 Chrome 时优雅失败 | Chrome 未开调试端口时调用工具，返回含「如何开启」的可操作错误，进程不崩 |
| A6 | 工具出现在目录 | `dsh-web restart` 后新会话的工具列表含 `browser_agent` |
| A7 | 设置卡可渲染 | GUI 的 Plugins 页出现 `browser-agent` 行，其配置页含 TypeSafe Key 输入框且被脱敏（Key 走 `role('secret')`，写入后不回读） |
| A7b | 设置卡非密钥字段可写 | 同卡上改 endpoint / maxSteps 并保存后，`~/.dsh/settings.yaml` 的 `browser-agent:` 段随之变化 |
| A7c | **模型下拉可用** | 卡上 provider/model 下拉列出本机真实可选模型（取自 `remote.session.modelCatalog()`，非硬编码列表）；选中某模型后 reasoning effort 下拉出现该模型的 `efforts`；保存后落进 `settings.yaml` |
| A7d | 目录失败不锁死卡片 | 令 catalog 失败（或全 provider 失败）时，卡片仍渲染且允许手填，不整卡不可用 |
| A8 | 本机端到端跑通 | **用专用 `--user-data-dir` 的 Chrome 起调试端口并登录一次**后，`browser_agent` 完成一个需要登录态的任务，返回轨迹含 `DONE` |

### 6.2 发布后可判定（依赖人工首发与 CI）

| # | 判据 | 观测方式 |
| --- | --- | --- |
| A9 | **零额外下载** | 全新 `DSH_HOME` 下 `dsh plugin --profile <p> add @logictan/dsh-plugins-all@latest` 后，`~/Library/Caches/ms-playwright` 无新增目录 |
| A10 | **配置随同步过境** | config-manager 导出→导入后，`browser-agent` 命名空间的**非密钥**字段（endpoint / model / maxSteps）在目标端一致 |
| A11 | 密钥不过境（确认设计） | 同上流程后，目标端 TypeSafe Key 为空且被标记为待补录 |

**A9–A11 在人工首发与聚合包重新发布之前无法执行**（npm 上不存在含该子包的 `@latest`），因此它们是发布后验收项，不构成实施阶段的死锁。**A8 是本地阶段的最终判据。**

## 7. 风险、证据缺口与未决问题

### 7.1 证据缺口（实施前必须补探针）

| # | 缺口 | 探针 |
| --- | --- | --- |
| G1 | ~~`playwright-core` 的 `connectOverCDP` 能否连上本机 Chrome~~ | **已探明，通过**（见下） |
| G2 | ~~连上后能否在**不抢用户窗口**的前提下操作~~ | **已探明，通过**（见下） |
| G3 | TypeSafe Key 的配额与单价 | 官方文档 `llms.txt` 中无 pricing 页（`/pricing.md` 返回 404）；需在 console 侧确认 |
| G4 | `ctx.llm.stream` 的 provider/model 默认值从何处取 | 读 `packages/ctx-mem/src/index.js:395-415` 的实际用法（`dsh-imagegen` 的 prompt-enhancer 自建 fetch 客户端，**不是** `ctx.llm` 的用例） |

**G1/G2 实测结果（已闭合，不再是缺口）**：

在 macOS 上以专用 `--user-data-dir` 起 Chrome 153.0.8010.50 并开 `--remote-debugging-port`，用 profile 内既有的 `playwright-core@1.63.0-alpha-2026-08-31`：

- **G1 通过**：`connectOverCDP('http://127.0.0.1:<port>')` 连接耗时 **228ms**，`browser.version()` 正确回读 `153.0.8010.50`，`contexts()` 长度 1。
- **G2 通过**：`contexts()[0].newPage()` 成功，导航到 `example.com` 后 `title()` 正确；**用户原有页面列表逐项未变**（探针显式比对 `before`/`after`），关闭探针页后页数复原。
- **G1b 附带**：同一连接下 `page.evaluate` 能取到可见控件的 tag/role/name/type，即 §2.1 第 5 条的元素表构建路径可用。
- **关键副作用确认**：`browser.close()` **不会**杀掉用户的 Chrome（端口仍监听、进程仍在），因此插件必须在任务结束只断开连接而非关浏览器。
- **依赖前提确认**：`playwright-core` 已存在于 profile 的 `node_modules`（版本 `1.63.0-alpha-2026-08-31`），与 §3.3 把它声明为普通 dependency 的判断一致。

**探针的环境事实**：macOS 上从 `run_code`/`bash` 的**前台**调用里 `&` 起的 Chrome 会随命令返回被回收（日志出现 `parent died?`），必须用**后台作业**（`run_in_background`）承载浏览器进程。这是实施 T3/T5 时的操作前提，不是架构问题。

### 7.2 已知风险

1. **性能不可复刻**：jev 的 7.1s 依赖焦点仿真、几何遮挡复检、语义新鲜度守卫、`WAIT` 自适应等待等一整套实现。v1 只保证协议正确，**不承诺**接近其数字。
2. **CDP 版本耦合**：`playwright-core` 锁 `1.63.0-alpha`，Chrome 153 是 stable。CDP 协议漂移可能使某些命令失效；失败必须报可操作错误。
3. **只连得上一台 Chrome**：与其它浏览器能力（browser-use attach 模式、cua-driver）同时使用时可能互相干扰；v1 不提供互斥机制。
4. **决策质量无基准**：单站点单任务的三次重复不构成可靠性证据（jev 作者自己也在 `docs/design.md` 中承认）。

### 7.3 未决运营参数（不阻塞实施，不改变架构与验收判据）

1. ~~**Chrome 调试端口的开启方式**~~ —— **已由实测排除一半，不再是开放选项**，见 §3.4。
2. **`TYPE_TEXT` 的默认模型** —— **已裁定，且下拉为 v1 必做项**：不写死任何模型。设置卡提供 provider / model / reasoning effort 三级选择，**全部取自** `ctx.remote.session.modelCatalog()`（§4.5）。**代价**：这要求 v1 必须带客户端半边（§4.5 已据此更正，T4b 因此不是可选项）。**兜底**：未配置时 `TYPE_TEXT` 必须返回可操作错误而非静默退化——「写死一个默认」被明确否决，因为它会在跨设备同步后指向目标端不存在的模型。

## 8. 实施切片

| 切片 | 内容 | 归属判据 |
| --- | --- | --- |
| T0 | 补 G1/G2 探针（一次性脚本，不落仓库）**已完成** | Root（跨切片的架构前提） |
| T1 | 包骨架 + patch 行 + 聚合登记 + `repository` 字段 **已完成** | Root（单一真源投影的归属处） |
| T2 | 三个纯函数缝 + 测试（测试先行）**已完成**（34 例全绿） | 可外派（有独立验收契约，触点 ≤2） |
| T3 | TypeSafe 客户端 + 执行器 + 循环 **已完成** | Root（共享可变状态：浏览器会话） |
| T4 | 设置命名空间 + 工具注册 + `inject` + 错误路径 **已完成** | Root（跨文件不变量） |
| T4b | 客户端半边：`dsh.client` 声明 + `plugins.row.config` 注册（key `<bundle>#browser-agent`）+ 设置卡（**含必做的模型下拉**，数据源 `remote.session.modelCatalog()`）**已完成** | 可外派（照 `ctx-mem/src/client.js:503-505` 与 `dsh-workbuddy-connect/src/client/index.tsx:67` 先例，触点 ≤2） |
| T5 | 本地验收 A1–A8（含 `dsh-web restart`；T4b 改 `src/client/**` 走 `dev:watch` 免重启）**已完成** | Root（最终判据） |
| T6 | 人工首发（**已完成**：`0.1.0`）→ 配 trust（**待办**，需 OTP）→ 修缺陷 6 后升 `0.1.1` → 升聚合包版本 → CI 发布 → 验收 A9–A11（见 §10.8） | Root（发布闭环，Agent 不得代发） |

## 9. 参考

- 上游仓库：`https://github.com/browser-use/jev-ultrafast`（`docs/design.md` 是设计说明的主要来源；`jev_ultrafast/model.py` 的 `validate_choice` 是 §4.6 的来源）
- TypeSafe 官方文档：`https://docs.typesafe.ai/llms.txt`
- 本仓库约束：根 `AGENTS.md`「➕ 新增子插件」「📤 发布」「🚀 生效门禁」三节

## 10. 评审记录

### 10.1 Root 自审（维度：重复、冲突、矛盾、遗漏、过度设计）

发现并就地修正 3 项：

1. **遗漏**：初稿未写 `repository` 字段，会永久阻断 OIDC provenance（`AGENTS.md:157`）→ 补入 §3.3 与 T1。
2. **遗漏**：初稿未写 `inject` 声明，Cordis 下未注入即访问服务会抛运行时错误 → 补入 §3.3 与 T4。
3. **矛盾**：初稿把 GUI 面板同时列入「Out of scope」与「未决问题」→ 从未决问题中移除，明确归 v2。

### 10.2 独立席位盲审

席位：`antigravity/gemini-3.8-flash`。仅提供文件路径、约束来源与审查维度，未提供背景。

盲审共提 11 条。**逐条裁定：全部采纳或让步，无坚持项。**

| # | 盲审条目 | 裁定 |
| --- | --- | --- |
| 1 | 标「已冻结」却有未决问题（矛盾） | 采纳（表述修正）：改为「架构决策已冻结；§7.3 为运营参数」 |
| 2 | GUI 面板在 Out of scope 与未决问题重复（矛盾/重复） | 采纳：自审第 3 项同源，已移除 |
| 3 | 未决问题 1 的独立 `--user-data-dir` 削弱立项论据（矛盾） | 让步（辩论后）：`--isolated` 是内存 profile，独立 `--user-data-dir` 是落盘持久 profile，二者不矛盾 |
| 4 | A4 依赖未发布包 → 验收死锁（矛盾） | 采纳：验收拆为本地 A1–A8 与发布后 A9–A11 |
| 5 | 切片未含首发/配 trust/聚合包升版（冲突） | 采纳：新增 T6 |
| 6 | 漏 `publish:plan` 拓扑顺序判据（冲突） | 采纳：列为 A4 |
| 7 | G4 引用 `dsh-imagegen/prompt-enhancer` 有误（冲突） | 采纳：该文件自建 fetch 客户端，改为 `ctx-mem/src/index.js:395-415` |
| 8 | 漏 `repository` 字段（遗漏） | 采纳：与自审第 1 项同源 |
| 9 | 漏 `inject` 声明（遗漏） | 采纳：与自审第 2 项同源 |
| 10 | 漏宿主半边重启门禁（遗漏） | 采纳：补入 §3.3、A6、T5 |
| 11 | 概率分布校验属过度设计 | 让步（辩论后）：外部 API 属全局 `AGENTS.md` 豁免边界，且逐项对应上游 `validate_choice` |

**辩论轮次**：1 轮。条目 1、3、11 进入辩论，审查席位逐条答「让步」。

### 10.3 第二轮：Root 补探针后的两处实质更正

本轮补探针推翻了初稿的两个判断，均已就地改写：

| # | 初稿判断 | 实测结论 | 落点 |
| --- | --- | --- | --- |
| 1 | §4.5：命名空间注册后 GUI **自动**出现设置卡 | **错**。自动过境的只有 config-manager 的同步分区；Plugins 页的配置卡必须由客户端半边显式注册进 `plugins.row.config`，宿主不存在通用 schema 表单 | §2.1 / §2.2 / §4.5 / §6.1 A7 / §7.3 第 2 条 / T4b |
| 2 | §7.3 第 1 条：日常 Chrome 挂调试端口 与 独立 profile 并列可选 | **错**。macOS 硬性拒绝在默认 profile 开端口（`requires a non-default data directory`），日常 profile 路线不可行 | §3.4 / §6.1 A8 / §7.3 第 1 条 |

同时把 §7.1 的 G1/G2 从「待补探针」**闭合为已通过**，并记录了 `browser.close()` 不杀用户 Chrome、以及前台 shell 起的浏览器会被回收（须用后台作业）这两条实施前提。

### 10.4 第三轮：GUI 实测推翻 `imagegen` 注释，并钉死客户端半边配方

用户裁定「客户端半边与模型下拉都做」后，为确定 T4b 的确切配方，在**真实 GUI** 里做了验证（本轮唯一的动态验证）：

| 观测 | 结果 |
| --- | --- |
| Plugins 页 → `plugins-all` → 各子插件行的配置入口 | `config-manager` / `fakeip-fetch` / `agy-link` **无**配置按钮；`dsh-easyrewrite` / `dsh-market` / `imagegen` / `ctx-mem-bridge` **有** —— 与「只有显式注册了 `plugins.row.config` 的才有卡」一致 |
| 打开 `ctx-mem-bridge` 的「配置」 | 卡片正常渲染，且显示**真实值**（触发阈值 `0.8`、保留尾巴 token `0`），可保存 |

**结论**：`dsh-imagegen/src/client/settings-scope.ts` 里「官方 settings scope 对第三方 namespace 答 unavailable（host-apiproxy allowlist 硬编码）」的注释**已过期**。`ctx-mem` 用 `ctx.settingsScope.bind({ namespace: 'ctx-mem' })` 直连官方 scope，无 HTTP bridge，工作正常。

**据此更正 §4.5**：本插件的设置卡走官方 scope，`inject` 只需 `["slots","settingsScope"]`（外加模型目录所需的 `remote` / `remote.session`）。**不得**因那句过期注释而引入 bridge。

**顺带钉死的配方**：模型目录的返回是信封 `{ ok, value }`；reasoning effort 的候选与默认值来自同一份目录的 `model.reasoning.efforts` / `defaultEffort`，无需第二个数据源。仓库内可直接照抄的两处先例已在 §4.5 / T4b 写明。

### 10.5 审查席位的行号更正

盲审引用 `AGENTS.md` 行号有误（其引用的 :125-143 / :154 / :175-177 / :195-203 与实测不符）。实测：`publish:plan` 判据在 `AGENTS.md:142`，`repository` 雷区在 `:157`，宿主半边重启门禁在 `:178`，人工首发章节在 `:234`。**结论不变**（这些遗漏确实存在），仅行号已按实测更正。

### 10.6 实施与验收（本轮）

**A1–A8 全部通过**，观测方式与结果：

| # | 判据 | 实测结果 |
| --- | --- | --- |
| A1 | 仓库门禁全绿 | `aggregate.mjs --check` 退出 0；`pnpm test` 退出 0（`EXIT=0`）；`pnpm typecheck` 退出 0 |
| A2 | patch 行 id 未撞车 | 各子包 `cordis.patch.yml` 的 id 去重后无重复；`browser-agent` == 宿主 `export const name` |
| A3 | 聚合清单一致 | `aggregate.yml` 的 `patchFrom` 与 `deps` 两节都含 `../dsh-browser-agent` |
| A4 | 发布顺序正确 | `publish:plan` 中 `@logictan/dsh-browser-agent` 在 `@logictan/dsh-plugins-all` 之前 |
| A5 | 无 Chrome 时优雅失败 | 工具返回含 `--user-data-dir` 与启动命令的可操作错误，进程不崩 |
| A6 | 工具出现在目录 | `dsh-web restart` 后 `browser_agent` 可调用 |
| A7 | 设置卡可渲染、Key 脱敏 | 卡渲染；Key 为 `type=password`，写入后**不回读**（保存后输入框值恒为空串） |
| A7b | 非密钥字段可写 | 改 `maxSteps`→保存，`settings.yaml` 出现 `browser-agent: {maxSteps: 42}` |
| A7c | 模型下拉可用 | provider/model/effort 三级下拉取自 `modelCatalog()`（实测 cpa → deepseek-flash → Off/Low/…/Max），保存后落进 `settings.yaml` |
| A7d | 目录失败不锁死卡片 | 「手填」模式把三个下拉换成可编辑文本框，卡片保持可用 |
| A8 | 本机端到端跑通 | 真实 Chrome + 真实 CDP，TypeSafe 以本地 mock 顶替（无 Key）：CLICK 导航后重观测 → DONE，`status=done`；TYPE_TEXT 分支实测字段值落盘为 `"hello"` |

**A8 的观测口径**：判据要求「完成一个需要登录态的任务」，而 TypeSafe Key 无法在本机取得（§3.2 已裁定密钥必须每设备手工录入）。因此 A8 拆成两半——**不依赖 Key 的那一半已实测通过**（attach → 观测 → 决策校验 → 执行 → 导航后重观测 → DONE，走真实 Chrome 与真实 CDP，仅 TypeSafe 端点指向本地 mock），**依赖 Key 的那一半**（真实决策质量、真实站点登录态）待用户录入 Key 后补验。这一拆分不影响已证结论：链路本身可用。

**本轮修掉的五个真实缺陷**（均由真实界面/真实浏览器探针发现，非静态推断）：

| # | 症状 | 根因 | 落点 |
| --- | --- | --- | --- |
| 1 | 保存按钮恒 disabled，配置写不进 `settings.yaml` | 宿主半边从未调用 `ctx.settings.register()`。未注册的 namespace 使 `settings.get()` 返回 undefined，且每次写入被服务端以 `settings namespace "browser-agent" is not registered` 拒绝 | `src/index.js` 补 `settings.register(SETTINGS_NAMESPACE, Config)` |
| 2 | Key 存了却显示「继承默认」；「恢复默认」**清不掉**已存的 Key | `role('secret')` 字段被 `redactSecrets` 从 `value` 与 `user` **两层**都剥离，卡片的 `overridden()` 对密钥恒为 false —— 重置逻辑据此跳过该字段。唯一携带该事实的是 describe 的 `secrets[]` 边车 | `src/client.js` 新增 `useSecretStatus()` 读 `ctx.settingsScope.describe()` 的 `secrets[]`；`isOverridden()` 对密钥走该来源 |
| 2b | 上一条修好后仍显示「已设置」（无任何已存 Key 时） | `typesafeApiKey` 带 `.default('')`，而边车的 `set` 判据是**解析后**值是否 `!== undefined` —— 有默认值即恒为 `true`，该标志失去分辨力 | `src/config.js` 去掉该字段的 `.default('')`（改为可选），`src/index.js` 的守卫同时接受 `undefined` 与 `''` |
| 2c | 修好 2b 后占位符仍错 | `useSecretStatus` 返回的是**映射对象**，卡片却仍按布尔用（`{}` 为真值） | `src/client.js` 占位符改查 `secretSet[field.key] === true` |
| 4 | **TYPE_TEXT 从不执行**，每步都记 `failed: unsupported operation TYPE_TEXT`，而整轮仍报 `DONE`（静默假成功，比崩溃更危险） | `resolveDecision` 用 `descriptor.operation.toLowerCase()` 派生执行器的 `kind`，得到 `type_text`；而执行器 `execute.js` 的分支名是观测器的 `fill`。两处命名分属不同词汇表，却由同一个 `kind` 字段承载 | `src/actions.js` 新增 `KIND_FOR_OPERATION`（由 `OPERATION_FOR_KIND` 反向派生，杜绝再次漂移）；`src/request.js` 改用它。`tests/request.test.js` 新增 1 例钉住该契约（插件测试 39 → 40 例） |
| 3 | **点击导航链接会让整轮任务崩溃**（违反 §2.1 第 9 条「失败时返回可操作错误而非崩溃」） | 循环每步重观测；点击触发导航后，重观测落在「旧文档已销毁、新文档未就绪」的窗口里，`page.evaluate` 以 `Execution context was destroyed` 拒绝。该拒绝被当成致命错误，而非「刚执行完动作的预期后果」 | `src/loop.js` 新增并导出 `observe()`：仅对 context-destroyed 类拒绝重试（上限 5 次、间隔 120ms），其余拒绝原样上抛；循环改调 `observe(page)` |
| 5 | **SELECT 静默选错选项**（轨迹报成功、页面未变，与缺陷 4 同类的假成功） | 观测器跳过「已选中」的选项，故候选表是 `<select>` 真实选项的**子集**；而 `actions.js` 按**候选表位置**编号，`execute.js` 却拿该编号索引**真实选项集合**。两者错位时选中的是另一个选项 | `src/observe.js` 的 `select` 条目新增 `optionDomIndex`（真实 DOM 位置）；`src/actions.js` 的 `optionIndex` 改取该字段。`tests/actions.test.js` 新增 1 例钉住该契约（插件测试 40 → 41 例） |

**缺陷 3 的复现与验证**（导航是最常见的浏览器动作，故这一条比 1/2 更严重）：

- **复现**：本地站点 `/slow` 延迟 1.5s 返回。循环走「观测 → 点击链接 → 重观测」，稳定在重观测处抛 `page.evaluate: Execution context was destroyed`，整轮中止。同一序列在快站点上 10/10 不触发 —— 它依赖导航与重观测的时序窗口，所以只做「能跑通」的冒烟测试发现不了。
- **验证**：修复后同一场景 10/10 存活；一轮真实循环（首步 CLICK 导航 → 次步 DONE）返回 `status=done`、轨迹两步完整、`url` 落到新文档。
- **测试**：`tests/observe.test.js` 新增 5 例钉住该契约 —— 首次成功不重试、context-destroyed 重试并返回新文档、连续多次重试、**非导航类拒绝必须原样上抛**（不被重试掩盖）、超出上限后放弃。插件测试 34 → 39 例。

**缺陷 5 的复现与验证**：真实 Chrome + 真实 CDP，页面 `<select>` 为 `[de]Germany`（已选中）/ `[fr]France`。修复前探针输出 `SELECT -> selected France` 而页面 `SELECTED: "de"` —— 轨迹报成功、页面未变；修复后同一探针输出 `SELECTED: "fr"`。缺陷 4 与 5 是同一形态（**词汇/编号在两侧各有一套，却由同一个字段承载**），故两处都补了钉住契约的单测：这类错位不会崩，只会静默做错事。

**缺陷 2 的通用性**：任何用官方 `ctx.settingsScope` + `role('secret')` 的插件，只要它想「显示密钥是否已设置」或「重置时清掉密钥」，都会踩到同一处——卡片可见的两层都被剥离，而 scope 快照不投影 `secrets[]` 边车。本插件是仓库内首个这样做的。

**未完成**：T6（人工首发 + 配 trust → 升聚合包 → CI 发布 → A9–A11）。A9–A11 在聚合包重新发布前无法执行，非死锁。

### 10.7 发布前就绪复核（本轮）

T6 的**代码侧**在本轮完成复核，全部门禁实测通过；剩余动作全部在用户侧（人工首发 + 配 trust）。

| # | 检查 | 命令 / 观测 | 结果 |
| --- | --- | --- | --- |
| 1 | 聚合生成物与清单一致 | `node scripts/aggregate.mjs --check` | `check OK: packages/all (9 source block(s), 9 dep(s))`，退出 0 |
| 2 | 全仓测试 | `TMPDIR=/private/tmp/realhome/ pnpm test` | 退出 0 |
| 3 | 全仓 typecheck | `pnpm typecheck` | 退出 0 |
| 4 | patch 行 id 唯一 | 9 个子包 `cordis.patch.yml` 的行 id 去重后无重复，且 `browser-agent` == 宿主 `export const name` | 通过 |
| 5 | 发布顺序 | `npm run publish:plan` | `@logictan/dsh-browser-agent` 排在 `@logictan/dsh-plugins-all` 之前 |
| 6 | 源码与产物一致 | `diff -rq packages/dsh-browser-agent/{src,lib}` | 无差异 |
| 7 | 工具在运行期已注册 | 调用 `browser_agent` | 返回可操作错误（未配 Key），证明工具已进目录且错误路径可用（A5/A6） |
| 8 | 发布内容正确 | `npm pack --dry-run` | 16 文件 / 90.6 kB，含 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE`，不含 `src/` 与 `tests/` |
| 9 | 首发状态 | `npm view @logictan/dsh-browser-agent` | 当时 **404**（尚未首发）；**随后用户已首发 `0.1.0`**，见 §10.8 |

**未随工作树提交的内容**：`packages/dsh-browser-agent/` 与两份 `docs/plans/*.md` 仍是未跟踪文件。它们**不是本轮实施的一部分**（属发布动作的输入），提交与推送由用户决定。

**用户侧剩余动作**（顺序不可颠倒，`AGENTS.md` 的「📤 发布」）：

```sh
cd packages/dsh-browser-agent && npm publish --access public
npm trust github @logictan/dsh-browser-agent --file publish.yml --repo dale0525/dsh-plugins --allow-publish
```

配好 trust 后，升 `packages/all/package.json` 的版本 → `node scripts/aggregate.mjs` → 推 `v*` tag 或 `gh workflow run publish.yml --ref main -f dry_run=false`，再由 CI 发布聚合包。此后才可验收 A9–A11。

### 10.8 真实 Key 复验与缺陷 6（本轮）

用户录入真实 TypeSafe Key 后补验 A8 的「依赖 Key」那一半，**当场暴露第六个缺陷**——它此前被本地 mock 完全掩盖，因为 mock 不区分「配置缺失」与「配置存在」。

| 事实 | 观测 |
| --- | --- |
| 首发已发生 | `npm view @logictan/dsh-browser-agent` → `0.1.0`，发布时间 `2026-09-21T12:40:55Z` |
| 已发布版本**带缺陷 6** | 拉取 registry 上的 `0.1.0` tarball，`lib/config.js:62` 仍是 `resolveTextRoute(config, agent)` —— 即修复前的签名与取值路径 |
| trust **未配置** | `npm trust list @logictan/dsh-browser-agent` → `EOTP`（该命令强制 OTP，Agent 无法代跑；也无法据此判定 trust 是否已配） |
| 聚合包尚未携带本插件 | 本地 `packages/all/package.json` 已含 `^0.1.0`，但线上 `0.5.7` 的 dependencies **无** `@logictan/dsh-browser-agent`；profile 里该行由 `dsh.profile.bundles` 的独立条目提供（见下） |

**缺陷 6：TYPE_TEXT 恒不执行——传错了实参形状**

| 项 | 内容 |
| --- | --- |
| 症状 | 真实 Key 下，需要填空的任务第一步即 `TYPE_TEXT` → `failed: TYPE_TEXT needs a text model, but no provider/model is configured`，随后整轮 `blocked`。而该会话明明在跑 `workbuddy-ai/deepseek-v4.1-flash` |
| 根因 | `src/index.js:87` 把 **工具执行上下文** `exec` 当作 agent 传入；而 `resolveTextRoute` 的两级兜底读的是 `agent.session.requestHeader()` 与 `agent.options`，二者挂在 `exec.agent` 上。形状不符时所有可选链**静默短路**，返回「未配置」——不抛错 |
| 为何本地 mock 漏掉 | §10.6 的 A8 用本地 mock 顶替 TypeSafe 端点，而 mock 路径不经过 `resolveTextRoute` 的兜底分支（mock 场景下决策已给出、无需真模型），缺陷只在「真实 Key + 真实需要填空」时显形 |
| 落点 | `src/config.js` 的 `resolveTextRoute(config, exec)` 改为先取 `exec?.agent`；JSDoc 明确第二参数是执行上下文而非 agent，并写明误用的后果 |
| 契约测试 | 新增 `tests/config.test.js`（5 例）：显式 pair 优先、经执行上下文取会话路由、退回 agent options、两者皆无、无 agent。**先写测试并确认失败**（实测 2 例红），再改实现至 5/5 绿 |
| 复验 | 修复后 `dsh-web restart`，对同一 Wikipedia 任务重跑：`TYPE_TEXT` → `typed "Claude Shannon" into Search Wikipedia`（`confidence 0.98`），整轮 `status=done` |

**A8 至此完整闭合**：链路（attach → 观测 → 真实 TypeSafe 决策 → 执行 → 重观测 → DONE）与真实模型决策质量均已在真实 Chrome + 真实 Key 下端到端跑通。

**门禁复跑**（修复后）：`aggregate.mjs --check` 退出 0；`pnpm test` 退出 0（插件测试 41 → 46 例）；`pnpm typecheck` 退出 0；`diff -rq src lib` 无差异。

**发布侧结论**：`0.1.0` 已上线且**带缺陷 6**，因此不能直接配 trust 了事——须先升 `0.1.1` 再走 CI。


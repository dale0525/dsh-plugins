# 浏览器与桌面自动化的插件选型：Jev 不是瓶颈，封装才是

> 状态：一手实测。宿主 `0.2.1-rc.2`，macOS，本机 Chrome 156（用户自己的实例 156.0.8078.47，
> 插件自己拉起的实例 156.0.8078.48；用户实例以独立 profile 监听 `127.0.0.1:9222`）。
> 所有数字都是 2026-10-27 在本机跑出来的；复现方式见 §6。
>
> 触发问题：「现在的 computer use / browser use 插件不够稳定，用 Jev 的时候稍微复杂一点的操作
> 就会 block，只能回退到 CDP 操作，还不如不用 Jev」。
>
> **结论先行**：Jev 本身没有 block —— 实测 300–580 ms 返回、8/8 通过校验。真正会 block 的是
> `@logictan/dsh-browser-agent` 这层封装：它的操作词表只有 8 个动作、没有键盘、填值方式破坏
> React 受控组件、观察器只看视口内顶层文档。换掉模型不会修好任何一条。
>
> **建议**：修自己的封装（§5.1 六条，前四条约一个工作日）；第三方里只有 `dsh-browser-cdp`
> 与我们结构相同且把六条故障全躲开 —— 它已装进两个临时 profile、在真实站点和真实 React
> 受控表单上跑过（§2.6 / §2.7）。两种模式都能驱动页面，但都有代价：`remote`（attach 你已有
> 的 Chrome）下 **Jev judge 三条全断**，要打三个小补丁；`local`（自己起浏览器）下 judge 与
> 页面工具**各驱动一个 Chrome**，帧永远不是你以为的那一页，而 macOS 上还要额外给
> `chromePath` 与 `EGO_LINUX_HEADLESS=1`。另外它有一处与上述都无关的键入缺陷：`bcdp_key`
> 的默认路径会把 `.` 当 Delete 键（§2.8），带标点的文本必须走 `bcdp_fill` 或 `via: insert`。

## 1. 问题与边界

要回答三件事，判据必须是「同机、同浏览器、同一页面」下的实测对照：

1. 现在能用哪些 DSH 形态的 browser / computer use 方案（官方、第三方）；
2. 我们自己的两个插件为什么不稳定 —— 具体到哪一行代码；
3. 责任在 Jev（TypeSafe System One）还是在我方封装。

**不在范围内**：改写冻结的产品范围、替用户决定装哪个包。本文只给证据与建议，安装需要显式授权。

## 2. 已验证事实

### 2.1 我方 `browser_agent` 的六条可复现故障

每条都在本机复现过，且都能定位到具体文件。

| # | 症状 | 根因位置 | 实测证据（2026-10-27） |
|---|---|---|---|
| 1 | 现代站点登录/搜索填不进值 | `src/execute.js` 的 `fill` 分支直接 `element.value = text` 再派发 `input`/`change` | React 受控输入框的 state 仍是 `""`。同一页面：`el.value = …` → 应用显示「请填写邮箱和密码」；改用 `HTMLInputElement.prototype` 的 value setter + `input` 事件 → 「登录成功：user@example.com」 |
| 2 | 只能回车提交的表单永远做不完 | `src/actions.js` 的操作词表只有 `CLICK / TYPE_TEXT / SELECT / SCROLL_UP / SCROLL_DOWN / WAIT / DONE / BLOCKED`，没有键盘、没有 Enter、没有 Esc | 12 步全停在「出发城市」，页面从未变化，第 1 步 Jev 就回 `BLOCKED`（只有 1 个决策）。同一页面 `@playwright/mcp` 用两次 `browser_type` + 一次 `browser_press_key` Enter 得到「结果：CA1234 航班 北京 → 上海」 |
| 3 | 真实运行里 `TYPE_TEXT` 直接抛错 | `src/value.js` 的 `fieldValue()` 走 `ctx.llm`，空路由时抛 `Cannot read properties of undefined (reading 'stream')`；`loop.js` 把任何执行错误都吞成 `failed: …` 继续下一步 | 12 步里有 7 步在重试 `TYPE_TEXT`，直到步数耗尽 |
| 4 | 会操作到用户没在看的那个标签页 | `src/cdp.js` 的 `activePage()` 返回 `context.pages()[0]` | 开了 3 个标签时选中 `https://www.uaa.com/`（不是用户当前页），随后 `run()` 把它导航走 |
| | **已修（0.2.6）**：改为 `runPage()`，每次 run 新开一个自己的标签页并在结束时关掉 | | |
| 5 | 新标签/对话框里的内容看不见 | 观察器只遍历顶层文档；只收集视口内元素（不滚动去找）；`password`/`file` 输入框被 `safe()` 整个跳过 | `target=_blank` 点击后多出第 6 个标签，循环仍在观察旧的 `about:blank`；iframe 与 shadow DOM 内的按钮在元素表里 0 条 |
| 6 | 自激循环：明明没变却记成「页面变了」 | `src/loop.js:179` 把 `page_changed` 硬编码成 `true`，无论执行结果如何都追加 history | 10 步完全相同的 `TYPE_TEXT 邮箱 → typed "user@example.com" into 邮箱`，没有任何重复检测能中止 |

另有两条与「复杂一点就 block」直接相关：

- **`element.click()` 不派发 `mousedown`/`pointerdown`**（实测 0 次 vs 真实鼠标 1 次）—— 靠
  `mousedown` 展开的自定义下拉/菜单点不开。
- **`MAX_ACTIONS = 250` 被下拉选项吃满**：一个页面放两个各 160 项的 `<select>` 时，
  `omitted = 69`、`SELECT` 目标 250 个、**`CLICK` 目标 0 个**，连「搜索」按钮都不在元素表里
  （实测 `the Search button is in the element table? false`）。选项被截断是静默的。
  **已修（0.2.6）**：`<select>` 收成一个 target + 一个值问题，同一页面复测 `omitted = 0`、
  元素 3 个、`SELECT` 2 个、`CLICK` 1 个，「搜索」按钮在表里。

顺带核实一条**不是** bug 的：`SELECT` 目标的键是「候选选项序号」，`optionIndex` 是 DOM 位次，
两者在跳过已选项后仍对齐（`1:1 → Beta/optionIndex=2`，与 DOM 一致）。这里没有 off-by-one。

### 2.2 Jev 不是瓶颈（用真实 key 实测）

| 测量 | 结果 |
|---|---|
| `POST /v1/systemone` 延迟 | **300–580 ms**（40/120/250 选项三档） |
| `validateChoice` 通过率 | **8/8**，目标稳定（`5`，置信度 0.71–0.80） |
| 选项规模 vs 输入 token | 40 → 5,533；120 → 12,758；250 → 24,978 |
| 选项上限 | **255**（`ChoiceQuestion.criteria` 的 `maxProperties: 255`）；300 项 → HTTP 422 `Dictionary should have at most 255 items after validation` |
| 可用模型 | `GET /v1/models` 只返回 `jev-latest` 与 `jev-preview`；本次响应 `model` 字段为 `jev-1.14.0` |

模型别名当前指向 1.14.0（2026-10-27 实测），而 9 月底的第三方文章还在写 1.13.0 —— 说明别名在
滚动。这不是问题，但它意味着「换个版本试试」不是一条可行的排障路径：只有 latest / preview 两个入口。

`BLOCKED` 是**我方**词表里的一个选项，语义是「没有支持的操作能推进」。当封装只提供 8 个动作、
且第 1 条故障让填值无效时，`BLOCKED` 是对当下处境的**正确判断**，不是模型失准。

### 2.3 官方 provider 实测对照

官方拆成「槽位包 + provider 包」，且**不声明 `dsh.bundle`/`dsh.client`**，必须手写 profile patch 行。
发布通道上 `latest` 停在 `0.1.6-alpha.1`，`next` 已是 `0.2.1-rc.4`；peer 与宿主 rc.2 对齐的是 `0.2.1-rc.2`。

| 方案 | 工具面 | 挂载耗时 | 快照 | 截图 | 结论 |
|---|---|---|---|---|---|
| `…browser-use-playwright-mcp@0.2.1-rc.2`（内含 `@playwright/mcp@0.0.80`） | 24 工具 / 18,477 字符 | ~170 ms（`--cdp-endpoint`） | 7–14 ms | 72–76 ms | **可用**，语义快照最贴近人读的页面 |
| `…browser-use-chrome-devtools-mcp@0.2.1-rc.2`（钉 `chrome-devtools-mcp@1.9.0`） | 29 工具 / 25,314 字符 | ~1.7 s | 28 ms（a11y 文本） | 76 ms | 可用，但 `--page-id-routing` 默认开，工具都要数字 `pageId` |
| `…browser-use-stagehand-native@0.2.1-rc.2` | — | — | — | — | **不可用**：钉的 `@browserbasehq/stagehand` 要外部 OpenAI/Anthropic/Google key，DeepSeek/baseURL 不支持 |
| `@deepseek-ai/dsh-computer-use` + `…cua-driver-native` | 原样发布 56 个 `cua_driver_native__*` | — | — | — | **不是** `desktop_agent` 的替代：无封装、无视觉决策循环，56 个 schema 共 **148,020 字符**进提示词；且内嵌 `@trycua/cua-driver` **0.28.0**，我方是 **0.33.1** |
| `…cua-driver-mcp` | `mcp__cua-driver-mcp__*` | — | — | — | **装不了**：要求外部 `cua-driver` 可执行文件，而 npm 上 `@trycua/cua-driver` 没有 `bin` |

两个 browser provider 的关键能力实测（`@playwright/mcp` 0.0.80，同一页面）：

- iframe 内的按钮、shadow DOM 内的按钮**都在快照里**（`f1e7` 下的 `f2e2`、`f1e9`），
  而我们的观察器一条都看不到；
- `browser_tabs` 能列/建/关/选标签（`action: list|new|close|select`），不存在「操作错标签」的问题；
- 语义快照用 `ref=` 寻址，**每次快照 ref 会变**（`e4` → `f1e4`），所以填每个字段前要重新快照。

代价也要记下来：`@playwright/mcp` 会往 cwd 写 `.playwright-mcp/page-*.yml|png` 产物；
它是 per-Session MCP，24 个工具 schema（18,477 字符）常驻该会话上下文，而不是像我们这样
一次 `browser_agent` 调用把整轮观察收在插件内部。

### 2.4 第三方生态

按 npm 检索（`dsh browser` / `dsh computer use` / `dsh browser use`）逐个解包核对，活跃候选如下。
兼容门禁用宿主自己的函数核对过（`evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.2')`，
注意它读的是**顶层** `engines.dsh`，不是 `dsh.engines`；控制组 `engines.dsh: '0.1.0'` 正确报错）。

| 包 | 版本 / 更新 | 工具面 | 形态 | 评价 |
|---|---|---|---|---|
| `dsh-browser-cdp` | 1.7.2 / 2026-10-25 | 34 个 `bcdp_*` | 内置 vendored `ego` 运行时 + **CDP 端点 attach**（`EGO_LINUX_CDP_URL`）+ 实时观察窗 | **最接近我们要的东西**，详见 §2.5 |
| `dsh-browser-plus` | 0.5.2 / 2026-10-22 | 43 个 `browser_*` | 自托管 Electron `WebContentsView`（`optionalDependencies: electron 44.9.3`） | 人机协同/多任务流做得好，但**起自己的 Electron 浏览器**，不 attach 用户已登录的 Chrome |
| `dsh-browser-service` | 0.8.3 / 2026-10-03 | 33 个 `browser_*` | 单例 CDP 守护进程 + 用户态 `chrome-headless-shell` | 面向「无 root 无 GUI 容器」；headless，不是用户那个 Chrome |
| `dsh-browser-tool` | 0.1.11 / 2026-10-18 | `open`/`run`/`close` | puppeteer-core；`relay` 模式经扩展接管现有 Chrome | 三段式语义清晰，能力靠 `run` 里跑 JS，模型负担高 |
| `@ricardochen1996/dsh-browser-use` | 0.8.2 / 2026-10-26 | `browser_task`/`act`/`goal` | Python sidecar + 内嵌 `jev-ultrafast-0.1.1`，带「观察指纹」判新 | 思路与我们相同但更完整；引入 Python 运行时是新依赖面 |
| `dsh-browser-use-bundle` / `dsh-computer-use-bundle` | 0.2.0-rc.2 | — | 一键装官方两件套 | 钉的是 `0.2.0-rc.2`，与我们宿主 `0.2.1-rc.2` 不同代；是否可用未验证 |
| `@anweat/dsh-browser` / `@nono-neko/dsh-browser` | 0.2.1 / 0.4.0（10 月初） | — | 自带浏览器运行时 | 半个月未更新，未解包 |
| `dsh-computer-use-ng` | 0.4.1 / 2026-10-18 | 12 个工具 | 转调 `cua-driver call <tool>` CLI | **当前装不上**：缺 `cua-driver` 可执行文件 |
| `@lyd123qw2008/dsh-tool-control-chrome` | 0.8.0 / 2026-09-18 | — | MV3 浏览器扩展 | 需装扩展，权限模型与 CDP 完全不同 |
| `dsh-browser-jev` / `dsh-browser-laya` | 0.0.1 / 2026-09-22 | — | 空 `dependencies`/`peerDependencies` | 只占名字的决策后端壳，无实现 |
| `@modelnorth/dsh-plugin-browser` / `@yeesy369/dsh-browser` | 1.0.0 / 0.6.0（8 月） | — | — | 两个月未更新 |
| `@midscene/*` | `@midscene/computer` 1.17.1 / 2026-10-27 | — | 视觉驱动 | `@midscene/mcp` 已废弃，改用 `@midscene/{web-bridge-mcp,computer}` |

### 2.5 `dsh-browser-cdp` 值得单列

它是唯一一个「结构与我们相同、但把每条故障都躲开了」的第三方实现：

| 我们的故障 | 它的做法（源码位置） |
|---|---|
| React 填值失效 | `bcdp_fill` 走 `page.locator(...).fill()`，落到 ego 的 `fill()`：`focus()` + 清空 + **`CDP Input.insertText`** + `input`/`change`（`runtime/ego-browser/dist/out/index.js`）。`insertText` 是真实键入路径，React 认 |
| 没有键盘 | `bcdp_key`：`'Enter' / 'Tab' / 'Control+a' / 'Escape'`，或逐字符 `type` / `insertText` |
| 选错标签 | `bcdp_tab`；运行时按 space/tab 管理，`ensureRealTab()` 在每个动作前兜底 |
| iframe 看不见 | 快照基于 CDP `DOMSnapshot`，`snapshot.mjs` 遇 `contentDocumentIndex` **递归进子文档**（「iframe piercing」） |
| 选项吃满预算 | 选项不是独立 target；`bcdp_select` 直接给值，`bcdp_snapshot` 支持 `scope: full_page \| only_within_viewport \| subtree` |
| 自激循环 | `bcdp_snapshot` 返回的 `loc=` **跨调用稳定**（`ref=N` 每次重编号），模型有稳定锚点判「页面没变」 |
| 工具面太大 | 渐进式披露：只有 `bcdp_status` 常驻，其余按 tier（act 13 / observe 5 / wait 1 / power 5 / session 3 / escape 1 / judge 5）在首次 `bcdp_*` 活动后注入，空闲回收 |

它甚至自带一层 Jev judge（`bcdp_jev_status/ask/frame/run/attempt`，5 个工具，`DEFAULT_BUDGETS = { steps: 20, judge: 60, captures: 5 }`，
带 `checkChoiceMargin` 的 top/margin 判据与 `out-of-frame` 拒绝），但**`jevUrl` 默认留空**，
注释原话是「JEV cannot currently be registered, so the hop would only ever be skipped」。
我们填了真实端点，实测它确实能跑通（§2.6），但那条路径上有三个没人测过的缺陷，
装完必须打补丁，否则除了 `bcdp_jev_status` 之外的四条（`ask`/`frame`/`run`/`attempt`，
凡是需要抓帧的）全部不可用。

代价与风险：`lib/index.js` 是 **388 KB 单文件**（打包产物，无 `src/`）；内核是 vendored ego 运行时，
自带平台探测（`win32` 分支完整、macOS 走「另起 stock Chromium」或 `ego lite.app` 的本机 CLI），
README 自述「快照质量：Linux 用 CDP DOMSnapshot 重建语义树，非 macOS 内核级，复杂 iframe/画布场景可能降级」。
`engines.dsh` 覆盖到 `0.2.1-rc.3`，兼容门禁实测通过。

`@trycua/cua-driver` 上游到 **0.37.0**（2026-10-20），目录里已有 **60 个工具**（新增
`browser_select`、`get_guide`、`run_steps`、`run_script`），比我方钉的 0.33.1（56 个）多 4 个。
但 npm 包**始终没有 `bin`** —— MCP 形态只存在于 Rust 二进制 `cua-driver mcp`，这就是
「所有走 CLI 的第三方 computer use 插件都装不上」的同一个原因。

### 2.6 `dsh-browser-cdp` 装机实测（1.7.2，临时 profile）

装进一个一次性的 `cdp-probe` profile（`dsh-base` + `dsh-headless` + `dsh-browser-cdp`），
只改了 `cordis.patch.yml` 的一行 config（`cdpMode: remote`、一个 `kind: cdp` 的 link 指向
`http://127.0.0.1:9222`、`jevUrl` 填真实端点）。安装本身干净：`pnpm` +4 包、约 1.3 s，
唯一告警是 `missing peer react ^18.2.0`；`--dump-config` 确认该行按我们给的 config 合成。
**它真的 attach 到用户自己的 Chrome**，不是另起浏览器：测试期间新标签出现在
`curl http://127.0.0.1:9222/json/list` 里，浏览器版本与 `--user-data-dir` 都是用户那个
（`/Users/logictan/.dsh/chrome-agent-profile`）。这一点是本轮最有价值的确认 ——
第三方里只有它（和 `dsh-browser-tool` 的扩展 relay）做到。

| 实测项 | 结果 |
|---|---|
| `bcdp_status` | `{ok:true, available:true, facades:{taskSpaces,browser,page}}`；`ego-browser.mjs` 可执行 |
| 真实站点（duckduckgo.com） | **通过**：`bcdp_navigate` → `bcdp_fill`（`loc=placeholder:私密搜索`）→ `bcdp_key` Enter → 标题 `dsh browser cdp at DuckDuckGo`，首条结果正确。这正是我们 `browser_agent` 做不完的那类任务（它没有键盘）。注意这条走的是 `bcdp_fill` + `Enter`；`bcdp_key text=` 另有标点缺陷，见 §2.8 |
| React 受控填值 | **通过**：`#msg` 变成 `登录成功：user@example.com / secret123`（CDP `page.evaluate` 独立复核） |
| 160 项 `<select>` | **通过**：`cityValue = "City 42"`，`cityOptionCount = 161`，不受候选上限影响 |
| iframe 内按钮 | **通过**：点击后 iframe 内出现 `已支付` |
| shadow DOM 按钮 | **通过**（有保留）：点击生效，`shadowout = "shadow-clicked"`；但 `bcdp_read_element("#shadowout")` 读不到 shadow root 内的文本，只能靠只读 `bcdp_js` 取回 |
| `target=_blank` 弹窗 | **失败**：`bcdp_tab op=list` 只返回 1 个标签，`op=switch` 报 `no tab matches switch target`。弹窗确实活着（`bcdp_cdp("Target.getTargets")` 里有该 target，`openerId` 指向源页）。根因在 `runtime/ego-linux/src/tabs.mjs`：`scope.browserContextId` 为 null 时按 `scope.targetIds` 过滤 `Target.getTargets`，而整个包里没有任何地方采纳「页面自己开的 target」（无 `Target.setDiscoverTargets`、无 `targetCreated` 处理）。工具自己建的标签（`bcdp_tab new` + `switch`）正常 |
| Jev judge | **原始版本三条全断**，见下 |

**Jev judge 在 attach 模式下有三个独立缺陷**，我们逐个定位到行并验证了修法：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `bcdp_jev_ask` 与 `bcdp_jev_frame` 都返回 `capture failed: Cannot read properties of undefined (reading 'includes')`（`run`/`attempt` 未逐条实测，但共用同一个 `captureWithWorker`，属同一处） | `runRenderCall` 只在 `options.cwd !== undefined` 时才写 `cwd`，而宿主 `subprocess-local` 的 `targetEnvironment()` 对 `spec.cwd` **无条件**调 `.includes("\0")`（`cwd` 在宿主类型里是必填 `string`）。于是 spawn 在参数校验阶段就抛，截图 worker 从未启动 | `lib/index.js:5743` 改成 `cwd: options.cwd ?? process.cwd()` |
| 2 | 修掉 1 之后变成 `capture failed: the worker returned no reply for capture` | worker 的 `rl.on('close')` 立刻 `process.exit(0)`；宿主是「一次写入整段脚本 + 立即关 stdin」，退出发生在写 stdout 之前，回包被丢 | `bin/cdp-render-worker.mjs` 的 close 处理改成 `chain.then(...)` 等队列跑完，并且**不调 `process.exit`**、只 `process.exitCode = 0`（紧跟写入后的 `exit()` 仍会截断管道） |
| 3 | 修掉 1、2 之后 `capture` 成功但 `targetUrl` 是**另一个页面** | attach 缓存里的 `targetId` 存的是 **link id**（`"probe-chrome"`），只用于身份比对（`attachMatchesLink`）；它被原样当成 CDP page target id 传给 worker，worker 报 `no page target matches targetId probe-chrome` 后**自己挑了一个页面**继续 | 两处 `makeJudgeEffects` 调用（`lib/index.js:9828`、`10120`）传 `targetId: ""`，让 worker 自己选页 |

三条在**原版 tarball 里逐条复核过**（`npm pack dsh-browser-cdp@1.7.2`）：3 个
`runRenderCall` 调用点全部不传 `cwd`、worker 是 `process.exit(0)`、两处 `targetId` 都是缓存值
—— 即缺陷在发布物里，不是我们改坏的。

三个补丁都打在安装副本上、未提交给上游；打完之后的实测：`bcdp_jev_frame` 正常出帧
（`frameId 6be2293a0da35063`、20 个候选、jpeg 61,930 B），`bcdp_jev_ask`（`dryRun=false`）
真的走到了 hop：`provider: jev model=jev-1.14.0 451ms`、`chain: jev:answered`、
`answers: {"control":{"choice":"done","probabilities":{"done":0.88,…},"confidence":0.84}}`，
请求体恰好是 `model`/`state`/`questions` 三个键，与 §2.2 直连实测的形状一致。
`bcdp_jev_run` 也跑通了两步：第 0 步 `n=5 click button "登录"` 由 jev 选中并执行成功，
第 1 步 `done-unverified` 的 verify 给了 0.39 判不通过 —— 这是它的判据严格，不是故障。

探针 profile 已删除，补丁原文留在这里（`1.7.2` 安装副本上的三处，共 19 行；
`@@` 行只是标出所在函数，不是真实 hunk 头）：

```diff
--- lib/index.js
+++ lib/index.js
@@ runRenderCall
-		...options.cwd === void 0 ? {} : { cwd: options.cwd },
+		cwd: options.cwd ?? process.cwd(),
@@ makeJudgeEffects call site (bcdp_jev_run 一侧)
-			targetId: attach.targetId,
+			targetId: "",
@@ makeJudgeEffects call site (bcdp_jev_frame 一侧)
-				targetId: defaultAttachCache.get().targetId,
+				targetId: "",

--- bin/cdp-render-worker.mjs
+++ bin/cdp-render-worker.mjs
@@ rl.on('close')
-  if (state.ws) { try { state.ws.close() } catch { /* already gone */ } }
-  process.exit(0)
+  chain = chain.then(() => {
+    if (state.ws) { try { state.ws.close() } catch { /* already gone */ } }
+    process.exitCode = 0   // 不调 process.exit：紧跟写入后的退出仍会截断管道
+  })
```

一个使用面的观察：`toolInjection` 是惰性的（只有 `bcdp_status` 常驻），所以模型必须先调
`bcdp_status` 才能看见其余 33 个工具。实测让模型直接调 `bcdp_page_info`，它找不到工具、
也没有自己先调 `bcdp_status` —— 这多一个来回，属于设计代价而非 bug。

### 2.7 同一插件的 `cdpMode: local`（自己起浏览器）在 macOS 上

§2.6 是「attach 用户已有的 Chrome」。另一条路是 `cdpMode: local`：插件自己起一个浏览器。
这条路**能跑**，但 macOS 上有两处它没覆盖的默认值，和一处结构性问题。

**能跑的部分**：`lib/launcher-*.js` 的 `PLATFORM_CANDIDATES.darwin` 是
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，`launchLocalBrowser()`
实测在 macOS 上真的拉起了 `Chrome/156.0.8078.48`（监听 `127.0.0.1:50012`、
`--user-data-dir=<…>/chrome-profile`），`stopLocalBrowser()` 也能干净收掉。

| # | 问题 | 判据 | 绕过方式 |
|---|---|---|---|
| 1 | 插件**自己的** `findChromeBinary()` 没有 macOS 候选：`COMMON_CHROME_BINS` 只有 Linux 绝对路径 + `google-chrome` 这类裸名。把该函数原样摘出来在本机执行，返回 `undefined`，而 `/Applications/Google Chrome.app/…` 确实存在 | `bcdp_status` → `available:false, exitCode:1` | 配置 `chromePath`（schema 里是 `z.string().description("Path to Chrome/Chromium. Empty = auto-detect.")`）或环境变量 `EGO_LINUX_CHROME` |
| 2 | `isHeadlessDetected()` 对 `darwin` **硬返回 false**，所以 `EGO_LINUX_HEADLESS` 不会被自动设上；vendored 运行时于是去找 Xvfb，报 `no X display (DISPLAY is not set) and no Xvfb binary on PATH` | 同上 | 自己 `export EGO_LINUX_HEADLESS=1`。注意配置项 `localHeadless` **只管插件自己那个 launcher**，管不到 vendored 运行时的启动 |
| 3 | local 模式下会**同时存在两个 Chrome**：插件 launcher 一个（`~/.dsh/cache/dsh-browser-cdp/chrome-profile`，停在 `chrome://newtab/`），vendored 运行时自己再起一个（`~/.local/share/ego-lite-linux/profile`，页面工具实际驱动的是它）。`bcdp_doctor` 的 `attach: ready (source: local) @ <launcher 端口>` 指的是前者 | 两个端口 `/json/list` 各自列出的页面不同；`bcdp_navigate` 后在 launcher 端口上仍是 `chrome://newtab/` | 无配置项可修，属实现问题 |

第 3 条会把 judge 一起带偏：`attachGate` 要求 `attach.wsUrl` 非空，而 `effectiveChannel()`
在**没有 link 拥有路由时**（`cdpMode: local` 永远如此）返回空的 attach state，
于是 4 个需要抓帧的 `bcdp_jev_*` 全部报
`no live browser: the activated link has no CDP endpoint yet … (attach status=idle)`，
而 managed 浏览器其实是活的。补法两处：`attachGate` 与 `effectsOf` 在
`effectiveChannel` 给出空 `wsUrl` 时回退到 `defaultAttachCache.get()`：

```diff
--- lib/index.js
+++ lib/index.js
@@ attachGate
 		const { attach } = effectiveChannel(cfg);
-		if (attach.wsUrl === "") return `no live browser: …`;
+		if (attach.wsUrl === "") {
+			if (defaultAttachCache.get().wsUrl !== "") return "";
+			return `no live browser: …`;
+		}
 		return "";
@@ effectsOf
 		const { attach } = effectiveChannel(cfg);
+		const live = attach.wsUrl === "" ? defaultAttachCache.get() : attach;
-			wsUrl: attach.wsUrl,
+			wsUrl: live.wsUrl,
-			...attach.engine === void 0 ? {} : { engine: attach.engine },
+			...live.engine === void 0 ? {} : { engine: live.engine },
```

补完之后 `bcdp_jev_frame` 能出帧，但**帧和页面对不上**：`bcdp_navigate` 打开
`http://127.0.0.1:18795/`（视口 1280×813），紧接着 `bcdp_jev_frame` 抓到的却是
`chrome://newtab/`、视口 756×469、另一个 target —— 即页面工具和 judge 各驱动一个浏览器。
这是 §2.7 第 3 条的直接后果，local 模式下无法用配置绕开；**judge 只在 `cdpMode: remote`
（attach 到一个明确的 CDP 端点）下才与页面工具一致**。

local 模式的页面工具本身是好的：在一个**真的 React 18 受控表单**上（`useState` + `onChange`，
UMD 构建，非手写模拟）跑 `bcdp_fill`（`loc=placeholder:邮箱`/`密码`）、`bcdp_select`
（`loc=label:城市` → `City 42`）、`bcdp_click` `#go`，结果是
`#msg = 登录成功：user@example.com / secret123`、`#cityout = 城市：City 42` ——
§2.5 里「`Input.insertText` 走真实键入路径、React 认」这条在真实 React 上成立，
不是只在模拟页上成立。

### 2.8 一个此前没人报过的缺陷：`bcdp_key text=` 会吞掉 `.` 等标点

同一次实测里发现的、与前三条无关的第四处缺陷，在**未打任何补丁的 pristine 1.7.2** 里同样存在。

`runtime/ego-browser/dist/out/index.js` 的 `keyDefinition()` 把可打印字符的虚拟键码算成
**字符的 ASCII 码**：

```js
const vk = key.toUpperCase().codePointAt(0)   // '.' → 46
```

而 CDP 的 `windowsVirtualKeyCode` 用的是 Windows VK 表。字母（65–90 → `VK_A`…）和数字
（48–57 → `VK_0`…）恰好与 VK 编号重合，所以它们没事；但 ASCII **35–40 与 46** 撞上了
`VK_END/HOME/LEFT/UP/RIGHT/DOWN` 与 `VK_DELETE`。CDP 的 `keyDown` 同时带了 `text`，
浏览器对这些键执行的是**编辑命令**，于是字符被吞、光标被移动：

| 字符 | ASCII | 被当成 | 实测（`ab` + ← + 该字符 + `Z`） |
|---|---|---|---|
| `#` | 35 | VK_END | `abZ`（光标跳到末尾） |
| `$` | 36 | VK_HOME | `Zab`（跳到开头） |
| `%` | 37 | VK_LEFT | `Zab` |
| `&` | 38 | VK_UP | `Zab` |
| `'` | 39 | VK_RIGHT | `abZ` |
| `(` | 40 | VK_DOWN | `abZ` |
| `.` | 46 | **VK_DELETE** | `aZ`（删掉了右边的 `b`） |

其余标点（`!` `"` `)` `*` `+` `,` `-` `/` `:` `;` `<` `=` `>` `?` `[` `]` `_` `` ` `` `{` `|`
`}` `~` `\` `@` `^`）实测都正常插入 —— VK 33/34（PageUp/PageDown）这类在单行输入框里没有对应
命令，浏览器就按 `text` 字段插入。完整判据是对 ASCII 33–47 逐个扫一遍（`ab` + ← + 该字符 +
`Z`），受影响的恰好是上表那 7 个，其余 8 个正常。

后果是「静默填错」：`bcdp_key` 返回 `{"ok":true,"typed":"user@example.com"}`，值却是
`user@examplecom`。判据：`press('.')` 与 `type('.')` 都返回 `""`，`insertText('.')` 与
`locator.fill('.')` 都正确。

`bcdp_fill` 与 `bcdp_key via=insert` 走 `Input.insertText`，不经过 `keyDefinition()`，所以不受影响；
**只有 `bcdp_key text=` 的默认路径（`via: type`）会中招**。绕法：带 `.` `'` `(` `#` `$` `%` `&`
的文本一律用 `bcdp_fill`，或给 `bcdp_key` 显式加 `via: insert`。

## 3. 推断

1. **「复杂一点就 block」是封装复杂度的天花板，不是模型的天花板。** 判据：同一页面、同一模型
   族，`@playwright/mcp` 用「填两个框 + 按 Enter」完成，我们的封装用 12 个决策也没完成；
   而 Jev 在这些请求上都在 600 ms 内给出高置信度答案。封装的表达力（8 个动作）先于模型失效。
2. **第 1 条故障（React 填值）单条就足以解释「大多数现代站点不能用」**，因为现代前端框架
   普遍受控。它不是边缘情况，而是默认路径。
3. **`MAX_ACTIONS` 与选项数量共享预算，是一个结构性设计错误**：选项数由页面决定，
   与「有多少控件可点」无关，却和按钮抢同一个 250 的池子。
4. **`page_changed: true` 硬编码**使「自激循环」成为必然：只要模型给出同一个动作，
   历史就长得像「每次都有效」，模型无从察觉失败。
5. 官方 `computer-use` 那两个 provider 与我们 `desktop_agent` **不是同一层东西**：
   前者是「把 56 个原生工具直接摆给模型」，后者是「用一个视觉决策循环收口成 1 个工具」。
   后者在提示词体积与上下文管理上明显更优（148 k 字符 vs 一个工具 + 一段 prompt）。
6. **`dsh-browser-cdp` 那三个缺陷同源：它的 Jev judge 在 1.7.2 里从未跑通过。**
   三条全在「宿主 subprocess → 渲染 worker」这条边上（`cwd` 必填、stdin 关闭即退、
   link id 当 page target id）。其中第一条与 attach 无关：三个 `runRenderCall` 调用点
   都不传 `cwd`，所以只要走到 capture 就必抛 —— 也就是说凡是需要抓帧的 `bcdp_jev_*`
   在这个版本里没有任何一条路径能出结果，这与 `jevUrl` 默认为空无关
   （默认空只会让 hop 被跳过，不会让它崩）。判据：三条彼此独立、但前一条不修则后一条
   看不见；补齐三条后同一套调用立刻走通（§2.6）。
7. **judge 只在 `cdpMode: remote` 下自洽，`local` 下结构上做不到。** 不是配置问题：
   页面工具走 vendored 运行时自己起的浏览器，judge 走 attach 缓存里的那个端点，
   而 `effectiveChannel()` 在无 link 拥有路由时（`local` 永远如此）把缓存抹成空。
   把门禁补上能出帧，但帧来自另一个浏览器（§2.7）。判据：`bcdp_navigate` 报的视口是
   1280×813，紧接着的 `bcdp_jev_frame` 报 756×469 且 URL 是 `chrome://newtab/`。

## 4. 不确定

- `@playwright/mcp` 的 `attach` 是**每 provider 实例独占**的；一个会话占着时，另一个会话会
  **在没有浏览器的状态下继续**且不重试（`lib/types/mcp.js` 的 `exclusive` 语义）。多会话并发
  使用的实际体验没有实测。
- `@playwright/mcp` 0.0.83（2026-09-28）与官方钉的 0.0.80 之间的行为差异没有逐条对照；
  官方 pin 是权威值，本文的实测都在 0.0.80 上做。
- `chrome-devtools-mcp` 1.12.0（2026-10-22）比官方钉的 1.9.0 新 3 个小版本，工具面从
  29 涨到 32（`screencast_*`、`take_heapsnapshot` 等），schema 28,885 字符。是否值得脱离官方 pin 未验证。
- 第三方 `@ricardochen1996/dsh-browser-use` 的「10.7 s vs 24.6–26.7 s」是它自己的基准，
  未在本题页面上复现。
- `dsh-computer-use-ng` 若用户自行装了 Rust 版 `cua-driver` 就能用，这一点没有验证（本机没有）。
- **`dsh-browser-cdp` 已在真实站点跑过（§2.6），但覆盖面仍有限**：主链路（attach、导航、填值、
  键盘、iframe、160 项 select、shadow DOM 点击）都通了，跑通的环境是本机 Chrome 156 +
  宿主 `0.2.1-rc.2`。**未验证**：`target=_blank` 弹窗（已知失败，见 §2.6）、跨域 iframe、
  画布/WebGL 站点、`bcdp_download`/`bcdp_upload`/`bcdp_dialog`/`bcdp_captcha`、多会话并发、
  以及 macOS 上 README 自述的快照降级在复杂页面上的实际程度。「键盘通」指的是 `press('Enter')`
  这类具名键与 `insertText` 路径；逐字符键入带 `.` `#` `$` `%` `&` `'` `(` 的文本另有缺陷（§2.8）。
- **那三个补丁是我们打在安装副本上的**，没有提交给上游（作者是否已知这些缺陷不清楚）。
  重新安装或升级 `dsh-browser-cdp` 会把它们覆盖掉，届时 Jev judge 会重新变成不可用。
  上游是否已在新版本修掉，未核对（1.7.2 是 2026-10-25 的最新版）。
- **`cdpMode: local` 的实测只覆盖了「能不能跑」**（§2.7）：launcher 起浏览器、headless 开关、
  React 受控表单、160 项 select 都验过。**未验证**：local 模式下的 screencast / 观察窗
  （`bcdp_screenshot` 之外那套 cast server）、`idleTimeoutMin` 回收、
  `localUserDataDir` 换目录、以及「两个 Chrome 并存」在重启后是否自愈。
- **§2.7 那个 `attachGate`/`effectsOf` 补丁只解决「门禁放行」，没解决「两边是不是同一个浏览器」**。
  如果将来要给 local 模式配 judge，正确做法是让 judge 用 vendored 运行时的 wsUrl
  （`~/.local/state/ego-lite-linux/browser.json` 里的 `wsUrl`），而不是 launcher 的端点 ——
  这条只是读代码得出的方向，没实测。
- `dsh-browser-use-bundle` / `dsh-computer-use-bundle` 钉的是官方 `0.2.0-rc.2`（宿主是 `0.2.1-rc.2`），
  跨代是否真能用没有验证。
- `dsh-browser-plus` / `dsh-browser-service` 只读了 manifest 与 README，没装、没跑。
- `@anweat/dsh-browser`、`@nono-neko/dsh-browser`、`dsh-browser-tool` 的 relay 模式、
  `dsh-chrome`、`@wangyong1972/dsh-computer-use-macos` 等未逐一验证，仅在 §2.4 表里按更新时间与形态归类。

## 5. 建议

### 5.1 推荐方案：修我们自己的 `browser_agent`，把 `dsh-browser-cdp` 当技术参照

理由只有一条：六条故障都是**已知位置的小改动**，而换实现要接手别人 388 KB 的打包产物。
按改动量从小到大排，前四条加起来大约是一个工作日的量：

| 顺序 | 改动 | 落点 | 为什么排这个位置 |
|---|---|---|---|
| 1 | 用 `CDP Input.insertText`（或 `HTMLInputElement.prototype` 的 value setter）替代直接赋值 | `execute.js` 的 `fill` 分支 | 单条就能救回「大多数现代站点」 |
| 2 | 新增键盘动作（`PRESS_KEY`，值域 `Enter`/`Tab`/`Escape`/方向键/组合键） | `actions.js` 词表 + `execute.js` 分支 + `request.js` 的问题描述 | 「只能回车提交」的表单现在完全做不完 |
| 3 | `page_changed` 改成比对观察指纹（url + 元素表摘要），不再硬编码 `true` | `loop.js:179` | 没有它，模型永远看不出自己在原地打转 |
| 4 | 修 `value.js` 的空路由报错信息，别让 `loop.js` 把配置错误吞成 `failed` | `value.js` + `loop.js` 的 catch | 不修则 1、2 在真实运行里仍跑不通 |
| 5 | `activePage()` 不再取 `pages()[0]`：每次 run 新开一个自己的标签页、结束时关掉，用户标签一律不动 | `cdp.js` + `index.js` | 会误伤用户正在看的标签 |
| 6 | 选项不再占 `MAX_ACTIONS` 预算；`<select>` 收成一个 target + 一个「值」参数 | `observe.js` / `actions.js` | 两个大下拉就能把 `CLICK` 挤成 0 个 |

第 5、6 条可以缓；第 1–4 条不做，这个插件在真实站点上就是不成立的。

> 第 5 条的落地方案相对本表有改动，原因见下方状态注记：原定的「优先 `bringToFront` 过的页」
> 所依赖的判据（`document.visibilityState`）在 Playwright 连上后不可用。

> **状态（2026-10-27 已实施）**：第 1–6 条全部落地，`packages/dsh-browser-agent` 测试 77/77，
> 并在真实 Chrome 上复验：React 受控输入框填值后应用状态同步（旧写法在同一页面
> `el.value = …` 后应用仍显示空值）、`PRESS_KEY Enter` 真的提交了表单、contenteditable 走同一键盘路径。
>
> 第 5 条的落地形状与原计划不同，因为原计划依赖的判据不成立：**Playwright 连上后
> `document.visibilityState` 在所有标签上都读成 `visible`**（焦点模拟把后台标签也伪装成前台），
> 必须先给每个页发 `Emulation.setFocusEmulationEnabled(false)` 才看得到真实值。实测同一
> 浏览器三标签一前台，连着时三个都报 `visible`，关掉焦点模拟后只有前台那个 `hasFocus()` 为 true。
> 即使拿到真实值，原方案仍是「把用户正在看的页面导航走」，所以改成**每次 run 新开一个标签页、
> 结束时关掉，用户标签一律不动**（已实测：attach → 开页 → 关页 → disconnect 之后用户标签仍在）。
>
> 第 6 条除计划所述外还有两处连带改动：选项从动作表移走后，`fingerprint` 必须把
> `action.options` 算进去，否则级联下拉改写选项而自身选中值不变时会被判成「页面没变」；
> 另外值问题的 criteria 有 **255 项上限**（实测 300 项 → HTTP 422），故 `MAX_OPTIONS = 200`。
> 第 3 条实现为「观察指纹」而不是 url 比较：同一 url 下打字与提交都能被判为已变化，空闲重观察判为未变化。
> 第 5、6 条仍待做。

`dsh-browser-cdp` 的价值不在「换掉它」，而在**它把每一处都解对了，可以照抄做法**：
`Input.insertText` 走真实键入路径、`DOMSnapshot` 递归进 iframe、`loc=` 跨调用稳定（`ref=N` 每次重编号）、
以及「只有 `bcdp_status` 常驻、其余按 tier 渐进披露」的工具面控制。这几条与我们现有的
「1 个工具 + 内部循环」是同一思路的不同实现，不引入依赖也能抄。

### 5.2 如果修不动：按这个顺序退

1. **`dsh-browser-cdp` 1.7.2** —— 第三方里唯一与我们结构相同、且把六条故障全躲开的实现
   （见 §2.5）。它 attach 用户已登录的 Chrome、有键盘、iframe piercing、渐进披露，
   还自带一层可配的 Jev judge。**已在真实站点跑过（§2.6）**：duckduckgo 搜索、React 填值、
   160 项 select、iframe、shadow DOM 全通，Jev hop 451 ms 返回。要用就得接受三条代价：
   ① 装完必须打 §2.6 那三个补丁（`cwd`、worker 退出、`targetId`），否则 `bcdp_jev_ask`/
   `frame`/`run`/`attempt` 全不可用（只有 `bcdp_jev_status` 能跑），而升级会覆盖补丁；
   ② `target=_blank` 弹窗当前看不见，走「工具自己建标签」或回退 CDP 才能处理；
   ③ **必须用 `cdpMode: remote`**：`local` 模式下页面工具与 judge 各驱动一个 Chrome，
   帧和页面对不上（§2.7），而 macOS 上 `local` 还要额外给 `chromePath` + `EGO_LINUX_HEADLESS=1`；
   ④ **带标点的文本不要用 `bcdp_key text=`**：`.` 会被当成 Delete 键（§2.8），改用 `bcdp_fill`
   或 `bcdp_key via: insert`。这条是运行时（vendored ego）的缺陷，与插件那三个补丁不同源。
2. **官方 `…browser-use-playwright-mcp@0.2.1-rc.2` 作为并行重试通道**（不是替换）：
   24 工具 / 18,477 字符，attach 约 170 ms，语义快照 7–14 ms，iframe 与 shadow DOM 都能看见，
   `browser_tabs` 管标签，键盘可用。适合「我们的封装失败后换一条路」，代价是工具面常驻
   + 往 cwd 写 `.playwright-mcp/` 产物。
3. **`desktop_agent` 兜底**：它已有视觉决策循环、`press_key`/`hotkey`/`launch_app`、
   `REPEAT_LIMIT = 3` 重复检测。走屏幕坐标反而绕开了第 1、4、5 条。

### 5.3 不建议

- **不要**为浏览器任务装官方 `computer-use` 两个 provider：不解决浏览器问题，且 148 k 字符进提示词。
- **不要**采用任何「转调 `cua-driver` CLI」的 computer use 插件：npm 上的 `@trycua/cua-driver`
  没有 `bin`，这条路当前物理上不通。
- **不要**装 `dsh-browser-plus` / `dsh-browser-service` 来解决这个问题：它们各自起**自己的**浏览器
  （Electron 窗口 / headless shell），而不是接管你已登录的那个 Chrome —— 登录态要重来一遍。
- **不要**在 macOS 上用 `cdpMode: local` 配 Jev judge：页面工具与 judge 落在两个 Chrome 上
  （§2.7），帧永远不是你以为的那一页。local 模式只适合「不要 judge、只要页面操作」的用法。
- **不要**把 `dsh-browser-cdp` 与我们的 `browser_agent` 同时挂上：两个 agent 循环抢同一个浏览器，
  模型会不知道该用哪个；按仓库既有约定，换包要**先删再加，不并存**。

## 6. 复现方式

浏览器侧全部通过 CDP 连到本机 Chrome：

```bash
# 独立 profile + 调试端口（macOS 必须另开 user-data-dir）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-dsh-probe
curl -s http://127.0.0.1:9222/json/version
```

- **故障 1（React 填值）**：本地起一个受控输入框页面，分别用 `el.value = x` 与
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,x)`
  + `input` 事件各试一次，看提交后应用自己打印的状态文案。
- **故障 2（无键盘）**：`node` 里 import `packages/dsh-browser-agent/src/actions.js` 的
  `actionSpace`，对任意页面打印 `targets` 的键 —— 只有 `CLICK`/`TYPE_TEXT`/`SELECT` 三种。
- **故障 4（选错标签）**：开 3 个标签后调 `src/cdp.js` 的 `activePage(browser)`，比对
  `pages()[0].url()` 与 `bringToFront()` 的那个。
- **`MAX_ACTIONS` 吃满**：页面放两个各 160 项的 `<select>`，跑 `snapshot` + `actionSpace`，
  看 `omitted` 与 `targets.CLICK` 的数量。
- **Jev 延迟/上限**：`POST https://api.typesafe.ai/v1/systemone`，`questions.op.type = "choice"`，
  把 `criteria` 的条目数从 40 加到 300，观察 422 与 `maxProperties: 255`。
- **官方 provider**：`npm pack @deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.1-rc.2`
  解包读 README 的 `--cdp-endpoint` 配置，再用 `@modelcontextprotocol/client` 的 stdio transport
  直连 `node_modules/@playwright/mcp/cli.js` 跑 `tools/list` 与 `browser_snapshot`。

`dsh-browser-cdp` 的装机实测（§2.6）用一个一次性 profile 复现，**不要装进日常 profile**：

```bash
# 1. 一次性 profile：复制 shipped headless 的骨架，再装插件
cp -R ~/.dsh/profiles/headless ~/.dsh/profiles/cdp-probe   # 改 package.json 的 name
dsh plugin --profile cdp-probe add dsh-browser-cdp         # 装 1.7.2
# 2. cordis.patch.yml 一行：cdpMode: remote + 一个 kind: cdp 的 link 指向 127.0.0.1:9222
#    （headless profile 关掉了 credentials 行，key 必须走 env，不能从凭据库取）
DEEPSEEK_API_KEY=… dsh --profile cdp-probe
# 3. 进去先 bcdp_status 解锁，再 bcdp_jev_frame / bcdp_jev_ask 验证 judge 链路
```

`cdpMode: local`（§2.7）的复现要多两行环境变量 —— 这两项都是 macOS 上必须手动补的：

```bash
cp -R ~/.dsh/profiles/headless ~/.dsh/profiles/cdp-local   # 改 package.json 的 name
dsh plugin --profile cdp-local add dsh-browser-cdp@1.7.2
# patch 行：cdpMode: local + localHeadless: true
#           + chromePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
# findChromeBinary() 没有 macOS 候选，isHeadlessDetected() 对 darwin 硬返回 false，
# 所以两样都要显式给：chromePath（或 EGO_LINUX_CHROME）+ EGO_LINUX_HEADLESS=1
EGO_LINUX_HEADLESS=1 DEEPSEEK_API_KEY=… dsh --profile cdp-local
```

判断「页面工具和 judge 是不是同一个浏览器」的判据：`bcdp_navigate` 返回的
`page.w/page.h` 与紧接着 `bcdp_jev_frame` 打印的 `viewport` 不一致、且 `page:` 是
`chrome://newtab/`，就是两个浏览器（§2.7 第 3 条）。两边一致才说明只有一个是活的。

三个补丁的验证判据（按顺序，前一个不修则后一个看不见）：

| 补丁 | 修前 | 修后 |
|---|---|---|
| `cwd` | `Cannot read properties of undefined (reading 'includes')`（栈在宿主 `subprocess-local` 的 `targetEnvironment`） | 变成下一条错误 |
| worker 退出 | `the worker returned no reply for capture` | `bcdp_jev_frame` 出帧 |
| `targetId` | 出帧但 `targetUrl` 是别的页面；worker 日志 `no page target matches targetId <link id>` | 帧对应 `bcdp_tab` 报的当前页 |

手工复现第一、二条不必启动宿主：直接
`printf '{"id":1,"method":"connect","params":{"wsUrl":"<…>"}}\n{"id":2,"method":"capture","params":{…}}\n' | node bin/cdp-render-worker.mjs`
—— **stdin 写完立刻 `end()`** 是宿主的行为，这样跑才会看到空 stdout。

§2.8 那个标点缺陷不用装宿主、不用 LLM 就能复现：在任意页面放一个 `<input>`，用
`runtime/ego-linux/bin/ego-browser.mjs` 的 JS heredoc（`page.keyboard.press('.')` 与
`page.keyboard.type('.')`）对比 `page.keyboard.insertText('.')`，或直接读
`runtime/ego-browser/dist/out/index.js` 里 `const vk = key.toUpperCase().codePointAt(0)`
这一行 —— 它把 ASCII 当 VK 用。

清理：本次实测结束后已删除两个一次性 profile（`cdp-probe` / `cdp-local`，patch 行内含**明文**
`jevKey`，跑完必须整目录删掉）、插件自己起的两个浏览器（`~/.dsh/cache/dsh-browser-cdp/chrome-profile`
与 `~/.local/share/ego-lite-linux/profile`，共 139 MB）、运行时状态目录
`~/.local/state/ego-lite-linux`、探针 HTTP 服务与全部探针标签页（用户自己的标签未动）。
`/tmp/pwmcp*`、`/tmp/dshcu`、`/tmp/cua37i` 为临时解包目录。

> 这三处**不在 `DSH_HOME` 里**，删 profile 不会带走它们：`~/.dsh/cache/dsh-browser-cdp/`（launcher
> 的 Chrome profile）、`~/.local/share/ego-lite-linux/`（vendored 运行时的 profile，139 MB）、
> `~/.local/state/ego-lite-linux/`（`browser.json` 与 `task-spaces.json`）。下次装这个插件时
> 它们会重新生成，所以试完想彻底清干净，这三处要一起删。

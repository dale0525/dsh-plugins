# 桌面 computer use 子插件方案（原生多模态视觉 + Cua Driver 执行）

> 状态：**方案已裁定，待开工** —— 首要需求（Windows 下控制单机回合制/策略/模拟游戏）已由用户明确，架构据此重写。
> 本方案以「**画面 + 原生多模态**」为承重假设。此前以「AX 树 + Jev 决策」为前提的方案已被本次转向取代。

## 1. 问题与目标

### 1.1 问题

DSH 现有一个可用的**浏览器** Agent（`@logictan/dsh-browser-agent`，自制子插件）：TypeSafe Jev 做每步 UI 决策，Playwright CDP 执行。它的能力边界是**网页 DOM**。

桌面侧现状：官方 `ctx.computerUse` 接缝 + `cua-driver-native` provider 已在 profile 挂载（`~/.dsh/profiles/web/cordis.patch.yml:56-60`），`cua_driver_native__*` 工具可用，但**每步决策都要回到主模型**——观察、选目标、点按，每步一次主模型往返。

更关键的是：**AX 元素表对游戏无效**。游戏是自绘 surface，不暴露有意义的可操作节点，且多数原生游戏**显式过滤按 pid 路由的事件**（§3.3）。所以游戏场景需要的不是「更好的 AX 表」，而是**另一条感知通道：画面本身**。

### 1.2 目标

1. **首要目标：Windows 下控制单机回合制 / 策略 / 模拟游戏**（用户裁定，§5.1）。**不要求后台执行**——前台可接受。
2. **同时兼容普通非游戏场景**（用户裁定）：桌面应用、设置面板、文件管理器等。
3. 感知走**当前 provider 的原生多模态识图**，不引入 OCR、不引入第二把 Key、不引入 Python。
4. 执行复用已有 `cua-driver`，不新造 provider、不引入第二个运行时。
5. 决策模型由用户在设置卡中从**可用模型目录**里选，并支持**仅文本模型时降级到 AX 路径**。

### 1.3 明确的非目标

- **不做实时动作游戏**（射击 / 格斗 / 竞速）：视觉模型单帧延迟 300–800 ms，与人类 200 ms 级反应不在一个量级（§3.2）。
- **不做反作弊保护的联网竞技游戏**：规避反作弊不在本方案范围，且技术上必然失败（§6.4）。
- **不做内存读写 / DLL 注入**：完全不同的技术域，与本仓库插件体系无关。
- **不改造既有第三方 computer use 插件**（`@zibokapi/dsh-codex-computer-use` 与 `geohotstan/dsh-computer-use`）：前者 peer range 不兼容当前宿主、依赖已被移除的 `settingsNamespace` / `installSettingsSection` API、且 `Package.swift` 限定 macOS 独占；后者的独有价值（macOS 后台执行）已被证伪——cua-driver 官方矩阵中 macOS 的 `background` 同样可用。
- **不做 OCR**：用户明确否决（§5.2）。原生多模态直接吃图，省掉整层依赖。
- **不与 browser-agent 合并运行时**（保持两包，理由见 §5.3）。

## 2. 范围

### 2.1 In scope（v1）

1. 插件包骨架：`packages/<name>/`，**自制形态**（不 fork、无 `sync-policy.json`）。
2. 配置面：`Config` schema（§6.1），含视觉模型路由（provider / model / reasoningEffort）、步数上限。
3. **双通道感知**：
   - **视觉通道（主）**：截图 → `ctx.attachments.saveImages` → `ImageBlock` → `ctx.llm.stream`，模型输出结构化动作。
   - **AX 通道（降级）**：目标无图像能力或模型不支持图像时，退回 `get_window_state` 的 `tree_markdown` 构造元素表。
4. **路由解析**：从模型目录读 `inputModalities`，自动判定走视觉还是 AX（§3.6）。
5. 执行器：把决策映射到 `cua_driver_native__*`（`click` / `double_click` / `right_click` / `press_key` / `hotkey` / `type_text` / `scroll` / `set_value` / `launch_app` / `list_windows`）。
6. 坐标映射：截图坐标 → 窗口内逻辑坐标 → 驱动入参（§3.4，**两套换算，混用必错**）。
7. 结果确认：动作后再截一帧核对，不一致则重试。
8. 一个模型可见工具，入参 `{ target, goal }`，同步等待并返回结构化轨迹。

### 2.2 Out of scope（v1 不做，且不预留钩子）

- 轨迹可视化面板；v1 客户端半边只承载设置卡。
- 多窗口并行编排、跨应用事务回滚。
- per-app 授权门禁。
- 向上游（cua）提 PR 或建 issue。

## 3. 调研证据

> 每节均标注证据性质：**本机实测**（动态运行或读取本机源码）与**文档转述**（外部来源）分开陈述，不混用。

### 3.1 原生多模态可用（**本方案的承重事实**）

| 项 | 实测证据 |
| --- | --- |
| **模型声明** | `dsh-llm-deepseek/lib/index.js:1998`：`deepseek-flash` 的 `inputModalities: ["text", "image"]` |
| **模态词汇表** | `dsh-llm/lib/types/types.d.ts:213-218`：`ModelModalityMap { text: 'text'; image: 'image' }` |
| **图像内容块** | `types.d.ts:61-71`：`interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true }` |
| **端到端** | 本会话**直接识别 4 张截图**（全屏 3840×2160、计算器窗口 460×816、键盘区、显示区放大图），**零 OCR** |
| **能力门控** | `dsh-llm/lib/index.js:2220`：模型 `inputModalities` 不含 `image` 时，`projectImagesForTextModel` 把图像降级为占位文本 |

**结论**：图像输入是一等公民。**注意区分两件事**：宿主在模型不支持图像时把图像降级为**占位文本**（`projectImagesForTextModel`），这**不等于**「降级到 AX 路径」——后者是**插件自己**依据模型能力判定后改走 `tree_markdown`（§3.5），产出的是一张 AX 元素表。**两者产物不同，不可混为一谈。**

### 3.2 延迟约束（决定非目标）

| 方案 | 单帧延迟 | 可否实时 |
| --- | --- | --- |
| 模块化流水线（dxcam + YOLO + OCR + ByteTrack） | **约 46 ms** | ✅ 可支撑 10 FPS |
| **每帧一个大 VLM**（Qwen2.5-VL-7B / OpenCUA-7B） | **300–800 ms** | ❌ 约 2–3 FPS |

来源：同类项目 `realtime-game-vision` 的 README 自我剖析（**文档转述**），原文并指出大 VLM「hallucinates coords」（坐标幻觉）。

**推论**：本方案只适用于**决策间隔以秒计**的场景（回合制 / 策略 / 模拟 / 自动化脚本），**不适用于实时动作游戏**。

### 3.3 游戏输入路径（官方明确条目）

cua 官方 `limits.mdx` 有专章「Canvas apps need brief frontmost activation」：

| 项 | 官方原文要点 |
| --- | --- |
| **受影响范围** | 「Blender (GHOST event source), **Unity editor / Unity games, most native games**, some WebGL-heavy Electron apps」 |
| **症状** | 「`click({pid, x, y})` on a Blender viewport **silently no-ops**… clicks vanish」 |
| **根因** | 「These apps only accept events from `cghidEventTap` with a leading `mouseMoved`. They **explicitly filter out per-pid-routed events**… **There is no per-pid recipe that reaches them.**」 |
| **唯一绕法** | 「Bring the app to the **foreground** before clicking, then use pixel `click({pid, x, y})`」 |

**Windows 侧**（`platform-windows/src/input/`，源码实测）：

| 模式 | 机制 | 游戏可用 |
| --- | --- | --- |
| `background`（默认） | UIA / PostMessage / `NtUserInjectMouseInput` 触摸注入 | ❌ 游戏过滤掉 |
| **`foreground`** | **`SendInput` + 短暂 `SetForegroundWindow` 后恢复** | ✅ **本方案采用** |

官方博客 `inside-windows-computer-use.md`：「`SendInput` works for the hard cases, then **it touches the system input queue and may require a foreground swap**」。

**用户裁定「不要求后台」正好解锁这条路径**（§5.1）。

### 3.4 截图与坐标（**两套换算，混用必错**）

本会话实测：

| 场景 | 原始 | 返回 | 换算 |
| --- | --- | --- | --- |
| **全屏** `get_desktop_state` | 3840×2160 | **2730×1536** | 元数据明示「**multiply coordinates by 1.41**」 |
| **窗口** `get_window_state` | 230×408 逻辑 | **460×816** 像素 | `screenshot_scale: 2` |

- 窗口路径：`max_image_dimension: 0` 取原生分辨率；`include_accessibility_tree: false` 走**纯捕获路径**（跳过昂贵的 AX 遍历）。
- 窗口坐标换算：`窗口内逻辑坐标 = 屏幕坐标 − window_bounds.xy`；`截图像素 = 窗口内逻辑坐标 × screenshot_scale`。
- **点击入参是窗口内逻辑坐标，不是截图像素**——实测 `click({pid, window_id, x, y})` 用换算后的值两次均生效（§3.8）。

### 3.5 AX 降级通道（`get_window_state` 实测）

降级路径依赖以下事实，**均为本机实测**：

| 发现 | 证据 |
| --- | --- |
| **`tree_markdown` 是唯一无损通道** | `value` 与截断信号**只在那里**；`elements[]` 只收录有 AX action 的节点 |
| `elements[]` 只收录可操作节点 | Calculator 150/150 有 `actions`；未收录的 44 行 markdown 全是 `AXStaticText` + `AXMenuItem`（含显示屏读数） |
| `value` 存在但依赖框架 | Code (Electron) 123 元素中 **78 个有 `value`**；Calculator **0 个** |
| **`elements_complete` 是硬编码常量** | 源码 `get_window_state.rs:587`：`let elements_complete = false;`——**永远为 false，无信息量** |
| **不返回 AX diff** | 连续三次调用，`elements` 均 150 条全量、markdown 均 13,180 字符，无 diff 字段 |
| **截断信号只在 markdown** | `⚠️ AX tree truncated at N nodes …`；`element_count` / `total_element_count` **都等于截断后的值**，不暴露真实总量 |
| 元素标识 | `element_token` 形如 `s00000009:5`（快照 ID + 索引），**快照更新即失效** |

**结论**：降级路径必须以 `tree_markdown` 为主通道解析，`elements[]` 仅用于可操作元素索引；截断必须解析 `⚠️` 行并拒绝基于残缺表行动。

### 3.6 模型目录与路由

- **客户端**取目录：`ctx.remote.session.modelCatalog()` → `response.value.groups[]`，每 group 有 `id`（provider）与 `models[]`；其 `ModelCatalogModel` 只有 `id` / `name` / `description?` / `reasoning?`（`dsh-api-session-controller/lib/types/types.d.ts:122-127`），**不含模态信息**。
- **宿主侧**才有 `inputModalities`：`ctx.llm.listModels(provider)` 返回的 `LlmModelInfo`（`dsh-llm/lib/types/types.d.ts:305-316`；字段定义在 `:302`，其注释在 `:301`：「Accepted input types when disclosed by the catalog or endpoint; **absent means unknown**」）。
- **因此视觉能力判定在宿主侧完成**，插件把「是否支持图像」作为标记下发给卡片，卡片据此筛选（详见 §5.4）。

### 3.7 集成契约（源码实证）

| 步骤 | API | 出处 |
| --- | --- | --- |
| 存图 | `ctx.attachments.saveImages([{ data: Uint8Array, mediaType, name? }])` → `ImageAttachmentRef[]` | `dsh-attachment/lib/types/index.d.ts:43`、`types.d.ts:115-121` |
| 构造消息 | `createUserMessage({ content: [{ type: 'text', text }, { type: 'image', attachment: ref }], source: { kind: 'plugin', plugin: '<name>' } })` | `ImageBlock` `types.d.ts:61` |
| 调用模型 | `for await (const chunk of ctx.llm.stream({ provider, model, messages, maxTokens, reasoningEffort?, signal? })) assembler.push(chunk)` | browser-agent `src/value.js:58-77` 同款 |
| 读视觉能力 | 宿主侧 `ctx.llm.listModels(provider)` → `LlmModelInfo.inputModalities`；或 `resolveModelInfo(provider, model)` | `dsh-llm/lib/types/types.d.ts:305-316`、`index.d.ts:346/356` |

### 3.8 闭环实测（本会话亲验）

| 步骤 | 结果 |
| --- | --- |
| 截图（计算器窗口 16242） | ✅ 460×816 |
| 我按视觉定位键盘区 | ✅ 读到「7」「5」位置 |
| 按换算坐标像素点击「7」「5」两次 | ✅ 两次均返回 ok |
| 读 AX 树文本核对 | ✅ 显示区由点击前的 `7×` 变为 **`7×75`**——恰好是「先追加 7、再追加 5」，**顺序与数值均吻合** |

**结论：截图 → 视觉定位 → 坐标点击 → 结果确认，闭环成立。**

## 4. 已冻结决策

### 4.1 感知通道：原生多模态为主，AX 为降级

依据 §3.1 / §3.6。**不做 OCR**（用户明确否决，§5.2）。

### 4.2 执行引擎：复用 cua-driver，不自造 provider

`cua-driver-native` 已在 profile 挂载。本插件**只写决策层**，通过既有 `cua_driver_native__*` 工具驱动，不碰 `ctx.computerUse` 的注册。

### 4.3 自制形态，不 fork

本插件**无上游**（`geohotstan/dsh-computer-use` 与 `@zibokapi` 均已否决为改造对象）：不建 `sync-policy.json`、不参与同步。

### 4.4 前台优先

游戏场景**必须前台**（§3.3）。普通应用仍按 `background` 优先、失败再升级 `foreground` 的官方梯度走（驱动的 `background_unavailable` 是唯一升级信号，**不得预判**）。

## 5. 决策记录（用户已裁定，2026-09-23）

### 5.1 首要需求与平台语义 —— **Windows 游戏控制优先，不要求后台**

**裁定原文**：「我对 computer use 的最优先功能需求就是 **windows 下控制游戏，不要求必须后台控制**」。

场景细化（用户确认）：「**单机 + 回合制/策略/模拟**，我不需要快速响应，我只需要让自动化**知道画面上有什么、应该在哪里操作**（单击、双击、右击、按键、输入文本）」。

并明确要求：「这个方案应该**可以同时兼容普通非游戏的场景**」。

**含义**：
- 本机（macOS）只做实施与发包；**Windows 实机验证由用户在其他设备完成**。
- 「不要求后台」使 §3.3 的 `foreground` / `SendInput` 路径可用——这是游戏场景的**唯一可行路径**。
- 前台切换的代价与披露要求见 §6.3。

### 5.2 感知方式 —— **不用 OCR，用当前 provider 的原生多模态识图**

**裁定原文**：「不要用 ocr，用当前 provider 的原生多模态识图能力」。

**影响**：放弃「OCR 提取文字 → 喂文本模型」的中间层。这既省掉整条依赖链（`paddleocr` / `tesseract.js` / `onnxruntime-node` 及其模型体积），也避免「文字描述丢失画面信息」的信息损失。

**实测支撑**：本会话已用原生多模态直接识别 4 张截图（§3.1），并完成闭环（§3.8）。

### 5.3 与 browser-agent 的关系 —— **保持两包**

**理由**：桌面半边在 Windows 上依赖 `cua-driver` 原生二进制，浏览器半边依赖 `playwright-core`；合并会让 Windows 用户装到一个必然加载失败的半边。平台差异必须隔离。

### 5.4 决策模型选择 —— **用户在设置卡中从可用模型目录里选**

**裁定原文**：「要像 dsh-browser-agent 那样，在设置里让用户自己从可用模型中选（并支持『仅文本模型时降级到 AX 路径』）」。

**实现要点**（对齐 browser-agent 的 `useModelCatalog`，`src/client.js:216-265`）：
- 三个字段 `visionProvider` / `visionModel` / `visionReasoningEffort`，**空值表示「继承会话当前路由」**——这是唯一在配置同步到另一台设备后仍然正确的默认值（browser-agent `src/config.js:54-57` 同款理由）。
- 目录读取失败时**不禁用卡片**，退回手填。
- **视觉能力判定在宿主侧完成**：`ModelCatalogModel` 只带 `id` / `name` / `description?` / `reasoning?`（`dsh-api-session-controller/lib/types/types.d.ts:122-127`），**不含 `inputModalities`**；该字段只在宿主侧 `ctx.llm.listModels(provider)` 的 `LlmModelInfo` 上（`dsh-llm/lib/types/types.d.ts:305-316`）。插件**在宿主侧**读它，把「是否支持图像」作为每个模型条目的标记下发给卡片。
- 卡片据该标记**只列出支持图像的模型**；无可用视觉模型时提示「将走 AX 降级路径」。

## 6. 约束与兼容要求

### 6.1 配置面硬约束

- **不得 inject `settings`**，**不得使用 `settings.register` / `settings.get`**（0.1.7-alpha.1 已移除，会致 entry `pending` 并拖垮 Web UI boot audit）。
- `Config` **必须从包入口 re-export**（`dsh-settings` 从 `entry.fiber.runtime.Config` 派生表单）。
- 字段用 `volatile()`，`apply` 内以 `{ get() }` 读取。
- **本插件无自有密钥字段**（复用 `ctx.llm`，不引入第二把 Key），故不涉及 `role('secret')`；若将来新增密钥字段，`role()` 必须在 `volatile()` **之前**（否则 `volatile schema is already wrapped`）。

### 6.2 打包与安装约束（仓库门禁）

- patch 行 `id` 全仓库唯一，且等于宿主半边 `export const name`；撞车即硬崩（`duplicate loader entry id`），**无自动检查**。
- 客户端产物 entry `id` 等于包名。
- 聚合 `packages/all/aggregate.yml` 的 `patchFrom` 与 `deps` **两节都要登记**。

### 6.3 能力边界（写入验收预期）

- **提权进程不可操作**：Windows UIPI 硬限制。Microsoft 官方文档原文：「Applications are permitted to inject input only into applications that are at an **equal or lesser integrity level**」。**以管理员权限运行的游戏无法被注入。**
- **前台切换会打断用户**：游戏场景必须前台（§4.4），这是设计代价而非缺陷。
- **`background` 是 best-effort**：失败返回结构化 `background_unavailable`，**不静默降级**。
- **实时动作游戏不可行**：延迟约束（§3.2）。
- **截图尺寸受宿主策略限制**：`ImageAttachmentLimits` 含 `maxImagePixels` / `maxImageDimension` / `maxImageBytes` / `maxImagesPerMessage`（`dsh-attachment/lib/types/types.d.ts:65-73`）。全屏截图（实测 3840×2160）**可能超出**，须由 `ctx.attachments` 的校验兜底；超限时图像被 offload 成占位文本（`ImageBlock.offloaded`，`dsh-llm/lib/types/types.d.ts:65-70`），**模型将看不到画面**——因此应优先窗口截图并限制尺寸。

### 6.4 反作弊：**明确不做**

联网竞技游戏的反作弊会检测合成输入。**规避反作弊不属于本方案范围**，且从工程角度是必然失败的军备竞赛。若目标游戏有反作弊，**本方案不适用**。

## 7. 可观测验收判据

### 7.1 本地可判定（实施完成即可验收）

| # | 判据 | 观测方式 |
| --- | --- | --- |
| A1 | 插件在 0.1.7-alpha.1 上激活成功，entry 非 `pending` | Web UI 插件页 / boot audit |
| A2 | 设置卡正确渲染，字段与 `Config` schema 一一对应（**本插件无自有密钥**——复用 `ctx.llm`，不引入第二把 Key） | 设置页 + `Config` 字段对照 |
| A3 | 设置卡的模型下拉**只列出视觉可用模型**；判定取自宿主侧 `ctx.llm.listModels()` 的 `inputModalities`，**不依赖客户端目录** | 设置页 + 宿主侧日志对照 |
| A4 | 工具出现在模型可见工具表，且**不与** `cua_driver_native__*` 命名冲突 | 工具清单 |
| A5 | 对至少一个真实 App 完成端到端任务，结果判定正确 | 真实界面操作 + 结果核对 |
| A6 | **视觉通道生效**：截图进消息且被模型正确理解（能说出画面内容）；截图在宿主 `ImageAttachmentLimits` 内（优先窗口截图而非全屏） | 记录请求内容 + 模型回答 + 附件尺寸 |
| A7 | **坐标映射正确**：视觉定位的点与预期目标一致 | 与 AX 元素框比对 |
| A8 | **降级路径生效**：配置为纯文本模型时，自动走 AX 表且任务仍可完成 | 配置纯文本模型 + 观察走哪条通道 |
| A9 | 全仓门禁通过：`aggregate.mjs --check` / `pnpm test` / `pnpm typecheck` | 命令输出 |
| A10 | **工具契约**：模型可见工具**同步等待**并返回结构化轨迹（含每步动作与结果）；动作后确认不一致时**执行重试**而非静默结束 | 工具清单 + 单次任务轨迹 |
| A11 | **目录失败回退**：模型目录读取失败时设置卡**不被禁用**，可手填路由 | 断网/模拟目录失败 + 设置页 |

### 7.2 需特定环境才能判定

| # | 判据 | 阻塞条件 |
| --- | --- | --- |
| B1 | **Windows 上控制一个回合制/策略/模拟游戏成功** | **需 Windows 实机（用户在其他设备测，§5.1）** |
| B2 | Windows `foreground` 路径的 `SendInput` 被游戏接收 | 需 Windows 实机 |
| B3 | 发布后经聚合包全新安装可用 | 需人工首发 + CI |

## 8. 实施切片

> 顺序不可颠倒；每片独立可验收。**尚未授权开工。**

| 片 | 内容 | 验收 |
| --- | --- | --- |
| T1 | 包骨架 + `Config` schema（含视觉路由三字段）+ 激活 | A1 / A2 |
| T2 | 截图 → `saveImages` → `ImageBlock` → `llm.stream` 的最小闭环 | A6 |
| T3 | 坐标映射层（两套换算）+ 执行器映射到 `cua_driver_native__*` | A7 / A5 |
| T4 | 路由解析（读 `inputModalities`）+ AX 降级通道 | A8 |
| T5 | 决策循环（观察 → 决策 → 执行 → 确认）+ 模型可见工具注册 + 步数上限 | A4 / A5 / A10 |
| T6 | 客户端设置卡（模型目录下拉 + 降级提示 + 目录失败回退） | A3 / A11 界面验证 |
| T7 | 聚合登记 + 门禁 + 发布 | A9 / B3 |

## 9. 风险与证据缺口

### 9.1 证据缺口

1. **Windows 全链路未实机验证**（§5.1）——已由用户裁定交由其他设备承担，但仍是**最大缺口**。
2. **本机全部证据来自 macOS**：Windows 的 `SendInput` / WGC 截图路径**只读过源码，未真机跑过**。
3. **视觉决策的准确率未量化**：本会话只验证了「能识图 + 能闭环」，**未做多轮游戏场景的准确率统计**。
4. **长会话 token 成本未知**：每步一张截图的累积成本未测量。

### 9.2 已知风险

| 风险 | 说明 |
| --- | --- |
| **视觉模型坐标幻觉** | 同类项目明确指出大 VLM「hallucinates coords」（§3.2）。**缓解**：动作后重新截图核对；必要时与 AX 元素框交叉验证。 |
| **截图 token 成本** | 每步一张截图，**成本尚未量化**（§9.1 第 5 条），方向上高于纯文本。**缓解**：优先窗口截图而非全屏；只截相关区域。 |
| **前台切换打断用户** | 游戏场景的固有代价（§6.3），只能如实告知。 |
| **提权游戏不可操作** | Windows UIPI 硬限制（§6.3），无法绕过。 |
| **反作弊** | 明确不做（§6.4）。 |
| **模型能力漂移** | 目录里的 `inputModalities` 是「披露值」；模型实际视觉能力需实测（A6）。 |
| **依赖实验性 provider** | `dsh-experimental-computer-use-cua-driver-native` 为 `0.1.6-alpha.2` 实验包。 |

## 10. 参考

- 本仓库同源实现：`packages/dsh-browser-agent/`（`src/value.js` 的 llm 调用、`src/client.js` 的 `useModelCatalog`、`src/config.js` 的 schema 约定）
- 宿主接缝源码：`dsh-llm/lib/types/types.d.ts`（`ImageBlock` / `ModelModality`）、`dsh-attachment/lib/types/`（`saveImages` / `SaveImageAttachment`）
- 执行引擎：`trycua/cua` 的 `cua-driver`（三平台、`foreground` / `background` 梯度）
- 官方文档（**转述来源**）：`cua.ai/docs` 的 `limits`（canvas/游戏条目）、`contracts`、`process-model`、`macos-permissions`
- 官方博客（**转述来源**）：`blog/inside-windows-computer-use.md`（Windows 输入阶梯与 `SendInput`）
- Microsoft 官方文档（**转述来源**）：`SendInput` 的 UIPI 约束


## 11. 评审记录（2026-09-23）

**Root 自审**（8 项，全部就地修正）：
1. 插入 §3.5 后 4 处 `§x.y` 交叉引用失效 → 已重编号修正。
2. §3 标题与导语声称「全部为本机动态验证」，与 §3.2/§3.3 的转述性质矛盾 → 改为按节标注证据性质。
3. §3.5 的 `get_window_state.rs:587` 上游行号 → 复验准确。
4. §3.7 集成契约的 API 名称与行号 → 逐条复验准确。
5. **§5.4/A3 的视觉能力判定写错实现路径**：`ModelCatalogModel` 不含 `inputModalities`，该字段只在宿主侧 → 改为宿主侧 `ctx.llm.listModels()` 判定。
6. §6.3 补入 `ImageAttachmentLimits` 尺寸约束（全屏截图可能超限）。
7. §3.8 证据表述加强：明确点击前基线为 `7×`、点击后为 `7×75`。
8. A2 与 §6.1 的密钥字段：本插件复用 `ctx.llm`、无自有 Key，属转向前的残留 → 已改正。

**盲审**：两个独立席位（同一模型两次派出，第一次收尾异常但产出完整报告），共 30 条。
**逐条裁定**：
- **采纳并修正（13 条）**：C1（§3.6 与 §5.4 对 `inputModalities` 读取位置相反）、C2（宿主降级产出占位文本，≠ AX 路径）、C3（token 成本「未知」与「显著高于」矛盾）、C4（两处「旧方案」引用不可解析）、C5（`cordis.patch.yml` 未标明是 profile 文件）、C6（`:301` → `:302`）、E1（Jev 风险条超范围）、E2（TypeSafe 提 PR 非目标无关）、M1（A4 无归属切片）、M2+M3（补 A10 工具契约）、M4（补 A11 目录失败回退）、M5（A6 补尺寸约束）、M6（§1.3 与 §4.3 对 geohotstan 的表述不一致）。
- **判「已知边界」不修（9 条）**：R1–R9 的重复条目。判定依据：这些是**不同章节面向不同问题**的有意回指——`docs/plans/` 的读者会跳读单节，每节需自足；且删除会使某节失去结论。其中 R1（前台代价三处）与 R3（UIPI 两处）已按指针化改写，R10（§9.1 内部重复）已合并。
- **采纳但判定为「验收面扩展」并已落地（8 条）**：M2/M3 合并为 A10，M4 为 A11，M1/M5/M6 就地修正。

**结论**：无坚持条目，共识达成，无需辩论轮。

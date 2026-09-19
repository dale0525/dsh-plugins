# 上下文交接（context handoff）调研：codex 机制、PTC 兼容性与确定性抽取的边界

> 状态：一手信源调研报告。所有数字均为本机实测，可复现的标识在 §7。
> 结论已影响 `docs/plans/2026-09-19-context-handoff-backend.md` 的方案形态。

## 1. 调研问题

用户提出的原始问题：能否照搬 codex 的 `features.context_management.experimental_mode`，
把 DSH 的上下文管理与 OpenViking 结合，做成同等逻辑的插件。

由此拆出三个必须回答的子问题：

| # | 问题 | 决定什么 |
|---|---|---|
| Q1 | codex 那套机制的真实语义是什么？ | 是否值得照搬 |
| Q2 | 现成方案（`dsh-dcp`）能否直接用？ | 是 fork 还是重写 |
| Q3 | 我们的模型能否承担"自主上下文管理"？ | 是否需要模型参与 |

## 2. Q1：codex 机制的语义（源码实证）

**它不是压缩，是"换窗口 + 外部化记忆"。**

`codex-rs/core/src/compact_token_budget.rs` 的 `run_compact_task_inner` 注释明确写着：

> Token-budget compaction skips model/server summarization and installs a fresh context window instead.

即：**不调模型做摘要**，直接开一个新上下文窗口。配套三件东西：

| 机制 | 源码位置 | 作用 |
|---|---|---|
| 窗口元数据注入 | `core/src/context/token_budget_context.rs` | `<context_window>` 带 first/current/previous window id；`<context_window_guidance>` 带操作指引 |
| 阈值提醒 | `models.json` 的 `model_messages.token_budget` | `reminder_threshold_tokens: 6144` 提醒写 notes；`auto_compact_fallback_buffer_tokens: 16384` 耗尽后强制只许调 notes + new_context |
| notes/history 工具 | `codex-rs/ext/history-notes/src/tools.rs` | 9 个工具，其中 `notes.*` 5 个、`history.*` 4 个 |

激活门（`core/src/session/token_budget.rs` 的 `apply_experimental_context`）同时卡 9 条：
feature 开、模型 `supports_experimental_context`、provider 走 codex backend、
OpenAI 官方鉴权（无 env_key / bearer / aws）、ChatGPT 鉴权、套餐 Plus/Pro/ProLite、
token_budget 能开且开着。任一不满足即**静默返回**。

**关键事实（决定可移植性）**：`notes` 与 `history` 不是本地实现，而是打私有端点
`alpha/history/v2/*` 与 `alpha/notes/v2/*`（`ext/history-notes/src/backend.rs`）。
上游 issue 记录该路径的实际状态：

| issue | 报告内容 |
|---|---|
| [#43194](https://github.com/openai/codex/issues/43194) | Pro + Astra 下 notes/history 端点稳定返回 404，而 `new_context` 仍执行，导致任务状态被丢弃 |
| [#44873](https://github.com/openai/codex/issues/44873) | 0.154.0 因运行时 `supports_experimental_context=false` 整个特性失效 |
| [#42446](https://github.com/openai/codex/issues/42446) | 官方确认 API-key 会话与自定义 provider 被排除 |

**推论**：该机制的收益完全建立在"模型会自己写 notes、自己调 new_context"之上。
这需要模型侧的训练配合，不能靠提示词复现。→ 引出 Q3。

## 3. Q2：`dsh-dcp` 在 PTC 模式下的结构性失效

### 3.1 被考察对象

[`fan56/dsh-dcp`](https://github.com/fan56/dsh-dcp)（npm `@aiwayds/dsh-dcp`，v0.11.0，MIT，6 stars）。
它的做法：继承 `BasicCompactionEngine`，**只覆写 `summarize()` 一个方法**，
用确定性代码抽取代替 LLM 摘要，零模型调用。

它的 `summarize()` 是 DSH compaction seam 上唯一的子类钩子——这一点已由
`@deepseek-ai/dsh-compaction-basic` 的源码注释确认：

> `summarize()` is the sole subclass customization hook.

### 3.2 实测：在真实压缩区间上跑它的抽取器

取本机一段真实发生过的压缩（标识见 §7），把它的 150 个被压缩事件喂给
`dsh-dcp` 的 `summarizeDeterministically()`：

| 指标 | 实测值 |
|---|---|
| 区间事件数 | 150（72 assistant/message + 72 tool/result + 6 user/message） |
| 区间原始 JSON 体积 | 2,618,147 字符（逐事件 `json.dumps` 求和口径；文件落盘形态为 2,618,447 字符） |
| 区间标称 token（宿主记账） | 160,323 |
| **`dsh-dcp` 产出** | **543 字符** |
| 其中空章节 | **8 节里 4 节为 `(none)`**（另有 1 处 `(none)` 是 `Next Step` 节内的空条目，不是空节） |

产出全文的核心部分：

```
## Primary Request and Intent
(none)

## Key Technical Concepts
(none)

## Files and Code
(none)

## Errors and Fixes
- run_code: bash: [sS]*?: command not found
- run_code: Error: code run failed (exception): ToolCallError: ### Error

## Pending Jobs
(none)
```

### 3.3 根因

`dsh-dcp/summarizer.js` 靠**工具名 + 结构化参数键**抽事实：

```js
const PATH_KEYS = ['file_path', 'absolute_path', 'notebook_path', 'path', 'glob', 'pattern']
const COMMAND_KEYS = ['command', 'cmd', 'script']
```

但实测会话运行在 **PTC 模式**（`tools.mode = ptc`），72 次工具调用的形态是：

```json
{
  "name": "run_code",
  "arguments": "{\"code\":\"const [pwd, ls] = await Promise.all([\\n  tools.bash({ command: 'pwd && ls' }),\\n  tools.glob({ pattern: '*agy*' }),\\n]);\"}"
}
```

**真实的 `bash` / `glob` / `write` 全部被包在 TypeScript 程序字符串里。**
抽取器看到的是 `run_code`，参数里没有 `path`、没有 `command`，于是全部落空。

**这不是 `dsh-dcp` 的缺陷，是它的输入假设与 PTC 不兼容。**
它假设"一次工具调用 = 一个工具名 + 结构化参数"，PTC 下"一次调用 = 一段代码"。

## 4. 发现：PTC 的真实调用有权威结构化来源，不必解析代码

`run_code` 的参数是一段 TypeScript，真实调用以 `tools.<name>({...})` 形式内联其中，
因此"解析代码"是可行路线。但 DSH 已把每次子调用**结构化落盘**为
`tool/ptc-dispatch` 事件，它是比解析源码更可靠的来源。

### 4.1 两条还原路线的实测对比

同一区间（seq 10–630，150 节点）上，两条路线各自能还原出的真实调用：

| 还原项 | 解析 `run_code` 源码 | `tool/ptc-dispatch` 事件 |
|---|---|---|
| 真实工具调用 | 115 次 | **126 次** |
| 工具名分布 | `bash` 103 / `write` 11 / `glob` 1 | 同左 **+ `mcp__playwright-mcp__*` 11 次** |
| shell 命令 | 61 次命中 / 60 条去重（103 个 `command:` 键中漏 42） | **103 次 / 102 条去重** |
| 命令最长长度 | — | 781 字符，内层引号完整，插值已求值 |
| 报错判定 | 从文本刮取，实测含假阳性 | 权威 `isError` 字段，实测 **1 条** |

**两条路线各有独立的失效模式，且都实测到了**：

| 失效模式 | 实测 |
|---|---|
| 正则漏抽：`tools['<name>']({...})` 方括号写法不匹配 `tools\.(\w+)\(` | 11 次 `mcp__playwright-mcp__*` 调用全部漏掉 |
| 正则漏抽：`command:` 的值用模板字符串（反引号）而非引号 | 103 个 `command:` 键中，正则只命中 61 个（去重 60），**漏 42 个** |
| 正则假阳性：转义与截断导致命令文本错乱 | 13 条命令不在权威集合中 |
| 正则的报错源不可靠 | 从文本刮取的条目混有非错误条目（探针 C 独立指出 9 类，见 §5.4） |

**模板字符串这一条尤其值得注意**：它不只是"少抽了几条"。反引号命令里常含
运行时插值，例如：

```js
tools.bash({ command: `ls -R ${base}/lib | head -40; echo "=== README ==="`, description: '...' })
```

正则路线要么漏掉它（如实测），要么——若放宽为匹配任意引号——会把
**未求值的 `${base}` 占位符**当作命令原文写进骨架。骨架的契约是"硬事实逐字保留"，
而 `${base}` 从来不是任何一次真实执行过的命令文本。
dispatch 的 `arguments.command` 是**求值后**的实参，不存在这个问题。

**结论：`tool/ptc-dispatch` 是权威来源，源码解析降级为兜底。**
这不是"精度高低"的取舍，而是"正确与否"的取舍——正则路线在真实数据上
既漏 11 次调用、又漏 42 条命令、还产出 13 条不存在的事实，
而这些都会经骨架进入压缩产出。

### 4.2 `tool/ptc-dispatch` 的形态（源码实证）

事件在 `dsh-tools/lib/index.js` 中经 `agent.session.append("tool/ptc-dispatch", ...)` 写入，
字段为 `{ rootCallId, parentCallId, subCallId, name, arguments, isError, error?, content }`：

- `rootCallId` 关联外层 `run_code` 的 `tool-call` id —— 实测该区间内 126 个 dispatch 的
  `rootCallId` **全部落在** 该区间 `run_code` 块 id 的集合内（72/72 精确子集）。
- `arguments` 经 `jsonNormalizeArgs` 走 `snapshotJsonValue` 快照，
  **是结构化对象而非字符串**，取 `arguments.command` 无需再解析。
- `isError` 是工具执行结果的权威布尔字段。
- 该事件**只在 log 中，不在 surface 上**，因此不进入模型请求，也不占上下文预算。

### 4.3 实现前提：如何在 `summarize()` 里定位这些事件

`summarize(input, agent, signal)` 只拿到 `input.messages`，拿不到区间 seq。
但 `agent.session` 可达（上游 `summarizeWithLlm` 即用 `agent.session.requestHeader()`），
于是可以按**对象身份**把 `input.messages` 映回 seq：

- 实测同一区间：150 条派生消息 **150/150** 全部映射成功，且映射结果与
  `shadowedSeqs` 集合精确相等。
- 带 surface 投影（`replace`）时：415 条映射 **415/415** 成功，无对象被多条 seq 共享。

得到 seq 集合后，即可按 **seq 范围**从 `agent.session` 取原始事件——
**包括只在 log 中的 `tool/ptc-dispatch`**。

**一个必须避开的实现陷阱**：判断"某事件是否属于本区间"必须用
**seq 范围**（`min(shadowedSeqs) <= seq <= max(shadowedSeqs)`），
**不能用 `shadowedSeqs` 成员判定**。因为 dispatch 是 log-only 事件，
其 seq 与 surface 节点交错，不在 `shadowedSeqs` 里。
用成员判定会得到"区间内 0 个 dispatch"的错误结论（本调研早期即踩过此坑）。

### 4.4 兜底路线的实现陷阱

当 dispatch 缺失（例如区间来自更早的 DSH 版本、或事件未落盘）时，
才回退到源码解析。此时抽取参数值必须用反向引用匹配成对引号
（`command\s*:\s*(['"])(.*?)\1`），不能用 `[^'"]*` 排除引号。
被抽取的命令常在内层使用引号（如 `echo "=== plugins ==="`），
排除式写法会在内层引号处截断，静默产出残缺命令。

**推论**：PTC 不是障碍——它的子调用已被运行时结构化记录，
抽取精度不受源码写法影响。代价是需要一个 PTC 感知的还原层，
这是 `dsh-dcp` 完全没有的一层。

## 5. Q3：模型能力探针（本机实测）

### 5.1 探针设计

两个探针，均挂在 `agent/pre-step` 事件上（该事件的作用域规则见 §6），
用 `--patch` 临时叠加层运行，不改任何配置。

任务是一个多步真实任务：读两个日志文件、逐文件统计 ERROR/WARN、比较、写报告。

**探针 A（被动响应）**：在对话中途注入预算通知，三种措辞：

| 措辞 | 内容 |
|---|---|
| `bare` | 只给数字："你只剩 2000 token" |
| `guided` | 数字 + 目标："如果这任务要跨窗口，确保你的进度和下一步能留下来" |
| `explicit` | 数字 + 明确动作："继续之前先把进度存到 `<路径>`" |

**探针 B（主动触发）**：注册一个 `compact_now` 工具，描述里写明"预算快耗尽且任务未完时调用"，
配合与 A 相同的三档通知。

### 5.2 结果

探针 A（每档 3 次）：

| 措辞 | 写检查点 |
|---|---|
| `bare` | **0/3** |
| `guided` | **0/3** |
| `explicit` | **3/3** |

探针 B（每档 3 次）：

| 条件 | 调用 `compact_now` |
|---|---|
| `off`（工具可用，无预算信息） | 0/3 |
| `bare` | 0/3 |
| `guided` | 0/3 |
| `explicit` | **2/3** |
| 阳性对照（用户直接要求调用） | 1/1 ✅ |

阳性对照证明工具确实注册且模型可见，因此探针 B 的 0/9 是真实负结果，不是探针故障。

### 5.3 解读

**模型读到了预算信息并据此调整行为**——`bare` 档的推理原文：

> context budget is tight (2000 tokens). A quick verification is cheap.

它随后改用 `grep -c` 代替逐行读取来省 token。
**但它把预算信息用于"省着花"，不是"存下来"。**

`guided` 档在**工作中途**（step 3）注入、且任务确有可保存的中间状态时，仍然 0/3。

**结论：`deepseek-v4.1-flash` 不会自主外化上下文状态；只在被明确点名动作时执行。**

两组合计（口径见下表，勿混用）：

| 组 | 构成 | 合计 |
|---|---|---|
| 自主（未点名动作） | 探针 A 的 `bare`/`guided` + 探针 B 的 `off`/`bare`/`guided` | **0/15** |
| 点名（明确要求该动作） | 探针 A 的 `explicit` + 探针 B 的 `explicit` | **5/6** |

两组的分母不同（前者 5 档 × 3 次，后者 2 档 × 3 次），
因此**不可互相相减**；上表只用于说明"是否点名"这一个自变量的方向。

### 5.4 探针 C：模型填空实验

探针 A/B 只测"模型会不会自主行动"。方案的可行性还取决于另一个不同的问题：
**模型能否在纯硬事实骨架上补出可用的因果？** 为此单独做了一次填空实验。

**输入**：程序抽取的骨架（`skeleton_slim.json`，5,716 字节），含
`user_intents` / `tool_call_counts` / `files_touched` / `commands_run` /
`errors_seen` / `last_assistant_statements` 六项，**不含** agent 的推理过程。

**指令**：要求只输出四节（`Why This Approach` / `Errors and Their Causes` /
`Open Decisions` / `Next Step`），并明确"不得虚构未列出的事实"。

**路由**：`workbuddy-ai` / `deepseek-v4.1-flash`（与会话实际路由一致）。

**结果**：产出 5,651 字节，四节齐备且内容可用。三项可核验的产出质量：

| 项 | 产出内容 |
|---|---|
| 因果 | 从骨架的路径与命令推断出"先定位归属再动手"的策略，并指出依据是 `buildMirrorRunCode` 与 `useCode ? JSON.stringify(...)` |
| 报错归因 | 把 `bash: [sS]*?: command not found` 归因为"把 grep 正则当 bash 命令执行"，并写明"无副作用，已由后续正确调用绕过" |
| 防重试 | 明确写出"不要用原参数重试"（`browser_click`）、"不要因为没找到就重跑全盘 `find`" |
| 误报纠正 | 主动指出骨架的 `errors_seen` 里有 9 类条目**并非错误**（`wc -c` 输出、YAML 分隔符、`dsh-web status` 正常输出等），要求不要按错误处理 |

最后一项值得注意：模型不仅填补了因果，还**识别出程序抽取的假阳性**并逐条排除。
这说明"骨架定事实、模型补因果"的分工是可行的。

**成本**：该次填空调用实测 `inputTokens=2533`、`outputTokens=1561`，
全价合计 **4,094 tokens**（对照 §3.1 的 `compaction-basic` 为 85,806，降幅 21x）。

### 5.5 边界与不确定性

- 样本量为每档 3 次（探针 A/B）；探针 C 为单次运行。方向明确，但未做统计检验。
- 仅测试了 `workbuddy-ai/deepseek-v4.1-flash` 一个模型。**未验证其他模型**，
  不能推断为"所有模型都不会自主外化"或"所有模型都能填空"。
- 探针的注入点、任务形态、措辞均为人工设定，可能未覆盖其他情境。
- 探针 C 的骨架与成本基线均取自 §7 标识的**同一区间**（骨架的 `user_intents[0]`
  与该会话首条用户消息逐字一致，基线即该区间 `compaction/summary` 事件的 usage），
  属同区间对照。其结构代表性未经多样本验证。

### 5.6 级联压缩：既有后端的固有事实衰减

压缩会反复发生。实测一个会话连续压缩 3 次：

| 次序 | 被压缩区间 | 节点数 | tokens |
|---|---|---|---|
| 1 | seq 9–1255 | 415 | 149,222 |
| 2 | seq 1005–1532 | 215 | 133,829 |
| 3 | seq 1535–1602 | 26 | 88,615 |

**第 2 次压缩的区间包含第 1 次产出的 checkpoint**（checkpoint seq 1271 落在区间内；
第 3 次同理包含 checkpoint seq 1541）。而 checkpoint 的内容是**纯文本**——
实测三个 checkpoint 的块类型均为 `['text','text','text']`，**零个 `tool-call` 块**。

于是第 2 次压缩时，模型看到的是第 1 次的**自然语言摘要**，而不是原始工具活动。
事实在传递中衰减，实测丢失：

| 事实 | 第 1 次压缩后 | 第 2 次压缩后 |
|---|---|---|
| `cua-driver` | 有 | **丢失** |
| `Accessibility` | 有 | **丢失** |
| `computer use` | 有 | 存活 |
| `TCC` | 有 | 存活 |

**但原始事件从未被删除**：`compaction/summary` 事件保留了它的 `shadowedSeqs`，
实测三个 checkpoint 对应的原始区间**全部仍在 log 中**（415/415、215/215、26/26）。
从第 1 次的原始区间可重新抽出 **241 个 `tool-call` 块**。

**对本方案的意义**：骨架每次从**原始事件**重建，而不是从上次的文本摘要转发，
因此级联不再衰减。这是"程序抽取"相对"模型重写"在多次压缩下的额外收益，
也是本方案与纯 `dsh-dcp` 的又一处结构性差异。

## 6. 作用域规则（影响挂载位置）

一个与方案形态相关的机制事实：

**事件监听与工具注册可以从 profile 层作用于 preset 会话，服务替换不能。**

依据 `dsh-scope/lib/index.js` 的 `scopeTarget`：

```js
const tag = scopeOf(ctx)
if (tag === void 0) return true                       // 无标签监听器：放行
for (let cursor = key; ...) if (cursor === tag) return true   // 祖先标签：放行
```

`dsh-scope` README 原文：

> event admission extends UP it (a listener tagged with an ancestor receives events dispatched to a descendant key)

**运行中的实证**：`@openviking/dsh-memory-plugin` 挂在 `profiles/web/package.json` 的
`bundles` 里（profile 层），`standard` preset 内没有它，但它通过 `agent/pre-step`
注入的记忆块正常出现在 preset 会话中。

**服务替换受限的原因**：cordis 服务按 `isolate` realm 的 key 解析
（`cordis/lib/index.js` 的 `_getImpl`），而 `standard` preset 把压缩后端放在
`isolate: { compaction: true }` 组内（`presets/standard/agent.cordis.yml:138`）。
profile 层的 `insert` 注册在 root realm，preset 内解析不到。
且 preset 挂载有 `leakedServices` 审计，往 root realm 发布服务会被拒绝挂载。

**因此**：

| 改动类型 | 挂载层 |
|---|---|
| 注入消息、注册工具 | profile 层即可 |
| **替换压缩后端（`ctx.compaction`）** | **必须改 preset** |

preset 根顺序为 shipped → 配置根 → 用户根，`discoverPresets` 是 first-root-wins，
所以用户根**无法覆盖**官方 `standard` 的 id，必须使用新 id。

## 7. 可复现标识

| 项 | 值 |
|---|---|
| 被分析会话 | `session-b98b89bf-3040-4c54-b78d-0baf4f312b9f` |
| 会话日志 | `~/.dsh/sessions/--Volumes-LogicExt-DSH--/session-b98b89bf-.../session.v3.jsonl.zstd` |
| compactionId | `ef26b720-47ad-4b0a-8a45-c8c67c2b51fb` |
| shadowedRange | seq 10–630，150 个 seq |
| shadowedTokenCount | 160,323 |
| 摘要模型 | `workbuddy-ai` / `deepseek-v4.1-flash` |
| `dsh-dcp` 版本 | `@aiwayds/dsh-dcp@0.11.0` |
| DSH 版本 | `0.1.6-alpha.2` |
| 探针 C 会话 | `session-472178a8-9d0e-419f-85dd-75ce4b836fe7` |
| 探针 C 输入骨架 | `skeleton_slim.json`，5,716 字节 |
| 探针 C 产出 | 5,651 字节；usage `inputTokens=2533` / `outputTokens=1561` |
| 探针 A/B 运行方式 | `dsh --profile headless --patch <overlay>`，叠加层只做模型路由与探针挂载 |
| 级联压缩会话 | `session-73d5edb0-77f3-4af8-a821-3cf63d7660b8`（默认模式，连续 3 次压缩） |
| 级联压缩会话日志 | `~/.dsh/sessions/--Volumes-LogicExt-DSH--/session-73d5edb0-.../session.v3.jsonl.zstd` |
| 默认模式区间 | seq 9–1255，415 节点，149,222 tokens；241 次工具调用，22 条 `isError` |
| 默认模式工具名来源 | `assistant/message` 的 `tool-call` 块；`tool/result.source.callId` 关联，实测 241/241 |

## 8. 结论

1. **codex 的机制不值得照搬**：它依赖私有后端与模型侧训练配合，
   且上游已有 404 与特性失效的未解 issue。
2. **`dsh-dcp` 不能直接用**：在 PTC 模式下结构性失效（数据见 §3.2）。
   但其继承 `BasicCompactionEngine` 只覆写 `summarize()` 的**框架**是可复用的。
3. **模型不能自主管理上下文**：只在被点名动作时执行（数据见 §5.3）。
4. **可行的形态是"程序抽取硬事实 + 模型填空补因果"**：
   PTC 还原层负责拿到 `dsh-dcp` 丢失的料，模型只读骨架补程序做不了的因果与悬而未决
   （填空实验见 §5.4）。
5. **PTC 的还原以 `tool/ptc-dispatch` 为权威源，源码解析仅作兜底**：
   实测正则路线漏 11 次调用、多出 13 条假阳性命令（见 §4.1）。
6. **骨架必须从原始事件重建，不能转发上次的 checkpoint**：
   既有后端在级联压缩中会丢失事实（见 §5.6），本方案天然规避。

第 4、5、6 条的具体设计、验收契约与未决项见
[`../plans/2026-09-19-context-handoff-backend.md`](../plans/2026-09-19-context-handoff-backend.md)。

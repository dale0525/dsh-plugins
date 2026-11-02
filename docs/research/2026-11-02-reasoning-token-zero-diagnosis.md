# 上游日志里思考 token 为 0/1 的成因：三类请求与两个假象

> 状态：一手实测结论。数字来自本机运行中的 DSH 与直连上游 CPA 端点
> （`cpa.logiconsole.com`，模型 `deepseek-flash`）的对照实验。
> 复现方式见 §6。

## 1. 问题

在上游面板看到大量请求的思考 token 为 0 或 1，而会话的 `reasoningEffort` 配的是 `high`。
需要判断这是配置失效，还是正常现象。

结论：**正常，但 0/1 来自三种互不相干的原因，混在一起看会得出错误判断。**

## 2. 三类请求必须分开统计

### 2.1 标题生成：思考被显式关闭

`dsh-session-title-llm` 构造请求时 `selectReasoningEffort(model)` 返回 `undefined`，
`reasoningEffort` 字段整个不进请求体（`lib/index.js:185-190`）。会话日志里
`session/title-llm-request` 事件记录为 `reasoningEffort: <ABSENT>`，只有 `maxTokens`。

pi-ai 对 `thinkingFormat: "deepseek"` 的分支是：**没有 effort 就发
`thinking: {type: "disabled"}`**（`@earendil-works/pi-ai/dist/api/openai-completions.js:670-680`）。
实测这类请求上游返回 `reasoning_tokens: 0`、`reasoning_content` 长度 0。
这类 0 是设计如此。

### 2.2 输出预算被压到个位数：思考等于预算

deepseek 的思考与答案**共用** `max_tokens`。实测同一 prompt、`effort=high`、只改 `max_tokens`：

| max_tokens | 1 | 2 | 8 | 64 | 512 |
|---|---|---|---|---|---|
| reasoning_tokens | 1 | 2 | 8 | 64 | 361 |

预算小时思考先吃光全部预算，于是 `reasoning_tokens` 恰好等于 `max_tokens`。
看起来像「0/1」，实质是「预算不够思考」。压缩提取这类辅助调用若把预算算得很紧，
就会落进这一档。

### 2.3 主对话：high 确实发出去了

`agent-default-model` 的 `reasoningEffort: high` 会经 `agent/request` 落到请求体，
pi-ai 发 `thinking: {type: "enabled"}` + `reasoning_effort: "high"`。会话日志里
`"reasoningEffort":"high"` 有实记录，不存在「配置没生效」。

## 3. 假象一：`reasoning_effort` 对思考量不单调

同一复杂任务、每档跑 3 次：

| effort | none | low | high | max |
|---|---|---|---|---|
| reasoning_tokens | 245 / 197 / 212 | 277 / 229 / 221 | 255 / 363 / 210 | 129 / 385 / 228 |

**不单调**。`max` 跑出过 129，低于 `none` 的 245。该端点上 `reasoning_effort`
只是提示，模型不保证按档位增减思考量。因此「调高档位以增加思考」在这个端点不可依赖，
也不能用思考 token 数反推档位是否生效。

## 4. 假象二：DSH 根本不记录思考 token

`dsh-llm-pi-ai` 的 `mapUsage` 只映射 `inputTokens` / `outputTokens` / `totalTokens`
与 cache 字段（`lib/index.js:1441-1449`），pi-ai 读到的 `usage.reasoning` 被注释说明
「已折进 output」。会话日志里搜 `reasoningTokens` 零命中。

所以面板上的数字**只可能来自上游**，DSH 侧既不存也不显示。同时要区分上游 usage 的两个
同名字段：`prompt_tokens_details.reasoning_tokens` 恒为 0（prompt 侧字段，本就应该为 0），
有意义的是 `completion_tokens_details.reasoning_tokens` 与 `completion_thinking_tokens`。

## 5. 处置

不需要改动。三条成因里只有 §2.2 看起来可疑，而它对应压缩提取这类辅助调用，
预算压紧是刻意取舍。想减少 0/1 噪音，唯一有意义的动作是按 `purpose` 分类统计
（`session-title` / `compaction` / 主对话各自成组），而不是调 `reasoning_effort`——
后者在该端点没有可测的单调效果。

## 6. 复现

直连上游，`stream: false`，`max_tokens` 分档，只改 `thinking` / `reasoning_effort`，
读 `usage.completion_tokens_details.reasoning_tokens` 与 `message.reasoning_content` 长度。
凭据取 `$DSH_HOME/.credentials.yaml` 的 `CPA_API_KEY`。

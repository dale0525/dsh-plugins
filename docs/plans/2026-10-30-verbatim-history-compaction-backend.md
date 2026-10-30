# 逐字历史压缩后端 —— 方案（事前冻结）

状态：**已双盲审通过（2026-10-30）**。本文冻结「为什么现有压缩会丢细节、新后端做什么、边界在哪、验收判据」，供实现阶段照此执行。评审记录见 §8。

## 1. 问题

`@deepseek-ai/dsh-compaction-basic` 在超长会话里丢掉了几乎全部历史细节，且压缩次数越多丢得越彻底。

实测口径：本机 8 个最大会话（`~/.dsh/sessions/**/session.v4.jsonl.zstd`，合计 403 MiB），各自从建会话起全量回放，按 `cpa/deepseek-flash` 的默认策略（`contextWindow: 450000`、`maxTokens: 128000`、`headroomTokens: 65536`、`thresholdRatio: 0.8`、`retainRatio: 0.16`）重算。

| session | 现行压缩次数 | 现行丢弃 tok | 现行摘要 tok | 现行末态 surface |
|---|---|---|---|---|
| `2d0811a6-e128-` | 33 | 5851153 | 151472 | 1820414 |
| `c24067aa-456d-` | 33 | 5814333 | 159125 | 2090976 |
| `e080967e-b9f3-` | 21 | 3571285 | 80937 | 1205523 |
| `b1113528-cc35-` | 13 | 2022997 | 29213 | 752151 |
| `dc1edf88-eafc-` | 18 | 3003058 | 73649 | 1077975 |
| `41b3d338-2a32-` | 10 | 1393135 | 39280 | 566303 |
| `7a5b82a2-c619-` | 9 | 1557794 | 29772 | 488082 |
| `428f3552-9b1f-` | 8 | 1306248 | 20923 | 493282 |
| **合计** | **145** | **24520003** | **584371** | **8494706** |

保留率 **2.38%**；末态 surface 是阈值的 **33.12 倍**。也就是说这 8 个会话在现行后端下从未真正收敛到阈值以下——每轮都在压缩，每轮都压不下去。

### 1.1 丢弃构成

按 meter 计价（`tokenMeter` 的 `estimateContent`：4 字符/token，reasoning 也计价），8 会话合计 23,864,645 tok：

| 类别 | tokens | 占比 |
|---|---|---|
| `reasoning` 块 | 15218025 | 63.77% |
| `tool/result` 正文 | 6008122 | 25.18% |
| `tool-call` 参数 | 2478980 | 10.39% |
| 可见正文（user + assistant `text`） | 159518 | **0.67%** |

**被丢弃的东西里，人写的字只占 0.67%。** 现行摘要按「Primary Request / Key Technical Concepts / Errors and Fixes …」九节模板重写，把这 0.67% 再压缩一次，于是正文细节在第一次压缩就没了。

### 1.2 级联降解机制

`selectCompactableRange`（`dsh-compaction-basic/lib/index.js:400-433`）的保留区间从后往前累加到 `retainTokens` 为止，起点恒为 `surfaceNodes[firstIdx]`（`firstIdx` 在有 system head 时是 1）。**已有 checkpoint 就在 index 1，所以下一次压缩必然把它连同后面一起替换。** 实测每次 `shadowedRange.start` 等于上一次 checkpoint 的 `seq`（369, 571, 1225, 2245, 3058, 4040, 4701, 6096, 7118, 8216, 9719, 10921），链深从 1 涨到 13。每一次都把上一份摘要再摘要一遍——这就是「压缩着压缩着就丢了很多细节」。

### 1.3 压缩并非由真实压力触发

145 个 `compaction/start` 点里，meter 复用 provider 上报 usage 的次数是 **0**，全部回落到启发式估计。真实 `usageTokens` ≥ 阈值只有 16 次。估计器对真实用量的高估比：含 reasoning 时 `median=4.19`、`max=18.15`；去掉 reasoning 后 `median=1.47`。所以大部分压缩本来不必发生。

### 1.4 注入重复

`agent-instructions`（29–31k 字符/条，每会话仅 6–8 份不同）与 `skill-catalog`（2–3 份不同）在每次压缩后重新追加一份副本；实测 `skill-catalog` 有 22–36 份副本。注入总价 368952 / 460788 / 289478 / 230585 / 263794 / 104813 / 72530 / 75875 tok，去重后 82932 / 145262 / 96051 / 164873 / 161689 / 88020 / 44665 / 50872 tok。

## 2. 为什么不能只做「正文逐字、其余指针化」

原始方案 B-3 是「只压 reasoning 与工具结果、正文逐字不动」。实测这条路走不通，必须记录：

| session | T0 原始 | T2 去推理 | T2+T3 去旧工具结果 | 正文+工具参数 | 阈值 |
|---|---|---|---|---|---|
| `2d0811a6-e128-` | 6044589 | 1981157 | 611885 | 435956 | 256464 |
| `c24067aa-456d-` | 6157153 | 2324244 | 729937 | 249606 | 256464 |
| `e080967e-b9f3-` | 3671821 | 1390543 | 538124 | 325576 | 256464 |
| `b1113528-cc35-` | 2172339 | 954093 | 430530 | 287052 | 256464 |
| `dc1edf88-eafc-` | 3171629 | 1447934 | 480118 | 331218 | 256464 |
| `41b3d338-2a32-` | 1478575 | 965356 | 361241 | 440529 | 256464 |
| `7a5b82a2-c619-` | 1628670 | 705046 | 222661 | 256702 | 256464 |
| `428f3552-9b1f-` | 1477888 | 816291 | 270400 | 309950 | 256464 |

（T3 口径：仅最近 40 个节点的工具结果保留原文，其余换成指针；工具参数按 160 字符截断。）

去 reasoning 后仍是阈值的 277%–911%；再加上旧工具结果指针化，也只有 `7a5b82a2` 一个装得下。**所以纯 B-3 不成立。** 本文的方案是 B-3 的修订版：正文逐字进摘要，但摘要本身受预算上限；旧工具结果与 reasoning 不进摘要。这个偏离在此明写。

根因是 `tool-call` 参数总量 9.51M 字符，其中 `bash` 独占 8.00M（84.2%，n=15459）。工具参数不能全文保留。

## 3. 方案

新建插件 `@logictan/dsh-verbatim-compaction`，宿主半边继承 `BasicCompactionEngine`，**只覆盖 `protected summarize()`**。重放、区间选择、durable 事务、shrink 守卫全部沿用基础类——基础类的公开面只把 `summarize` 当作定制点（`dsh-compaction-basic/lib/types/index.d.ts:41`：「Override this sole hook for a template or remote summarizer」）。

### 3.1 五档降级

摘要是确定性的，不调用 LLM：

- **T1** 用户正文逐字；仅当用户正文总量超过摘要预算 50% 时，从最早的 turn 起等额截断。
- **T1'** 助手正文逐字；仅当整份摘要超预算时，按 turn 等额截断（每 turn 至少 800 字符）。
- **T2** 重复注入只记一次。
- **T3** 旧工具结果换成一行指针（工具名 + 参数摘要 + 大小 + 首行）。
- **T4** reasoning 不进摘要。
- **T5** 用户消息不因压缩而从历史里消失——它要么在保留尾上，要么进了摘要。

T1 的兜底是实测支撑的，不是防御性设计：8 会话 261 条用户消息合计仅 2591 tok，单条最大 105 tok，而预算是 196752 tok、用户上限 98376 tok，所以「逐字」在现有数据里从不触发截断；但用户粘贴大文件时无上限会顶穿预算、触发 shrink 守卫导致压缩失败，所以留这条。

T5 由区间选择隐式保证：`start` 恒为 `surface.nodes[firstIdx]`（有 system head 时 `firstIdx=1`），所以任何被阴影的区间都从 surface 首节点开始，不存在「只丢用户消息」的区间。用户消息只会成为摘要的**输入**。这一点无法通过 `compaction/summary` 记录显式表达（`commitCompactionBody` 的载荷是固定的，见 `dsh-compaction-basic/lib/index.js:629-673`），所以是隐式的。

### 3.2 摘要格式

逐 turn 分块。turn 编号优先取日志里 `turn/start` 事件的 `data.turn`，与 `assistant/message` 的 `event.data.turn` 交叉校验；两者都缺时按非注入 `user/message` 分段，编号写 `?`。

```
## user (turn 7)
<用户消息正文，逐字>

### assistant (turn 7)
<助手可见正文，逐字>
  tools: bash×73 skill×2 read×14 (164299 bytes)
  errors: 2: <首行> | <首行>
  wrote: /path/a.ts, /path/b.ts
```

`tools:` 行只给工具名与调用次数、结果总字节数；`errors:` 只给错误结果首行（最多 3 条）；`wrote:` 只给 `write`/`edit`/`multiedit`/`apply_patch` 的 `path` 参数。

### 3.3 摘要源：日志扫描减当前保留尾

摘要必须覆盖**整段历史**，而不只是本次被阴影的区间——否则旧 checkpoint 被吞掉后，它承载的内容就永久消失。

取法是确定性的，**需要读 session 日志，但不需要读取或解析任何历史 `compaction/summary` 记录**：

> 摘要源 = `session.snapshotEvents()` 里所有 `surfaceOp: 'append'` 的 surface 事件，**减去**当前 `end` 之后的保留尾。

等价于「曾经进过 surface 的全部内容，减去还在 surface 上的尾部」。日志是 append-only 的，`snapshotEvents()` 返回全量冻结事件（`dsh-session/lib/index.js:1452`），所以这个集合无需任何累积状态。

口径注意：被 `tool-result-pruner` 或旧 checkpoint 以 `{op:'replace'}` 移出 surface 的原事件仍满足 `append` 条件，因此也会进摘要源。这是**有意**的——T3 把工具结果一律换成一行指针，原文进不进摘要源对体积几乎无影响：实测把被 replace 的旧原文剔除后，摘要只小 19–109 tok（10871→10852、6112→6081、23890→23837、32364→32355、17425→17407、52923→52868、2118→2066、8843→8802）。取「全部 append」的实现更简单，且不会因为漏读而丢内容。

实测这条路 8 个会话全部收敛：

| session | 新压缩次数 | 新摘要 tok | 摘要/预算 | 新末态 surface |
|---|---|---|---|---|
| `2d0811a6-e128-` | 29 | 6518 | 3.3% | 159424 |
| `c24067aa-456d-` | 30 | 4720 | 2.4% | 83130 |
| `e080967e-b9f3-` | 18 | 21513 | 10.9% | 86115 |
| `b1113528-cc35-` | 10 | 20998 | 10.7% | 209211 |
| `dc1edf88-eafc-` | 15 | 11508 | 5.8% | 147899 |
| `41b3d338-2a32-` | 7 | 44542 | 22.6% | 173440 |
| `7a5b82a2-c619-` | 7 | 982 | 0.5% | 201327 |
| `428f3552-9b1f-` | 6 | 1347 | 0.7% | 249573 |
| **合计** | **122** | **112128** | — | **1310119** |

（预算 = `thresholdTokens − retainTokens − 8192` = 196752。）

末态 surface 合计 1310119，是阈值的 5.11 倍（逐会话看全部低于阈值 256464，因为阈值是每会话各自的压力线）；现行后端同一批会话末态合计 8494706 = 33.12 倍。摘要最大 44542 tok，占预算 22.6%，**T1' 的截断分支从未触发**。

模拟按真实时序进行：压缩时刻只看当时已存在的 append 事件，不含未来事件。另已验证摘要源集合逐次**单调增长**（120 次压缩里 0 次收缩），所以「第二次摘要仍含第一次的全部 turn」成立。

### 3.4 必须吞掉旧 checkpoint

`firstIdx` 保持基础类的算法（有 system head 时 1），**不额外跳过已有 checkpoint**。新摘要覆盖旧 checkpoint 是收敛的必要条件：旧 checkpoint 的内容已经进了新摘要，留着它只会重复计价。若人为跳过，实测 `41b3d338` 会卡死在 135 次压缩。

### 3.5 本次被阴影区间的反查

`SummarizationInput` 只有 `{tools?, messages}`，没有 seq。反查**只用于定位本次区间**（摘要源另走 §3.3 的日志扫描，两者职责分开）：

```
firstIdx = surface.nodes[0] 是 system/message ? 1 : 0
take     = input.messages.length - firstIdx
region   = surface.nodes.slice(firstIdx, firstIdx + take)
```

实测 120 次压缩里 `region` 与真实被阴影区间**逐 seq 一致**（`bad = 0`）。校验用 `session.eventAt(seq)` 的 `deriveEventMessage` 非 null 且 `type` 属于 surface 集合。

### 3.6 边界与失败门禁

- 摘要预算的硬上限：`min(196752, shadowed_price − 86 − 512)`，其中 `shadowed_price` 是本次被阴影区间的 route 价、86 是 `frameSummary` 的固定开销（`CHECKPOINT_PREAMBLE` 300 字符 + 两个标签，共 341 字符 = 86 tok）、512 是安全余量。超限时按 T1/T1' 从最早的 turn 起等额截断。这条是 shrink 守卫的结构性兜底——守卫条件是「新摘要 ≥ 被阴影区间价」，而摘要随历史累加、区间可以很小，二者没有天然不等式。
- `start` 与 `end` 的 tool-pairing 平衡由基础类的 `validateSurfaceRegion` 检查（`dsh-compaction-basic/lib/index.js:557-558`：start 用 `toolPairingBalancedBefore`、end 用 `toolPairingBalancedAfter`），`summarize` 被调用时早已通过，插件不重复校验。
- `summarize` 失败即抛。基础类会走 `recover`（`compaction/summary-error` waterfall）后重试同一区间。**设单次尝试标记**：第二次仍失败就抛出让 `compactIfNeeded` 记 warn 并继续本轮（`lib/index.js:843-850`），不无限重试。
- `/compact`（`dsh-command-compact/lib/index.js:55` → `ctx.compaction.compactNow`）与 `context-overflow` 走同一条 `compactRegion` → `summarize`，无需单独处理；它们用 `retainTokens: 0`，区间比自动压缩更大（实测最小 89 个真实节点），守卫余量反而更宽（最小 221274 tok）。
- shrink 守卫余量实测（`retain=51520` / `retain=0` 两档，各 8 会话全量回放）：最小余量 174387 / 221274 tok，触发 0 次。没有任何一次区间的真实节点数少于 65，也没有任何单节点 ≥ `retainTokens`（最大单节点 12487–28622 tok），所以区间不会退化成「只有一个旧 checkpoint」。

### 3.7 配置与挂载

`retainTokens` 用默认 `retainRatio: 0.16` 推出的 51520 即可，不改成 0。实测 `retainTokens: 0` 反而让末态 surface 更大（`2d0811a6` 252610 vs 159424），因为尾部被压光后下一轮立刻又触发压缩。

挂载点是本方案唯一的架构难点，必须说清楚：

- 真正生效的 `compaction` 组嵌在 4 个 agent preset（`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`）的 `config.plugins` 里，带 `isolate: {compaction: true}`。因此每个 preset 各自持有一个 `compaction` 服务实例，根上下文看不到它们。
- 顶层只有 `compaction-basic` / `command-compact` 两行，且都被 `dsh-web-app` 的 bundle patch 置为 `disabled: true`。
- `applyEntryPatches`（`cordis-plugin-include/lib/index.js:56-105`）的 `entryMap` 只收录顶层条目与 `group: true` 条目的 `config` 数组。preset 行不是 group，其 `config.plugins` 里的行**不可达**——实测对 `compaction` 的 `insert` 补丁报 `patch insert: entry "compaction" not found`。
- `provide('compaction')` 在同一 isolate scope 内重复注册会抛 `service "compaction" has been registered at <...>`（`cordis/lib/index.js:815`），所以新行不能与 `compaction-basic` 并存于同一组。

采用宿主官方路径：**在 profile patch 里按 Loader row id override 整份 preset `config`**（宿主指南 `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`「Change a shipped preset」一节：*Override the declaration by its Loader row id instead of inserting. The override replaces the complete `config`, so restate `id`, `plugins` and every other field the shipped file carries*）。

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # 原样重述，仅把 compaction 组里的 compaction-basic 换成 verbatim-compaction
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: verbatim-compaction
            name: '@logictan/dsh-verbatim-compaction'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config: { … }
```

已用 `applyEntryPatches` 纯函数实测这条路可行：patch 命中 `preset-standard`，overrides 分支 `target[key] = value` 整份替换 `config`，输入数据不被就地修改（`structuredClone`），无 warn。代价是四个 preset 各自要重述一遍 `plugins`；这个代价换来的是确定性和零时序依赖。

不采用 `internal/config` 运行时改写：它依赖新插件的监听器先于 preset 注册（顺序无保证），且 `loader` 自己的监听器会把 group 条目的 config 原样返回，是否被覆盖取决于监听器嵌套顺序——多一个不确定因素，换不到任何好处。

## 4. 不做什么

- 不改宿主包，不给上游提 PR。
- 不改 `dsh-compaction-basic` 的源码。若实现必须改它（例如 `retainTokens` 下限校验），先停下来问，不在方案里默许。
- 不做 LLM 摘要的 fallback。失败就降级到基础后端行为（抛错、本轮不压缩）。
- 不做 reasoning 的显式剔除。`dsh-reasoning-strip` 已在 adapter seam 剥离 reasoning，本插件只需在摘要里不读它。

## 5. 验收判据

自动化（进 `pnpm test`，用 `test/fixtures/` 里提交的脱敏小会话日志，约 200 行）：

- 摘要确定性：同一份夹具跑两次，摘要逐字节相同。
- 摘要 token 恒 ≤ 预算，且 < 被阴影区间的 route 价（shrink 守卫不触发）。
- 摘要里用户消息正文逐字可检索（对夹具里的每条非注入 user 文本断言命中）。
- 摘要源集合逐次单调增长（第二次的摘要仍含第一次的全部 turn 编号）。
- `summarize` 全程零 LLM 调用（注入 mock `ctx.llm`，断言 `stream` 调用次数为 0）。
- 无 `turn/start` 的夹具走退化分支，不抛错。

实现者本地一次性验证（不进 CI，因为需要本机 403 MiB 会话数据）：

- 8 个实测会话全部收敛：末态 surface < 阈值，压缩次数 ≤ 35，摘要 ≤ 预算。

四条本地门禁：`node scripts/aggregate.mjs --check`、`pnpm test`、`pnpm typecheck`、`pnpm run check:host`。

## 6. 未验证项

- §3.7 的 profile patch override 已用 `applyEntryPatches` 纯函数实测（命中、替换、无 warn、不就地改输入），但**未在真实 profile 上实机跑过**——四个 preset 的 `plugins` 全量重述后能否通过各自的 `resolveConfig`，待实现阶段验证。
- 摘要按 turn 分块依赖 `turn/start` 的 `data.turn` 与 `assistant/message` 的 `data.turn`。实测 8 会话全部携带整数 `turn`（17/19/34/78/33/84/9/13 条，命中率 100%），但无契约保证；两者都缺时退化为按 user 消息分段，编号写 `?`。

## 7. 已裁定

- 用新增插件实现，不改宿主。
- 摘要确定性生成，不调用 LLM。
- 摘要源取「日志里全部 append 事件减当前保留尾」；需要读日志，但不读历史 `compaction/summary`。
- `retainTokens` 保持默认 51520。
- 纯 B-3 不可行，本方案是 B-3 修订版；此偏离已在此明写。
- 挂载走 profile patch override preset 行，不走运行时 `internal/config` 改写。

## 8. 评审记录

双盲审，2026-10-30。审查包：本文（sha256 `0ec3c29c…5c95c`，212 行），维度为证据正确性 / 内部一致性 / 完整性 / 过度设计 / 可验证性。第二席 `cpa/gemini-3.8-flash-high`（`reasoning_effort: high`）。

第一席（Root 自审）9 条：R1 多余表述（`end` 重算）、R2 死代码且 Before/After 写反、R3 T5 论证方向反了、R4 未写 pruner 交互、R5 未写 loader 监听器顺序、R6 未写 `/compact` 路径、R7 缺合计、R8 缺测试落点、R9 T1 无上限。

第二席 6 条：shrink 守卫必崩、摘要源自相矛盾（含 pruner 拾回）、挂载点未验证（含引错包）、T1 无上限、`turn/start` 被过滤、验收依赖私有数据。

合并后共指 3 条（T1 无上限、pruner 交互、挂载点）；两席独有 6 条。辩论 1 轮，全部条目达成「采纳」或「让步」，无坚持，无共识破裂。

逐条裁定：R1/R2/R6/R7/R8 采纳（文档已改）；R3 采纳（T5 重写）；R4 采纳（§3.3 补口径与实测）；R5 采纳但结论降级（loader 监听器不丢弃改写，属误报，已删该防御）；R9 与第二席条目 4 同一问题，采纳（T1 加上限）；第二席条目 1 部分采纳——「必崩」被实测驳回（两档 retain 各 8 会话、120+ 次压缩、守卫触发 0 次、最小余量 174387 tok），但「无结构性不等式保证」成立，故采纳硬上限 `min(196752, shadowed_price − 86 − 512)`；条目 2.1/2.2/3.1/3.2/3.3/5/6 全部采纳；条目 2.3「彻底破坏修剪成果」被实测驳回（摘要只差 19–109 tok），但口径说明已补入 §3.3。

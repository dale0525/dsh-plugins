# ctx-mem 检查点成本优化与去 fork 化

> 状态：S1 / S2 / S3 / S5 已实施并提交；§8 未决问题 1 已按建议取 24,000 落地。
> 实施中的偏离以实际代码为准，逐条记在 §10.4。全部数字来自 §4 的实测，探针与口径随文标注。

## 1. 问题与目标

### 1.1 问题

`ctx-mem` 是替换 `@deepseek-ai/dsh-compaction-basic` 的压缩后端：程序逐字抽取硬事实
（路径 / 命令 / 报错 / 用户原话），模型只补四节因果。它在真实会话里连续失败了 27 次，
且每次压缩产出的检查点都比它替换掉的内容还大。

一次真实会话（归档 `session-63205867-…`，300K 窗口）的实测：

| 项 | 实测值 |
|---|---|
| 会话事件总数 | 3,071 |
| `compaction/start` | 46（其中 32 次属于同一段风暴） |
| `compaction/summary`（成功） | 11（前 2 次是官方引擎，后 9 次是 ctx-mem） |
| `compaction/end` 带 error | 35（其中 **27 次**是宿主 guard 拒绝） |
| 最后一次检查点 | 192,353 字符，其中 `### Commands Run` 占 **87.3%** |

三个症状，一个根因：

1. **宿主 guard 拒绝**：`summary is not smaller than the shadowed content`。
   27 次全部发生在 seq 2894–3063，超出量 min 59 / median 269 / max 2,287 token。
2. **压缩反而让上下文变大**：`3042→3043` 一折的检查点自身价 46,069，而它替换掉的
   span 价只有 46,225 —— 只赚回 156 token（0.34%）。
3. **同一段反复压缩**：32 次 `compaction/start` 只成功了 4 次，形成两轮一步的抖动。

### 1.2 目标

1. **检查点成本有界**：单次检查点的价格与「被替换内容的价格」保持可证明的余量，
   而不是靠 0.34% 的薄边过线。
2. **guard 在结构上不可能失败**：预算驱动渲染，使「新 < 旧」由构造保证，而非碰运气。
3. **去 fork 化**：本包与上游 `fan56/dsh-dcp` 的差异已达「重写」量级，
   继续挂 `git subtree` 同步的代价大于收益，改为自制插件。
4. **不牺牲事实**：路径、命令、报错仍是逐字，只是按价值分档截断。

### 1.3 非目标

- 不改宿主的投影公式（`projectedTokens`），不改压缩触发策略，不改保留尾巴策略。
- 不通过「转发上一次检查点文本」来省 token（见 §5.6 的否掉方案）。
- 不把 `regionOf` 的区间语义改成成员集（见 §5.6，会导致灾难性事实丢失）。

## 2. 范围

### 2.1 在范围内

- **S1**：检查点渲染改为预算驱动（`src/render.js` 新增 + `src/skeleton.js` 接线 +
  `src/index.js` 的预算计算），含分档降级与地板判定。
- **S2**：错误条目的执行器噪音过滤（`src/extract.js`）。
- **S3**：去 fork 化（`sync-policy.json`、CI matrix、`LICENSE` / `README.md` /
  `package.json` 的归属表述、`lib/` 取消跟踪）。
- **S5**：插件界面只显示一个条目（`packages/ctx-mem/cordis.patch.yml` 去掉
  disabled 的引擎行，同步 `README.md` / `aggregate.yml` 表述并重生成聚合 patch）。

### 2.2 明确不在范围内

- **宿主侧的 `reasoning` 块定价**（§5.5 F5）。那是 `@deepseek-ai/dsh-token-meter`
  的行为，插件无法触及；本计划只记录观察，不实现。
- 用户 profile 的 `cordis.patch.yml` 里 `ctx-mem` / `ctx-mem-bridge` 两行的
  **启用状态**（用户管理）。S5 改的是**本包自己的** `cordis.patch.yml`，不碰用户层。
- 官方引擎（`compaction-basic`）自己的检查点格式。本计划只处理 ctx-mem 的产出。

## 3. 约束与兼容性

1. **唯一替换点是 `summarize(input, agent, signal)`**。宿主引擎的触发策略、保留尾巴、
   事务锁、tool-pairing 边界全部继承，不得覆写。
2. **`input.messages` 是插件能看到的全部**。span 的选择由宿主做，插件**无法加宽或收窄 span**。
3. **guard 的抛出点在 `summarize()` 之外**。`summarizeCompaction` 的 `for(;;)` 重试循环
   只包住 `dependencies.summarize(...)`；`framedSummaryTokenCount >= shadowedRouteTokenCount`
   这一 throw 位于循环**之后**（`dsh-compaction-basic/lib/index.js:579-580`）。
   ⇒ **`compaction/summary-error` 瀑布永远无法挽救 guard 失败**。插件侧唯一的杠杆
   是把产出做小。
4. **不得假设 span 是 seq 升序**。`shadowedSeqs` 是 surface 顺序，11 折里 8 折非单调
   （如 `fold@3070` 的 span 是 `[2879, 2896, 3043]`）。任何新代码不得依赖升序。
5. **`reasoning` 块不进入后续请求**（§4.5 有证据），但**参与定价**。插件不能假设
   「定价 = 真实重发压力」。
6. **`regionOf` 的区间语义是承重结构**。`### Commands Run` 的累积事实靠区间重扫实现；
   改成成员集会静默清空（§4.6 实测：414 → 0 条命令）。

## 4. 实测根因

> 探针：`/tmp/tl/` 下的只读脚本，输入为会话归档解压后的 `s.jsonl`（3,071 事件）。
> 定价口径：`@deepseek-ai/dsh-token-meter/lib/types/estimate.js` 的 `estimateMessage`
> （`CHARS_PER_TOKEN = 4`）。检查点价 = `frameSummary` 的三块消息之价。

### 4.1 R1 — `### Commands Run` 是无上限的逐字转储（**主因，充分**）

区域 `[8, 3043]`（= 最后一次检查点 `fold@3070` 的来源）的 `extractFacts` 真值：

| 节 | 条数 | 字符 | 占骨架 | 最长条目 |
|---|---|---|---|---|
| `### User Intents` | 11 | 417 | 0.2% | 112 |
| `### Files Touched` | 14 | 925 | 0.5% | 82 |
| `### Commands Run` | **429** | **165,835** | **87.3%** | **2,699** |
| `### Errors Seen` | 31 | 22,686 | 11.9% | **15,581** |
| 骨架合计 | | 189,953 | | |

`src/skeleton.js:92-95` 的 `renderBody` 明确逐字输出（不裁剪、不转义、不缩进，
嵌入换行原样保留），这是该模块的设计意图。**没有 `maxItemChars` 一类的上限。**
⇒ 骨架大小由「历史上有多少条命令」线性决定，与「有多少条命令是承重的」无关。

429 条命令里，351 条是多行（heredoc / 多语句 shell）。命令正文中真正以 `- ` 开头的
嵌入行只有 2 行，所以「按行计数」会把 429 误读成 487 —— 本计划的全部计数都按
`extractFacts` 的条目数，不按行数。

### 4.2 R2 — `### Errors Seen` 的问题是**单条过大**，不是**条目失控**

| 折 | intents | files | commands | errors |
|---|---|---|---|---|
| `fold@1062` | 3 | 8 | 192 | 15 |
| `fold@1632` | 4 | 10 | 253 | 20 |
| `fold@2187` | 5 | 11 | 280 | 22 |
| `fold@2677` | 7 | 14 | 386 | 29 |
| `fold@2851` | 8 | 14 | 410 | 31 |
| `fold@2886` | 9 | 14 | 414 | 31 |
| `fold@2890` | 9 | 14 | 414 | 31 |
| `fold@3042` | 9 | 14 | 414 | 31 |
| `fold@3070` | 11 | 14 | 429 | 31 |

错误条目**收敛于 31**，不是无界增长。它的成本来自两条巨条目：15,581 字符与 4,102 字符，
内容是 `grep` 命中了一个压缩过的前端 bundle（`dsh-web-frontend/dist/assets/index-*.js`），
把整段 minified JS 当成「错误首行」记了下来。

> 口径修正：早先记录过「错误 31 → 47」的增长。那是把 `compaction/summary` 事件自身的
> 文本也计入区域后的产物。按 `extractFacts` 对区域 `[8, 3043]` 的真值，**错误是 31 条**。
> 本计划采用 31。

### 4.3 R3 — 执行器噪音过滤（F2）是**质量杠杆，不是成本杠杆**

区域 `[8, 3043]` 的 31 条错误，按触发原因分类：

| 触发原因 | 条数 |
|---|---|
| `block.isError === true`（宿主明确标记） | 14 |
| 仅 `[exit code: N≠0]`，且首行**无**错误语义 | **9** |
| 首行文本命中错误正则 | 6 |
| `[killed by signal]` / `[timed out]` / `[sandbox]` | 2 |

那 9 条「纯噪音」是 shell 探测的段落标题被当成了错误首行：

```
bash: ===== standard            bash: dsh-scope
bash: === dispatch ===          bash: === ctx-mem in dump? ===
bash: ##### session             bash: === scope filter: untagged dispatch admitted? ===
bash: 509:| A16 | `minimal` 不被改动 | …
bash: === trust 日志结尾（19:14:56） ===
bash: === 更宽的凭据扫描（含 base64/长随机串） ===
```

`grep` 未命中、`ls` 路径不存在这类探测**非 0 退出是正常语义**，不是失败。
但 9 条合计只有 **266 字符**（占错误节 1.2%）。

> 上表「仅 `[exit code: N≠0]` 且首行无错误语义 = 9」是按**触发原因**分的；
> 其中 `=== 更宽的凭据扫描 …` 那条实际由 `signal` 触发，只是首行同样无错误语义，
> 故按「文本无错误语义」并列时也落进这张表。S2 的谓词按触发原因判定，
> 不受这次列举口径影响 —— 见 §10.3。

⇒ **F2 必须做，但它的收益是「`### Errors Seen` 只列真实失败」，不是省 token。**
本计划不得把 F2 宣传成成本优化。

### 4.4 R4 — guard 的分母在退化折上等于**上一个检查点自己的价**

27 次失败的分母只有两个取值：**46,225** 与 **46,069**。

| 检查点 | 它自己的帧价 | 作为后续折的 span 时的分母 |
|---|---|---|
| `checkpoint@2891` | **46,225** | 46,225（`fold@3042` 与失败折） |
| `checkpoint@3043` | **46,069** | 46,069（失败折） |

对照每个检查点自身的价：

| 检查点 | 自身帧价 | 它替换掉的 span 价 | 余量 |
|---|---|---|---|
| `checkpoint@2851` | 45,730 | 150,979 | +105,249 |
| `checkpoint@2886` | 46,630 | 71,545 | +24,915 |
| `checkpoint@2890` | **46,225** | 46,630 | **+405** |
| `checkpoint@3042` | **46,069** | 46,225 | **+156** |

⇒ 系统已经运行在「新检查点价 ≈ 旧检查点价」的刀刃上。`fold@2890` / `fold@3042`
是**擦边通过**（余量 405 / 156 token）。任何重试轮次只要 span 稍有不同，就会翻到
失败一侧 —— 27 次失败的超出量 median 只有 269 token（分母的 0.58%）。

**这就是全部失败模式：0.1%–5% 的超支，发生在一条已经贴合的边界上。**

退化折的成因（`fold@2890` 的 surface 尾部）：

```
seq     type               price
    8   system/message      3489
 2887   user/message       46630   ← 上一个检查点
 2879   assistant/message 123200   ← 一个 reasoning-only 块
```

`retainTokens`（0.16 × 300,000 = 48,000）的行走从尾部开始累加，第一个节点就是
123,200 ≥ 48,000 ⇒ `keepFromIdx` 停在检查点之后 ⇒ span 退化为「上一个检查点」本身。

### 4.5 R5 — 123,200 是**幽灵价**：`reasoning` 块不进入后续请求

`seq 2879` 是一条 `assistant/message`，单个 `reasoning` 块，492,767 字符，
provider `workbuddy-ai` / model `deepseek-v4.1-flash`，
usage `{inputTokens:2196, outputTokens:128000, totalTokens:283796, cacheReadTokens:153600}`。

**它不进入后续请求的证据**：紧随其后的 `assistant/message`（`seq 2901`）报告
`in=75276 cacheRead=60160`，与正常信封一致；此后该会话又完成了 4 次压缩、
发起 32 次 `compaction/start`。若 123,200 token 真的重发，这个会话不可能继续。

⇒ 真实的重发压力约为 `75276 − 60160 ≈ 15,000` token，而不是 123,200。
定价把 `reasoning` 像素算进了 `retainTokens` 的比较，使保留尾巴的判定严重失真。

**宿主侧的两个后果**（插件无法修，见 §5.5 F5）：
(a) `reasoning` 块被定价，而适配器从不重发它；
(b) 由 (a) 导出的退化 span 让 guard 的分母塌到检查点自身的价。

### 4.6 R6 — `regionOf` 的区间语义是承重的，不得替换

早先假设「区间过采」是缺陷（`extractFacts` 多收 2–17 倍）。**该假设是错的。**
`extractFacts` 忠实返回它被给予的东西；过采 100% 来自 `regionOf` 用区间而非成员集。

区间与成员集在 9 个 ctx-mem 折上的对照：

| 折 | 真实骨架 | 区间复现 | 成员集复现 |
|---|---|---|---|
| `fold@1062` | 92,899 | **92,898 ✓** | 37,005 ✗ |
| `fold@1632` | 117,391 | **117,390 ✓** | 8,502 ✗ |
| `fold@2187` | 127,399 | **127,398 ✓** | 26,607 ✗ |
| `fold@2677` | 168,741 | **168,740 ✓** | 24,486 ✗ |
| `fold@2851` | 179,470 | **179,469 ✓** | 27,950 ✗ |
| `fold@2886` | 181,947 | **181,946 ✓** | 2,581 ✗ |
| `fold@2890` | 181,947 | **181,946 ✓** | 118 ✗ |
| `fold@3042` | 181,947 | **181,946 ✓** | 118 ✗ |
| `fold@3070` | 189,954 | **189,953 ✓** | 116 ✗ |

（`区间复现 = 真实 − 1`：真实骨架后紧跟一个分隔换行，已逐字节核对。）

区间重扫正是事实的**累积机制**：`checkpoint@3070` 携带 429 条命令，
而它这一折的 span 只有 3 个节点。若改成成员集，`fold@2890` / `fold@3042`
的命令数从 414 直接归零 —— **静默的事实丢失**。

⇒ `regionOf` 保持现状。区间过采是特性，不是缺陷。

（早先两折 `fold@204` / `fold@514` 的骨架来自官方引擎而非 ctx-mem，其
`## Primary Request and Intent` 头可辨。它们不属于本插件的产出，本计划不解释其区域。）

### 4.7 R7 — 分档渲染的绝对价

对区域 `[8, 3043]`（429 命令 / 31 错误）实测各档：

| 档 | 规则 | 字符 | 帧价 | 命令 | 错误 |
|---|---|---|---|---|---|
| T0 | 现状逐字 | 189,953 | **47,591** | 429 | 31 |
| T1 | 变异命令 ≤4,000；其余首行 ≤200；错误 ≤300 | 95,605 | **24,004** | 429 | 31 |
| T2 | 变异命令 ≤2,000；其余首行 ≤120；错误 ≤200 | 91,733 | **23,036** | 429 | 31 |
| T3 | 只留变异命令（首行 ≤120）；错误 ≤120 | 8,854 | **2,316** | 103 | 31 |
| T4 | 只留 intents + files（地板） | 1,446 | **464** | 0 | 0 |

**框架开销是常数 94 token**（前言 + 开闭标签 + 三块结构），与正文长度无关：

| 正文 | 单块价 | 三块 + 前言价 | 开销 |
|---|---|---|---|
| 1 字符 | 9 | 103 | 94 |
| 100 字符 | 33 | 127 | 94 |
| 10,000 字符 | 2,508 | 2,602 | 94 |
| 189,953 字符 | 47,497 | 47,591 | 94 |

**这 94 token 已经包含在上表每一档的「帧价」里**——帧价是对 `frameSummary` 的
三块消息整体定价得到的，不是正文价。所以 §5.1 的 `reserve` **不是**用来覆盖
这 94 token 的；它的用途见 §4.8（留出「渲染价 < 分母」的余量）。
`reserve` 取 ≥256 时已把 94 覆盖在内，但两者**不是同一笔开销**，不得相加。

### 4.8 R8 — **固定规则渲染不足以修复 guard**（本节推翻了 §4.7 的乐观结论）

T1（固定规则的有界渲染）把每个检查点压到约 23,000 token，看似余量充足。
但**退化折的分母就是上一个检查点自己的价**，而事实集随区域单调增长：

用 T1 渲染检查点就位后（`checkpoint@2891` 的 T1 价 = 22,959），重放连续退化折：

| 迭代 | 区域末端 | 分母（= 上一检查点价） | T1 渲染价 | T1 判定 | 预算驱动渲染价 | 预算驱动判定 |
|---|---|---|---|---|---|---|
| 1 | 2899 | 22,959 | 22,959+ | **FAIL** | 22,438 | PASS |
| 2 | 2907 | 22,438 | — | **FAIL** | 21,897 | PASS |
| 3 | 2915 | 21,897 | — | **FAIL** | 21,239 | PASS |
| 4 | 2923 | 21,239 | — | **FAIL** | 20,700 | PASS |
| 5 | 2931 | 20,700 | — | **FAIL** | 19,862 | PASS |
| … | | | | | | |

**机制**：区域每折只多几个 seq，事实集单调增长 ⇒ 任何固定规则的渲染价单调增长；
而退化折的分母固定在「上一检查点价」。**增长序列 vs 固定上限 ⇒ 迟早越界。**
T1 只是把越界点从 46,225 挪到 23,000，并把超出量从 269 压到约 100。

⇒ **F1（分档有界渲染）必须与 F3（预算驱动）同时做，且 F3 是承重的那一半。**
预算驱动按构造保证「渲染价 ≤ 预算 < 分母」，因此 guard 在结构上不可能失败。

预算规则：`budget = denominator − reserve`，`reserve = max(256, ⌈denominator × 2%⌉)`。
用 `reserve = 512` 的定值变体实测可连续通过 **38 轮**背靠背退化折，
之后才触及 T4 地板（464 token）。真实场景里分母在每次非退化折后回升，
所以 38 轮是极悲观的下界。

**地板（审查后修正）**：宿主 guard 要求 `帧价 < denominator`。地板档自身的帧价是
**464**（含那 94 的框架开销），与 `reserve` 无关 ⇒ 数学上不可满足的条件是

```
denominator ≤ 464          （不是 ≤ 464 + reserve）
```

`denominator ≤ 464 + reserve` 只是「插件预算规则会把地板档也判为超预算」的**插件侧**
条件，此时插件应直接返回地板档（它仍可能满足宿主 guard，若 `denominator > 464`）。
两者含义不同，初稿把它们混为一谈，已按此更正。

**地板处置**：当 `denominator ≤ 464` 时，宿主 guard 不可满足。插件此时
**提前判定并放弃**（返回地板档并记录一条可诊断的日志），而不是让宿主抛出一个
只有数字的 `Error`。

### 4.9 R9 — 因果节也在被保护的价格里，必须从预算中先扣除

**这是盲审发现的严重缺陷（§10.2 条目 1），实测确认。**

`summarize()` 的产出是**一个**文本块：

```
summary = textBlocks(`${skeleton}\n\n${normalizeCausal(raw)}`)   // src/index.js:139
```

而宿主 guard 定价的是这个**整体**（`frameSummary` 对 summary 文本定价）。
但 §5.1 的预算规则只约束**骨架**。因果节实测 **582–1,143 token**
（占检查点 1.0–3.7%），它落在被保护的价格里、却在我的预算公式之外 ⇒
**预算满足 ≠ 帧价小于分母**，退化折上仍会越界。

**修法**：先把因果节的价量出来，再从分母里扣掉，剩下的才给骨架：

```
causalPrice    = estimateMessage(causalMessage)          // 因果节单独定价
skeletonBudget = denominator − causalPrice − FRAME_RESERVE   // 实测取 64（见 §10.4 自审 10）
```

**实测**：该规则在全部 9 个真实 ctx-mem 折上 **9/9 PASS**，且在连续 12 轮
退化折上无一次触地板。骨架规模在 12 轮里从 ~21,000 降到 ~410，命令数
从 429 降到 ~376（**每轮只丢约 3 条命令**，因为削减集中在探测类命令）。

**顺序要求**：因果节必须先渲染、后量价、再算骨架预算。若反过来（先给骨架预算、
再渲染因果），因果节一旦偏长就会重新越界。

## 5. 改动设计

### 5.1 S1 — 预算驱动的分档渲染（F1 + F3）

新增 `src/render.js`：纯函数，无 I/O、无 session 访问、无模型调用。
`estimate` 由调用方注入（纯函数不得自己去摸 `ctx`），签名与落点：

```js
renderCheckpoint(facts, budget, estimate) -> { text, tier, commands, errors, floorHit }
```

`estimate(text) -> number` 是 token 估计器；`summarize()` 传
`(text) => this.ctx.tokenMeter.estimateMessage(causalLikeMessage(text))` 一类的闭包。
测试传一个确定性桩即可（A2/A5/A7 都靠它）。

**分母与骨架预算的计算**（`src/index.js` 的 `summarize()` 内）：

```
denominator    = Σ estimateMessage(m)   for m in input.messages
                 跳过开头的 system/message（宿主 selectCompactableRange 的 firstIdx = 1 跳它）
causalPrice    = 因果节单独定价（§4.9）
skeletonBudget = denominator − causalPrice − FRAME_RESERVE
```

实测 11/11 与宿主 `shadowedRouteTokenCount` **精确相等**（§6 A1 钉住）。
定价用 `this.ctx.tokenMeter.estimateMessage`（宿主已注入 `tokenMeter`，
`BasicCompactionEngine.inject` 含 `"tokenMeter"`），不深路径导入。

**绝对上限 `maxCheckpointTokens`**（新增配置键，缺省 24 000）：
即使 `skeletonBudget` 算出来很大（正常折的分母可达 46 000+），渲染也不得
超过这个绝对值——它是「图片 / 附件会话里分母失真」时的兜底（§7）。
判定取两者的小值：`effectiveBudget = min(skeletonBudget, maxCheckpointTokens)`。
该键进 `src/config.js` 的 `OWN_CONFIG_KEYS` 与 schema，并进 README 配置表与
`skills/ctx-mem-config/SKILL.md`。

**分档**（从富到贫，取第一个装得下的档）：

| 档 | 规则 |
|---|---|
| T1 | `write` 类命令逐字 ≤4,000 字符；其余命令首行 ≤200；错误 ≤300；intents / files 逐字 |
| T2 | `write` 类 ≤2,000；其余首行 ≤120；错误 ≤200 |
| T3 | 只保留 `write` 类（首行 ≤120）；错误 ≤120 |
| T4 | 只保留 intents + files（地板） |

截断一律带显式标记：`…[+N chars]`（N = 被丢弃的字符数），使下游模型知道此处有省略。

**`write` 类判别式**（§6 A3 钉住其行为）：

```
/(^|[;&|(\s])(git\s+(commit|push|add|rm|mv|checkout|restore|reset|tag|init|subtree|merge|rebase|stash|cherry-pick|apply|clean)
|npm\s+(publish|install|i|ci|version|unpublish)|pnpm\s+(install|add|remove|publish|build)
|node\s+build\.mjs|dsh-web\s+(restart|start|stop)|mkdir|rm\s|mv\s|cp\s|chmod|tee\s|patch\s|sed\s+-i|touch\s|>\s*\S)/m
```

覆盖区域 `[8, 3043]` 的 429 条命令中的 **103 条**（24%）。这 103 条是状态改变类操作，
逐字保留；其余 326 条是探测类（`ls` / `grep` / `sed -n` / `echo` / `cat`），首行足够。

**顺序**：intents 与 files 逐字且永不裁剪（它们是 0.7% 的成本、100% 的意图保真）；
错误与命令都**从最新往前保留**（最近的上下文最有价值），旧的先丢。

**为何不是「只做 F1」**：§4.8 已证伪。F1 是 F3 的第一档，不是独立修复。

### 5.2 S2 — 执行器错误过滤（F2）

`src/extract.js` 的 `recordError` 之前加一个精确谓词。丢弃条件（**全部**满足）：

1. 触发原因是 `[exit code: N≠0]`（不是 `block.isError === true`）；
2. 结果里**没有** `[killed by signal]` / `[timed out]` / `[sandbox]` 标记；
3. `firstMeaningfulLine` 返回的**就是标记行本身**（即结果只有标记、没有真实输出）→ **保留**；
4. 首行是**装饰行**（三个以上 `=`/`#`/`*`/`_`/`~`/`+`/`-` 连排，或 ATX markdown 标题）→ 丢弃。

**条件 4 的原稿（「首行既不命中 `ERROR_PATTERN_EN` 也不命中 `ERROR_PATTERN_ZH` → 丢弃」）
在实施时被证伪，已就地改写**（见 §10.3）：该判据与本节末「不得改动
`firstMeaningfulLine` / `isWrapperMarker` / `looksLikeFailure` 语义」自相矛盾 ——
它会把 `ls: /x: No such file or directory`（`tests/extract.test.js:353`）与
`some stdout`（`:374`）一并当噪音丢弃。这两条与 `dsh-scope` 之间**不存在任何文本可分的判据**，
故只能按形状判：真装饰行丢，其余一律保留（宁可留噪音，不可丢硬事实）。

实测在区域 `[8, 3043]` 上按新判据丢弃 **7** 条（原稿 9 条；`dsh-scope`、`509:| A16 | …`、
`=== 更宽的凭据扫描 ===` 三条因不具装饰形状而保留），全部 9 折合计丢弃 7 类重复项。
保留 24 条。代价：丢弃 200 字符。

**不得**改动 `firstMeaningfulLine` / `isWrapperMarker` / `looksLikeFailure` 的现有语义
（它们有测试钉住，且 §4.3 的分类依赖它们）。

### 5.3 S3 — 去 fork 化

**依据**：上游引入提交是 `22df7a3 Add 'packages/ctx-mem/' from commit 'b0c3d39…'`
（2026-09-19，父提交 `5e4424f`），**从未跑过一次同步**。与上游 `b0c3d39` 的差异：

| 我方文件 | 上游对应 | 差异行 |
|---|---|---|
| `src/config.js` | `lib/config.js` | 104 / 122 |
| `src/index.js` | `lib/index.js` | 240 / 491（完整重写） |
| `src/skill.js` | `lib/skill.js` | 48 / 48（98 行里 96 行不同） |
| `src/bridge.js` | `lib/setup.js` | 95 / 135 |
| `src/extract.js` | `lib/summarizer.js` | 435 / 500 |
| `src/skeleton.js` / `region.js` / `causal.js` / `prompt.js` | 上游无对应 | 全新 |

`src/extract.js` / `skeleton.js` / `region.js` / `causal.js` / `prompt.js` 与 `bridge.js`
是本插件的主体，上游没有等价物。**继续 fork 只会让每次人工重拷丢失改造。**

**执行步骤（一次改动内完成，缺一即测试变红）**：

1. `git rm packages/ctx-mem/sync-policy.json`
2. 删除 `.github/workflows/sync-upstream.yml:56-58` 的 ctx-mem matrix 条目
   （`- id: ctx-mem` / `pkg` / `test` 三行）。

   **必须在同一次提交里删 policy 与 matrix**。`scripts/sync-upstream.test.mjs:815`
   断言二者集合 `deepEqual`，但它**读 workflow 用工作区、读 policy 用 `HEAD`**
   （`git ls-tree HEAD` + `git show HEAD:<path>`）。实测这个不对称的后果：
   - 只删 policy（matrix 行留着）→ 测试**仍绿**（HEAD 里 policy 还在）；
   - 只删 matrix 行（policy 留着）→ 测试**变红**，报
     `actual: [config-manager, easyrewrite, imagegen, market, workbuddy]`
     vs `expected: [… ctx-mem …]`。

   所以判据是**提交后的状态**：一旦 policy 的删除被提交，matrix 行就成了多余项，
   测试立刻变红。两步一次做完即可。

3. `git rm --cached packages/ctx-mem/lib/{config,index,skill}.js`

   这三个文件被跟踪，但被 `packages/ctx-mem/.gitignore` 的 `/lib/` 忽略
   （git 不会自动取消已跟踪文件）。来源已查明，**不是**「构建产物误入库」那么简单：
   上游 `fan56/dsh-dcp` **没有 `src/`，它的 `lib/` 就是源码目录**；subtree 收养
   （`22df7a3`）按上游原样带进 6 个 `lib/*.js`。随后 `5e4424f` 把 `lib/config.js`
   / `lib/index.js` / `lib/skill.js` **就地改写成我方内容**，并删除上游独有的
   `lib/{command,setup,summarizer}.js`。

   即 `lib/` 同时是「上游的源码目录」与「我方的构建产物目录」—— 两者撞名。
   `sync-policy.json` 把 6 个 `lib/*.js` 全列进 `deleted`，而
   `scripts/sync-upstream.mjs:533-559` 对被忽略的 `deleted` 路径走
   `git rm --cached` + 还原我方磁盘内容（正是为这种撞名设计的）。

   取消跟踪是**零损失**的，已核对：磁盘上 `lib/` 的 9 个文件与 `src/` **逐字节相同**
   （`diff -rq src lib` 无输出），且 `build.mjs` 在 `prepare` / `prepack` 时
   从 `src/` 全量重建 `lib/`。仓库内没有任何测试或脚本按路径读
   `packages/ctx-mem/lib/`（已 `grep` 确认）。
4. `packages/ctx-mem/LICENSE`：保留（MIT 与归属义务随衍生作品存续）。
5. `packages/ctx-mem/README.md` §上游：改为「本插件自 `fan56/dsh-dcp` `v0.11.0`
   衍生（MIT），此后已重写为主体；上游同步已停止」，并删除 `sync-policy.json` 的指路。
6. `packages/ctx-mem/package.json` 的 `description`：删掉 `Fork of @aiwayds/dsh-dcp.`，
   改为衍生说明（保留上游标识，因 MIT 要求保留版权与许可声明）。

**保留 fork 祖先提交**：不重写历史（全局规范禁止）。去 fork 化只删「同步机制」，
不删「来源记录」。

### 5.4 S5 — 插件界面只显示一个条目

**现象**：插件管理页的 `@logictan/dsh-plugins-all` 卡片里出现 `ctx-mem` 与
`ctx-mem-bridge` 两个条目，用户只需要一个。

**机制（已读宿主源码核对）**：`dsh-plugin-manager` 的 `declaredRows(name, info)`
（`lib/index.js:997-1028`）读该 bundle 自己的 `dsh.bundle.patch`，把其中
**每个 `insert` 行**（`flatten` 会展开 group）都变成界面的一行。本包的
`cordis.patch.yml` 声明了两行，所以界面上就是两行。

**修法**：删掉 `disabled` 的引擎行，只留 bridge 行。

```yaml
- insert:
    - id: ctx-mem-bridge
      name: '@logictan/dsh-ctx-mem/bridge'
      config:
        engine: {}
```

**为什么删引擎行是零功能损失的**（逐条已核对）：

1. 引擎行是 `disabled: true`，在 profile 平面**从不挂载**；
2. 真正挂载引擎的是 bridge **注入到 preset 组合**里的那一行
   （`buildPatches` 生成的 `{id: 'ctx-mem', name: '@logictan/dsh-ctx-mem'}`，
   落点是 preset 的 `compaction` group，与 profile 平面无关）；
3. 包本身仍必须被安装，这一点由 `packages/all/aggregate.yml` 的 `deps` 保证，
   **与是否有 profile 平面行无关**；
4. `scripts/aggregate.mjs:169` 只要求该包的 patch 里至少有**一行** `- id:`
   （bridge 行满足）；
5. 仓库内**没有任何测试或脚本**按行 id 读本包的 patch
   （`grep` 确认：`tests/` 只断言 `bridge.js` 的 `export const name`）。

**保留哪一行**：bridge 行。它是唯一 enabled、唯一承载 `config.engine` 的行，
也是用户需要开关的那一行。

**副作用（须在计划内记明）**：用户 profile 自己的 patch 层里若有
`- id: ctx-mem / disabled: true` 这类覆盖项，引擎行消失后它就成了空目标，
宿主 `applyEntryPatches` 会打印一条
`patch: entry %C not found` 警告后跳过。这是**警告不是错误**，且用户 profile 的
启用状态按 §2.2 属用户管理、本计划不改。落地时在 README 里写明这一点。

**连带改动**（都在同一片内完成）：

- `packages/ctx-mem/README.md` §挂载：把「声明两行」改成「只声明 bridge 行」，
  并说明引擎行由 bridge 注入，不再是 profile 平面的行。
- `packages/all/aggregate.yml` 的 `deps` 注释：现在写的是「ctx-mem's ENGINE row is
  disabled …」，需改为不再引用引擎行、只解释「包必须被安装」。
- `node scripts/aggregate.mjs` 重生成 `packages/all/cordis.patch.yml`（生成物）。

### 5.5 F5 — 宿主侧 `reasoning` 定价（**不在本计划实现**）

§4.5 的证据表明 `reasoning` 块被定价但从不重发。修复点是
`@deepseek-ai/dsh-token-meter` 的 `estimateMessage` 或 `route-pricing`。
本计划**只记录观察**，作为上游问题单独处理（§8 未决问题 2）。
插件侧的 `summarize()` 拿不到 pricing 策略，无法在插件内规避。

### 5.6 否掉的方案（不得重新提出）

| 方案 | 否掉理由（实测） |
|---|---|
| **转发上一次检查点文本**（delta / 不动点骨架） | 检查点 markdown 往返有损：11 个检查点只能还原 188 条不同命令，而区间重扫给出 429 条；错误 42 vs 26，其中 17 行是只在检查点里出现过的散文。`src/skeleton.js` 的模块文档明确禁止转发 |
| **把 `regionOf` 的区间改成邻接/成员集** | 静默灾难性事实丢失：`fold@2890` / `fold@3042` 的命令数 414 → **0**（§4.6） |
| **只做有界渲染（F1）** | §4.8 实测：固定规则的渲染价单调增长，退化折分母固定 ⇒ 迟早越界。F1 必须作为 F3 的档位存在 |
| **注册 `compaction/summary-error` 恢复钩子** | 宿主 guard 的 throw 在 `for(;;)` 重试循环**之外**（`dsh-compaction-basic/lib/index.js:579-580`），**不可恢复**。且 `for(;;)` 无轮数上限，无条件返回 `true` 会造成活锁 |
| **提高 `maxTokens`** | 骨架是本地渲染的，不经模型；`maxTokens` 只影响因果节的生成，与本问题无关 |
| **改宿主的 `projectedTokens` 投影公式** | 界面 17%↔51% 的跳动是「需要一次新采样」的正常行为，不是缺陷 |

## 6. 验收契约

测试先行。每条一句话 + 一个可证伪命令。

| # | 契约 | 证伪方式 |
|---|---|---|
| A1 | 插件算出的分母与宿主 `shadowedRouteTokenCount` 精确相等 | 用归档重放 11 折，断言逐个相等（实测已 11/11） |
| A2 | 渲染帧价 **严格小于** denominator（公式见 §10.4 自审 5：原稿的 `max(256, ⌈denominator×2%⌉)` 未实施） | 单元测试：对每个档的渲染结果断言 `price(render) < denominator` |
| A3 | `write` 类判别式在 429 条真实命令上命中 103 条，且命中集包含全部 `git commit` / `npm publish` / `dsh-web restart` | 固定语料断言命中条数与集合 |
| A4 | intents 与 files 在任何档下都逐字、不裁剪、不截断 | 单元测试：构造超长 intent，断言输出含完整原文 |
| A5 | 截断一律带 `…[+N chars]` 标记，N 等于被丢弃字符数 | 单元测试：断言标记与长度差一致 |
| A6 | 保底档（T4）的价 ≤ 464 + 50 token 且只含 intents + files | 单元测试断言档位与内容 |
| A7 | `denominator ≤ 464` 时返回地板档并置 `floorHit: true`（不抛异常） | 单元测试：传一个极小的 denominator，断言 `floorHit === true` 且不抛 |
| A8 | 执行器噪音过滤：装饰行 banner 被丢弃，「只有标记无输出」与非装饰首行被保留 | 单元测试三条：`[exit code: 1]` + 装饰 banner → 丢弃；只有 `[exit code: 1]` → 保留；`dsh-scope` + `[exit code: 1]` → 保留 |
| A9 | 渲染不假设 span 升序 | 单元测试：传非单调 `shadowedSeqs`，断言产出与升序输入相同 |
| A10 | 去 fork 后 `node scripts/sync-upstream.mjs --list` 不再列出 ctx-mem，且 `node --test scripts/sync-upstream.test.mjs` 全绿 | 运行该测试 |
| A11 | `lib/` 不再被 git 跟踪 | `git ls-files packages/ctx-mem/lib/` 无输出 |
| A12 | **帧价含因果节**：对 9 个真实折重放，断言 `price(skeleton + causal) < denominator`（不是只断言骨架） | 归档重放：9/9 PASS（实测） |
| A13 | `skeletonBudget = denominator − causalPrice − FRAME_RESERVE`；因果节变长时骨架预算等量变小 | 单元测试（渲染器层，确定性）：预算 24000→250，断言命令数 60→5 单调不增；引擎层接线另由 A2/A12 与归档重放钉住（causal 0→8000 字符 ⇒ 429→385，见 §10.4） |
| A14 | `effectiveBudget = min(skeletonBudget, maxCheckpointTokens)`，且缺省 `maxCheckpointTokens = 24000` | 单元测试：传超大 denominator，断言渲染价 ≤ 24 000 + 框架开销 |
| A15 | 连续 12 轮背靠背退化折不触地板，保留率 ≥ 90% | 归档重放：忠实分母链（见 §10.4 自审 6），断言 12 轮 `floorHit` 全 false、最低保留率 92.0%（20 轮时降至 87.4%） |
| A16 | 本包 patch 只声明一行（`ctx-mem-bridge`），引擎行不存在 | `node -e` 读 `cordis.patch.yml` 断言行数 == 1 且 id 为 `ctx-mem-bridge`；`aggregate.mjs --check` 通过 |
| A18 | intents / files 不受 `maxCheckpointTokens` 约束（保底档自身超上限时以保真优先） | 单元测试：`maxCheckpointTokens: 1`，断言最早 intent 与 file 仍在产出里 |

**端到端**：A17 —— 在真实 Web GUI 里跑一次会触发压缩的长会话，
断言 `compaction/end` 无 `error`，且 `compaction/summary` 的
`shadowedTokenCount > price(summary)`，余量 ≥ reserve。

**回归**：`pnpm --filter @logictan/dsh-ctx-mem test` 全绿（当前 103 测试）；
`node scripts/aggregate.mjs --check` 输出 `check OK`。

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 截断丢失承重命令 | 下游会话接不上 | `write` 类判别式保守（宁可多留）；T1 优先于 T2/T3；A3 钉住命中集 |
| 因果节偏长吃掉骨架预算 | 骨架过早降档、丢命令 | §4.9 先量因果价再扣；A13 钉住「因果变长 ⇒ 骨架单调不增」；A15 钉住 12 轮 |
| 预算驱动在极端退化下触地板 | guard 仍失败 | A7 提前判定 + 日志；根因由 F5 解决 |
| 分母计算在含图片/附件的会话里失真 | 渲染超出预算 | `node.tokens ≠ heuristicTokens` 时插件算的是近似；用 `maxCheckpointTokens` 绝对上限兜底（A14） |
| 去 fork 化后无法再拉上游修复 | 上游 bug 修复需人工移植 | 已实测：改造量已达重写级，同步从未跑过；保留祖先提交可人工 diff |
| 截断标记改变 `### Commands Run` 的形态 | 下游模型可能误读为原始文本 | 标记 `…[+N chars]` 显式且不可与 shell 语法混淆 |
| 删引擎行后用户 profile 的空覆盖项 | 宿主打印一条 `patch: entry not found` 警告 | 已知无害（警告非错误）；README 写明，用户自行清理 |

## 8. 未决问题（开工前需裁定）

1. **`maxCheckpointTokens` 绝对上限取多少？** 建议 24,000（≈ T1 在最后一次检查点的价，
   留 2× 余量）。取更小会更早降档、丢更多命令。
2. **F5（宿主 `reasoning` 定价）是否要另开上游 issue / 单独计划？**
   本计划不实现它，但它是退化折的根因。

## 9. 实施顺序

| 片 | 内容 | 归属 | 依据 |
|---|---|---|---|
| S1 | `src/render.js` + `skeleton.js` 接线 + `index.js` 预算 + `config.js` 新键 + 测试 | **Root** | 跨文件不变量（预算、档位、分母、因果价四者的关系），且是单一真源投影的归属处 |
| S2 | `extract.js` 的执行器过滤 + 测试 | 外派 | 有可独立判定的验收契约（A8）；共享触点 1 处（`extract.js`） |
| S5 | `cordis.patch.yml` 删引擎行 + README/aggregate.yml 表述 + 重生成聚合 patch | **Root** | 单一真源投影的归属处（子包 patch → 聚合 patch 逐字拼接） |
| S3 | 去 fork 化（6 处文件 + CI） | **Root** | 共享可变状态（CI matrix 与 policy 集合必须同时改，否则测试变红） |

顺序：S1 → S2（S2 与 S1 无共享写状态，可并行）→ S5 → S3（最后，因它动 CI 与元数据）。
S5 改的是 `cordis.patch.yml`，宿主 HMR 会即时 reconcile、**无需重启**。

## 10. 评审记录

### 10.1 Root 自审（写计划过程中，3 处，均已就地修正）

**自审 1：推翻「F1 足够」的结论。** 初稿把「有界渲染（F1）」当作主修复，理由是
它把 47,591 压到 24,004、余量充足。重算退化折的分母后发现分母就是上一个检查点
自己的价，而事实集随区域单调增长 ⇒ 固定规则的渲染价单调增长、迟早越界
（§4.8 的 8 轮迭代表）。改为「F1 是 F3 的第一档，F3 承重」。**这是本计划最重要的一次自我推翻。**

**自审 2：修正错误条数的口径。** 初稿写「错误 31 → 47 增长」。按 `extractFacts`
对区域 `[8, 3043]` 的真值是 **31 条且收敛**；47 那个数字是把 `compaction/summary`
事件自身的文本计入区域的产物。已改为 31，并据此把 F2 从「成本杠杆」降级为
「质量杠杆」（9 条噪音合计仅 266 字符，占错误节 1.2%）。

**自审 3：删掉「注册 recover 钩子」的候选。** 初稿把它列为待定项。读宿主源码发现
guard 的 throw 在 `for(;;)` 重试循环**之外**，不可恢复；且该循环无轮数上限，
无条件返回 `true` 会活锁。已移入 §5.6 否掉方案。

### 10.2 独立盲审

盲审席位 `antigravity/gemini-3.8-flash`，只给计划路径与审查维度（重复 / 冲突 /
矛盾 / 遗漏 / 过度设计），未给背景。返回 **14 条**，逐条裁定如下。

#### 采纳（10 条）

| # | 条目 | 处置 |
|---|---|---|
| 1 | **因果节在被保护的价格里，却不在预算公式内**（严重） | 采纳。新增 §4.9 与 A12/A13：先量因果价、再算骨架预算（`denominator − causalPrice − FRAME_RESERVE`，余量实测取 64）。实测 9/9 PASS、12 轮退化折不触地板。**这是本轮最重要的一条** |
| 2 | 「地板不可满足」的条件写错：真值是 `denominator ≤ 464`，不是 `≤ 464 + reserve` | 采纳。§4.8 已更正，并区分「宿主侧不可满足」与「插件侧判超预算」两个不同条件 |
| 3 | 94 token 的框架开销**已含在帧价里**，`reserve` 若 ≥256 是重复计算 | 采纳。§4.7 改为明确说明两者不是同一笔开销、不得相加 |
| 4 | §5.6 写「区间重扫给出 428 条」，规范计数是 **429** | 采纳。已改（本文件全部计数以 `extractFacts` 的条目数为准） |
| 5 | §2.1 / §9 把 S1 的文件面写成 `skeleton.js` + 新增 `render.js`，漏了 `src/index.js` | 采纳。§2.1 与 §9 已补 `src/index.js`（分母与预算的落点） |
| 6 | `maxCheckpointTokens` 在 §7/§8 出现，但 §2 / §5.1 / `config.js` schema / `OWN_CONFIG_KEYS` / §6 都没有 | 采纳。§5.1 补键定义与落点，A14 钉住缺省值 24 000 |
| 8 | 纯函数签名 `renderCheckpoint(facts, budget)` 缺它需要的估计器 | 采纳。签名改为 `renderCheckpoint(facts, budget, estimate)`，并说明测试用确定性桩 |
| 9 | 计划提到要改根 `AGENTS.md` 的目录树 | 采纳（部分）。**实测该树根本没列 `ctx-mem`**（也没列 `dsh-fakeip-fetch` / `dsh-agy-link`），所以无需改动。已在 §2.1 移除该动作。**本条的实际状态：原稿并未真的写入这个动作，属于盲审对「遗漏」的误报**，核对后确认无需修改 |
| 10 | S4（bridge 的 `presets` 键）是过度设计 | 采纳。`minimal` 与用户自建预设**按设计**没有 compaction group，bridge 在那里结构性失效，数据化没有真实收益。**S4 整片删除**，原 A12 随之删除 |
| 14 | 缺少「删引擎行之后用户 profile 的空覆盖项」的后果说明 | 采纳。§5.4 已写明宿主会打印 `patch: entry not found` 警告（警告非错误），并要求写进 README |

#### 部分采纳（1 条，经一轮辩论后让步）

| # | 条目 | 裁定 |
|---|---|---|
| 11 | `reserve` 在 §4.8 写 `max(256, ⌈denominator×2%⌉)`，但 38 轮模拟用的是定值 512 ⇒ 数字与规则不一致 | **部分采纳**。Root 反驳：512 是**故意取的悲观变体**，用来给出「下界」；规则本身是 `max(256, 2%)`，在 46,225 的分母上是 924，比 512 更宽。盲审席接受该说明，但双方同意在文中标注清楚。§4.8 已写明 512 是「定值变体」而非规则值。判**让步**（按盲审要求补标注） |

#### 不采纳（3 条）

| # | 条目 | 不采纳理由与辩论结论 |
|---|---|---|
| 7 | 建议把 `regionOf` 的区间改成成员集以消除过采 | **不采纳。** 计划 §4.6 已有 9 折实测：成员集在 `fold@2890` / `fold@3042` 把命令数从 414 打到 **0**（静默事实丢失）。盲审未获得该节实测数据，读后判**让步** |
| 12 | 建议注册 `compaction/summary-error` 恢复钩子来兜住 guard 失败 | **不采纳。** §3.3 与 §5.6 已证：guard 的 throw 在 `for(;;)` 重试循环**之外**（`dsh-compaction-basic/lib/index.js:579-580`），不可恢复；且该循环无轮数上限，无条件 `return true` 会活锁。盲审读源码后判**让步** |
| 13 | 建议提高 `maxTokens` 以避免「summarization truncated at the token cap」 | **不采纳。** 那个报错是 7 次旧风暴、已解决；骨架是**本地渲染**不经模型，`maxTokens` 只影响因果节生成，与本问题的 guard 失败无关。盲审判**让步** |

**辩论轮次**：1 轮。条目 11 走完「提交原判 → Root 反驳 + 证据 → 席位答『让步』」的完整往返；
条目 7 / 12 / 13 的「不采纳」均已开轮，席位在拿到 §4.6 / §3.3 / §5.6 的实测与源码行号后
逐条答**让步**，无「坚持」。**共识成立，无破裂项。**

### 10.3 实施期自审（S2 落地，1 处，已就地修正）

**自审 4：§5.2 条件 4 与本节末的「不得改动既有语义」自相矛盾，条件 4 被证伪并改写。**

按 §5.2 原稿实现后，`tests/extract.test.js` 有 **2 条**既有测试转红：

| 测试 | 夹具 | 原稿裁决 | 应有裁决 |
|---|---|---|---|
| `:353` 失败藏在 `[stderr]` 之后 | `[stderr]\nls: /nonexistent-probe: No such file or directory\n[exit code: 1]` | 丢弃 | **保留** |
| `:374` 非零退出且无 stderr | `some stdout\n[exit code: 3]` | 丢弃 | **保留** |

根因：条件 4 的判据是「首行不命中 `ERROR_PATTERN_EN`/`_ZH`」，而
`No such file or directory` 与 `some stdout` **都不命中**该正则 —— 与 `dsh-scope`
这类真噪音在文本上**完全不可分**。任何能丢掉 `dsh-scope` 的文本规则都会同时丢掉这两条
真诊断，这与本节「不得改动既有语义」直接冲突。

改用**形状**判据后全部自洽：装饰行（`=`/`#`/`*`/`_`/`~`/`+`/`-` 三连排，或 ATX 标题）
丢弃，其余一律保留。

独立探针复验（区域 `[8, 3043]`，逐字镜像 `extract.js` 的
`joinedText` / `firstMeaningfulLine` / `looksLikeFailure` / `firstToolResultBlock`）：

- 失败候选 **31** 条，触发原因分类 `isError 14 / exit-only 9 / first-line 6 / signal 2`
  —— 与 §4.3 的表**逐格相符**，证明探针忠实；
- 新判据丢弃 **7** 条（原稿 9 条），保留 24 条，字符 22,593 → 22,393（省 200）；
- 未丢弃的 3 条为 `dsh-scope`、`509:| A16 | …`、`=== 更宽的凭据扫描 ===`
  —— 均无装饰形状，属**安全方向**（宁可留噪音，不可丢硬事实）；
- §4.3 列表里的 `=== 更宽的凭据扫描 ===` 本来也不在原稿的 9 条丢弃集内
  （它由 `signal` 触发），§4.3 把它列入「纯噪音」是列举口径问题，非谓词问题。

**代价**：F2 的收益从「9 条」降为「7 条」，且 §4.3 已声明 F2 是质量杠杆而非成本杠杆，
故该收缩不影响本计划的任何成本结论（骨架 87.3% 的结论与 F2 无关）。
A8 已随之改写为三条断言（新增「非装饰首行必须保留」一条反向钉住）。

### 10.4 实施期自审（S1 落地，6 处）

**自审 5：A2 的预算公式是死稿，实际实施的是另一条公式。**

原稿 A2 写 `budget = denominator − max(256, ⌈denominator×2%⌉)`。实施时发现它与 A13/A14
无法共存：A13 要求先扣因果价（§4.9 的盲审条目 1），A14 要求再取
`min(·, maxCheckpointTokens)`。三条各自都成立，但合成后的生产公式是

```
budget = min(denominator − causalPrice − FRAME_RESERVE, maxCheckpointTokens)
```

`max(256, 2%)` 这条经验规则**从未进入代码**。它是 §4.8 用来给出「下界」的悲观变体，
在真实折上（denominator 46,225 ⇒ 2% = 924）反而比定值 512 更宽。A2 已改为只保留它
真正要钉住的判据（帧价严格小于分母），公式归本节。

**自审 6：§4.9 的「顺序要求」不可实现，改为两遍渲染。**

§4.9 末句要求「因果节必须先渲染、后量价、再算骨架预算」。这句**做不到**：
因果节是**模型填空的输出**，而填空调用的**输入就是骨架**——骨架必须先存在。
原句把因果节当成了可独立渲染的输入，与 §5.1 的调用链自相矛盾。

实际落地的是**两遍渲染**，既不违反该节要防的越界，也不产生额外模型调用：

1. **第一遍**：按 `causalAllowance`（因果节上界，实测 1,143 token，取 1,200 余量）
   从分母里预留，渲染临时骨架 → 作为填空调用的输入；
2. **第二遍**：拿到真实因果文本后，用**真实帧价**（`framedPrice` 把因果节也定价）
   重渲染骨架，产出最终检查点。

第二遍的预算只扣 `FRAME_RESERVE`、**不再扣一次因果价**——注入的估计器
`(causal) => (skeleton) => framedPrice(meter, skeleton + causal)` 已经把因果节算进帧价里了。
早期探针在这里重复扣了一次，导致预算偏小（无害但公式错），已修正。

**自审 7：A15 的分母链模型错了两次，只有第三个是忠实的。**

A15 要模拟「背靠背退化折」，关键是每轮的分母怎么递推。前两个模型都低估了分母：

| 模型 | 公式 | 后果 |
|---|---|---|
| (a) | `D = est(skeleton) + causalPrice` | 漏掉因果节在帧内的价 |
| (b) | `D = framedPrice(body)` | 漏掉**本轮新追加的事件**，分母几何塌缩（46,225 → 23,895 → 22,372 → …），凭空造出约 30 条命令的丢失 |
| (c) **忠实** | `D₁ = 46225`；`Dₙ₊₁ = framedPrice(bodyₙ) + Σ estimateMessage(hiₙ, hiₙ₊₁] 区间内的事件)` | 用真实归档 seq 2891 起每轮新事件价（5069 / 1953 / 1676 / 5001 / …） |

只有 (c) 与宿主 `prepareCompaction` 的口径一致。**(c) 的结果：guard 20/20 PASS、
12 轮不触地板、最低保留率 92.0%（20 轮时 87.4%）。** 教训：模拟「分母」时必须问「宿主这一轮会重新定价哪些事件」，
而不是只定价自己的产出。

**自审 8：保真阶梯里不能有 T3，且档位选择不能「取第一个非空」。**

两个实现缺陷，都是**静默事实丢失**，由测试当场抓住：

- **T3 进保真阶梯**会让一个 budget-3000 的用例返回 `tier=T3, commands=0`
  ——T3 只保留 `write` 类命令，而探测类命令**被整类丢掉**，这是丢事实、不是降细节。
  且它永远「装得下」，所以阶梯会在 T3 停住并静默返回空命令表。
  改为：保真阶梯**只有 T1 → T2**，T3 移进「截断循环」参与比较。
- **`break` on first non-empty** 让 T3 不可达：探测命令洪泛时，
  T2 截断后仍非空就停住，永远不会去 T3 找回更早的 `write` 类命令。
  改为 `writeLikeCount` + `prefer`：先比「保住的 write 类命令条数」，再比总条数。

**自审 9：`maxCheckpointTokens` 不是硬保证——保底档可以超上限，这是有意的。**

`FRAME_RESERVE`/上限只约束**骨架的降档与截断**，而 intents 与 files **永不裁剪**
（§5.1）。当保底档自身已超上限时，渲染器返回保底档并置 `floorHit`，**不**为了满足
上限去丢 intent。这是刻意的取舍：intents+files 是约 0.7% 的成本与 100% 的意图保真。
A14 因此改为用「保底档低于上限」的区域（120 轮）验证上限真的生效，
另加 A18 反向钉住「上限极小也不丢 intent」。README 已写明该边界。

**自审 10：`FRAME_RESERVE` 定 64，但不是硬需求。**

对余量 0/32/64/96/128/192/256 逐档扫忠实模型：**全部 guard 20/20 PASS、全部不触地板**，
最低保留率（20 轮）84.2%（512）～87.4%（64）；12 轮口径下 64 为 92.0%。保留率随余量单调下降，故取最小的、仍非零的 64
作为保守余量——它是「给框架与舍入留一点头寸」的工程选择，不是 A15 通过的必要条件。

**自审 11：分母跳过 index 0 必须是条件式的。**

`shadowedPrice` 初版**无条件**跳过第一条消息，理由是「宿主 `selectCompactableRange`
用 `firstIdx = 1`」。但宿主那行是条件表达式
（`dsh-compaction-basic/lib/index.js:394`）：

```js
const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;
```

**只有**当第一条真是 `system/message` 时才从 1 开始；没有 system 头的区域从 0 开始。
无头区域被无条件跳过后，分母少算了第一条消息的整份价。

方向上安全（分母偏小 ⇒ 预算偏小 ⇒ 检查点更小 ⇒ guard 仍过），但代价是**预算花不出去**：
实测无头区域渲染成 **3,573** token，而同一宿主分母对应的额度本可支撑 **16,010** ——
同一个宿主分母，两个检查点差 4.5 倍，事实被白白丢掉。A1 的全部价值是「插件分母与宿主
`shadowedRouteTokenCount` 精确相等」，无条件跳过让这条契约在无头区域不成立。

修法：判据改为 `head.role === 'system'`（与宿主的 `systemHead` 同义）。
新增 A1 测试让两个夹具的**宿主分母刻意相等**（有头 = `[system(H), user(H), …]`，
宿主跳 system；无头 = `[user(H), …]`，宿主全留，两者都是 `H + turns`），
断言两边渲染价必须相等。

**该测试前两版是重言的**，已推翻：夹具用共享的 `pushTurn`（事实集太小、任何档都装得下）
时预算永不生效，分母差异不可见，改坏实现测试照样绿。第三版改用大 heredoc 命令后，
把实现改回无条件跳过即报 `got 3573 vs 16010` 失败 —— 这才证明测试在守这条契约。
**教训：验收测试必须先用「故意改坏实现」验证它会红，否则无法区分「测试通过」与
「测试没测到」。**

**实测总账**（全部用发布的 `lib/` 模块，不是重新实现）：

| 判据 | 结果 |
|---|---|
| A12 帧价严格小于分母（9 个真实折） | **9/9 PASS**（余量 23,244–158,178） |
| 对照：旧固定规则渲染在同 9 折 | 9/9 也未越界（真实折的分母足够大） |
| 退化链 20 轮 guard | **新 0/20 失败；旧 2/20 失败**（旧渲染帧价单调增至 25,113，而分母低至 24,542） |
| A13 因果 0→8000 字符 | 命令 429→385，单调不增 **PASS** |
| A14 超大分母 | 帧价 23,829 ≤ 24,000 + 102 **PASS** |
| A15 忠实链 12 轮 | 不触地板、最低保留率 92.0%（20 轮 87.4%）**PASS** |
| 单元测试 | **135/135**（S1 前为 106） |

退化链的失败机制值得记下：**旧渲染的帧价单调增长，而分母在震荡**（低至 24,542）。
两者必然相交——这正是生产上 27 次 guard 失败（超出 59–2,287 token）的成因，
也是「固定规则渲染无论调多小都会越界」的实证。

### 10.5 交付缺口（实施完成但用户尚不可见）

**本计划的四项改动都已进仓库，但用户界面上看不到任何变化。** 这不是回归，是交付链的
一个未记入计划的环节，必须写明，否则「S5 已完成」会被误读为「插件页已经只剩一个条目」。

实测（2026-09-20）：

| 位置 | `id: ctx-mem` 行数 | 是否有 S1/S2 代码 |
|---|---|---|
| 仓库工作集 | 1（只有 bridge） | 有（`render.js` / `isNoiseExitError` / `maxCheckpointTokens`） |
| 已发布的 `@logictan/dsh-plugins-all@0.4.0` | **2** | —— |
| 用户 profile `~/.dsh/profiles/web/node_modules/` | **2** | **无**（`lib/` 里没有 `render.js`，`extract.js` 无 `isNoiseExitError`） |

用户 profile 依赖的是 `"@logictan/dsh-plugins-all": "^0.4.0"`，即 npm 上的**已发布版本**，
而不是本仓库。本仓库的 `packages/all/package.json` 版本号**仍是 0.4.0**，与已发布版本
**同号但内容不同**（ctx-mem 块 16 增 14 删）。因此：

1. 本计划的改动要到达用户界面，必须**重新发布**聚合包；
2. 同号重发不可行（npm 拒绝覆盖已发布版本），故必须先**升版本**（0.4.0 → 0.5.0）；
3. 升版本与发布都不在本计划的授权范围内（§2.1 未列），需用户裁定。

**因此 A16 / A17 的判据需要分开看**：

- **A16**（本包 patch 只有一行、`aggregate.mjs --check` 通过）—— **仓库内已满足**，
  可独立验收；
- **A17**（真实 Web GUI 里跑一次压缩、断言 `compaction/end` 无 error）—— **未验收**，
  且在当前 profile 下**不可能验收**：GUI 里跑的仍是旧 ctx-mem 0.1.0。

**S1 的核心结论不受此影响**：预算驱动渲染的正确性由归档重放与 133 条单元测试独立证明
（§10.4 实测总账），不依赖是否已发布。但「guard 在生产上不再失败」这句话，
要等新版发布并进入用户 profile 之后才谈得上验证。

**后续动作（需用户授权）**：`packages/all` 升 0.4.0 → 0.5.0、`packages/ctx-mem` 升
0.1.0 → 0.2.0（S1/S2 改了对外行为与配置键），然后走 `scripts/publish.mjs` 的拓扑顺序发布。

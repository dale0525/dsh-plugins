# ctx-mem 检查点可读性优化

> 前置计划：[`2026-09-20-ctx-mem-optimization-and-de-forking.md`](./2026-09-20-ctx-mem-optimization-and-de-forking.md)
> （下称**前序计划**）。前序计划解决「压缩是否成功」（guard 不失败、事实不衰减），
> 本计划解决「压缩产物是否对 agent 可用」。
>
> **本文档已于 2026-09-20 按当前工作树重写 §1–§9，并于 2026-09-21 按 S5/S6/A5d 落地后的
> 工作树复核 §1–§9。** 树中已落地的实现（S0–S6）按实测数字记录。原稿的 **S1（`capProbe`）** 与
> **S6-旧（OpenViking 记忆根锚点）** 已随用户裁定删除，不再出现在本文档中；
> 原稿的 §4.7 / §5.8 / §10.5 等悬空引用一并清除。
>
> **⚠️ 生效前提**：§1–§9 的全部实现已落地且测试通过，但**代码落地 ≠ 宿主生效**——改动必须
> 走完「提交 → 升版 → CI/CD 发布 → `dsh-web restart`」才会被宿主加载。2026-09-21 首次核对时
> 该流程尚未执行，端到端验收（A14）**未通过**；证据、根因与通过路径见 §10.6，发布后的复验见 §10.7。

## 1. 问题与目标

### 1.1 问题

前序计划交付后，ctx-mem 的压缩在**机制上**已经正确：

| 指标 | 实测（会话 `ee2e100e` 的 6 折） |
|---|---|
| 宿主 guard | 6/6 PASS，帧价占分母 2.1%–26.9%（100% 才失败） |
| 压缩比 | 779,345 → 47,231 token（**6.06%**） |
| 事实衰减 | 无。每折从原始事件重建，末折仍保有 355 条命令 |

但**产物本身**对消费它的 agent 不友好。末折检查点（fold `dad2768e`，投递 66,001 字符）：

| 节 | 字符 | 占比 |
|---|---|---|
| `### User Intents` | 491 | 0.7% |
| `### Files Touched` | 1,900 | 2.9% |
| `### Commands Run` | **53,916** | **82.1%** |
| `### Errors Seen` | 6,447 | 9.8% |
| 四节因果（`## Why This Approach` 等） | 2,733 | 4.2% |

**82% 的篇幅是一份 shell 转录，4.2% 是只有模型能提供的解释。** 信息密度倒挂。

更关键的是**一类信息完全缺失**：assistant 在过程中得出的结论、以及 assistant 向用户
提出的问题，都不在检查点里。压缩后 assistant 只看到用户说了什么，看不到自己在回答什么、
问过什么（§4.6）。

### 1.2 目标

在不改动预算公式与区域语义的前提下，消除六类**可测的**可用性缺陷：

1. **命令节占据检查点 82% 的篇幅，其中 48.9% 是探针**（§4.1）——最严重。
   修法是**整类丢弃**（S0，已落地）。
2. **`### Errors Seen` 含假阳性**（§4.2）——污染最可靠的一节（S2，已落地）。
3. **列表结构歧义**（§4.3）——多行命令的续行与条目边界不可分（S3，已落地）。
4. **最高价值的一节被埋在 89.7% 处**（§4.4）——节序（S4，已落地）。
5. **user intent 没有配对上下文**（§4.6）——压缩后 assistant 无法把用户的回答对应回
   它回答的是哪个问题（S6，已落地）。
6. **`maxCheckpointTokens` 只存在于配置文件里**（§4.7）——用户无法在插件设置界面调整
   （S5，已落地）。

### 1.3 非目标

- **不改 T1/T2/T3 档位阶梯的形状。** 三档仍按保真度排序；S0 之后三档都只渲染写类命令，
  差别只剩每条保留多少（§5.1）。
- **不改 `regionOf` 的区间语义。** 前序计划 §4.6 R6 与 `tests/region.test.js:291`
  已钉死：区间过采是**特性**。收窄会静默丢弃 161–347 条命令/折（实测）。
- **不打开 OpenViking 的 `captureToolResults`。** 评审期用户裁定「不打开 ov 的 tool」；
  该开关已是 `false`（`~/.dsh/profiles/web/cordis.patch.yml:41`），本计划零改动。
- **不做「探查结果探针」机制**（评审期用户裁定「探查结果探针不做」）：探针的输出已由
  错误节与文件节承载，不再为探针保留渲染路径。
- **不给 `### Files Touched` 加 `/tmp` 过滤**（§4.5）。
- **不做完整 assistant 摘要。** S6 只为每条 user intent 配一条**紧邻其前的 assistant 陈述**，
  不引入「assistant 说了什么」的独立汇总节（§5.5、§5.8）。

## 2. 范围

### 2.1 在范围内

| 片 | 文件 | 状态 |
|---|---|---|
| **S0** | `packages/ctx-mem/src/render.js` | **已落地**：命令节只渲染写类（`isWriteLike`），探针整类丢弃 |
| **S2** | `packages/ctx-mem/src/extract.js` | **已落地**：`recordError` 出口加 `isMisclassifiedError`（§5.2） |
| **S3** | `packages/ctx-mem/src/skeleton.js` | **已落地**：`renderBody` 缩进多行条目的续行 |
| **S4** | `packages/ctx-mem/src/skeleton.js` | **已落地**：`SECTIONS` 顺序：errors 提到 commands 之前 |
| **S6** | `src/extract.js` + `src/skeleton.js` + `src/render.js` | **已落地**：为每条 user intent 记下紧邻其前的 assistant 陈述（§5.5） |
| **S5** | `src/config.js` + `src/client.js` | **已落地**：缺省 24,000 → 10,000；设置界面可改（§5.6） |
| 测试 | `tests/{render,skeleton,extract,config,index}.test.js` | 各片针对性测试（§6） |

S3 / S4 / S6 同文件（`skeleton.js`），但**触点不同**：S3 改 `renderBody`，S4 改
`SECTIONS` 常量，S6 改 `buildSkeleton` 的 intents 节渲染。三者须串行。

**S5 已不再与任何片冲突**：S0 落地后探针在所有档位都不渲染，缺省值降到 10,000 只会把
档位从 T1 换到 T1（实测区域 `[8,2991]` 在 10,000 下仍是 T1，帧价 7,057）——
原稿记录的「10K 使探针路径失效」这一冲突**已随 S0 消失**（§4.7）。

### 2.2 明确不在范围内

- 前序计划 §5.1 / §5.2 / §5.3 / §5.4 的任何内容（已完成）。
- 宿主侧的 `reasoning` 定价缺陷（前序计划 §5.5 F5，插件无法修）。
- `### Files Touched` 的 `/tmp` 噪声（47% 是临时路径，见 §4.5 —— 判为**已知边界**）。
- 任何文档、README、SKILL.md 的改动（除非 §6 验收要求）。
- **S5 之外的任何界面改动**：本计划不给 ctx-mem 加第二个设置卡片，也不改
  `thresholdRatio` / `retainRatio` / `fillEnabled` 等其余键的呈现方式。

## 3. 约束与兼容性

1. **`renderCheckpoint` 的契约是「永不抛异常」**（`src/render.js:305-306`，实现见 `:314`）。
   任何新增的渲染分支必须是纯函数且对任意输入返回字符串，不得新增抛点。
2. **`renderBody` 的注释曾声明「不裁剪、不转义、不缩进」**（`src/skeleton.js:99-104`）。
   S3 已**改写该契约**——这是本计划唯一一处有意改变对外产物形态的改动，已由
   `tests/skeleton.test.js` 的 A3b 钉住并同步注释。
3. **`looksLikeFailure` / `firstMeaningfulLine` / `isWrapperMarker` 的语义不得改动。**
   前序计划 §5.2 已把它们列为冻结契约，且 `tests/extract.test.js:353` / `:374` 钉住
   「装饰行判据不得退化为『首行不命中错误正则』」这一教训。
   **新增约束**：S2 的谓词必须**尊重宿主的 `isError` 权威**——`isNoiseExitError` 的第一行
   就是 `if (isError) return false`（`src/extract.js:518`），S2 沿用同一姿态
   （`src/extract.js:449`），不得仅凭文本形状推翻宿主的判定。
4. **`buildSkeleton` 是纯渲染器**，无 I/O、无 session 访问、无模型调用
   （`src/skeleton.js:11-12`）。S3/S4/S6 必须保持这一性质。
5. **节序改动是价格中性的**——依据见 §4.4 的实测。
6. **`intents` 永远逐字保留、永不裁剪**（`src/render.js:15-18`）。S6 的配对上下文是
   **附加**在 intent 之后的一行，受独立的上限约束；不得为了让上下文放下而裁剪 intent。

## 4. 实测根因

> **探针与口径**：会话归档 `ee2e100e` 解压后的 `ee2e.jsonl`（3,017 事件），区域
> `[8, 2991]`（= 末折 `dad2768e` 的 `shadowedSeqs` 跨度）。
> 定价口径：`@deepseek-ai/dsh-token-meter/lib/types/estimate.js` 的 `estimateMessage`
> （`CHARS_PER_TOKEN = 4`），帧价经 `src/frame.js` 的 `frameCheckpointMessage`。
>
> **真值**（`extractFacts`，区域 `[8,2991]`）：`intents 13 / files 49 / commands 355`；
> `errors` HEAD 52 → 工作树 **43**。`isWriteLike` 判定写类：HEAD 88 / 工作树 **61**。
> T1@24,000 渲染：HEAD 355 条 / 52 错误 / 帧价 15,813；工作树 **61 条 / 43 错误 / 帧价 7,057**。
> 分母 61,464。
>
> **S2 的最终丢弃数是 9 而非 11**：谓词按 A5d 收窄到「行首 200 字符」后，两条 46K 的 heredoc
> 泄漏行（`✔` 出现在第 ~37,600 字符处）**不再被误丢**，错误条目因此是 **43**（§4.2）。
>
> **缺陷计数与条目计数是两个口径**：条目数按 `extractFacts` 的数组长度（355）；
> 缺陷计数按**渲染后的文本行**。两者不可混用。

### 4.1 C1 — 命令节占据 82% 篇幅，其中近半是探针（**主因，已修**）

渲染器按 `isWriteLike` 分流每条命令。**HEAD 版**只对写类命令做整条截断，探针降级为首行
（`capFirstLine`），于是 267 条探针把 26,376 字符（占命令节 **48.9%**）带进检查点——
而它们的首行绝大多数是 `cd <repo>`（158 条）或 `echo ===`（43 条），**读者拿到的是
「有人在那个目录里干了点什么」**。

实测（区域 `[8,2991]`，HEAD 版 `renderCheckpoint(facts, 24000)`）：

| 指标 | 值 |
|---|---|
| 命令条目 | 355（写类 88 / 探针 267） |
| 命令节字符（节头 → errors 节头） | 53,934 |
| 其中探针贡献 | **26,376（48.9%）** |
| 探针首行是 `cd …` / `echo …` | 158 + 43 = 201 / 267 = 75.3% |

**修法（S0，已落地）**：探针**整类不渲染**（`commandAt` 返回 `undefined`）。
探针的事实是它的**输出**，而输出已由 `### Errors Seen` 与 `### Files Touched` 承载；
探针文本本身是一个「读者已经知道答案的问题」，保留它只是花预算复述问题。

| 指标 | HEAD | 工作树 |
|---|---|---|
| 命令条目 | 355 | **61** |
| 命令节字符 | 53,934 | **18,547** |
| 其中探针行 | 26,376（48.9%） | **0** |
| 帧价 | 15,813 | **7,057（−8,756）** |

> **两列的口径不同，不可相减**：HEAD 侧 53,934 是**命令节的字符跨度**（命令节头 → errors 节头），
> 工作树侧 18,547 是同一跨度的字符数；而帧价是**整份检查点**的定价，同时含 S2/S3/S6 的效果
> （§5.7 的分步表才是增量来源）。

> **61 而非 88**：工作树同时收紧了 `isWriteLike` 的三条判据（§5.1），把 27 条「读操作被
> 误判为写操作」的命令（引号内的子命令、`git tag -l` 类列举、重定向到 `/tmp` 的探针）
> 正确归为探针。

### 4.2 C2 — `### Errors Seen` 含 17.3% 假阳性（**已修**）

末折 HEAD 版渲染出的 52 条错误里，**9 条（17.3%）不是错误**：

| 类别 | 条数 | 机制 |
|---|---|---|
| **通过的测试行**（含 `✔`） | 6 | `ERROR_PATTERN_ZH`（`extract.js:41`）匹配测试**名**里的 `失败`/`拒绝` |
| **工具的 JSON 输出 blob** | 3 | `ERROR_PATTERN_EN` 匹配 `"conclusion":"failure"` 的子串 |
| heredoc 泄漏行（46K 字符） | **0（保留）** | `cat > /tmp/msg.txt <<'MSG'` 的正文被当作诊断；该行内含 `✔`，但位于第 ~37,600 字符处，**在 A5d 的行首 200 字符窗口之外**，故不被丢弃 |

> **另一条曾被我误判为假阳性**：`bash: 0`（首行是 `0`）。实测 `seq 127` 是
> `git ls-remote --tags origin | grep -c ''` 的退出码 1——**它是真错误**，必须保留。
> 详见 §5.2 与 §5.8。

实例（前两条是**通过的测试**，第三条是 `gh run list` 的正常输出）：

```
- bash: ✔ subtree pull 硬失败（无 subtree 祖先）→ 退出码 3，不产出假提交、不推进基线
- bash: packages/dsh-config-manager test: ✔ zip-security: 重复条目名拒绝 (1.416708ms)
- bash: [{"conclusion":"failure","createdAt":"2026-09-20T08:38:47Z",...
```

**修法（S2，已落地）**：`recordError` 出口加 `isMisclassifiedError`（§5.2），
两条形状谓词 + `isError` / 全文 `✘` 守卫。

| 指标 | HEAD | 工作树 |
|---|---|---|
| 错误条目 | 52 | **43** |
| 渲染后错误节字符 | 6,445 | **4,976（−1,469）** |
| 其中**行首 200 字符**含 `✔` | 6 | 0 |
| 其中**全文**含 `✔` | 8 | **2**（两条 46K 巨行，按 A5d 保留） |
| 其中 JSON blob | 3 | 0 |

> **`✔` 计数分两个口径**：HEAD 的 52 条里，**行首 200 字符**含 `✔` 的有 6 条，**全文**含 `✔`
> 的有 8 条——多出的 2 条就是那两条 46K 的 heredoc 泄漏行（`✔` 出现在第 ~37,600 字符处）。
> §5.2 记录了这条谓词因此暴露的**过度宽松**问题；A5d 收窄到行首窗口后这两条**恢复保留**，
> 于是工作树侧「全文含 `✔`」是 2 而不是 0。

### 4.3 C3 — 列表结构歧义（**已修**）

HEAD 版 `renderBody` 把条目渲染成 `- ${item}` 且**不缩进**。条目自带换行时，续行与下一条目
在文本上完全不可分：

| 指标 | HEAD | 工作树 |
|---|---|---|
| 渲染器实际产出的条目 | 355 | 61 |
| 逐行数 `- ` 得到的条目 | 472 | 166 |
| 缩进两格的续行（`  ` 开头、非 `  - `、非 `  ↑ `） | 10 | 182 |
| 条目内**标题形状**的行（第 0 列 `# ...`） | **2**（另加 `## Extracted Facts`） | **0** |
| 缩进后的续行 `  - ` | 0 | 3 |

> **口径**：本表只保留**能改变阅读语义**的两行。第 0 列的 `# ...` 行会让 markdown 渲染器
> 把续行当成新标题并**截断该节**（HEAD 实测有 2 条，来自 heredoc 里写计划文档时的
> `# CI lines look like: ...`）；`  - ` 行会让读者把一个条目数成两个。
> 这两项在工作树中都已归零。

**修法（S3，已落地）**：`renderBody` 的续行前缀两个空格（CommonMark 列表项的最小缩进）。

**成本**：工作树 172 条续行 × 2 字符 = 344 字符（**+89 token**，实测）。

### 4.4 C4 — 最高价值的一节被埋在 89.7% 处（**已修**）

| 节 | HEAD 偏移 | 占比 | 工作树偏移 | 占比 |
|---|---|---|---|---|
| `### User Intents` | 19 | 0.0% | 19 | 0.1% |
| `### Files Touched` | 528 | 0.8% | 2,359 | 8.5% |
| `### Commands Run` | 2,447 | 3.9% | 9,272 | 33.3% |
| **`### Errors Seen`** | **56,381** | **89.7%** | **4,278** | **15.4%** |
| `## Why This Approach` | — | — | — | — |

> **口径**：两列都是**骨架正文**的节头偏移与占比（HEAD 62,843 字符 / 工作树 27,819 字符，
> 区域 `[8,2991]`，T1@24,000）。HEAD 侧按骨架计而非按投递消息计，两列才可比。
> 骨架里没有 `## Why This Approach`——因果四节由模型产出，不在骨架内，故该行留空。
>
> **结论不变**：errors 从 89.7% 挪到 15.4%，即从「埋在最后」变成「读完 files 就读到」。
> 工作树的 commands 占 33.3% 是因为 S0 之后它已缩到 18,547 字符，骨架总量也随之降到 27,819。

**修法（S4，已落地）**：`SECTIONS` 顺序改为 intents → files → **errors** → commands。

**价格中性**：实测同一 facts 在两种节序下帧价**差为 0**（工作树，区域 `[8,2991]`；
交换 `SECTIONS` 里 errors/commands 两项后重新渲染，帧价不变）。

### 4.5 已知边界：`### Files Touched` 的 `/tmp` 噪声（**不修**）

49 条路径中 23 条是 `/tmp` 临时脚本，另有 `.` 1 条。**判为已知边界，理由**：

1. 该节合计 1,919 字符（**6.9%**），修它省不下 token。
2. 「`/tmp` 路径是不是噪声」取决于上下文——调试脚本的路径在排查时是真事实。
3. 任何「按前缀过滤」的规则都会引入「哪些目录算噪声」的主观判断，与前序计划 §5.2 的
   教训（文本规则会误杀真诊断）同构。

⇒ 记录在案，不修，不辩论。

### 4.6 C6 — user intent 没有配对上下文（**已修，S6**）

`### User Intents` 只渲染用户说了什么（`src/extract.js:172`、`src/skeleton.js:46-51`）。
压缩后 assistant 看到的是 13 条孤立的用户消息：

```
- 继续
- 已完成重启
- 授权启用
- 已完成重启
```

**「继续」是继续什么、「已完成重启」是在回应哪一步、用户对哪个问题给了授权——全部丢失。**
这正是压缩后 assistant 反复走回头路的根因之一。

实测（区域 `[8,2991]`）：

| 指标 | 值 |
|---|---|
| genuine user intent | 13 |
| `contexts.length` | 13（与 intents 下标对齐） |
| 其中**有**紧邻其前的 assistant 文本（`!== ''`） | 11 |
| 前一条 assistant 文本总字符 | 6,518（平均 593） |
| 按 300 字符封顶后写入 | intents 节 489 → **2,340** 字符（**+458 token**） |

**修法（S6，已落地）**：见 §5.5。

### 4.7 C5 — `maxCheckpointTokens` 曾是配置文件里的死旋钮（**已修，S5**）

**现状（S5 落地前）**：该键只存在于 cordis patch 的 `config.engine.maxCheckpointTokens`
（当时缺省 24,000），设置界面里没有它。**S5 落地后**：缺省改为 **10,000**
（`src/config.js:41`），并新增客户端半边 `src/client.js`，把该键做成设置卡片里的一个输入框。

**原稿记录的「10K 使探针路径失效」冲突已消失**：原稿认为降到 10,000 会让
`renderCheckpoint` 选中 T3、而 T3 的 `writeOnly` 丢弃全部探针。**S0 落地后三档都不渲染
探针**，`writeOnly` 标志已从 `TIERS` 中删除（`src/render.js:39-43`），10,000 与 24,000
在该区域**都落在 T1**：

| cap | HEAD 选中档 | 工作树选中档 | 工作树命令条目 | 工作树帧价 |
|---|---|---|---|---|
| 24,000（原缺省） | T1 | **T1** | 61 | 7,057 |
| 12,000 | T3 | **T1** | 61 | 7,057 |
| **10,000（新缺省）** | T3 | **T1** | 61 | 7,057 |
| 7,000 | T3 | **T2** | 61 | 6,873 |
| 6,600 | T3 | **T3** | 61 | 3,963 |
| 6,000 | T3 | **T3** | 61 | 3,963 |

⇒ **缺省值 10,000 现在是一个纯粹的上限旋钮**，不再有分档副作用：
10,000 与 24,000 落在同一档、产出同一份检查点（7,057）。降档点在 7,000 与 6,600。
S5 因此从「产品取舍」降级为「补一个可配置项」。

## 5. 改动设计

### 5.1 S0 — 探针整类丢弃（**已落地**）

`src/render.js` 的 `commandAt`（`:135-143`）：

```js
function commandAt(command, tier) {
  if (!isWriteLike(command)) return undefined;          // 探针整类丢弃
  if (tier.writeVerbatim > 0) return capText(command, tier.writeVerbatim);
  return capWriteFirstLine(command, tier.firstLine);
}
```

**连带改动**（同文件）：

1. `TIERS` 删除 `writeOnly` 标志（`:39-43`）——三档都丢探针，该标志已无区分作用。
2. `renderCheckpoint` 的**保真阶梯**从 `['T1','T2']` 扩为 `['T1','T2','T3']`（`:320`）——
   原设计把 T3 排除在阶梯外，理由是「T3 丢事实，所以永远装得下」。S0 之后**没有任何一档
   丢事实**（都只丢探针），T3 回到阶梯内，退化顺序重新变成「先降保真、再丢条目」。
3. `isWriteLike` 收紧三条判据（`:72-85`）：引号内的子命令不算调用（`QUOTED` 剥离）、
   `git tag` 的列举形式不算写、重定向到 `/tmp` / `/dev/null` / `/private/tmp` 不算写。

**实测**：§4.1。命令条目 355 → 61，帧价 15,813 → 7,057（含 S2/S3/S6 的全部效果）。

### 5.2 S2 — 错误假阳性过滤（**已落地**）

在 `src/extract.js` 的 `recordError`（`:410`）里，`isNoiseExitError` 之后新增
`isMisclassifiedError(content, line, isError)`（`:448-453`），命中即丢弃：

```js
const PASS_LINE = /[✔✓]/;          // 通过的测试行
const FAIL_LINE = /[✘✗×]/;         // 失败的测试行，否决两条丢弃规则
const JSON_BLOB = /^\[\s*\{/;      // 序列化的工具载荷

function isMisclassifiedError(content, line, isError) {
  if (isError) return false;                              // 宿主已裁定：永不推翻
  if (FAIL_LINE.test(joinedText(content))) return false;  // 本次运行也失败过
  const trimmed = line.trim();
  return PASS_LINE.test(trimmed) || JSON_BLOB.test(trimmed);
}
```

**为什么这两条不违反 §3.3 的冻结契约**：它们**不改动** `looksLikeFailure` /
`firstMeaningfulLine` / `isWrapperMarker` 的语义，只在 `recordError` 的**出口**加一层过滤。
前序计划 §5.2 的教训是「不得用『首行不命中错误正则』当判据」——本谓词用的是**符号形状**
（`✔`）与**结构形状**（JSON 数组），不是「不命中正则」。

**实测**：§4.2。错误条目 52 → **43**，错误节字符 6,445 → **4,976**。

> **过度宽松已按 A5d 收紧**：`PASS_LINE` 与 `JSON_BLOB` 现在只作用于**行的前 200 字符**，
> 判据落在它声称的形状上。收紧前那两条 46K 的 heredoc 泄漏行是因 `✔` 出现在第 ~37,600
> 字符处而被**顺带**丢掉的；收紧后它们**恢复保留**，所以最终丢弃数是 **9**（6 条通过行 +
> 3 条 JSON blob），而不是收紧前的 11。
>
> **原计划预测「收紧后 52 → 41 不应改变」被实测证伪**：41 是**过度宽松**下的产物，正确的
> 数字是 **43**。A5d 的断言因此钉在「谓词只看行首 200 字符」这一形状契约上，
> 而不是钉在一个具体条目数上。

### 5.3 S3 — 续行缩进（**已落地**）

`src/skeleton.js` 的 `renderBody`（`:116-119`）：

```js
function renderBody(items) {
  if (items.length === 0) return NONE;
  return items.map((item) => `- ${item.replace(/\n/g, '\n  ')}`).join('\n');
}
```

**为什么两个空格就够**：CommonMark 的列表项续行缩进要求是「不超过内容起始列」，`- ` 占两列，
续行缩进两格即落进同一列表项。逐行读 `- ` 的读者因此不会把续行误判为新条目，markdown
渲染器也不会把续行里的 `# ...` 当成新标题。

**成本**：172 条续行 × 2 字符 = 344 字符（**+89 token**，实测）。

**已同步**：`tests/skeleton.test.js` 的 A3b 已改写为断言「一个条目仍占一个 bullet，且续行
缩进两格」；`renderBody` 的注释已同步。

### 5.4 S4 — 节序（**已落地**）

`src/skeleton.js:46-51` 的 `SECTIONS` 顺序改为：

```js
{ key: 'intents',  header: '### User Intents'  },
{ key: 'files',    header: '### Files Touched' },
{ key: 'errors',   header: '### Errors Seen'   },   // moved before commands
{ key: 'commands', header: '### Commands Run'  },
```

**理由**：错误是**最不可再生**的一节（`greedyFill` 已把「errors give way last of all」
写进贪心顺序）；命令是转录，可回放。把 errors 提到前面，让 agent 在 4.2% 处就能读到最可靠
的信息。

**价格中性**：实测同一 facts 在两种节序下帧价相等（差 0，§4.4）。

**已同步**：`tests/skeleton.test.js` 的本地 `SECTIONS` 副本与 A4 顺序断言已更新。

### 5.5 S6 — user intent 的配对上下文（**已落地**）

**问题**：见 §4.6。压缩后 assistant 只有孤立的用户消息，无法把「继续」「已完成重启」
「授权启用」对应回它们各自在回应什么。

**设计**：为每条 genuine user intent 记下**紧邻其前的那一条 assistant 陈述**，作为配对上下文
一并渲染。

**数据形状**（`src/extract.js`）：新增与 `intents` **按下标对齐**的列表：

```js
/**
 * @typedef {object} Facts
 * @property {string[]} intents   Verbatim user intent texts, in order.
 * @property {string[]} contexts  The assistant statement immediately preceding
 *   each intent, by index; `''` when the region holds no assistant text before
 *   that turn (e.g. the first user message). Same length as `intents`.
 * ...
 */
```

**抽取规则**（`extractFacts` 的单次遍历，`:128-180`）：

- 维护 `pendingAssistant`：遇到 `assistant/message` 时，用现有的 `assistantBlocks`
  （`:228`）+ `concatenatedText`（`:294`）取出文本；**非空才覆盖**，空则保留上一个
  （避免 tool-call-only 的 assistant 消息把陈述冲掉）。
- 遇到 genuine user message 时，`contexts.push(pendingAssistant)`，然后
  `pendingAssistant = ''` —— **只配对紧邻其前的一条**，不复用、不跨轮累积。
- 区域内的第一条 user intent 通常没有前置 assistant 文本，`contexts[0] === ''`。

**渲染**（`src/skeleton.js`）：`### User Intents` 的每个条目渲染为

```
- <intent 逐字>
  ↑ <context 上限内>
```

intent 本身仍逐字保留、永不裁剪（§3.6）；`↑ ` 行只在 `contexts[i] !== ''` 时出现。

**上限**（`src/render.js`）：`TIERS` 新增 `contextCap`（T1 300 / T2 200 / T3 120），
在 `transformAll` 与 `greedyFill` 的 base 里用现成的 `capText` 施加。上下文**不参与贪心
丢弃**——它与 intents 同属「永不丢弃」的基础部分，只是各自受上限约束。

**实测成本**（区域 `[8,2991]`，T1）：intents 节 489 → 2,340 字符，帧价 6,599 → 7,057
（**+458 token**）。加上 §5.1–§5.4 的净变化，投影帧价 7,761，占分母 12.6%（§5.7）。

**验收**：A19–A21（§6）——**均已落地并通过**。

### 5.6 S5 — 把 `maxCheckpointTokens` 提到设置界面（**已落地**）

#### 5.6.1 两个可参照的既有实现

用户指定参照 `dsh-easyrewrite` 与 `dsh-workbuddy-connect`。两者是**同一目标的两代做法**：

| | easyrewrite | workbuddy（现行接缝） |
|---|---|---|
| 让命名空间「被服务」 | `ctx.settings.register(ns, dummySchema)`，schema 是 `(x) => x` 加一个假 `toJSON` | `settings.installSection(ctx, ns, SECTION, config, { setSource, onChange })` |
| 卡片 | 手写，注册进 `plugins.row.config` | 手写，注册进 `plugins.row.config` |
| 读写 | 自己的 HTTP 路由 | 接缝自带的 `get` / `update` |
| 证据 | `src/index.js:319-326`、`src/client.src.js:4206-4220` | `src/index.ts:763-772`、`src/client/index.tsx:100-105` |

**`installSection` 才是现行接缝**（`dsh-settings` 的 `SettingsProvider.installSection`，
签名见 `lib/types/index.d.ts:228`）。**S5 采用 workbuddy 的形态。**

#### 5.6.2 三条硬约束（都来自实测，不是推断）

**约束 1 — 必须新增客户端半边。** `plugins.row.config` 是**槽**，键为
`<bundle 包名>#<行 id>`，由插件自己注册（`dsh-client-ui-plugin-manager` 只做分派）。
宿主**没有**「按 schema 自动生成表单」的通用渲染器——实测六个 `dsh-client-ui-settings-*`
包里没有任何 schema→form 组件，每个卡片都是手写的。而 `ctx-mem` 当前**完全没有客户端
半边**（`src/` 无 `client*`，`package.json` 无 `dsh.client`、无 `./client` 导出，
`build.mjs` 明确写着「no client half, no bundling step」）。

⇒ S5 需要：新增 `src/client/`、`package.json` 加 `dsh.client` 与 `./client` 导出、
`build.mjs` 加客户端构建、新增 `SettingsCard`。**这是本计划里最大的一块新代码。**

**约束 2 — 注册的单一所有者应是 bridge 行，不是引擎行。** 引擎行由 bridge 注入到 preset 的
`compaction` 组内，而该组带 `isolate: { compaction: true, toolResultPruner: true }`
（`dsh-agent-presets/presets/standard/agent.cordis.yml:138-142`）。更关键的是：
**preset 可能被挂载多次**（bridge 覆盖 `standard` / `ptc` / `cordis` 三个），而
`installSection` 对同一命名空间的第二次注册会冲突。bridge 行是**profile 平面、每进程一次**，
且**已经**是用户写 `config.engine` 的地方。

**约束 3 — 引擎在构造时一次性捕获配置。** `this.ctxMemConfig = own`（`src/index.js:121`）
之后只读。所以要让设置**即时生效**，必须把 `maxCheckpointTokens` 的读取从
`this.ctxMemConfig.maxCheckpointTokens`（`:147`）改为在渲染时求值的 thunk；否则只能声明
`applies: 'restart'`。

**建议**：先按 `applies: 'restart'` 实现——压缩是低频操作，重启一次可接受，而 live 路径需要
把配置源穿透 bridge→patch→engine 三层，成本远高于收益。

#### 5.6.3 缺省值 10,000 的后果

见 §4.7 的实测表。**摘要**：S0 之后该键是一个纯粹的上限旋钮，10,000 与 24,000 在实测区域
落在同一档（T1）、产出同一份检查点。**原稿记录的「S1 不可达」冲突已消失。**

### 5.7 全部落地改动（S0–S6）的合计投影

| 项 | 帧价影响（区域 `[8,2991]`，T1@24,000） |
|---|---|
| 基线（HEAD，HEAD 抽取器 + HEAD 渲染器） | 15,813 |
| 换用工作树渲染器（S0 + S3 + S4） | **−8,846** |
| 换用工作树抽取器（S2 错误过滤） | **−368** |
| S6 配对上下文 | **+458** |
| **骨架小计（工作树，已落地）** | **7,057** |
| 加因果节（末折实测 2,733 字符 = 684 token） | **+684** |
| **投影合计** | **≈ 7,741** |
| 分母 | 61,464 |
| **占比** | **≈ 12.6%**（guard 在 100% 失败） |

> **口径**：四项增量是**逐步施加**测出来的（换渲染器 → 换抽取器 → 加 S6），不是把单项数字
> 相加——三者作用于同一份渲染文本，加法会重复计数。S3 单独成本实测 **+87 token**（174 条
> 续行 × 2 字符），已含在「换用工作树渲染器」那一行里。
> **实际投递的 HEAD 检查点是 16,517 token（26.9%）**，工作树全量落地后是 7,057（11.5%），
> 含因果节投影 ≈7,741（12.6%）。

余量充足。**换渲染器是主收益（−8,846，其中 S0 占绝大部分），S2/S4 是纯质量收益，
S3 花 87 换结构无歧义，S6 花 458 换回「用户在回答什么」。**

### 5.8 否掉的方案（不得重新提出）

| 方案 | 否掉理由 |
|---|---|
| 把探针「截断得更聪明」（`capProbe` 跳前导导航行） | **已作废**（评审期用户裁定「探查结果探针不做」）。探针的事实是它的输出，输出已在错误节与文件节；为探针保留渲染路径就是保留 48.9% 的噪声 |
| 调低 `maxCheckpointTokens` 到 14,000 让 T3 生效 | 原稿理由（「一次砍掉 267 条命令」）**随 S0 消失**：三档都不渲染探针。该键现在只是上限旋钮 |
| 收窄 `regionOf` 的区间（跳过 system 头） | 前序计划 §4.6 R6 + `tests/region.test.js:291` 已钉死；实测收窄会丢 161–347 条命令/折 |
| 按前缀过滤 `/tmp` 路径 | 见 §4.5：主观判断，且只占 6.9% |
| 把 `### Commands Run` 移到末尾（因果节之后） | 与 S4 同效但更激进：命令是转录，放在 errors 之后即可，不必降到因果四节之后 |
| 丢弃「纯数字 / 纯退出码」的错误条目 | **实测证伪**：`bash: 0` 是 `git ls-remote --tags \| grep -c ''` 的退出码 1。丢它就是丢「这条命令失败了」 |
| 用 `t.includes('"conclusion"')` 识别 JSON blob | **实测证伪**：命中的 5 条里 2 条不是 JSON 数组，而是把 `gh run list` 命令原文误当诊断的行。`JSON_BLOB` 已覆盖 3 条真 blob，硬编码业务字段是 over-fitting |
| 为 assistant 建一个独立的「结论汇总」节 | 越权：那需要模型总结，而检查点的契约是「硬事实逐字 + 模型只补四节因果」。S6 只做**机械配对**，不做总结 |
| 为每条 user intent 记录**整个** assistant 回合 | 成本不可控（末折单个 assistant 回合实测 2,810 字符），且「整个回合」里的工具叙述对「用户在回答什么」没有增量。只取紧邻其前的一条陈述 |

## 6. 验收契约

| # | 契约 | 验证方式 | 状态 |
|---|---|---|---|
| **A1** | S0 落地后，命令节**不再出现探针**：`renderCheckpoint(facts, 24000, framed).commands` 的每一项都 `isWriteLike` | 单元测试 + 归档重放 | **已满足** |
| **A2** | S0 **不改变**写类命令的渲染：写类命令逐字保留（超过 `writeVerbatim` 才截断） | 单元测试 | **已满足** |
| **A3** | S0 的截断仍带 `…[+N chars]`，且 `N` = 实际未输出的字符数 | 单元测试，镜像既有 `capFirstLine` 的标记算术 | **已满足** |
| **A4** | S0 落地后既有 `tests/render.test.js` + `tests/budget.test.js` 全绿 | 套件 | **已满足**：`packages/ctx-mem` 全包 `node --test` **170/170 PASS** |
| **A5** | S2 落地后 `### Errors Seen` 无 `✔`/`✓` 通过行、无 JSON blob | 单元测试 + 归档重放 | **已满足**（`extract.test.js:537`、`:551`） |
| **A5b** | S2 **不得**丢弃纯数字/纯退出码条目（`bash: 0` 是真错误） | 单元测试：该条必须仍在 | **已满足**（`extract.test.js:563`） |
| **A5c** | S2 **尊重 `isError`**：宿主标记失败时一律保留；且全文含 `✘`/`✗`/`×` 时保留 | 单元测试两例 | **已满足**（`extract.test.js:582`、`:595`） |
| **A5d** | S2 的谓词只作用于**行的前 200 字符** | 单元测试两例（`extract.test.js:610`、`:633`） | **已满足**。**原判据「收紧后 52 → 41 不变」已被实测证伪**：41 是过度宽松下的产物，收紧后正确值是 **43**（§5.2） |
| **A6** | S2 **不改变** `looksLikeFailure` / `firstMeaningfulLine` / `isWrapperMarker` 语义 | `tests/extract.test.js:353` / `:374` 仍绿 | **已满足** |
| **A7** | S2 落地后区域 `[8,2991]` 的错误 **52 → 43**，渲染后错误节字符 **6,445 → 4,976** | 归档重放 | **已实测**（§4.2） |
| **A8** | S3 落地后「逐行读 `- ` 得到的条目数」在命令节 == 渲染器实际产出的条目数 | 单元测试：多行命令夹具 | **已满足** |
| **A9** | S3 **不改变**单行条目的渲染（逐字相同） | 单元测试：单行命令的前后渲染比对 | **已满足** |
| **A10** | S4 落地后节序为 intents → files → **errors** → commands，四节都在 | `tests/skeleton.test.js` 的 A4 断言 | **已满足** |
| **A11** | S4 是**价格中性**的：同一 facts 两种节序帧价相等 | 单元测试 | **已满足**（归档重放差 **0**） |
| **A12** | S0–S6 落地后，区域 `[8,2991]` 的帧价（骨架 + 因果）**< 分母** | 归档重放：**7,057 骨架 / ≈7,741 含因果 < 61,464（12.6%）** | **已实测** |
| **A13** | 全仓 `pnpm test` 与 `pnpm typecheck` 通过 | 仓库门禁 | **已跑**：`pnpm typecheck` 退出码 0；`packages/ctx-mem` 独立 `node --test` **170/170 PASS**。全仓 `pnpm test` 退出码非 0，唯一原因是 `packages/dsh-agy-link` 的环境性失败（见 §7 风险表末行） |
| **A19** | S6 落地后，每条有前置 assistant 陈述的 intent 都带 `↑` 行；`contexts.length === intents.length` | 单元测试：两轮用户消息夹一条 assistant 文本 | **已满足**（`extract.test.js:656`、`:671`；`skeleton.test.js:211`、`:224`、`:231`） |
| **A20** | S6 **不裁剪 intent 本身**：`contexts[i]` 超限时只截断上下文行 | 单元测试：超长上下文 + 逐字 intent 比对 | **已满足**（`render.test.js:300`、`:314`；`skeleton.test.js:239`） |
| **A21** | S6 的上下文**只取紧邻其前的一条**，不跨轮累积 | 单元测试：连续两条用户消息（中间无 assistant）时第二条 `contexts === ''` | **已满足**（`extract.test.js:677`） |
| **A15** | `DEFAULT_MAX_CHECKPOINT_TOKENS` 为 **10000**，且 schema 缺省、`splitConfig` 兜底、文档三处一致 | 单元测试：`Config({}).maxCheckpointTokens === 10000` | **已满足**（`index.test.js:173`） |
| **A16** | 设置界面能改该键并持久化，重启后生效 | 真实界面验证（A14） | **实现已落地**（`src/client.js` + `installSection`）；界面**未经真实点击验证**——见 §10.6 |
| **A17** | 命名空间**只注册一次**（多 preset 挂载时不冲突） | 单元测试：`installSection` 注册在 bridge 行，不在引擎行 | **已满足**（`bridge.test.js:238`） |
| **A18** | 该键的界面文案**必须写明它是上限旋钮，调小会触发分档切换** | 界面文案审查 | **已满足**（`src/client.js:34-39`） |

**端到端（A14）**：在真实 Web GUI 里触发一次压缩，确认新检查点的 `### Errors Seen` 在
`### Commands Run` 之前、命令节只含写类命令、且每条 intent 带配对上下文。需要一次长会话，
属**交付后验证**，不作为开工前置。

> **2026-09-21 实测：A14 未通过。** 在真实会话里触发压缩后，产物**仍是旧形态**——
> errors 在 commands 之后、无 `↑` 配对行。根因不是实现缺陷，而是**改动未发布**：
> profile 装的是已发布的 0.2.0（== HEAD，pre-S5/S6）。完整证据与通过路径见 §10.6。

## 7. 风险

| 风险 | 后果 | 缓解 |
|---|---|---|
| S0 把真事实判成探针而丢弃 | 事实丢失 | `isWriteLike` 的三条判据都有实测依据（§5.1）；**已知边界**：判定是文本规则，新工具形态需扩 `WRITE_LIKE`。A1 + A2 钉住 |
| S2 的 `isMisclassifiedError` 丢掉真错误 | 硬事实丢失 | 两条谓词都带 `isError` 与全文 `✘` 守卫；**已知过度宽松**见 §5.2，A5d 要求收紧到行首 |
| S3 改变产物形态导致下游解析器失效 | 未知消费者破裂 | `renderBody` 的契约已在 `skeleton.js:99-104` 改写并注明。A8/A9 钉住 |
| S4 节序改动打破外部按偏移解析的消费者 | 未知消费者破裂 | 检查点没有版本化契约，且节序从未被承诺稳定（`SECTIONS` 是内部常量）。A10 钉住 |
| S6 的配对上下文撑大 intents 节 | 挤占命令预算 | 上下文受 `contextCap` 约束（T1 300），实测 +458 token（§5.5）；且它属于「永不丢弃的基础部分」，只影响档位选择不影响条目保留 |
| **落地≠生效：改动未发布时 GUI 仍跑旧版** | A14 端到端验证失败——压缩产物仍是旧形态 | 实测见 §10.6：本会话（2026-09-21）真实压缩产出的检查点**仍是 errors 在 commands 之后、无 `↑` 配对行**。根因是 profile 装的是**已发布的 0.2.0**（== HEAD，pre-S5/S6），而工作树改动**未提交、未升版、未发布**。生效路径：提交 → 升版 → CI/CD 发布 → `dsh-web restart` |
| `packages/dsh-agy-link` 测试失败污染全仓门禁 | `pnpm test` 退出码非 0，掩盖真实回归 | 该包 test script 在本机环境（node 版本 / `--experimental-transform-types`）不可用，`git status --porcelain packages/dsh-agy-link` 为空——**未被本次改动触碰**。判为环境噪音：ctx-mem 的验收以 `packages/ctx-mem` 独立 `node --test` 为准（170/170 PASS） |
| S6 配对错位（`contexts` 与 `intents` 下标不齐） | assistant 把 A 的陈述配到 B 的提问 | 两者在**同一次遍历**里成对 push，长度恒等；A19 断言 `length` 相等 |
| 新增客户端半边引入构建/加载面 | `dsh.client` 配错则浏览器半边不加载 | 照抄 `dsh-workbuddy-connect` 的 `dsh.client` 与 `./client` 导出；A13 typecheck 覆盖 |
| 命名空间被重复注册（preset 挂载多次） | `installSection` 冲突，宿主报错 | 注册挂 profile 平面的 bridge 行（每进程一次），不挂引擎行。A17 钉住 |

## 8. 未决问题（开工前需裁定）

1. **S6 的上下文上限取多少？** 实测（区域 `[8,2991]`）：300 字符 → +458 token；
   200 → +410；500 → +560。**建议 T1 取 300**——它足以覆盖「已完成重启」「授权启用」这类
   短回答所指的完整陈述，而末折单个 assistant 回合实测最长 2,810 字符，再放大收益递减。
2. **S6 的上下文要不要保留首行以外的内容？** 当前设计用现成的 `capText` 截断**整条陈述**
   （保留开头），而不是只取首行。**建议保留整条并截断**：assistant 的结论常在首行之后
   （「已完成本轮全部工作。」之后才是里程碑列表），只取首行会把信息量最大的部分切掉。
3. **S3 的缩进宽度：2 格还是 4 格？** 2 格足够 CommonMark 语义，且成本减半。
   **已按 2 格落地**（§5.3）。
4. **S5 的 `applies` 取 `live` 还是 `restart`？** **建议 `restart`**——压缩是低频操作，
   而 live 需要把配置源穿透 bridge→patch→engine 三层（§5.6.2 约束 3）。
5. **S5 的缺省值是否仍要改成 10,000？** 原稿的冲突（§4.7）已消失，该键现在只是上限旋钮。
   **已裁定并落地：改成 10,000**（`src/config.js:41`）——10,000 与 24,000 在实测区域落在
   同一档、产出同一份检查点（7,057）。
6. **S2 的谓词收紧（A5d）要不要先于 S6 做？** 当前 11 条丢弃里 2 条是靠「46K 字符里恰好含
   `✔`」丢的，判据不落在它声称的形状上。**已落地**：谓词收窄到行首 200 字符
   （`extract.test.js:610`、`:633`），两条巨行恢复保留，最终丢弃 **9** 条（§5.2）。
7. **S5 的 `applies` 最终取什么？** 已按 `restart` 落地（`src/client.js` 的卡片提示文案
   写明「重启后生效」）。

## 9. 实施顺序

```
S0 (render.js)              ── 已落地 ─┐
S2 (extract.js)             ── 已落地 ─┤
S3 (skeleton.js renderBody) ── 已落地 ─┤  同文件，须串行
S4 (skeleton.js SECTIONS)   ── 已落地 ─┘
                                        │
                                        ▼
S2 补测试 + 谓词收紧 (extract.js + extract.test.js)  ── 已落地
                                        │
                                        ▼
S6 (extract.js + skeleton.js + render.js)           ── 已落地
                                        │
                                        ▼
S5 (config.js 缺省值 + 客户端半边 + installSection) ── 已落地
                                        │
                                        ▼
提交 → 升版 → CI/CD 发布 → dsh-web restart        ── 未做（A14 因此未通过，§10.6）
```

1. ~~先裁定 §8 第 1、2 条~~（已裁定：T1 取 300 字符上限、保留整条并截断）。
2. ~~S2 补测试 + 谓词收紧~~（A5 / A5b / A5c / A5d 均已落地）。
3. ~~S6~~（A19–A21 已落地，`tests/skeleton.test.js` 夹具已同步）。
4. ~~S5~~（缺省值 10,000 + `src/client.js` + `installSection` 均已落地）。
5. **剩余：把工作树改动提交、升版、走 CI/CD 发布，然后重启宿主。** 这是 A14 通过的唯一路径。

## 10. 评审记录

> **说明**：§10.1–§10.4 写于 §1–§9 重写之前，是对**原稿**的评审记录，其中的章节号
> （§4.1 / §5.1 / §5.3 / A1b / A15–A18 等）指向当时的文本，重写后可能已迁移或删除。
> 保留原文以存证；**当前有效的设计以 §1–§9 为准**。§10.5 记录重写时核定的实施状态。

### 10.1 Root 自审（写计划过程中，3 处，均已就地修正）

**自审 1：撤回「C3 有 33 处结构歧义」的初稿数字。**
初稿按「`- ` 开头且上一行非空」计数，得到 33。该口径把**每一条正常条目的首行**都算了进去
（355 条里 357 条满足「上一行非空」）。改用渲染器**实际产出的条目数组**与「逐行计数」
的差集后，真值是 **3** 条嵌入 `- ` 行 + **2** 条标题形状行。§4.3 已按真值改写。

**自审 2：撤回「write-like 保留 0/88」的探针假象。**
早先的探针用 `renderCheckpoint(...).originals.filter(isWriteLike).length` 计数，恒得 0。
根因是 T1 的**快路径**（`render.js:294`）直接 `return result(parts, name, false)`，
**不记录 `originals`**（该字段只在贪心路径填充）。改用**位置对齐**重测后真值是
**88/88 逐字保留**。§1.1 的表格已按真值改写。

**自审 3：把「`### Files Touched` 的 /tmp 噪声」从「缺陷」降级为「已知边界」。**
初稿把它列为第五项缺陷。核验后：该节 1,918 字符（2.9%），修它省不下 token，且
「哪些目录算噪声」是主观判断，与前序计划 §5.2 的教训同构。已移入 §4.5，标注不修。

### 10.2 独立盲审

**席位**：`antigravity/gemini-3.8-flash`（独立于 Root）。**产出 9 条，全部经 Root 独立探针复验。**

| # | 条目 | 复验结论 | 处置 |
|---|---|---|---|
| 1 | 假阳性比例标题 23% vs 正文 19.2% 矛盾 | **成立** | 初稿两个数分别是「抽取口径 23.1%」与「渲染口径 19.2%」，标题误用了后者。**最终定为 17.3%**（= 9/52，只算真正该丢的 6 通过行 + 3 JSON blob）；§4.1 新增口径说明 |
| 2 | `capProbe` 的 `N` 与「含被跳过的前导行」矛盾 | **成立** | 改写为「前导行被保留，不计入 `N`」 |
| 3 | S1 保留了前导行，首行仍是 `cd`，未达目标 | **成立且重要** | §5.1 新增说明：S1 改的是**全文**（72→7），首行 72→72 是**有意行为**；新增 A1b |
| 4 | S3 会打破 `skeleton.test.js` 的 A3b | **成立** | §5.3 补上 A3b 同步要求 |
| 5 | A1 引用了未定义的 `NOFACT` | **成立** | §4.1 给出 `NOFACT` 的完整定义与代码 |
| 6 | `isMisclassifiedError` 不尊重 `isError`，且多行 `✔`+`✘` 会漏判 | **成立** | 谓词签名改为 `(content, line, isError)`，加 `isError` 与全文 `✘` 守卫；新增 A5b/A5c |
| 7 | `prefix` 无长度上限；`"conclusion"` 是 over-fitting | **前半成立、后半更严重** | `prefix` 实测最长 139 < 200，**不加限制**（记为有意决策）；`"conclusion"` **删除**——实测误伤 2 条非 JSON 行 |
| 8 | 「价格中性」在 4 节重复 | **成立** | §3 / §5.4 / A11 改为引用 §4.4 |
| 9 | §4.4 把偏移差与总长度差混为一谈 | **成立** | 更正为 56,381（正文）/ 56,703（投递），差 322 字符 |

**盲审之外、Root 自审追加的 1 条**（盲审未覆盖）：

| # | 条目 | 复验结论 | 处置 |
|---|---|---|---|
| R1 | 初稿把 `bash: 0` / `bash:       35` 当假阳性 | **证伪**（实测是真错误） | 删除「纯数字」谓词；新增 A5b；写入 §5.6 否决表 |

**全部 10 条均已采纳并就地修正，无「需辩论」项。**
盲审条目 7 的后半段（`"conclusion"`）与 Root 自审 R1 指向同一处代码，
复验时一并收紧：**S2 最终只剩两条谓词**。

### 10.3 实施期预演（S1 落地前，1 处，已实测）

**预演 1：S1 的补丁在真实代码上跑通了全部既有测试。**

把 `capProbe` 按 §5.1 写进 `src/render.js` 的副本、替换 `commandAt` 的探针分支后，
在仓库内跑完整 `packages/ctx-mem` 测试套件：

```
ℹ tests 143
ℹ pass 143
ℹ fail 0
```

**零回归**。随后已把 `src/render.js` 恢复为原样（`diff -q` 确认字节相同），
工作区未留改动。这条预演把 A4 从「计划」变成「已验」。


### 10.4 需求变更记录（评审后由用户追加）

**变更**：把 `maxCheckpointTokens` 提到插件设置界面供用户配置，缺省值 **24,000 → 10,000**。

**处置**：新增 **S5**（§5.7）与根因 **C5**（§4.6）；§1.2 增第 5 条目标；
§1.3 的「不改缺省值」非目标**作废并改写**；§2.1 范围表加 S5 行；§2.2 加「S5 之外的界面改动不做」；
§6 加 A15–A18；§7 加 4 条风险；§8 加第 5、6 条待裁定；§9 重排实施顺序。

**参照实现**：用户指定参照 `dsh-easyrewrite` 与 `dsh-workbuddy-connect`。实测两者是
同一目标的两代做法，S5 采用后者的 `settings.installSection`（现行接缝，签名见
`dsh-settings/lib/types/index.d.ts:228`）。证据：

| 事实 | 位置 |
|---|---|
| easyrewrite 用 `ctx.settings.register` + 假 schema | `dsh-easyrewrite/src/index.js:319-326` |
| easyrewrite 手写卡片注册进 `plugins.row.config` | `dsh-easyrewrite/src/client.src.js:4206-4220` |
| workbuddy 用 `settings.installSection`（现行） | `dsh-workbuddy-connect/src/index.ts:763-772` |
| workbuddy 的接缝迁移说明（0.1.2 起 helper 上移到 provider 服务） | `dsh-workbuddy-connect/src/index.ts:725-740` |
| 卡片是**槽**、由插件自己注册，宿主只分派 | `dsh-client-ui-plugin-manager/lib/client.js:1323` |
| 宿主**没有** schema→form 的通用渲染器 | 六个 `dsh-client-ui-settings-*` 包内无任何此类组件 |
| ctx-mem 当前**无**客户端半边 | `build.mjs:1-8`「no client half」；`package.json` 无 `dsh.client`、无 `./client` 导出 |
| 引擎行位于 `isolate: { compaction: true }` 组内 | `dsh-agent-presets/presets/standard/agent.cordis.yml:138-142` |
| 引擎构造时一次性捕获配置（非 live） | `ctx-mem/src/index.js:121`、`:147` |

**未决（当时）**：§8 第 5 条（缺省值裁定）与第 6 条（`live` 还是 `restart`）当时尚未裁定。
**2026-09-21 复核**：两条均已裁定并落地——缺省值改为 10,000、`applies` 取 `restart`（§8）。

### 10.5 树状态核对与文档重写（2026-09-20，2026-09-21 复核）

**触发**：用户裁定「把 §4–§9 整体重写对齐当前树；只为每条 user intent 记下前一条
assistant 陈述作配对上下文；删除 §5.8；实现已在树中但零测试的片补测试并修正数字」。

**核对结论**（逐条对当前工作树复验，非推断）：

| 项 | 原稿 | 树中实际（2026-09-21 复核） |
|---|---|---|
| S0（探针整类丢弃） | 未记录（原稿是 S1 `capProbe`） | **已落地**：`commandAt` 对探针返回 `undefined`；`TIERS` 删除 `writeOnly`；保真阶梯恢复 T1→T2→T3 |
| S2（错误过滤） | 未落地 | **已落地**：`isMisclassifiedError` + `PASS_LINE`/`FAIL_LINE`/`JSON_BLOB`，谓词已按 A5d 收窄到行首 200 字符 |
| S3（续行缩进） | 未落地 | **已落地**：`renderBody` 两空格续行 |
| S4（节序） | 未落地 | **已落地**：`SECTIONS` errors 在 commands 之前 |
| S5（设置界面） | 未落地 | **已落地**：`DEFAULT_MAX_CHECKPOINT_TOKENS = 10000`（`config.js:41`）；新增 `src/client.js` + `dsh.client` + `./client` 导出；`installSection` 挂在 bridge 行 |
| S6（配对上下文） | 未落地 | **已落地**：`contexts` 与 `intents` 同遍历成对 push；渲染为缩进的 `  ↑ ` 行 |
| S1（`capProbe`） | 计划中 | **已作废**：用户裁定「探查结果探针不做」，S0 取代之 |
| S6-旧（OpenViking 记忆根锚点） | 计划中 | **已删除**（用户裁定） |
| 错误条目数 | 52 → **43** | 52 → **43**（实测，§4.2；谓词收窄后两条巨行保留） |
| 错误节字符 | 6,446 → 4,977 | 6,445 → **4,976**（实测） |
| 命令条目 | 355（T1 全量） | **61**（探针整类丢弃 + `isWriteLike` 收紧） |
| 帧价 | 16,971 骨架 / 17,671 含因果 | **7,057** 骨架 / ≈7,741 含因果（投影） |
| 单元测试 | 143/143 | **170/170 PASS** |

**数字修正的来源（2026-09-21）**：原稿写的 `52 → 41` 是**过度宽松**谓词下的产物。
谓词按 A5d 收窄到行首 200 字符后，两条 46K 的 heredoc 泄漏行（`✔` 在第 ~37,600 字符处）
**恢复保留**，正确值是 **43**。这同时证伪了 §5.2 原判据「收紧后 52 → 41 不应改变」。

**悬空引用清理**：原稿引用的「§4.7」（原稿中不存在）、「§5.8」（原稿中不存在）、
「§10.5 R1 / R3」（原稿中不存在的裁定编号）全部清除；「OpenViking 记忆根锚点」目标与
原 S6 一并删除，S6 编号改指「user intent 的配对上下文」（用户本轮新增的需求）。
新文档的 §4.7 与 §5.8 是**重写时新写的**章节，与上述已清除的旧引用无关。

**上一轮遗留的零覆盖缺口已闭合**：§10.5 首版记录「A5 / A5b / A5c / A5d 在 `tests/` 中零覆盖」，
本轮复核时该缺口**已补齐**——四个契约各有针对性测试（`extract.test.js:537/551/563/582/595/610/633`），
全包 170/170 PASS。S2 的谓词亦已按 A5d 收窄到行首 200 字符（§5.2）。

### 10.6 端到端验证（A14）——**未通过，根因已定位**（2026-09-21）

**触发**：用户在同一会话里真实执行了一次压缩，并要求直接核对产物。

**核对方法**：解压该会话归档（`~/.dsh/sessions/.../session.v3.jsonl.zstd`），逐折读出
`compaction/summary` 事件的投递正文，检查三项契约：errors 是否在 commands 之前、
intents 是否带 `  ↑ ` 配对行、命令节是否只含写类命令。

**结论：四项契约全部未生效**——每一折的 `### Errors Seen` 偏移（39,648 / 45,729 等）
都**远大于** `### Commands Run` 的偏移（1,906 / 978 等），即 errors 仍在 commands **之后**；
`  ↑ ` 配对行数为 **0**。这正是 HEAD 的旧形态。

**根因（实测，非推断）**：**工作树改动从未进入 profile**。

| 证据 | 值 |
|---|---|
| 工作树 `package.json` 版本 | `0.2.0`（未升版） |
| `HEAD:packages/ctx-mem/package.json` 版本 | `0.2.0`（同版本） |
| npm 已发布版本 | `0.1.0`、`0.2.0`（`0.2.0` == HEAD，pre-S5/S6） |
| `npm pack @logictan/dsh-ctx-mem@0.2.0` 内容 | 含 `lib/skeleton.js` 等，**无 `lib/client.js`**；`dsh` 字段**无** `client` |
| profile 安装版本 | `0.2.0`，`lib/` 下**无 `client.js`** |
| 工作树 `git status` | `src/{bridge,config,extract,render,skeleton}.js` 与 6 个 `tests/*.js` 均为 `M`（未提交）；`src/client.js` 为 `??`（未跟踪） |

⇒ 宿主加载的是**已发布的 0.2.0**，而 S5/S6/A5d 只存在于**未提交的工作树**里。
A14 因此不是「实现有 bug」，而是「改动未发布」。

**通过 A14 的路径**（唯一路径）：提交工作树改动 → 升 `packages/ctx-mem` 版本
（同时升聚合包 `packages/all`，否则 range 解析不到新子插件）→ 跑
`node scripts/aggregate.mjs` → 走 CI/CD 发布（**禁止手动 `npm publish`**，
见根 `AGENTS.md`「📤 发布」）→ `dsh-web restart` → 重新触发一次压缩核对。

> **未做**：上表中的提交、升版、发布三步均**未执行**——它们超出「改文档」的授权范围，
> 且发布属用户执行的门禁（新包首发）或 CI/CD（更新包）。本计划到此为止，剩余动作见 §9 第 5 步。

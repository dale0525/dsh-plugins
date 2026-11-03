# @logictan/dsh-verbatim-compaction

把上下文压缩的**摘要**从「让模型重写整段历史」换成「用户原话逐字保留，助手部分只留每轮提取的结论」：用户的话一个字不改，助手正文由一次模型调用换成「做了什么 / 得到什么结论 / 哪些结论被推翻」三节，推理块从不读取。

用户原话与助手正文待遇不同，理由是二者可重建性不同：助手回复能从它的工具调用和上下文推回来，用户的纠正、警告、约束推不回来。宿主原生压缩会改写这些原话，那正是本插件要消除的损失。

## 它解决什么

`@deepseek-ai/dsh-compaction-basic` 每次压缩都发起一次 `ctx.llm.stream()`，要求模型按九节模板（Primary Request / Key Technical Concepts / Errors and Fixes …）重写被阴影的区间。在 8 个真实会话上实测（403 MiB、145 次压缩、24.5M 被丢弃 token）：

- 模板只保住被丢弃内容的 **2.38%**；
- 被丢弃内容里真正的「人写的正文」只占 **0.67%** —— 其余是推理 63.8%、工具结果 25.2%、工具调用参数 10.4%；
- 侥幸保住的正文，下一次压缩会被**再摘要一遍**：`selectCompactableRange` 总是从 `surfaceNodes[firstIdx]` 开始，而上一份 checkpoint 正好坐在 index 1。

本插件只覆盖基类的 `summarize()`（基类文档里点名的唯一子类钩子），重放、区间选择、durable 事务与 shrink 守卫全部沿用基类，因此不可能与宿主的事务语义分叉。

## 摘要长什么样

```
## user
（用户原话，逐字，永不改写）

### assistant
## Did
- 实测 `auto_vacuum=FULL` 删除后自动缩容：19.61 MB → 0.01 MB
## Concluded
- 选 FULL：回收发生在宿主自己的 DELETE 里，不受 busy_timeout=0 影响
## Overturned
- 先前认为必须显式执行 VACUUM 才能回收空间
  wrote: /Volumes/LogicExt/Git/BookReader/src/video.js
## Answers
- 验证码已发出，请输入手机上收到的验证码
  → 现在试（推荐）
## Asked
- 是否要用 FULL 而不是 INCREMENTAL
  1. 用 FULL
  2. 用 INCREMENTAL
```

`## Answers` 是走 `ask_user_question` 的问答，由代码从日志渲染；`## Asked` 是模型从正文里认出来的提问。两者并列，各管一半——`## Asked` 永远在最后，因为它的用户回复就是下一行。

标题不带轮次号：日志里的 `turn` 号既不唯一也不是一轮一个（一个真实会话把两条请求都编号成 1），印出来就是会撒谎的标题。

- **用户原话逐字**，不重写、不改写、不摘要。
- **助手正文由提取块替代**，不并列保留——并列就是同一份内容写两遍。
- 工具结果内容丢弃，工具指针行也删除（实测 122 轮会话里它占 1202 token、6% 的上限，却只多给「跑了几次、多少字节」；提取块本来就拿到了每条调用的 `description`，指针行只是 `## Did` 的低信息量复述）。
- 错误只留首行（100 字符）。
- `wrote` 记录本轮写过的路径。
- 推理块从不进入摘要，也不读取。

为什么助手正文不再逐字保留：实测 8 个会话、4400 条助手正文、748743 字符，其中 58.2% 是有实质结论的长文、35.8% 是带数据（数字/代码/引用）的短句、6.1% 是纯过程叙述（「现在我来看…」）。而字面重复几乎为零（段落级完全相同 0.1%）。也就是说，重复不在字面，而在**助手正文与提取块说了同一件事**；两者并列保留就是把这 58.2% 写两遍，还通过预算把真正的历史挤出去。

## goal 触发的轮次

由 goal 续跑的轮次没有用户消息，任务目标由宿主以 `<goal_round>` 注入。原来按「非 user 即注入」一律丢弃，结果一轮 909 字符、7 条任务的目标在摘要里一个字都没有，只剩一个没有任务说明的助手块。

现在保留 `Objective: "..."` 那段，丢弃 `Round: N/256` 计数，并且**同一个 objective 只记一次**——宿主每轮重复注入同一份，全留会在长跑里重复几十遍。objective 放在该轮的 user 位：它就是这一轮在服务的请求。

## 摘要源是日志，不是被阴影的区间

上一份 checkpoint 每次都被一起阴影掉，所以「只摘要被阴影区间」会把上一份摘要承载的全部历史再丢一次。本插件扫描会话日志里 `surfaceOp === 'append'` 的事件，减去本次压缩后仍留在 surface 上的尾部，重建整段历史——不需要任何累积状态，摘要源集合逐次单调增长（122 次压缩实测 0 次非单调）。

`turn/start` 不在 surface 上，但它是「这条 user 消息属于第几轮」的唯一记录（user 消息自身不带 turn），所以一并保留。

## 工具轨迹补出的三节

只抄正文救不了「正文为空」的轮次。实测一个 13878 事件的会话：1973 条 assistant 消息里只有 317 条带正文，其中一轮跑了 342 次工具调用却一个字没写，纯逐字摘要把它压成一行 `tools: bash×281`——活干了，记录没了。

所以提取的材料是三段：用户请求（逐字）、助手正文（逐字）、工具轨迹（每条调用的 `description`）。工具结果一条都不读：唯一曾被读出的东西是失败结果的首行，而那一行永远是传输或退出状态（`命令超过 600 秒未结束`），不是让失败有意义的那部分。模型输出四个字段：`asked` / `did` / `concluded` / `overturned`，标题与项目符号由渲染器拼装。

空节直接不出现：「没有内容」是一个空数组，不是需要事后识别的占位符。字段化之前是自由 markdown，模型写 `## Overturned\n- (none)` 就得在代码里再认一遍占位符，实测一份真实提取块里 `## Asked` 和 `## Overturned` 都是 `(none)`，删掉后 312 → 271 字符；按 130 轮算，这些占位合计约 900 token 只是在记录「什么都没发生」。现在这类占位在解析阶段就被滤掉，不再有一个专门的清理函数。`none of the tests passed`、`无法连接，改用代理` 这类真内容照原样保留。

`## Asked` 记的是「**助手**向**用户**提了什么、给了哪些选项」。这一节最容易错成「把用户请求改写一遍」——真实一次压缩里，模型把用户那段中文请求翻成英文塞进了 `Asked`，而用户原话就在它上面逐字抄着，同一件事写了两遍。

原因之一在材料标签：原来写 `USER REQUEST:`，模型有理由读成「这一轮问了什么」，现在改成 `USER INSTRUCTION (already in the digest verbatim; never copy it into Asked)`。另一部分靠指令本身——`## Asked` 的定义写明「助手问、用户答」，并注明照抄用户请求是这一节最常见的出错方式。

正文为空的轮次（那个真实案例有 96 条助手消息、150 次工具调用却只有 156 字符正文）本来就没有提问可记，`## Asked` 和 `## Did` 一样整节省略，不需要单独规则。实测 123 条真人消息里 43 条（35%）不超过 12 个字符——`3`、`1`、`同意`、`做`、`继续`——而 46% 是在回答上一轮助手的提问。只逐字保留「3」而不保留它在回答什么问题，等于记下一个决定却没记下决定的是什么。

模型用的是会话自己的路由（`session.requestHeader()?.config`），和宿主原生压缩同一个取法，不需要单独配置凭据。

三件事刻意做成这样：

- **工具轨迹不读工具结果**。曾经读失败结果的首行（先用 `/error/i` 匹配，347 条成功结果全部命中；改用 `data.isError` 后信号是对的，但那行文字从没被模型用上）。摘要里既没有 `ERR` 行，也没有 `  errors: N: …` 尾行。唯一的例外是 `ask_user_question` 的答案，它本身就是工具结果，由 `## Answers` 单独承载（见下）。
- **工具调用从 `assistant/message` 的 block 里取**。日志里没有独立的 `tool/call` 事件类型，按它过滤会一条都取不到。
- **提取失败就退回逐字正文**。模型不可达、超时、输出为空时，该轮保留原来的助手正文；压缩本身不能因此失败，否则会话死于上下文溢出，比丢细节更糟。降级是逐轮的：一批里某一轮没答，只有那一轮退回正文。**但降级不再无声**：整批拿不到可用 JSON、或单槽位在令牌上限被截断，都会打一条 `verbatim-compaction:` 开头的 warn，写明受影响的 slot key。没有这条日志时，插件退化成纯逐字摘要这件事在运行期完全不可观测——这正是「JSON 经常不生效却查不到」的成因。

提取调用的 `maxTokens` **在每槽位预算之外另加一笔固定的思考余量**（`EXTRACT_TOKENS_PER_TURN × 槽位数 + EXTRACT_THINKING_RESERVE_TOKENS`）。加入 `asked` 后每槽位预算从 220 提到 900：真实 8 槽批次上思考单独就占 1057–4086 token，`220 × 8 + 1000` 曾把一次调用从 JSON 中间截断，解析出 0 个槽位、整批丢失；`900 × n + 1000` 每次都能解析出全部槽位。`maxTokens` 把思考与正文算在一起，而思考是**每次调用的固定开销，不随批次变小而变小**——这正是「按槽位线性给上限」必然失败的原因。对真实路由（deepseek-flash，真实量级材料）实测：单槽位按旧公式 `220 × 1` 给上限，**4 次全部解析出 0 个槽位**（思考块吃光了整个配额）；改成 `220 × 1 + 1000` 后 **4 次全部成功**，1/2/4/8 槽位各 4 次同样全通过。

同时把 effort **钉在路由声明的最便宜档**，而不是沿用路由默认档。思考与正文共用同一笔 `maxTokens`，默认档通常是最贵那档，会挤占正文预算。实测 2 槽位、带余量：`low` 花 375 个思考 token、3/3 解析成功；`high` 花 931、只有 2/3。

**`off` 走不通，这一点是实测而非推断。** 用本地回显服务抓 pi-ai 1.3.0 对 `thinkingFormat: deepseek` 真正发出的 body：`off` 档被映射成 `reasoning_effort: "minimal"` 且 `thinking: {"type":"enabled"}` 固定不变，而该端点直接拒绝 `minimal`（`valid levels: low, medium, high`）。真正能关掉思考的是 provider 自己的 `thinking: {"type":"disabled"}`（实测 0 个思考 token），但 `GenerateOptions` 没有承载它的字段，这条接缝上的任何插件都发不出去。所以 effort 只在路由**声明了**非 `off` 档时才发——宿主会拒绝未声明的档位。

被令牌上限截断的那一批会**对半拆开重发**：截断的答案解析为空，一个超预算的轮次会连带丢掉同批其余七轮；对半拆把损失限制在仍然装不下的那一半，单槽位无法再拆时放弃并留 warn。注意这两条是一组：没有思考余量时，对半拆只会让每半的每槽位预算更紧、必然全败，所以余量是拆分重试成立的前提。判据钉在 `extractive.spec.mjs` 的「carries a thinking reserve」「pins the cheapest advertised effort」「never sent an effort it did not advertise」「split and retried, not dropped whole」「leaves a warning, not silence」。

提取结果按内容哈希缓存，同一次会话内复用。`digestSource` 每次压缩都从原始日志重建，而原始事件永远留在日志里，所以同一轮会被反复读到。实测那个压缩了 33 次的会话：共提取 142 轮，其中 **129 轮（91%）在更早的压缩里已经提取过**；全机 370 个会话、456 次压缩里，**81% 的压缩工作量是这种重复**（有压缩的 88 个会话中 70 个压缩过 2 次以上）。

缓存的键是提取材料的哈希（用户请求 + 助手正文 + 工具轨迹），不是 slot 位置：位置会随历史增长而错位，内容变了哈希就变，不会读到过期块。缓存是进程内的，重启即失效——代价只是重新提取一次，与加缓存前行为一致。

提取调用返回 **JSON 字段**（`{"slots":[{"key","did","concluded","overturned"}]}`），标题、项目符号、空行全部由代码拼装。此前是自由 markdown，模型会把标题和正文挤在同一行——真实产出里出现过 `… 重出 4 屏 Concluded Stitch 会回填真实车牌`，事后无法用正则判断句子在哪结束、下一个标题从哪开始。字段化之后这个歧义不存在。

`## Asked` 由**模型**输出，和 `did`/`concluded`/`overturned` 并列成 JSON 字段：`asked: [{question, options}]`。曾经改成由代码从 `ask_user_question` 的调用与结果里确定性生成，那个方案在「提问走的是工具」时才成立，而实测里提问大量出现在正文末尾，工具调用根本没有。

**为什么不能只靠日志读。** 两件事需要判断，而不是取字段：其一，提问不在可靠的位置——231 个「引出了短回复」的真实轮次里，34% 的提问后面还有正文（p90 = 7 段，最多 24 段），形如 `## 需要你决定` 后面又跟一节 `## 还没验证的`；其二，选项通常也不在提问旁边——28 个纯数字回复的轮次里，28 个都提供过编号列表，但只有 26/231 轮那份列表落在提问本段或前一段，多数隔着自己的小标题在上面。要认出「这个提问指的是哪份列表」需要判断，日志里只有文字。

**`answer` 字段被明确去掉。** 正文里提的问，回复就是下一节的 `## user` 行，逐字渲染；再写进 `asked.answer` 等于同一句话印两遍。指令里对应加了一条「不要报告用户的回复」，渲染上 `## Asked` 是块的最后一节，所以回复永远紧接在它下面。

**但「回复就在下一节 `## user`」只对正文提问成立。** 走 `ask_user_question` 的提问，用户是在工具自己的选择界面里作答的，答案变成**工具结果**，日志里根本没有 user 消息——实测一个真实会话：三个问题全部在界面里答完，相邻事件是 `tool/result`（`{"answers":[{"id","selected","custom"}]}`），没有 `user/message`，而连续两次检查点的摘要里问题和选择全都不在。所以工具问答由代码从日志确定性渲染成 `## Answers` 一节，与模型的 `asked` 并列、互不重叠：`ask_user_question` 不再进工具轨迹，模型也就无从复述它。

宿主还有第二种送达方式：用户在工具已经返回 pending 提示之后才答，宿主会补写一条 `user/message`，`source.kind` 是 `user-question-reply`，正文是同一份答案批次 JSON（连 `questions` 一起带上）。这条消息不是新请求，所以不另起 section，答案照样进 `## Answers`——它原本会被「只认 `user`/`goal`」的注入过滤整条丢掉。

`## Asked` 的位置由渲染器保证在最后，不靠模型。选项在问题下面缩进编号列出，`- 问题` 一行、`  1. …` 各行，用户的 `1` 因此有东西可指。

**选项自带的编号会被剥掉。** 模型会把源列表的 `1.` 一起抄进 `options`，渲染器再加一次编号就变成 `1. 1. …`；实测 5 次里 3 次如此，所以在解析阶段用正则剥掉，而不是只靠指令。

`ask_user_question` 既不进工具轨迹、也不受 120 条调用上限约束，因为它的问答已经整组由代码渲染进 `## Answers`。答案取 `answers[].selected`；用户没选而是自己打字的，答案在 `answers[].custom`（实测 31 次提问里 10 次是打字回答），两条都渲染。

一个 section 就是一次请求、一个 turn。日志会在同一次请求里推进 turn 号（实测一个请求的 7 条助手消息记作 turn 2、另 9 条记作 turn 3），按号码切分会把一个请求拆成「空请求 turn + 无用户消息的回复 turn」，摘要里就出现两个 `### assistant`。用户消息本身不带 turn 字段，这条也曾让两者永远对不上。

一个 section 只提取一次，提取块写给该 section 的第一个 turn——如果每个 turn 都拿到同一份事件，模型会对同一段材料答两遍（实测出现过两个完全相同的 `## Concluded` 块和 `(duplicate of SLOT 4:0)` 占位）。

提取按批调用：每 8 轮一次，一轮输出一个 `=== TURN n ===` 块。早期实现是每轮一次调用，122 轮就是 131 次往返，单轮 400 token 的输出上限乘以 131 就可能超过整个摘要上限。批处理把往返压到约 17 次，并共享 prompt 前缀以复用 provider 的 KV cache。

用户原话在布局上**先占额度**，提取块不得挤占。实测那个 122 轮会话：区间内真人原话共 469 字符（117 token），而每轮一块 420 字符的提取共 55020 字符——提取是正文的 117 倍，任何让二者竞争的布局都会把正文挤掉，而正文是「请用pixi管理开发环境」这类永不过期的约束，提取描述的却是已经做完的工作。

## 为什么不会触发 shrink 守卫

基类的守卫比较「framed 摘要」与「被替换内容的 route 价」，摘要不小于原内容就整次压缩失败。本插件的预算取 `min(DIGEST_TOKEN_CEILING, shadowedPrice − 86 − 512)`，上限 20000 token 远小于任何实测区间价，因此这条失败路径按构造不可能发生。

上限取**绝对值**而非「区间价的比例」。比例会让摘要随历史增长：同一会话实测早期区间 2642 字符、后期 51019 字符、触发事故那段 348539 字符——因为区间越大就允许摘要越大，而接近阈值的摘要立刻再触发压缩。固定上限让摘要大小与历史长度无关，宿主原生摘要也是这个形状（实测各区间稳定在 14009–22208 字符）。

## 超预算时折叠最旧的段，而不是删掉

摘要撞到 20000 token 上限后，把最旧的一批 section 交给模型压成一段，替换掉它们各自的提取块——不是删除：

```
## user
第1轮请求：…

### assistant
## Condensed (condensed from sections 1-20)
- <模型折叠出的段落>
```

覆盖范围内的 user 行全部保留（常驻约束不过期），只有各自的提取块被折掉，那才是腾出空间的地方。`covers` 按 **section** 计数而不是 turn：`buildSections` 每个用户请求开一节，所以一串连续请求就是一串连续 section；按 turn 计只会覆盖第一节，其余照旧渲染自己的块，折叠白做。

折叠只在普通渲染超预算时触发——它是一次模型调用，装得下就不该付费。

**折叠先于降级。** 折叠模式下 `renderDigest` 不走降级阶梯。此前 1200 轮时阶梯先丢掉 475 个 turn 的 body、只剩 `## Asked`，折叠根本没机会运行。

**折叠绝不截断。** 折叠路径返回完整文本，不做 `slice`：按字符切会把最后一块切成半句，而半句会被读成数据，比整节缺失更糟。折完全部分组仍超预算时（user 行本身过长），`summarize` 回退到降级阶梯并打 warn——预算上限是宿主 shrink guard 依赖的契约，降级后的摘要胜过超预算的摘要。

**折叠结果按内容缓存**（`provider:model:hashText(material)`，与提取缓存同一套 FNV-1a）：历史每次压缩都从原始日志重建，不缓存就每次重新付费。

实测（真实模型、12000 字符摘要）：折叠到 987 字符，压缩率 8.2%，保留了车控帧结构、签名覆盖范围与当前缺口。思考单独占 1873 token，`CONDENSE_TOKENS` 因此定为 6000——1200 时输出为空。

折叠组大小定为 100 个 section（按 8.2% 折叠率模拟）：

| 组大小 | 700 轮 | 1200 轮 |
| --- | --- | --- |
| 20 | 19 次调用 | 52 次 |
| 50 | 8 次 | 21 次 |
| 100 | 4 次 | 11 次 |

**一个真实上限**：3000 轮时全折叠后仍超预算，因为 user 行本身合计 54786 字符。那不是折叠机制的问题——那么多请求的常驻约束本身就超过摘要容量。

## 为什么会收敛（一条真实事故）

只满足守卫**不等于**收敛。守卫只要求摘要比被替换的内容小，一个占到被替换量 99.3% 的摘要照样通过守卫，而 surface 几乎没变。

会话 `小鹏汽车 App 改造评估` 上真实发生过：一次压缩 shadowed 87733 token，产出摘要 priced 87135——只回收 598 token（0.7%）。压缩后 surface 实测 **256704** token，阈值 **256464**，刚好卡在阈值上方，于是下一步立刻又压；此时 surface 上除 checkpoint 外没别的东西，第二次只 shadowed **1 个 seq**（就是刚写的那条 checkpoint），把同样的 34.8 万字符原样重抄一遍（346555 vs 348539），第三次直接 abort。

预算改成被替换量的一半后，同一份日志实测：257696 → **188120** token（0.73× 阈值），一轮就落到阈值以下。只压一条 checkpoint 时摘要也减半（279048 → 139865 字符），因此是几何衰减而非固定点。

## 安装

```bash
pnpm add @logictan/dsh-verbatim-compaction
```

## 激活：必须改 profile patch，本包的行不生效

**这是本插件唯一不直观的地方。** 真正在用的 `compaction` 组嵌在 4 个 agent preset（`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`）的 `config.plugins` 里，带 `isolate: {compaction: true}`，每个 preset 各持一个 `compaction` 服务实例，根上下文看不到它们。因此：

- 顶层新增一行 `compaction` 服务**不会被任何 agent 用到**；
- 往 preset 的 `config.plugins` 里 `insert` 会报 `patch insert: entry "compaction" not found`（`applyEntryPatches` 的 `entryMap` 只收录顶层条目与 `group: true` 条目）；
- 新行也不能与 `compaction-basic` 并存在同一组：`provide('compaction')` 重复注册会抛 `service "compaction" has been registered at <...>`。

本包自带的 `cordis.patch.yml` 因此只插入一行 `disabled: true` 的占位（让聚合包能带上它），真正激活靠**按 Loader row id override 整份 preset `config`**——宿主指南 `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`「Change a shipped preset」的官方路径。在 `~/.dsh/cordis.patch.yml` 里给每个要改的 preset 写一份完整 config，只把 `compaction` 组里的 `compaction-basic` 换成 `verbatim-compaction`：

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # 其余插件原样重述，只改 compaction 组
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

代价是每个要改的 preset 都要重述一遍 `plugins`；换来的是确定性——不依赖任何监听器顺序。

`cordis.patch.yml` 里那行占位必须保留，且 `id` 与本包宿主半边的 `export const name`（`verbatim-compaction`）一致，否则 `check:host` 会报 patch 行 id 不一致。

## 配置

无需配置。预算、注入折叠、错误首行长度都是内部常量；唯一的可调项是基类自己的 `thresholdRatio` / `retainRatio`，它们照旧从 `compaction-basic` 的配置读。

## 已知边界

- **超预算时按节降级，不按字符截断。** 用户原话先占额度（`USER_BUDGET_SHARE` = 0.9）；不够时整节丢弃（Overturned → Concluded → Did，`## Asked` 保留到最后）；仍不够时从最旧端整轮丢弃 body，user 行留到最后。任何层级都不切半行。
- **折叠需要至少一个 section。** `foldGroupStarts` 按 `CONDENSE_GROUP`（100）分组；不足一组的会话仍会折叠那唯一一组，不会因「不够 100」而放弃。
- **折叠成本按组计。** 1200 轮约 11 次模型调用，但只在摘要真的撞到 20000 token 时才发生；本机最大摘要 8050 token。
- **user 行本身过长时无解。** 3000 轮会话的请求合计 54786 字符，超过 80000 字符预算，折叠再多也装不下——那是预算本身的上限，不是折叠机制的问题。
- **注入内容不进摘要。** 判据是 `source.kind !== 'user'`——注入上下文在一个真实会话里占 user 消息字符的 97%，放进摘要会把人的原话淹掉。
- **不改善首轮之外的工具参数细节。** `bash` 命令本身（占工具参数 84.2%）不保留；需要「当时跑了什么命令」的场景不在本插件的覆盖范围内。

## License

MIT

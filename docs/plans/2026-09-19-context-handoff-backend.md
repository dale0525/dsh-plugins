# 上下文交接后端（context handoff backend）

> 状态：事前冻结的计划，待用户裁定 §8 的两项未决问题后开工。
> 实施中的偏离以实际代码为准。事实依据见
> [`../research/context-handoff-codex-ptc-and-deterministic-extraction.md`](../research/context-handoff-codex-ptc-and-deterministic-extraction.md)。

## 1. 问题与目标

### 1.1 问题

DSH 当前的压缩后端 `@deepseek-ai/dsh-compaction-basic` 在每次压缩时，
把被压缩区间的全部消息重放给模型写摘要。实测一次压缩：

| 项 | 实测值 |
|---|---|
| 被压缩区间 | 150 事件 / 160,323 tokens |
| 摘要请求输入 | 81,667 tokens |
| 摘要请求输出 | 4,139 tokens |
| **全价计费合计** | **85,806 tokens** |
| 缓存读取 | 30,720 tokens |

代价有三：每次压缩都要花掉一次接近满窗口的调用；输出不稳定（同输入多次结果不同）；
中文内容靠模型转写，路径/命令/报错可能漂移。

### 1.2 目标

用"程序抽取硬事实 + 模型只补因果"替代"模型重读全文写摘要"，实现：

1. **硬事实零漂移**：路径、命令、报错、用户原话由程序逐字保留，不经模型转写。
2. **成本显著下降**：模型调用从"读全文"降为"读骨架"。
3. **PTC 兼容**：在 `tools.mode = ptc` 下不丢失工具调用信息。
4. **因果不丢**：保留"为什么这么做、为什么失败、别再试什么"。

## 2. 范围

### 2.1 在范围内

- 一个继承 `BasicCompactionEngine` 的压缩后端，覆写 `summarize()`。
- 一个 PTC 感知的还原层：以 `tool/ptc-dispatch` 事件为权威源还原真实工具调用，
  源码解析仅作兜底（见调研 §4）。
- 一个确定性抽取层：产出结构化骨架（硬事实），**每次从原始事件重建**，
  不转发上次的 checkpoint（见调研 §5.6）。
- 一次"填空"模型调用：输入骨架，输出固定四节因果。
- 该后端的配置项、技能（`SKILL.md`）与安装方式。

### 2.2 明确不在范围内

| 不做 | 原因 |
|---|---|
| 改成 codex 那样的**真丢弃**（删除历史、旧区间不可回放） | DSH 的 compaction 是 `replace` 语义，旧区间留在 log 可回放、可审计、可 fork；codex 的新窗口是真丢弃。DSH 更安全，退回去无收益。**注意区分**：D8 的 `retainTokens: 0` 只是"不保留逐字尾巴"，旧事件仍在 log 中，不属此项 |
| 让模型自主管理上下文（写 notes / 主动调工具） | 探针实测自主外化率 0/15，只在被点名动作时执行（见调研 §5.3） |
| 用 OpenViking 当"细节索引" | 实测细节找回靠程序抽取的硬事实；且当前配置 `captureToolResults: false`，工具细节本就不入库，指针会指空 |
| 新增"读自己历史"的工具 | 属独立能力，本方案不引入。若后续要做，需单独立项 |
| 改动 `compaction-basic` 本体 | 本方案是替换后端，不是修改上游 |

## 3. 约束与兼容性

| 约束 | 内容 |
|---|---|
| DSH 版本 | `0.1.6-alpha.2`（本机实测版本） |
| 上游参考实现 | `@aiwayds/dsh-dcp@0.11.0`（MIT）——其 peer 要求 `>=0.1.5-rc.2`，与本机 alpha 线不满足；且其在 PTC 下失效。**因此 fork 改造，而非直接依赖** |
| 挂载层 | 压缩后端是 `ctx.compaction` 服务替换，preset 的 `isolate` realm 决定 profile 层无法覆盖该服务（调研 §6）。**落地方式见 §11**：由 profile 平面的 `ctx-mem-bridge` 行在 preset 组合挂载时注入 patch（路由 B），不再依赖专用 preset 副本。本插件的其余部分（配置项、`SKILL.md`）不涉及服务替换 |
| preset id | 用户根无法覆盖官方 `standard`（first-root-wins），必须使用新 id |
| 仓库 | 落在 `dsh-plugins` monorepo，遵循 `docs/adding-a-child-plugin.md` 的接入规范 |
| 构建产物 | `lib/` 不入版本控制，由 `prepare` 脚本构建（仓库既有约定） |

## 4. 已定决策

| # | 决策 | 依据 |
|---|---|---|
| D1 | 采用"程序抽取 + 模型填空"混合形态，而非纯确定性抽取 | 纯确定性抽取丢因果（实测 8 节里 4 节为空）；调研 §5.4 的填空实验证明模型在有硬事实垫底时能补出可用因果 |
| D2 | fork `dsh-dcp` 的框架而非依赖它 | 理由见 §3"上游参考实现"行；其抽取层需替换为 PTC 感知版本 |
| D3 | 新增 PTC 还原层，以 `tool/ptc-dispatch` 为权威源 | 实测 dispatch 还原 126 次调用 / 102 条命令，正则路线只有 115 次 / 60 条，且漏 11 次 MCP 调用、多出 13 条假阳性命令（调研 §4.1） |
| D4 | 保留 `BasicCompactionEngine` 的全部安全机制 | 触发、保留尾巴、事务锁、tool-pairing 边界均复用上游，仅替换 `summarize()` |
| D5 | 产出四节固定结构 | 与探针验证过的填空指令一致，且覆盖因果所需的最小集合 |
| D6 | 模型填空的输入是骨架，不是原始消息 | 成本从 85,806 降至实测 4,094 全价 token（21x） |
| D7 | 骨架每次从原始事件重建，不转发上次 checkpoint | 既有后端在级联压缩中丢失事实（`cua-driver`、`Accessibility`）；原始区间始终留在 log 中可重建（调研 §5.6） |
| D8 | 提供 `retainTokens: 0` 的"完全抛弃历史"选项，默认关闭 | 默认保留近期尾巴更安全；需要 codex 式硬切断时显式开启。手动 `/compact` 路径已等价于 `retainTokens: 0` |
| D9 | 挂载改为**路由 B**：profile 平面的 bridge 行在 preset 挂载时注入 patch，免专用模式 | 用户裁定「可以，选 B」；探针 probe12–17 证实 `internal/config` waterfall 覆盖 preset 子树、`{global:true}` 必需、就地改 `patches` 生效。详见 §11 |

## 5. 公共接缝与产出格式

### 5.1 唯一替换点

继承 `BasicCompactionEngine`，覆写 `summarize(input, agent, signal)`。
`input` 的形状由上游固定为 `{ tools?, messages }`（`buildSummarizationInput` 产出）。

### 5.1.1 如何从 `input.messages` 取回原始事件

`input` 只给派生后的消息，不给 seq。取回原始事件的路径（调研 §4.3 已实测）：

1. 用 `agent.session` 建立**对象身份 → seq** 的映射（`deriveEventMessage` 返回同一对象引用）。
   实测 150/150、415/415 全部命中，无对象被多条 seq 共享。
2. 得到本区间的 seq 集合后，按 **seq 范围**
   （`min(shadowedSeqs) <= seq <= max(shadowedSeqs)`）从 `agent.session` 取原始事件。

**禁止**用 `shadowedSeqs` 成员判定事件归属：`tool/ptc-dispatch` 是 log-only 事件，
其 seq 与 surface 节点交错，不在 `shadowedSeqs` 中，成员判定会得到"0 个 dispatch"。

### 5.1.2 两条抽取路径

| 模式 | 权威来源 | 兜底 |
|---|---|---|
| PTC（`run_code`） | `tool/ptc-dispatch` 的 `name` / `arguments` / `isError` | 解析 `run_code` 源码中的 `tools.<name>({...})` |
| 默认（直接调用） | `assistant/message` 的 `tool-call` 块 + `tool/result.source.callId` | — |

`tools.mode: 'both'` 产出两种形态混在同一区间，两条路径按块类型各自处理即可。

### 5.1.3 重建语义（避免级联衰减）

骨架每次从**原始事件**重建，**不得**把上次的 checkpoint 文本当作事实来源转发。
依据：既有后端在连续压缩中丢失事实（调研 §5.6），而 `compaction/summary` 保留了
原始 `shadowedSeqs`，实测三个 checkpoint 的原始区间全部仍在 log 中。

### 5.2 四节产出格式

固定以下四节，顺序不可变，空节写 `(none)`：

```markdown
## Why This Approach
- 目标是什么，以及选择该做法的理由。

## Errors and Their Causes
- 逐条：错误为什么发生、是否解决；明确写出"不要再重试什么"。

## Open Decisions
- 抽取截止时仍未解决的问题。

## Next Step
- 最具体的下一步动作。
```

骨架部分（硬事实）以固定小节附在四节之前，内容由程序保证：

```markdown
## Extracted Facts
### User Intents
### Files Touched
### Commands Run
### Errors Seen
```

### 5.3 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.8` | 压力触发阈值（继承上游语义） |
| `retainRatio` | `0.16` | 保留尾巴比例（继承上游语义） |
| `retainTokens` | 未设置 | 保留尾巴的绝对 token 数。设置后**覆盖** `retainRatio`；`0` 表示一条尾巴都不留（"完全抛弃历史"） |
| `fillEnabled` | `true` | 是否执行模型填空；`false` 时退化为纯确定性产出 |
| `fillProvider` / `fillModel` | 空 | 填空所用路由；空则用当前路由 |
| `language` | `zh` | 产出语言 |

`retainTokens: 0` 的效果与边界（源码实证）：

- 通过上游校验：`retainTokens` 只要求非负整数，约束仅有 `retainTokens < thresholdTokens`。
- 语义等价于手动 `/compact` 路径：该路径本就调用 `selectCompactableRange(..., 0)`。
- 模型请求中不再保留任何逐字近期上下文，是 codex 式的硬切断。
  旧事件仍留在 log 中（可回放、可审计、可 fork），但没有任何模型可读接口能取回它们
  （唯一提及 `sessionQuery` 的 `dsh-tool-cordis` 只挂在 `cordis` preset）。

**默认关闭**：默认仍走 `retainRatio: 0.16`，保留近期尾巴更安全。

骨架体积不设独立上限：它由被压缩区间决定，而区间已受 `retainRatio` 与上游
阈值约束。实测骨架为 5,716 字节，远小于该区间的原始体积。
若后续出现骨架过大挤压收益的实际证据，再引入上限。

## 6. 验收契约

以下每条都必须是**可观察**的，且能由一个测试独立判定。

| # | 验收项 | 判据 |
|---|---|---|
| A1 | PTC 还原正确 | 给定含 `tools.bash({command:'x'})` 的 `run_code` 消息，从同区间的 `tool/ptc-dispatch` 事件还原出 `bash` 调用与命令 `x`；dispatch 缺失时回退源码解析且结果一致 |
| A2 | 非 PTC 路径不回归 | 直接工具调用（`name` 非 `run_code`）仍按原逻辑抽取；`tools.mode: 'both'` 的混合区间两种形态都被还原 |
| A3 | 硬事实逐字保留 | 骨架中的路径/命令/报错与输入消息逐字一致，不经模型改写。**含内层引号的命令必须完整**（命令来自 dispatch 的结构化 `arguments.command`，天然完整；兜底路线须用反向引用匹配成对引号，见调研 §4.4） |
| A4 | 四节结构稳定 | 产出必含四节，顺序固定，空节为 `(none)` |
| A5 | 填空可关闭 | `fillEnabled: false` 时产出不含四节，且不发起模型调用 |
| A6 | 继承机制未破坏 | 压力触发、保留尾巴、溢出恢复、tool-pairing 边界的行为与上游一致 |
| A7 | 成本下降可测 | 同一区间的填空调用输入 token 显著低于 `compaction-basic` 的 81,667（目标 ≤ 1/5） |
| A8 | 事件归属按 seq 范围判定 | 构造一个区间，其 `shadowedSeqs` 成员判定会漏掉 log-only 事件；断言实现仍能取到这些事件 |
| A9 | 级联不衰减 | 连续两次压缩后，第一次区间内的硬事实仍完整出现在第二次的骨架中 |
| A10 | 硬切断可开启 | `retainTokens: 0` 时压缩后 surface 只剩 system + checkpoint；模型请求不含任何被压缩区间的逐字消息 |

## 7. 风险与证据缺口

| 风险 | 现状 | 缓解 |
|---|---|---|
| `tool/ptc-dispatch` 在旧版本 DSH 或异常路径下缺失 | 当前版本每个子调用都落盘；实测 126/126 可对齐 | 回退源码解析（A1 覆盖两条路线一致）；两者都失败时保留原始 `run_code` 文本，不静默丢弃 |
| 事件归属误用 `shadowedSeqs` 成员判定 | 该误用实测会得到"0 个 dispatch"的错误结论 | A8 专门断言按 seq 范围判定 |
| 骨架可能仍不足以支撑因果 | 单次实测模型产出可用因果 | 若填空产出空泛，回退 `fillEnabled: false`，仍有确定性产出 |
| 模型填空引入幻觉 | 指令已要求"不得虚构未列出的事实" | 骨架与模型产出的分区是硬边界：骨架节由程序生成，模型只写四节 |
| `retainTokens: 0` 丢掉近期逐字上下文 | 默认不开启 | 默认保持 `retainRatio: 0.16`；A10 只验证开启后的行为 |
| 模型能力结论外推过宽 | 仅测 `deepseek-v4.1-flash` | 方案不依赖"模型会自主管理"，只依赖"模型能按指令填空"——后者已由探针 `explicit` 档验证 |
| preset 副本随官方升级漂移 | 路由 B（§11）已消除此风险：不再复制官方组合，改为在挂载时注入 patch | 无副本即无漂移；patch 只按 `id` 定位官方行，官方改行内容不受影响 |
| bridge 在官方 preset 上打补丁失败（行被改名/删除） | 未发生；`standard`/`ptc`/`cordis` 三个 preset 均含 `id: compaction-basic` 且处于 `group: true` 的 `compaction` 组内（实测） | patch 未命中时上游只 `warn` 不抛错，后果是「该 preset 保持官方后端」而非挂载失败；A11 断言三个 preset 全部命中 |

## 8. 未决问题（开工前需裁定）

### 8.1 填空调用的路由

**问题**：填空用当前会话的路由，还是配置一个更便宜/更稳的固定路由？

- 用当前路由：零配置，但若当前模型弱，产出质量随之下降。
- 用固定路由：质量可控，但需用户维护一份额外配置，且引入跨 provider 依赖。

**倾向**：默认当前路由，配置项留出覆盖能力（§5.3 的 `fillProvider` / `fillModel`）。

### 8.2 preset 的落地方式

**问题**：新建独立 preset（如 `ctx-mem`）并把默认指向它，还是先只在非 web profile 验证？

- 新建并切默认：web 会话即生效，但官方 `standard` 的升级不会自动同步到副本。
- 先在别处验证：不动 web 默认，风险低，但不在日常环境里暴露问题。

**倾向**：先建 `ctx-mem` 副本，**不切默认**，用显式选 preset 的新会话验证；
验收通过后再决定是否切默认。

**裁定（2026-09-20，用户）**：用户要求「发布到 npm 之后，直接在 web profile 的任意模式使用，不想要新建一个模式才能用」，
并选定**路由 B**（§11）。因此本节倾向作废：`ctx-mem` 副本**已删除**，改为在挂载期给官方 preset 注入 patch，
任何模式（`standard`/`ptc`/`cordis`）都自动生效，无需选择专用 preset。

## 9. 实施顺序（待批准后执行）

1. fork `dsh-dcp` 进 `dsh-plugins/packages/`，改名、改 peer 约束至 alpha 线。
2. 先写事件归属（A8）与两条抽取路径（A1/A2）的测试，再实现还原层。
3. 先写四节格式、骨架与重建语义（A3/A4/A9）的测试，再实现。
4. 先写填空开关、成本门禁与硬切断（A5/A7/A10）的测试，再实现。
5. 跑完整测试套件，并验证 A6（继承机制未破坏）。
6. 建 `ctx-mem` preset，用显式选 preset 的新会话做端到端验证。
   **已完成**（2026-09-19）：preset 落在 `$DSH_HOME/.agent-presets/ctx-mem/`（id `ctx-mem`，显示名「上下文交接模式」），在真实 Web GUI 新建会话并显式选择该 preset，`/compact` 产出含 `## Extracted Facts` + 四节的 checkpoint。过程中暴露并修正三个缺陷，见 §10.2；漂移检查点见 §10.3；盲审修正后的最终端到端验收见 §10.4 C。
   **已被 §11 取代**（2026-09-20）：该副本与本节第 6 步的「显式选 preset」路径均由路由 B 替换，副本已删除。此处保留记录仅为追溯 §10.2/§10.3 的证据来源。

## 10. 评审记录

本文与其配套调研报告经过 Root 自审与一轮独立盲审。

**自审发现（就地修正）**：

| # | 发现 | 修正 |
|---|---|---|
| 1 | 区间体积 2,618,147 未注明口径，照文档复现会得到不同数字 | 补注"逐事件 `json.dumps` 求和口径；文件落盘形态为 2,618,447 字符" |
| 2 | 探针 C（填空实验）未在调研文档中记录，导致 D1 的引用不可核验 | 新增调研 §5.4，含路由、输入、产出、usage 与质量证据 |
| 3 | 探针 C 的骨架与成本基线是否同源未核实 | 核实为同一区间（骨架 `user_intents[0]` 与会话首条用户消息逐字一致），据此改正描述 |
| 4 | §9 的验收编号在重编号后失效 | 同步更新为 A5/A6/A7 |
| 5 | `maxSkeletonTokens` 在骨架实测远小于上限时属前置泛化 | 按 MVP 原则移除该配置项与 A6 截断判据，留待出现实际证据再引入 |

**盲审条目与裁定**（审查席位独立复现，未采信作者自述）：

| 条目 | 内容 | 裁定 |
|---|---|---|
| 1 | `dsh-dcp` 空节数应为 4 而非 5（第 5 个 `(none)` 是节内空条目） | **采纳**，已改为 4 并注明区别 |
| 2 | `0/9` 与 `5/6` 分母口径不一致，不可并列 | **采纳**，已改为分列两组（0/15 与 5/6）并注明不可相减 |
| 3 | D1 引用的填空实验在两份文档中均无来源 | **部分采纳** → 辩论：作者举证实验确实存在（产出文件、会话日志、路由配置），审查席位复现后**让步**；作者接受"未落文档"这一缺陷，已补调研 §5.4 |
| 4 | 4,094 tokens 无法复核 | **不采纳** → 辩论：该值为 `2533+1561` 之和而非字面串，审查席位此前只做字符串检索；复现后**让步**，确认可核验 |
| 5 | 区间体积口径未写明 | **采纳**，已补注口径 |
| 6 | 骨架中的命令被截断，A3"逐字一致"被自身产物否证 | **采纳**，已修正分析脚本的正则（改用反向引用），重算确认 61 条命令完整无截断，并在调研 §4 记录该实现陷阱、在 A3 增加对应判据 |
| 7 | `maxSkeletonTokens` 的"优先级"未定义，A6 不可判定，且属前置泛化 | **采纳**，已移除该配置项与对应判据 |
| 8 | 同一结论在 §3 与 §4 D2 重复维护 | **采纳**，D2 改为引用 §3，不再复述理由；调研 §8 改为引用 §3.2/§5.3 数据 |
| 9 | plan §3 把"服务替换须 preset"与"其余部分"合并成一条约束，与调研 §6 冲突 | **采纳**，已拆分为服务替换须 preset、其余部分可随同行挂载 |

**辩论轮次**：1 轮（针对条目 3、4）。**结论**：条目 3、4 审查席位均让步，
其余 7 条全部采纳，无坚持项，共识成立。

### 10.1 第二轮：还原层权威源与硬切断（用户裁定后）

用户在审阅第一轮结论后追加两个前置问题，并据此裁定两项改动。本轮为**用户裁定**
而非盲审，故不涉及辩论；下表记录裁定内容、依据与落地位置。

**Q1：方案对 PTC 与默认模式是否都有效？** 是，且是同一个后端。

| 证据 | 实测 |
|---|---|
| `# ── compaction` 组在 `standard` 与 `ptc` preset 中逐字节相同 | 两者均 1127 字符，`a == b` 为真 → 一份 preset 副本同时服务两种模式 |
| 默认模式抽取可行 | seq 9–1255 区间：241 次调用、241/241 经 `callId` 关联、22 条 `isError`、命令最长 1351 字符 |
| `tools.mode: 'both'` 合法 | 混合区间两种形态各自处理，已写入 A2 |

**Q2：能否做到 codex 那样"完全抛弃历史 = 新窗口"？** 分两层：

- **模型输入层：已经是。** 实测折叠 surface 后 log 1631 事件 → surface 11 节点 →
  模型请求 11 条消息，**1620 条旧事件不进入请求**。
- **状态层：默认不是，但可开启。** 默认 `retainRatio: 0.16` 故意保留近期尾巴；
  `retainTokens: 0` 即硬切断（等价于手动 `/compact` 已走的路径）。

**用户裁定**：

| 裁定 | 内容 | 落地 |
|---|---|---|
| 1 | PTC 还原层改为「以 `tool/ptc-dispatch` 为权威源、正则仅作兜底」 | D3、§2.1、§5.1.1–5.1.3、§7、§9、A1/A2/A8；调研 §4 |
| 2 | 「完全抛弃历史」（`retainTokens: 0`）写进配置，默认关闭 | D8、§2.2、§5.3、§7、A10 |

**本轮自审发现（就地修正）**：

| # | 发现 | 修正 |
|---|---|---|
| 1 | §2.2 原有"照搬 codex 的新窗口语义｜不做"一条，与新增的 D8 直接冲突 | 改写为"改成真丢弃（删除历史）｜不做"，并注明 `retainTokens: 0` 只是不保留逐字尾巴、旧事件仍在 log，不属此项 |
| 2 | §2.2 引用的自主外化率写作 `0/9`，与调研 §5.3 的 `0/15` 不一致 | 改为 `0/15` 并补引调研 §5.3 |
| 3 | 第一轮记录的"61 条命令完整无截断"口径未写明（次数还是去重数） | 实测为 61 次命中 / 60 条去重，且 `command:` 键共 103 个 → 正则在**模板字符串**形态上另漏 42 条；已在调研 §4.1 补正，并指出放宽匹配会把未求值的 `${...}` 当事实 |
| 4 | A3 仍把引号陷阱作为主路径要求，与 D3 改用结构化事件后的事实不符 | A3 改为：命令来自 dispatch 的结构化 `arguments.command`（天然完整），引号陷阱只在兜底路线适用，并改引调研 §4.4 |
| 5 | 事件归属若用 `shadowedSeqs` 成员判定会漏掉 log-only 事件（本调研早期踩过） | 新增 §5.1.1 明令按 seq 范围判定，并新增 A8 专门断言 |

### 10.2 第三轮：端到端验收暴露的三个缺陷（Root 自审 + 真实界面验证）

验收方式：**新建 Web GUI 会话并显式选择 `ctx-mem` preset**（§8.2 裁定），执行真实工具调用后发 `/compact`，读回 `compaction/summary` 事件的正文。前两次验收各暴露一个缺陷，第三次通过。

| # | 缺陷 | 根因（一手证据） | 修正 |
|---|---|---|---|
| 1 | 压缩直接失败：`compaction/end.error = "Receiver must be an instance of class CtxMemEngine"` | 宿主经 `compaction` 服务调用 `summarize()`，cordis 以**影子 context**（`createShadowMethod` 的 `Proxy`）作为 `this`；V8 的私有成员 brand check 因此拒绝接收者。宿主 `BasicCompactionEngine` 自身零私有成员，所以从未触发。已用真实 cordis 最小复现：直接调用正常，经 `ctx.compaction` 调用抛同一错误 | 移除 `#deterministic` / `#fill`，改为模块级函数并把 `ctx` 作参数传入；类内只留公有字段 |
| 2 | `### User Intents` 混入整份 `AGENTS.md` 与技能目录（该会话 18,133 字符中约 10K 是框架行） | 原判据 `kind !== 'tool' && kind !== 'plugin'` 只排除两种 kind。实测 200 份归档会话，`user/message` 的 source kind 共 9 种：`user` / `agent-instructions` / `skill-catalog` / `session-reference` / `subagent-settled` / `agent-message` / `skill-invocation` / `plugin` / 无 source | 判据改为宿主自己的规则 `kind === 'user'`（`dsh-api-session-controller` 与 Chat UI 的 `role: "inject"` 投影均如此）；无 source 仍视为真人发言 |
| 3 | `Errors Seen` 记为 `(none)`，但该会话确有一次失败命令 | 宿主**不把非零退出置为 `isError`**（`dsh-tool-bash`：「A nonzero command exit is reported, not failed」），而是把 `[exit code: N]` 作为正文标记追加，并把 stderr 前缀成独立的 `[stderr]` 行（`dsh-bash-local`）。`firstLine()` 于是取到字面量 `[stderr]`，与错误模式不匹配，报错被静默丢弃 | 新增 `firstMeaningfulLine()`（跳过宿主包装标记）与 `looksLikeFailure()`（认 `[exit code: ≠0]`、signal/timeout/sandbox 标记，以及首个真实输出行的错误模式）；`firstLine()` 成为死代码后删除 |

第 3 项直接命中本后端存在的理由（§2.1 第 1 条「报错逐字保留」）：缺陷期间唯一可得的失败证据被丢掉了。

**修正后实测**（同一份归档会话 seq 10–33，`Errors Seen` 从 `(none)` 变为）：

```
### Errors Seen
- bash: ls: /nonexistent-ctx-mem-probe: No such file or directory
```

骨架总长 478 字符（修正前 18,133）。回归检查：在 4,424 条消息 / 10,133 事件的真实区间上抽取耗时 52 ms，得 6 条 intent、167 个文件、1,178 条命令、149 条错误。

### 10.3 漂移检查点（§3 风险表「preset 副本随官方升级漂移」）

> **已被 §11 取代**（2026-09-20）：副本已删除，漂移面随之消失。路由 B 不复制官方组合，
> 只按 id 打补丁；官方改动 `compaction` 组结构时由 §11.7 的 A15 测试直接变红。

`ctx-mem` preset 是官方 `standard` 的全量副本，基线记录如下，供日后比对：

| 项 | 值 |
|---|---|
| 副本路径 | `$DSH_HOME/.agent-presets/ctx-mem/agent.cordis.yml` |
| 基线 | 宿主 `dsh-agent-presets/presets/standard/agent.cordis.yml`，harness `0.1.6-alpha.2` |
| 基线行数 / 副本行数 | 266 / 277 |
| 差异 | **仅一处 11 行块**：`# ── compaction` 组内的注释与 `compaction-basic` → `ctx-mem` 行替换 |

官方升级 `standard` 后，用 `diff` 复核该组以外的行是否漂移；差异面只有这一块，重新同步的成本是改一处 YAML 块。

### 10.4 第四轮：里程碑盲审（10 条）与高风险审查

§9 第 6 步收尾时按 §3 执行两类独立审查。盲审席位与高风险审查席位均为独立只读子代理。

**A. 里程碑盲审（10 条，全部采纳，无辩论轮）**

| # | 位置 | 缺陷 | 处置 |
|---|---|---|---|
| 1 | `src/index.js` 填空调用 | 只读全局 `this.config.maxTokens`，丢弃 `modelPolicies[].maxTokens`——而 `Config` 仍接受该键、SKILL.md 仍把它列为可设 | 新增 `maxTokensFor(config, target)`，按 `resolveTargetPolicy` 的语义取 `override?.maxTokens ?? config.maxTokens` |
| 2 | `src/index.js` 填空 options | 缺 `purpose: 'compaction'`（基线 `summarizeWithLlm` 有，适配器据此发压缩标记）；且注释自称与宿主调用「exactly 同形」 | 补 `purpose`；注释改为「a user message appended to a prefix」，不再 overclaim |
| 3 | `src/index.js` 返回对象 | JSDoc 声明 `usage` 但从不回填（基线把 assembler 的 usage 展开进结果，事件与轨迹 UI 会渲染它） | `fillCheckpoint` 返回 `{ text, usage }`，`summarize` 按「有则展开」回填 |
| 4 | `src/prompt.js` | `FACT_HEADINGS`/`CAUSAL_HEADINGS`/`EMPTY_MARKER` 三个导出无任何引用，且是 `skeleton.js`/`causal.js` 字面量的第三份副本（`prompt.js` 那份还无测试覆盖） | 删除三个常量与导出；注释说明「本文件是提示词，`causal.js` 的 `CAUSAL_SECTIONS` 才是解析真源」 |
| 5 | `src/skeleton.js` | `buildSkeleton(facts, options)` 首句 `void options`，形参与传参都不产生行为 | 删除形参、`SkeletonOptions` typedef、调用方传参；测试改为断言 `buildSkeleton.length === 1` |
| 6 | `SKILL.md` 键表 | 把 `summarizationProvider`/`summarizationModel` 列为「继承策略键」，但二者唯一读取点在官方 `summarize()`（已被覆写），对 ctx-mem 完全无效 | 拆成「仍然生效」表 + 明确标注两个无效键并指向 `fillProvider`/`fillModel` |
| 7 | `README.md` 键表 | 只列 6 键却让用户「按上表核对键名」，与 SKILL.md 的另一份清单不一致 | 补齐 11 键并指向 SKILL.md 为完整语义真源；补注两个无效键 |
| 8 | `src/extract.js` | `dispatchedRoots` 第二条收集路径不可达：`regionOf` 用同一批事件建 map，第一条循环已收全 | 删除第二段循环；A1c 测试改用真实 `regionOf`（原先用测试内 stub，钉住 `regionOf` 永不产出的形状） |
| 9 | `src/config.js` | `Object.freeze(new Set(...))` 不冻结 Set（实测 `add` 仍生效），`ReadonlySet` 声明是假的 | 改为模块私有 `const`（不导出），使保证成立 |
| 10 | `src/extract.js` | `extractFacts(session, region)` 的 `session` 全程未用，JSDoc 承诺「未来修订会读 spill locators」 | 删除形参与 `void session`；更新全部调用点与测试 |

第 1–3 条各自补了会失败的回归测试，并逐条做过**变异验证**（临时还原修复 → 对应用例失败 → 恢复 → 通过），确认测试真的钉住缺陷而非陪跑。

**B. 高风险审查（预设/插件装入全局环境，§3 独立门禁）**

审查范围：默认预设是否受影响、profile 平面行是否真 inert、手工拷贝目录的存活与可逆性、凭据暴露。结论：

| 问 | 结论 |
|---|---|
| 默认预设/未选该 preset 的会话是否受影响 | **不受影响**。`settings.yaml` 仍 `default: standard`；preset 是按 agent 挂载，行在 `isolate: { compaction: true }` 独立 realm |
| profile 平面行是否真 inert | **是**。`disabled: true` 使 `refresh()` 提前返回，不 import、不注册监听；且该行尚未随聚合包发布，当前活体组合里根本不存在 |
| 若启用会怎样 | 不会与 preset 冲突（realm 隔离），但会在同进程多出一个引擎，其压力监听器对每个 agent 触发，与 preset 引擎竞争压缩同一会话——靠会话级锁退化为 busy 拒绝 + 白烧额度，非数据损坏。禁用是正确决定 |
| 手工拷贝目录会被删吗 | **不会**。三次实测（`install` / 触 lockfile 后 `install` / `--force` reify 104 包）+ 一次真实 `pnpm add`→`pnpm remove` 循环，目录与内容均完好；DSH 的 fallback 维护只清理自己拥有的 symlink，且 profile 侧走 `ensureProfileSymlink`（遇真实目录静默容忍），不会 fail-loud |
| 可逆性 | **可逆**，删除集为 preset 目录 + 拷贝目录 + 未提交的工作区改动；无需回滚任何配置写入 |
| 凭据暴露 | **无**。已装副本无密钥字样，`settings.yaml` 未新增条目 |

**辩论轮（§3 第 3 步）**：审查方原判「`pnpm install` 会把这个游离目录当 extraneous 剪除」，Root 判「部分采纳」并以四次实测反驳。审查方复核后**让步**，并自行更正其 fail-loud 说法（改为静默容忍），同时查明原论证的归因错误：它引用的 "Remove extraneous packages" 是 `pnpm prune` 子命令的帮助文本，而 `dsh-plugin-manager` 只有 `add`/`remove` 两个 pnpm 调用点、全程不调 `prune`。共识成立。

**C. 最终端到端验收（第 1–3 条修正后的部署构建）**

盲审第 1–3 条改的是填空调用的**线上行为**（per-route `maxTokens`、`purpose`、`usage`），单元测试只钉住「调用参数正确」，不证明真实压缩链路上这些值确实到达并落盘。故在修正后的构建上重做一次全链路验收。

构建一致性：`diff -r packages/ctx-mem/{lib,skills}` 对已装副本 → 两者 IDENTICAL；随后 `dsh-web restart`（PID 18710 → 25624，`Verdict: OK`）。

会话：`session-62b3df92-0991-4530-8244-8db35ffa595d`，`agentPreset: ctx-mem`，真实 Web GUI 显式选择该 preset。首轮执行 `ls /nonexistent-final-acceptance-probe`（失败）与写 `/tmp/ctx-mem-final.txt`（成功），再发 `/compact`。

`compaction/summary`（compactionId `a36d64ad-a60d-40d7-a593-3938cb837af3`）落盘字段：

| 字段 | 实测值 | 钉住的修正 |
|---|---|---|
| `provider` / `model` | `workbuddy-ai` / `deepseek-v4.1-flash` | 填空走当前会话路由（§8.1 裁定） |
| `maxTokens` | `8192` | 第 1 条：无 `modelPolicies` 覆盖时回落到全局 `maxTokens`，与宿主 `resolveTargetPolicy` 同语义 |
| `usage` | `{inputTokens: 333, outputTokens: 225, totalTokens: 558}` | 第 3 条：`BlockAssembler.usage` 已回填（修正前该键缺失） |
| `llmStreamCall` | `true` | — |
| `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount` | `{11,26}` / 9 个 seq / `6169` | 遮蔽范围由 seq 区间判定（§10.1 第 5 条） |

正文结构与抽取正确性（同一事件）：

- `## Extracted Facts` 四节齐全；`### User Intents` **只含真人请求**（1 条，未混入 `agent-instructions` / `skill-catalog` / `plugin` 等框架行）。
- `### Errors Seen` 逐字保留失败证据：`- bash: ls: /nonexistent-final-acceptance-probe: No such file or directory`。
- `### Commands Run` 含 `ls /nonexistent-final-acceptance-probe`；`### Files Touched` 含 `/tmp/ctx-mem-final.txt`。
- 模型只补四节因果（`## Why This Approach` / `## Errors and Their Causes` / `## Open Decisions` / `## Next Step`），未改写硬事实。
- `compaction/end` 无 `error`。

界面侧：轨迹视图把该事件渲染为「请求 #3 · 压缩 · 轮次之间 · 已压缩」，对话视图显示「已压缩 9 条历史记录（约 6169 tokens）」。

第 2 条（`purpose: 'compaction'`）在本路由上**无法从外部观测**：该键唯一消费方是 `dsh-llm-deepseek`（映射为请求头 `x-deepseek-harness-compact: 1`），而本次填空路由是 `workbuddy-ai`，经 `dsh-llm-pi-ai` 组装请求体，该适配器只取 `temperature`/`maxTokens`/`sessionId` 三个可选字段，全文对 `purpose` 零引用。此行为与宿主 `summarizeWithLlm` 完全一致（宿主也无条件设置该键），故此处只声明「与宿主同形」，不声明「已观测到标记」。

**遗留（非缺陷，属未发布状态）**：`@logictan/dsh-ctx-mem` 与 `@logictan/dsh-fakeip-fetch` 均未发布到 npm，故 profile 只能手工拷贝；两者都不在任何 lockfile/manifest 中，不受机制保护。发布后应改为正常依赖安装，并按仓库 `AGENTS.md` 的「子插件先上线」顺序发布。

## 11. 路由 B：免专用模式的挂载期注入（2026-09-20 冻结）

### 11.1 问题

路由 A（专用 preset 副本）要求用户**先选择 `ctx-mem` 模式**才生效，且副本会随官方升级漂移（§7）。
目标：发布到 npm 后，web profile 的**任意既有模式**都直接使用 `ctx-mem`，不新建模式、不改默认。

### 11.2 机制（探针已验证）

`cordis` 的 `Fiber._resolveConfig`（`cordis/lib/index.js:1344`）对**每个** loader entry 执行
`waterfall(this, "internal/config", config, () => config)`，preset 子树的挂载也走这条路径。
因此挂在 **profile 平面**的 bridge 行能拿到 preset 组合的 config 对象，并**就地**写入 `patches`：

```js
ctx.on('internal/config', function (config, next) {
  const out = next()
  if (!out || typeof out.path !== 'string') return out
  if (!COVERED_PRESETS.has(presetIdFromPath(out.path))) return out   // 非目标预设：绝不触碰
  out.patches = [ /* 见 11.3 */ ]
  return out
}, { global: true })
```

四条硬约束，全部经探针证实（缺任一条机制失效）：

| # | 约束 | 证据 |
|---|---|---|
| B1 | 监听器必须挂 `{ global: true }` | `dispatch`（`cordis/lib/index.js:258`）按 `hook.global \|\| !filter \|\| filter(...)` 过滤；scoped preset 挂载带 scope tag，非 global 监听器收不到（probe9/probe10） |
| B2 | 必须**就地**改，不能返回克隆 | `harnessBase` 是 `WeakMap`，键为 config **对象标识**（`dsh-agent-presets/lib/index.js:614` 存、`:891` 取）；返回克隆会让 preset 行无法解析裸包名（probe8：`MODE=clone` → 标识丢失） |
| B3 | 判据用**组合路径的预设目录名**白名单（`standard`/`ptc`/`cordis`） | profile 平面的组合叫 `cordis.yml`，preset 组合叫 `agent.cordis.yml` 且父目录名即预设 id，故 `presetIdFromPath` 一次判定同时排除「profile 平面」与「不在范围内的预设」。**曾考虑并弃用 `scopeOf(this.ctx)`**（probe12：profile 平面为 `undefined`、preset 平面为 `{agentPreset:'standard'}`）：它依赖 `dsh-scope` 的 `kScope` **唯一 symbol** 跨包同实例，发布到 npm 后该不变量不由本包控制，一旦失配则 `scopeOf` 恒为 `undefined` → bridge **静默失效**。路径白名单自包含，最坏情况只是不注入。`this.entry` 在两种平面都是 `undefined`，从来不可用 |
| B4 | `path` 后缀 `agent.cordis.yml` 作二次过滤 | `COMPOSITION_FILE`（`dsh-agent-presets/lib/index.js:182`）；避免误伤 profile 组合 |

**最终验证（probe17，生产形状）**：host 平面 `{global:true}` 监听器 + `createScope(ctx, {agentPreset:'standard'})` 的 scoped 挂载。
`PATCH=0` → marker 只有 `ONE`（官方后端）；`PATCH=1` → marker 为 `TWO`（注入行已加载），
且 `compaction-basic` 被 `disabled: true` 关掉。补丁真的到达 `applyEntryPatches` 并生效。

**判据修订后的复验（probe18，四个预设目录全跑）**：把判据从 `scopeOf` 换成 `presetIdFromPath` 白名单后重跑：

| 输入路径 | `presetIdFromPath` | 是否注入 | marker | 结论 |
|---|---|---|---|---|
| `presets/standard/agent.cordis.yml` | `standard` | 是 | `TWO` | 官方行被关（`name` 守卫命中），注入行加载 |
| `presets/ptc/agent.cordis.yml` | `ptc` | 是 | `TWO` | 同上 |
| `presets/cordis/agent.cordis.yml` | `cordis` | 是 | `TWO` | 同上 |
| `presets/minimal/agent.cordis.yml` | `minimal` | **否** | `ONE` | 不在白名单，组合完全未被触碰（A16） |

probe18 还**顺带证实了 `name` 守卫的降级行为**：把 fixture 里 `compaction-basic` 的 `name` 改成别的值时，
`applyEntryPatches` 打出 `patch: name mismatch ... skipping`，该行**保持启用**（marker 为 `ONE TWO`），
即「官方一旦改名 → 保持官方后端」而非误关。这正是 11.3 写 `name` 的目的。

### 11.3 补丁内容（只针对官方行，不复制官方组合）

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true
- id: compaction
  insert:
    - id: ctx-mem
      name: '@logictan/dsh-ctx-mem'
```

- `name` 在 patch 里是**守卫**而非赋值（`applyEntryPatches`：不匹配则 `warn` 并跳过）。写上官方全名可让
  官方一旦改名就**降级为「保持官方后端」**，而不是静默关掉一个别的行。
- 先 `disabled` 后 `insert`：`applyEntryPatches` 按序执行且 `buildMap(insert)` 会把新行加入索引，故顺序无依赖；
  但显式保持「先关后插」便于阅读。
- 插入到 `compaction` 组内而非顶层：该组带 `isolate: {compaction: true, toolResultPruner: true}`，
  新行因此落在正确的 realm 里，`mountPreset` 的 `leakedServices` 检查不会报错。
  **若插到顶层会直接抛错**：`row(s) published process-global service(s) [compaction]; a preset service must sit behind an \`isolate\` realm`。
- `group: true` 是 `applyEntryPatches` 递归下探的前提（`if (entry.group && Array.isArray(entry.config))`）。
  三个目标 preset 的 `compaction` 组都带该键（实测）。

### 11.4 覆盖范围（用户裁定）

| preset | 处理 | 依据 |
|---|---|---|
| `standard` / `ptc` / `cordis` | 注入 11.3 的补丁 | 三者都含 `id: compaction-basic` 且处于带 `isolate` 的 `compaction` 组内 |
| `minimal` | **不处理** | 用户裁定「只覆盖 standard / ptc / cordis」。其组合文件自述 "Context compaction is absent."，连 `compaction` 组都没有；要支持就得插入一整套组，等于改写该预设的设计意图 |
| 用户自建 preset | 不处理（无 `compaction-basic` 行时 patch 不命中，仅 `warn`） | 同 `minimal`：不替用户的设计意图做决定 |
| 其它 profile（`headless` 等） | 不处理 | 这些组合没有 `agent-presets` 行，preset 子树根本不存在；bridge 的判据因此永不命中，天然 inert |

### 11.5 幂等与共存

- **幂等**：bridge 先扫描 `out.patches` 与（无法读取的）组合内容。若目标组合已含 `id: ctx-mem`
  （例如用户手工改过 preset），则**不注入**。判据只看 `patches`，因为 bridge 读不到 preset 文件内容。
  代价：用户若已在 preset 里手工放 `ctx-mem`，bridge 会再插一行 → 同一 realm 内重复注册 `compaction`。
  这是**已知边界**，不修：用户裁定删除路由 A 副本后不存在该场景，且 Realm 重复注册会抛错而非静默损坏。
- **追加而非替换**：`patches` 若已存在且**不含** `ctx-mem`，我们的两条补丁**追加**到其后，不替换整个列表。
  既然幂等判据已经承认 `patches` 可以预先存在，整体赋值就会静默丢弃另一个生产者的行。上游当前没有第二个
  `patches` 生产者（全 harness 只有 include 读它），所以这是防御性的正确形状，不是新增泛化。
- **与路由 A 共存**：路由 A 的 preset 副本已按用户裁定删除，故无需共存逻辑。

### 11.6 归属与命名

| 项 | 值 | 理由 |
|---|---|---|
| 代码位置 | `packages/ctx-mem/src/bridge.js`，与引擎同包 | bridge 与引擎是同一交付单元；分两个包会让「装上引擎却忘了 bridge」成为可能的错配 |
| 行 id | `ctx-mem-bridge` | 必须全仓库唯一且等于宿主半边 `export const name`（`cordis-plugin-loader/lib/index.js:91` 撞车即硬崩，`aggregate.mjs --check` 不校验）。`ctx-mem` 已被引擎行占用 |
| 行状态 | **enabled**（与引擎行的 `disabled: true` 相反） | bridge 的正确挂载点**就是** profile 平面；引擎行仍必须 disabled |
| 导出口 | 同包两个入口：`main` → 引擎，`./bridge` → bridge | `unwrapExports` 取 `default`；一行只能挂一个插件，故必须分行、分入口 |

### 11.7 验收契约（在 §6 之后续编号）

| # | 验收项 | 判据 |
|---|---|---|
| A11 | 任意模式自动生效 | 在真实 Web GUI 用**默认模式**（不选 `ctx-mem`）新建会话，`/compact` 产出的 `compaction/summary` 正文含 `## Extracted Facts` 与四节；且 `compaction/summary` 的 `provider`/`model` 与本会话路由一致 |
| A12 | 官方后端确实被替换 | 同一会话中 `ctx.compaction` 的 `sessionStatsOverview`/行为来自 `ctx-mem`；官方 `compaction-basic` 行处于 disabled（`dsh --profile web --dump-config` 看不到 preset 内部，故以「注入行已加载 + 官方行 disabled」的 probe 断言 + 真实压缩产物为准） |
| A13 | profile 平面不被误伤 | 同一 bridge 在无 preset 的 profile（`headless`）下不产生任何 patch，且不报错 |
| A14 | 判据与幂等 | 单元测试断言：profile 平面组合（`cordis.yml`）不注入；不在白名单的预设（`minimal`）不注入；`path` 不以 `agent.cordis.yml` 结尾时不注入；`patches` 已含 `ctx-mem`（顶层或嵌套在 `insert` 里）时不重复注入 |
| A15 | 三个 preset 全部命中 | 单元测试对 `standard`/`ptc`/`cordis` 三个**真实**官方组合跑 `applyEntryPatches`，断言每个都成功关掉 `compaction-basic` 且插入 `ctx-mem`，无 `warn` |
| A16 | `minimal` 不被改动 | 对官方 `minimal` 组合跑补丁，断言输出与输入逐字节相同（不命中、不插入） |
| A17 | 配置面能力对等 | 单元测试：`apply(ctx, {engine:{fillModel:'x'}})` 后，注入行的 `config` 含该键；缺省时注入行不带多余 `config`。probe18 已验证注入行的 `config` 能到达引擎的 `apply` |

### 11.8 实施顺序（TDD）

1. **先写测试**（A14/A15/A16 三个切片，纯函数、可独立判定）：`tests/bridge.test.js`。
   从官方 `presets/*/agent.cordis.yml` 读真实组合，断言补丁结果。红灯。
2. 实现 `src/bridge.js` 的纯函数部分（`shouldInject(ctx-ish, config)` / `buildPatches()`），令 A14/A15/A16 转绿。
3. 接上 `ctx.on('internal/config', ..., {global:true})` 与 `scopeOf` 读取，`export const name = 'ctx-mem-bridge'`。
4. `packages/ctx-mem/package.json` 加 `"./bridge"` 出口；`cordis.patch.yml` 追加 bridge 行（enabled）。
5. `node scripts/aggregate.mjs` 重算聚合包，`--check` 必须 OK。
6. 删除路由 A 副本 `$DSH_HOME/.agent-presets/ctx-mem/`（用户裁定），更新 `README.md` 与 `cordis.patch.yml` 注释里
   「唯一正确挂载点是 preset 组合」的旧结论。
7. 重新构建 + 拷贝到 profile（`lib/` 与 `skills/`）→ `dsh-web restart` → `dsh-web status` 须 `Verdict: OK`。
8. 真实界面验收 A11（默认模式新建会话 + `/compact` 读回产物）。

### 11.9 派单（写代码前）

| 切片 | 归属 | 判据 |
|---|---|---|
| S1 `tests/bridge.test.js` + `src/bridge.js` 纯函数（A14/A15/A16） | **外派** | ① 有可独立判定的验收契约（专门的测试文件 A14/A15/A16）；② 共享触点 = `src/bridge.js`、`tests/bridge.test.js`、`package.json`（加 devDependency）共 3 处，其中前两处与其它切片零重叠，第三处与 S3 重叠故 S3 后置 |
| S2 监听器接线 + `export const name`（A13） | **留 Root** | 命中「跨文件不变量」：`{global:true}`、就地改 `patches`、`presetIdFromPath` 白名单判据三者是**同一不变量**（B1–B3），任何一处改动都同时决定另外两处是否仍然成立。**S1 已把监听器与 default export 一并实现**，S2 收敛为接线核对 + A13（无 preset 的 profile 下 inert） |
| S3 `package.json` 出口 + `cordis.patch.yml` 行 + 聚合重算（A12） | **留 Root** | 命中「单一真源投影的归属处」：行 id 唯一性、`export const name` 与行 id 的一致性、聚合 patch 的生成物同源，三者必须一次改完 |
| S4 README/注释改写 + 删除路由 A 副本 | **留 Root** | 命中「单一真源」：删掉的是**当前唯一生效的挂载路径**，且要同时改写代码注释与 README 中已过时的结论；不可外派 |
| S5 真实界面验收 A11 + 重启 | **留 Root** | 需要操作本机 launchd 与浏览器，且是最终交付判定 |

S1 外派后，S2–S5 串行留在 Root。
**修正（写代码时发现）**：S1 与 S3 **并非零重叠** —— S1 要向 `packages/ctx-mem/package.json` 加三个 devDependency，
S3 要往同一文件加 `"./bridge"` 出口，两者共享同一可变文件。故 **S3 必须等 S1 落地后再动**，不得并行。

**删除路由 A 副本的时机修正**：原第 6 步把「删除」排在验收（第 8 步）之前。改为**验收通过后**再删：
若路由 B 未能生效，提前删除会让用户**彻底失去可用的 ctx-mem**（路由 A 是当前唯一生效路径）。
删除动作本身不影响 A11 —— A11 走的是默认模式，本就不经过路由 A。

### 11.10 测试可达性（S1 的硬约束，实测）

`packages/ctx-mem` 的 devDependencies **不包含** A15/A16 需要的两个包，实测均 `ERR_MODULE_NOT_FOUND`：

| 包 | npm 上存在？ | 用途 | 处置 |
|---|---|---|---|
| `@deepseek-ai/cordis-plugin-include@1.0.7` | 是（`latest`） | 导出 `applyEntryPatches` 与 `entryListSchema` | S1 需加 devDependency |
| `@deepseek-ai/dsh-agent-presets@0.1.6-alpha.2` | 是（`alpha` tag） | 提供**真实** `presets/*/agent.cordis.yml`（tarball 已确认含 `presets/`） | S1 需加 devDependency |
| `js-yaml@4` | 是 | 组合文件是 YAML，且**四个预设都用了 `!js` 标签**（`standard` 2 处、`ptc` 2 处、`cordis` 3 处、`minimal` 4 处），裸 `yaml.load` 会抛 `unknown scalar tag !<tag:yaml.org,2002:js>` | 必须用 `entryListSchema`（include 包自带 `js-yaml`），不能自己 `yaml.load` |

因此 A15/A16 的测试**读真实官方组合**（经 `entryListSchema` 解析）→ 跑 `applyEntryPatches` → 断言结果。
这样官方升级改动 `compaction` 组结构时测试立即变红，比运行时静默失效更早暴露。

> `pnpm-lock.yaml` 当前已是 dirty（属并行工作流的改动）。S1 加 devDependency 会在其上叠加改动；
> 由 Root 在 S3 统一跑一次 `pnpm install` 并确认 diff 只含这三个包，避免两个工作流互相覆盖。

### 11.11 配置面缺口与处置（写 S4 时发现）

**缺口**：路由 A 的 preset 行是用户唯一能写 `config:` 的地方。删掉它之后，bridge 注入的行由代码生成，
若 `buildPatches()` 不携带 `config`，则 README §配置 表里的 10 个键**全部无法设置** ——
这是能力回退，不是文档问题。

**探针 probe20（确认机制）**：cordis 把行 `config` 以**位置参数**传给 `apply(ctx, config)`
（`ctx.config` 需 `inject` 才能读，会抛 `cannot get property "config" without inject`）。
**探针 probe18 扩展（确认注入行也吃 config）**：给 `insert` 的行加
`config: { fillModel: 'deepseek-v4.1-flash' }`，该行 `apply` 收到 `{"fillModel":"deepseek-v4.1-flash"}`。
即注入行的 `config` 与手写行等价。

**处置**（S2，Root）：bridge 行自身接受 `config: { engine: {...} }`，
`apply(ctx, config)` 记下 `config.engine`，`onInternalConfig` 把它并入注入行的 `config`。
这样 profile patch 里一处即可配置，与路由 A 的能力等价：

```yaml
- id: ctx-mem-bridge
  name: '@logictan/dsh-ctx-mem/bridge'
  config:
    engine:
      fillModel: deepseek-v4.1-flash
```

`engine` 缺省为 `{}`（即全部走引擎默认值）。**这是被替换物的能力对等，不是新增泛化**：
不加它，删除路由 A 就等于静默砍掉配置面。

### 11.12 风险

| 风险 | 现状 | 缓解 |
|---|---|---|
| `internal/config` 是内部事件，上游可能改名 | 当前 `cordis@4.0.2` 稳定；该 waterfall 是 loader 注入 config 的唯一通道 | 监听器里对 `out`/`out.path` 做形状守卫；事件消失时 bridge 静默 inert（退化为官方后端），不抛错 |
| 官方 preset 改动 `compaction` 组结构 | 三 preset 实测一致；`name` 守卫 + `warn` 降级 | A15 对真实组合断言，官方升级后测试即红，比运行时静默失效更早暴露 |
| `disabled: true` 关掉官方行后无人提供 `compaction` | 不可能：同一 patch 立即插入 `ctx-mem`；若插入行加载失败，`mountPreset` 的 `inactiveRows` 检查会抛错而非留下空 realm | A11/A12 真实压缩产物验证 |
| 同包两入口的 `peerDependencies` 覆盖 | bridge 只用 `cordis`（`ctx.on`），已在 peer 列表；`dsh-scope` 因 B3 修订**不再需要** | 无新增 peer；仅测试侧需 `cordis-plugin-include` + `dsh-agent-presets` 作 devDependency |

### 11.13 落地结果（S1–S5，2026-09-20 实测）

**S1（外派）**：`src/bridge.js`（纯函数 + 监听器 + `export const name = 'ctx-mem-bridge'`）
与 `tests/bridge.test.js`。测试读**真实**官方组合（`@deepseek-ai/dsh-agent-presets` 的
`presets/*/agent.cordis.yml`，经 `entryListSchema` 解析以处理 `!js` 标签）再跑
`applyEntryPatches`。全包 **102 测试通过**（含 A14/A15/A16/A17）。

**S3（Root）**：`package.json` 加 `"./bridge"` 出口；`cordis.patch.yml` 声明
`ctx-mem-bridge`（enabled，带 `config.engine: {}`）与 `ctx-mem`（disabled）两行；
`node scripts/aggregate.mjs --check` → `check OK: packages/all (7 source block(s), 7 dep(s))`。

**S2/S4（Root）**：监听器接线核对（`{global: true}` + 就地改 + 路径白名单）；
README §挂载、`skills/ctx-mem-config/SKILL.md` §挂载、`src/skill.js` 的
`SKILL_DESCRIPTION` 三处改写为新挂载事实（frontmatter 与常量逐字一致，有测试钉住）。

**A11 实测（真实 Web GUI，默认「标准模式」）**：

| 观测项 | 值 |
|---|---|
| 会话 preset | `standard`（未选任何专用模式） |
| 归档 | `~/.dsh/sessions/--Volumes-LogicExt-Git-dsh-plugins--/session-48100004-…/session.v3.jsonl.zstd` |
| 命令 | `/compact` → `compaction/summary` 的 `data.summary[0].text` 以 `## Extracted Facts` 开头，含 `### User Intents` / `### Files Touched` / `### Commands Run` / `### Errors Seen` 与后四节 |
| 填空路由 | `provider: workbuddy-ai` / `model: deepseek-v4.1-flash`（与会话路由一致，未设 `fillProvider`/`fillModel`） |
| usage | input 278 / output 127（对照 §5 的纯官方基线 81,667 input：骨架路线确实把输入压到骨架量级） |
| `compaction/end` | 无 `error`；界面显示「已压缩 8 条历史记录（约 6053 tokens）」 |

**A11 复验（重启后，最终交付态）**：把修正后的 `applyBridge`（追加而非覆盖）重建并同步、
`dsh-web restart`（PID 78273 → 2426，`Verdict: OK`）后，在**默认「标准模式」**新建会话重跑：

| 观测项 | 值 |
|---|---|
| 会话 preset | `standard` |
| 归档 | `…/session-3a1f0366-2a4f-4dda-8c1d-a64a15616687/session.v3.jsonl.zstd` |
| 九个标题 | `## Extracted Facts` + 四个 `###` 子节 + 后四节**全部命中** |
| 填空路由 | `workbuddy-ai` / `deepseek-v4.1-flash` |
| usage | input 268 / output 137 |
| 模式菜单 | 「上下文交接模式」界面检索**零命中**，副本删除已生效 |

**A13 实测**：把**已安装的** `lib/bridge.js` 挂进真实 `cordis` + `Loader`，
喂三种 config 过 `internal/config` waterfall：

| 输入 `path` | 返回同一对象 | 注入 patches |
|---|---|---|
| `<profile>/cordis.yml`（profile 平面） | 是 | 无 |
| `presets/minimal/agent.cordis.yml` | 是 | 无 |
| `presets/standard/agent.cordis.yml` | 是 | 2 条 |

无 `warn`、无 `error`。profile 平面与 `minimal` 均未被触碰。

**S4 收尾**：路由 A 副本 `$DSH_HOME/.agent-presets/ctx-mem/` 已在 A11 通过后删除
（删除前备份于 `/tmp/route-a-preset-backup/`）。重建 `lib/` 并同步到 profile 安装副本
（`lib/`、`skills/`、`package.json`、`cordis.patch.yml`、`README.md`）。

**宿主启动状态**：`dsh-web status` → `Verdict: OK — the launchd job owns the port`
（作业 PID == 端口 owner）。`~/.dsh/dsh-web.err` 的 `duplicate loader entry` 全部位于
上次修复（02:36 前）的历史段，02:36:40 起运行的宿主进程**零** `ctx-mem` 相关报错。

### 11.14 评审记录（S1–S5 交付单元）

**Root 自审（1 处，已修）**：`applyBridge` 在 `config.patches` 已存在但不含 `ctx-mem` 时
**整体覆盖**该列表。既然幂等判据（`hasCtxMem`）已承认 `patches` 可能预先存在，整体赋值就会静默
丢弃另一个生产者的行——内部不自洽。改为**追加**（`[...existing, ...buildPatches()]`），并补一条
针对性测试。上游当前没有第二个 `patches` 生产者（全 harness 只有 `cordis-plugin-include` 读它），
故这是防御性正确形状，不改变任何现有行为。

**独立盲审（`antigravity/gemini-3.8-flash`）**：5 条，逐条裁定如下。

| # | 条目 | 裁定 | 依据 |
|---|---|---|---|
| 1 | `package.json` 的 `@aiwayds/dsh-dcp` 与 `README` 的 `fan56/dsh-dcp` 矛盾 | **不采纳** → 辩论后**让步** | 实测 `npm view @aiwayds/dsh-dcp repository.url` → `git+https://github.com/fan56/dsh-dcp.git`：同一上游的 npm 包名与仓库 URL 两套标识。`sync-policy.json` 的 `target.url` 是 subtree 拉取地址，必须是 git URL；`package.json` 写 npm 包名。各用对各自体系 |
| 2 | `src/skill.js` 的 `@module .../skill` 与 `exports` 缺 `"./skill"` 矛盾 | **不采纳** → 辩论后**让步** | `@module` 是 JSDoc 文档标注，不构成导入契约。反证：`bridge.js` 有 `./bridge` 出口却无 `@module` 标签，可见二者无绑定。全仓库零消费者按该子路径导入，`src/skill.js` 只被 `src/index.js` 相对导入。补出口等于新增无消费者的公开面（过度设计） |
| 3 | `README` 的 `fillProvider`/`fillModel` 漏了「只填一个不生效」 | **采纳** | `src/config.js:105` 要求两者同时非空；SKILL 已写明。README 已补 |
| 4 | README 与 SKILL 的配置表 10 个键双写 | **已知边界**，结案 | 早于本次交付存在；不影响默认配置/默认路径，也不改动已冻结的 A11–A17 契约 |
| 5 | `SKILL_DESCRIPTION` 与 SKILL.md frontmatter 逐字重复 | **已知边界**，结案 | 同上。该重复由 `tests/skill.test.js:45-52` 测试钉住，漂移会立即变红 |

**辩论轮次**：1 轮。条目 1、2 由 Root 提交原判、反驳与盲审当时未获得的事实（npm 标识体系、
`@module` 的实际语义、零消费者实测、同仓库 `bridge.js` 反证）；审查席位逐条回「让步」，
两项均撤销原判，无坚持项 → 共识达成，评审门禁结案。

**盲审同时确认「未发现缺陷」的部分**：`src/bridge.js`（判据、就地修改保身份、`hasCtxMem` 幂等、
`buildPatches` 空 engine 不加 `config` 键）、`tests/bridge.test.js`（真实官方组合经 `entryListSchema` 解析后跑 `applyEntryPatches`、零 warning）、`cordis.patch.yml`（两行 enabled/disabled 与各自
`export const name` 一致）、`stripFrontmatter`（15 行状态机，未引入 yaml 运行时依赖）。



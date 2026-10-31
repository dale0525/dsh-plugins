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
## Asked
- 是否要用 FULL 而不是 INCREMENTAL
## Did
- 实测 `auto_vacuum=FULL` 删除后自动缩容：19.61 MB → 0.01 MB
## Concluded
- 选 FULL：回收发生在宿主自己的 DELETE 里，不受 busy_timeout=0 影响
## Overturned
- 先前认为必须显式执行 VACUUM 才能回收空间
  errors: 1: Error: 命令超过 600 秒未结束，已断开连接
  wrote: /Volumes/LogicExt/Git/BookReader/src/video.js
```

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

所以提取的材料是三段：用户请求（逐字）、助手正文（逐字）、工具轨迹（每条调用的 `description`，失败的调用另记一行首行错误）。模型输出固定的四节：`## Asked` / `## Did` / `## Concluded` / `## Overturned`。

空节直接删掉，不留 `(none)` 占位。判据同时接受 `## Asked` 和裸写 `Asked`——实测模型有时不带 `##`，只认 `^#{1,6}` 会让 `Concluded\n- (none)` 原样留在摘要里。实测一份真实提取块里 `## Asked` 和 `## Overturned` 都是 `(none)`，删掉后 312 → 271 字符；按 130 轮算，这些占位合计约 900 token 只是在记录「什么都没发生」。清理在代码里做（`pruneEmptySections`），不只依赖提示词——模型仍写了 `(none)` 也不会白花 token。判据是整节每一行去掉项目符号后都只是 `(none)` / `none` / `n/a` / `无` 之类的占位；`none of the tests passed`、`无法连接，改用代理` 这类真内容照原样保留。

`## Asked` 记的是「**助手**向**用户**提了什么、给了哪些选项」。这一节最容易错成「把用户请求改写一遍」——真实一次压缩里，模型把用户那段中文请求翻成英文塞进了 `Asked`，而用户原话就在它上面逐字抄着，同一件事写了两遍。

原因之一在材料标签：原来写 `USER REQUEST:`，模型有理由读成「这一轮问了什么」，现在改成 `USER INSTRUCTION (already in the digest verbatim; never copy it into Asked)`。另一部分靠指令本身——`## Asked` 的定义写明「助手问、用户答」，并注明照抄用户请求是这一节最常见的出错方式。

正文为空的轮次（那个真实案例有 96 条助手消息、150 次工具调用却只有 156 字符正文）本来就没有提问可记，`## Asked` 和 `## Did` 一样走 `pruneEmptySections` 整节省略，不需要单独规则。实测 123 条真人消息里 43 条（35%）不超过 12 个字符——`3`、`1`、`同意`、`做`、`继续`——而 46% 是在回答上一轮助手的提问。只逐字保留「3」而不保留它在回答什么问题，等于记下一个决定却没记下决定的是什么。

模型用的是会话自己的路由（`session.requestHeader()?.config`），和宿主原生压缩同一个取法，不需要单独配置凭据。

三件事刻意做成这样：

- **失败信号只认 `data.isError`**。曾用 `/error/i` 匹配序列化文本，347 条成功结果全部命中（工具输出里常有 "error" 字样），模型据此报告「整轮失败」。测试里有一条专门钉住这个坑。
- **工具调用从 `assistant/message` 的 block 里取**。日志里没有独立的 `tool/call` 事件类型，按它过滤会一条都取不到。
- **提取失败就退回逐字正文**。模型不可达、超时、输出为空时，该轮保留原来的助手正文；压缩本身不能因此失败，否则会话死于上下文溢出，比丢细节更糟。降级是逐轮的：一批里某一轮没答，只有那一轮退回正文。

提取结果按内容哈希缓存，同一次会话内复用。`digestSource` 每次压缩都从原始日志重建，而原始事件永远留在日志里，所以同一轮会被反复读到。实测那个压缩了 33 次的会话：共提取 142 轮，其中 **129 轮（91%）在更早的压缩里已经提取过**；全机 370 个会话、456 次压缩里，**81% 的压缩工作量是这种重复**（有压缩的 88 个会话中 70 个压缩过 2 次以上）。

缓存的键是提取材料的哈希（用户请求 + 助手正文 + 工具轨迹），不是 slot 位置：位置会随历史增长而错位，内容变了哈希就变，不会读到过期块。缓存是进程内的，重启即失效——代价只是重新提取一次，与加缓存前行为一致。

提取按批调用：每 8 轮一次，一轮输出一个 `=== TURN n ===` 块。早期实现是每轮一次调用，122 轮就是 131 次往返，单轮 400 token 的输出上限乘以 131 就可能超过整个摘要上限。批处理把往返压到约 17 次，并共享 prompt 前缀以复用 provider 的 KV cache。

用户原话在布局上**先占额度**，提取块不得挤占。实测那个 122 轮会话：区间内真人原话共 469 字符（117 token），而每轮一块 420 字符的提取共 55020 字符——提取是正文的 117 倍，任何让二者竞争的布局都会把正文挤掉，而正文是「请用pixi管理开发环境」这类永不过期的约束，提取描述的却是已经做完的工作。

## 为什么不会触发 shrink 守卫

基类的守卫比较「framed 摘要」与「被替换内容的 route 价」，摘要不小于原内容就整次压缩失败。本插件的预算取 `min(DIGEST_TOKEN_CEILING, shadowedPrice − 86 − 512)`，上限 20000 token 远小于任何实测区间价，因此这条失败路径按构造不可能发生。

上限取**绝对值**而非「区间价的比例」。比例会让摘要随历史增长：同一会话实测早期区间 2642 字符、后期 51019 字符、触发事故那段 348539 字符——因为区间越大就允许摘要越大，而接近阈值的摘要立刻再触发压缩。固定上限让摘要大小与历史长度无关，宿主原生摘要也是这个形状（实测各区间稳定在 14009–22208 字符）。

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

- **每轮的正文/提取块会被均匀削薄，用户原话不会。** 用户原话先占额度（`USER_BUDGET_SHARE` = 0.9），剩余空间再分给各轮的提取块或正文，超出时按轮等比截断并标出省略字符数。只有在每轮都已削到零仍放不下时才整轮丢弃，且会写明丢了几轮——正常长会话不会走到这一步（122 轮实测 0 次）。
- **提取块可能被截断。** 122 轮、每轮 420 字符提取的极端情形会触到上限，块尾被切并标出字符数。真人原话不受影响。
- **`turn/start` 缺失时轮次编号退化为 `turn ?`。** 不会丢正文，只是编号不可读。
- **注入内容不进摘要。** 判据是 `source.kind !== 'user'`——注入上下文在一个真实会话里占 user 消息字符的 97%，放进摘要会把人的原话淹掉。
- **不改善首轮之外的工具参数细节。** `bash` 命令本身（占工具参数 84.2%）不保留；需要「当时跑了什么命令」的场景不在本插件的覆盖范围内。

## License

MIT

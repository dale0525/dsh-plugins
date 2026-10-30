# @logictan/dsh-verbatim-compaction

把上下文压缩的**摘要**从「让模型重写一遍」换成「正文逐字抄进 checkpoint，再用一次模型调用从工具轨迹里补出结论」：用户与助手的正文逐字保留、推理块从不读取；每轮另调一次会话自身的模型，输出「做了什么 / 得到什么结论 / 哪些结论被推翻」。

## 它解决什么

`@deepseek-ai/dsh-compaction-basic` 每次压缩都发起一次 `ctx.llm.stream()`，要求模型按九节模板（Primary Request / Key Technical Concepts / Errors and Fixes …）重写被阴影的区间。在 8 个真实会话上实测（403 MiB、145 次压缩、24.5M 被丢弃 token）：

- 模板只保住被丢弃内容的 **2.38%**；
- 被丢弃内容里真正的「人写的正文」只占 **0.67%** —— 其余是推理 63.8%、工具结果 25.2%、工具调用参数 10.4%；
- 侥幸保住的正文，下一次压缩会被**再摘要一遍**：`selectCompactableRange` 总是从 `surfaceNodes[firstIdx]` 开始，而上一份 checkpoint 正好坐在 index 1。

本插件只覆盖基类的 `summarize()`（基类文档里点名的唯一子类钩子），重放、区间选择、durable 事务与 shrink 守卫全部沿用基类，因此不可能与宿主的事务语义分叉。

## 摘要长什么样

```
## user (turn 37)
（用户原话，逐字）

### assistant (turn 37)
（助手正文，逐字）
  tools: bash×280 ssh_exec×44 web_search×6 (408830 bytes)
  errors: 1: Error: 命令超过 600 秒未结束，已断开连接
  wrote: /Volumes/LogicExt/Git/BookReader/src/video.js
```

- 正文逐字，不重写、不改写。
- 工具结果只留「工具名 × 次数 + 字节数」，内容丢弃。
- 错误只留首行（100 字符），足以知道「这里失败过、失败原因是什么」。
- `wrote` 记录本轮写过的路径，重建「改了哪些文件」。
- 推理块从不进入摘要，也不读取。

## 摘要源是日志，不是被阴影的区间

上一份 checkpoint 每次都被一起阴影掉，所以「只摘要被阴影区间」会把上一份摘要承载的全部历史再丢一次。本插件扫描会话日志里 `surfaceOp === 'append'` 的事件，减去本次压缩后仍留在 surface 上的尾部，重建整段历史——不需要任何累积状态，摘要源集合逐次单调增长（122 次压缩实测 0 次非单调）。

`turn/start` 不在 surface 上，但它是「这条 user 消息属于第几轮」的唯一记录（user 消息自身不带 turn），所以一并保留。

## 工具轨迹补出的三节

逐字抄正文救不了「正文为空」的轮次。实测一个 13878 事件的会话：1973 条 assistant 消息里只有 317 条带正文，其中一轮跑了 342 次工具调用却一个字没写，逐字摘要把它压成一行 `tools: bash×281`——活干了，记录没了。

所以每轮另发一次模型调用，材料是三段：用户请求（逐字）、助手正文（逐字）、工具轨迹（每条调用的 `description`，失败的调用另记一行首行错误）。模型输出固定的三节：`## Did` / `## Concluded` / `## Overturned`。

模型用的是会话自己的路由（`session.requestHeader()?.config`），和宿主原生压缩同一个取法，不需要单独配置凭据。

三件事刻意做成这样：

- **失败信号只认 `data.isError`**。曾用 `/error/i` 匹配序列化文本，347 条成功结果全部命中（工具输出里常有 "error" 字样），模型据此报告「整轮失败」。测试里有一条专门钉住这个坑。
- **工具调用从 `assistant/message` 的 block 里取**。日志里没有独立的 `tool/call` 事件类型，按它过滤会一条都取不到。
- **提取失败就退回纯逐字摘要**。模型不可达、超时、输出为空都返回 null；压缩本身不能因此失败，否则会话死于上下文溢出，比丢细节更糟。

代价是每轮一次模型调用（实测 13 轮合计约 74649 字符材料）。提取结果与逐字摘要共用同一个预算，超预算时只保留逐字摘要。

## 为什么不会触发 shrink 守卫

基类的守卫比较「framed 摘要」与「被替换内容的 route 价」，摘要不小于原内容就整次压缩失败。本插件把预算直接算成 `min(196752, shadowedPrice − 86 − 512)`：上界取守卫自己的那个数，因此这条失败路径按构造不可能发生，而不是靠实测侥幸。实测 8 个会话 0 次触发，最小余量 174387。

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

- **正文超预算会被截断。** 预算是硬的，两级依次触发：**先** user 正文超过预算一半时从**最新**往前算、最旧的先丢（用户刚说的话是下一轮唯一依赖的东西，丢它等于丢任务）；**仍不够**才把助手正文按轮均分截断，每轮下限 800 字符。8 个实测会话里两级都没跑过（最大摘要 44542 token，预算 196752），所以这是守卫而不是常态。
- **`turn/start` 缺失时轮次编号退化为 `turn ?`。** 不会丢正文，只是编号不可读。
- **注入内容不进摘要。** 判据是 `source.kind !== 'user'`——注入上下文在一个真实会话里占 user 消息字符的 97%，放进摘要会把人的原话淹掉。
- **不改善首轮之外的工具参数细节。** `bash` 命令本身（占工具参数 84.2%）不保留；需要「当时跑了什么命令」的场景不在本插件的覆盖范围内。

## License

MIT

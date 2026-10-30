# @logictan/dsh-verbatim-compaction

把上下文压缩的**摘要**从「让模型重写一遍」换成「确定性地把正文抄进 checkpoint」：用户与助手的正文逐字保留，工具结果压成一行指针，推理块从不读取，全程零模型调用。

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

- **正文超预算会被截断。** 预算是硬的：助手正文先按轮均分截断，仍不够才从最旧的 user 正文开始截。8 个实测会话里两条分支都没跑过（最大摘要 44542 token，预算 196752），所以这是守卫而不是常态。
- **`turn/start` 缺失时轮次编号退化为 `turn ?`。** 不会丢正文，只是编号不可读。
- **注入内容不进摘要。** 判据是 `source.kind !== 'user'`——注入上下文在一个真实会话里占 user 消息字符的 97%，放进摘要会把人的原话淹掉。
- **不改善首轮之外的工具参数细节。** `bash` 命令本身（占工具参数 84.2%）不保留；需要「当时跑了什么命令」的场景不在本插件的覆盖范围内。

## License

MIT

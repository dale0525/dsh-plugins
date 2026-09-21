---
name: ctx-mem-config
description: "ctx-mem 上下文交接压缩后端（@logictan/dsh-ctx-mem）的使用与配置指南。凡涉及上下文压缩行为、/compact、压缩调参（阈值/保留尾巴/填空开关/填空路由/产出语言）、或要改挂载与配置位置时先读本指南：ctx-mem 替换官方 compaction-basic，程序逐字抽取硬事实（路径/命令/报错）+ 模型只补四节因果，产出含 ## Extracted Facts 骨架与 ## Why This Approach 等四节；可调键 thresholdRatio / retainRatio / retainTokens / fillEnabled / fillProvider / fillModel / language / maxCheckpointTokens。触发词：ctx-mem、压缩、compaction、上下文超限、上下文交接、摘要、骨架、硬事实、thresholdRatio、retainTokens、fillEnabled。"
---

# ctx-mem 使用指南

ctx-mem 是 `ctx.compaction` 服务的替换实现：它继承官方
`BasicCompactionEngine` 的全部安全机制（压力触发、保留尾巴、事务锁、
tool-pairing 边界），只覆写 `summarize()`。

压缩一次的实际动作：

1. 按消息对象身份取回被压缩区间的 seq，再按 **seq 范围**取原始事件。
2. 程序抽取硬事实——路径、命令、报错逐字保留，不经模型转写。
3. 渲染成骨架 `## Extracted Facts`（含 `### User Intents` / `### Files Touched`
   / `### Commands Run` / `### Errors Seen`）。
4. 一次「填空」模型调用：只输入骨架，产出固定四节因果
   `## Why This Approach` / `## Errors and Their Causes` /
   `## Open Decisions` / `## Next Step`（空节写 `(none)`）。

骨架每次从原始事件重建，不转发上次的 checkpoint，所以连续压缩不会让早期
硬事实衰减。

## 挂载：bridge 自动替换，无需选模式

压缩后端是**服务替换**，`preset` 的 `isolate` realm 决定 profile 层的引擎行无法
覆盖它。本插件因此把替换动作交给 **bridge 行** `ctx-mem-bridge`
（`@logictan/dsh-ctx-mem`，挂在 profile 平面）：宿主挂载 preset 组合时，
bridge 给该组合注入一段 `patches`——关掉官方 `compaction-basic`，并在同一个
`compaction` 组内插入 `ctx-mem`。

因此**任何模式都直接生效**，不必新建或选择专用模式。覆盖 `standard` / `ptc` /
`cordis`；`minimal` 与用户自建 preset 不覆盖，无 preset 的 profile 不经过 preset
子树，bridge 自然 inert。覆盖名单见包内 `src/bridge.js` 的 `COVERED_PRESETS`。

配置写在 **bridge 行的 `config.engine`** 下，它会被转发到注入的引擎行：

```yaml
- id: ctx-mem-bridge
  name: '@logictan/dsh-ctx-mem'
  config:
    engine:
      fillModel: deepseek-v4.1-flash
```

不要改 preset 文件，也不要给 `ctx-mem` 行写 `config:`——引擎**没有** profile 平面的
行（它由 bridge 注入到 preset 的 `isolate` 组内），配置只认 bridge 行的 `config.engine`。

## 配置键

行上的 `config:` 段全部可选，不写即用默认。键分两类。

ctx-mem 自有键：

| 键 | 默认 | 说明 |
|---|---|---|
| `fillEnabled` | `true` | 是否执行填空调用。`false` 时**零模型调用**，只产出骨架 |
| `fillProvider` / `fillModel` | 空 | 填空所用路由。两者都空 = 用会话当前路由；只填一个不生效 |
| `language` | `zh` | 四节因果的语言，取值 `zh` / `en` |
| `maxCheckpointTokens` | `10000` | 检查点的绝对 token 上限（骨架预算取它与分母推导值的较小者）。**纯上限旋钮**：调小不丢事实类别，只让骨架更早降档（写类命令保留更短） |

继承官方 `compaction-basic` 且**对 ctx-mem 仍然生效**的策略键：

| 键 | 默认 | 说明 |
|---|---|---|
| `thresholdRatio` | `0.8` | 压力触发阈值 |
| `retainRatio` | `0.16` | 保留近期尾巴的比例 |
| `retainTokens` | 未设置 | 绝对保留 token 数，设置后覆盖 `retainRatio`；`0` = 硬切断 |
| `maxTokens` | `8192` | 填空调用的 token 上限（全局默认） |
| `modelPolicies` | `[]` | 按路由覆盖，元素形如 `{ provider, model, maxTokens, thresholdRatio, ... }` |
| `compactionRetries` | `1` | 一次压缩后仍超阈值的重试次数 |
| `maxOverflowRetries` | `1` | 上下文溢出后的恢复重试次数 |
| `auto` | `true` | 是否注册自动压缩 |

`modelPolicies` 里给某条路由钉的 `maxTokens` **优先于**全局 `maxTokens`，
ctx-mem 与官方后端一致地这样取值。

两个官方键**对 ctx-mem 无效**，不要设：`summarizationProvider` /
`summarizationModel`。它们唯一的读取点在官方 `summarize()` 里，而 ctx-mem
覆写的正是这个方法 —— 填空路由请用 `fillProvider` / `fillModel`。

两个容易踩的点：

- `retainTokens` 一旦设置就**覆盖** `retainRatio`；`retainTokens: 0` 表示一条
  逐字尾巴都不留（硬切断，等价于手动 `/compact` 走的路径）。旧事件仍在 log 中
  可回放，但没有任何模型可读接口能取回它们。**默认关闭**，需要时显式开启。
- `fillEnabled: false` 时产出**不含四节**，只有骨架。模型产出空泛时回退到它。

## 排查

| 现象 | 原因 |
|---|---|
| 压缩后没有四节 | `fillEnabled: false`，或会话没有可用路由（此时静默退化为纯骨架，不报错） |
| 压缩直接报错 `truncated at the token cap` | 填空输出被 `maxTokens` 截断，检查 `maxTokens` |
| 压缩报错 `produced no text` | 填空模型返回空文本 |
| 宿主启动报 `service "compaction" has been registered` | 同一 realm 内注册了两次 `compaction`：preset 里手工留了 `ctx-mem` 行，bridge 又插了一行 |
| 压缩仍是官方行为 | 会话用的 preset 不在 `COVERED_PRESETS` 里（如 `minimal`），或 profile 没有 `agent-presets` 行 |
| 改了 `config.engine` 但没生效 | 写在了 `ctx-mem` 行上；配置只认 bridge 行的 `config.engine` |

## 调整压缩行为时

用户抱怨压缩结果时，先问清期望再映射到键，不要直接甩配置表：

- 「丢了细节 / 路径命令对不上」→ 不是配置问题，是抽取层缺陷，记录具体区间与
  字段反馈。
- 「摘要太短 / 因果太空泛」→ `fillEnabled` 已开时换更强的填空路由
  （`fillProvider` + `fillModel`）。
- 「上下文还是很快满」→ 调低 `thresholdRatio`。
- 「摘要语言不对」→ `language`。
- 「想彻底不留近期原文」→ `retainTokens: 0`，并说明代价。

# ctx-mem — 上下文交接后端

dsh（DeepSeek Harness）的压缩后端：**程序抽取硬事实 + 模型只补四节因果**。

替换 `compaction-basic` 的"把旧对话重新总结一遍"，改为：

1. **程序抽取**：从原始会话事件里逐字取出用户原话、路径、命令、报错——不经模型改写；
2. **模型填空**：把这份骨架喂给模型，只让它写四节因果（为什么这么做、错在哪、悬而未决、下一步）。

模型输入因此从整段历史缩到一份骨架，产出则不再有"摘要把命令改错"这一类失真。

## 为什么不是纯确定性抽取

纯确定性抽取丢因果。实测同一段历史（150 事件 / 160,323 token）交给纯代码后端，8 个产出节里 **4 节为空**——事实都在，但"为什么"没了，下一个会话无法接续。

## 为什么不是照搬 `compaction-basic`

`compaction-basic` 把整段历史（实测 **81,667 input + 4,139 output** 全价 token）重发给模型做语义归纳。它的产出会重写命令与路径，且同一段历史多次压缩结果不同。本插件把"事实"与"因果"分开：事实由程序保证逐字一致，模型只负责它真正擅长的部分。

## PTC 感知

PTC（programmatic tool calling）模式下，模型写的是 `run_code` 脚本，真实工具调用是宿主在执行脚本时落盘的 `tool/ptc-dispatch` 事件。正则解析 `run_code` 源码会漏调用、漏引号内层内容、把模板字符串里的 `${...}` 当成事实。

本插件以 `tool/ptc-dispatch` 的**结构化** `arguments` 为权威源（实测 126 次调用 / 102 条命令，零截断），源码解析仅在该调用没有 dispatch 事件时兜底；非 PTC 的直接工具调用走 `assistant/message` 的 `tool-call` 块。`tools.mode: 'both'` 的混合区间两条路径并存。

## 事件归属

从 `input.messages` 取回原始事件，靠**对象身份 → seq** 映射定位区间，再按 **seq 范围**取事件。不能用 `shadowedSeqs` 成员判定：`tool/ptc-dispatch` 是 log-only 事件，seq 与 surface 节点交错且不在该集合中，成员判定会得到"0 个 dispatch"的错误结论。

## 级联不衰减

骨架**每次从原始事件重建**，不转发上一次的 checkpoint 文本。既有后端在连续压缩中会丢失早期事实；原始区间始终留在 log 中，可重建、可回放、可审计。

## 产出格式

骨架（程序生成）在前，四节因果（模型生成）在后：

```markdown
## Extracted Facts
### User Intents
### Files Touched
### Commands Run
### Errors Seen

## Why This Approach
## Errors and Their Causes
## Open Decisions
## Next Step
```

四节顺序固定，空节写 `(none)`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `fillEnabled` | `true` | 是否执行模型填空；`false` 时退化为纯确定性产出，且不发起模型调用 |
| `fillProvider` / `fillModel` | 空 | 填空所用路由；两者都空 = 用当前会话路由，只填一个不生效 |
| `language` | `zh` | 产出语言 |
| `thresholdRatio` | `0.8` | 压力触发阈值（继承 `compaction-basic` 语义） |
| `retainRatio` | `0.16` | 保留近期尾巴的比例（继承语义） |
| `retainTokens` | 未设置 | 保留尾巴的绝对 token 数，设置后覆盖 `retainRatio`；`0` = 一条尾巴都不留（硬切断） |
| `maxTokens` | `8192` | 填空调用的 token 上限 |
| `modelPolicies` | `[]` | 按路由覆盖；`maxTokens` 等键可在此按 `provider`/`model` 单独钉住 |
| `compactionRetries` | `1` | 一次压缩后仍超阈值的重试次数 |
| `maxOverflowRetries` | `1` | 上下文溢出后的恢复重试次数 |
| `auto` | `true` | 是否注册自动压缩 |

完整的键语义与两个易踩的坑见包内技能 `skills/ctx-mem-config/SKILL.md`（宿主技能名 `ctx-mem-config`），本表只列键与默认值。

触发、保留尾巴、溢出恢复、事务锁、tool-pairing 边界全部继承 `BasicCompactionEngine`，本插件只替换 `summarize()`。

`summarizationProvider` / `summarizationModel` 对 ctx-mem **无效**（它们只在官方 `summarize()` 里被读取，而该方法已被覆写）；填空路由请用 `fillProvider` / `fillModel`。

`retainTokens: 0` 是 codex 式的硬切断：压缩后 surface 只剩 system + checkpoint，模型请求不含任何被压缩区间的逐字消息。旧事件仍在 log 中（可回放、可审计、可 fork），只是没有任何模型可读接口能取回。**默认关闭**。

## 挂载

压缩后端是 `ctx.compaction` 服务替换，而每个 preset 都在 `isolate: { compaction: true }` 组里组合自己的后端，profile 层的行无法覆盖该 realm。本插件因此由两部分组成：

1. **引擎行** `ctx-mem`（`@logictan/dsh-ctx-mem`）——真正的后端，必须落在 preset 的 `isolate` 组内。
2. **bridge 行** `ctx-mem-bridge`（`@logictan/dsh-ctx-mem/bridge`）——挂在 profile 平面，在宿主挂载 preset 组合时给该组合注入一段 `patches`：关掉官方的 `compaction-basic`，并在同一个 `compaction` 组内插入 `ctx-mem`。

因此**任何模式都直接生效**，无需新建或选择专用 preset：`standard` / `ptc` / `cordis` 三个预设会被 bridge 自动替换后端。`minimal` 与用户自建预设**不在覆盖范围内**——它们的设计意图里没有上下文压缩，bridge 不替它们做决定。无 preset 的 profile（如 `headless`）不经过 preset 子树，bridge 自然不生效。

要调整行为，用 **bridge 行** 的 `config.engine:`（键见上表），不要改 preset 文件。

```yaml
# 覆盖的预设 id 由 src/bridge.js 的 COVERED_PRESETS 决定
- id: ctx-mem-bridge
  name: '@logictan/dsh-ctx-mem/bridge'
  config:
    engine:
      fillModel: deepseek-v4.1-flash
```

**引擎行故意不写 `config:`**：上表每个键都已经等于继承来的默认值（或按设计不设置），写出来只会把默认值钉死在上游的当前取值上。引擎的配置只认 bridge 行的 `config.engine`——注入行由 bridge 生成，是它唯一的落点。

本包的 `cordis.patch.yml` 声明两行：bridge 行 **enabled**（它的正确挂载点就是 profile 平面），引擎行 **disabled**（它在 profile 平面挂载会与 preset 的后端并存，两个引擎同时监听 `agent/pre-step` 压缩同一个会话）。两行的 id 分别等于各自宿主半边的 `export const name`；包本身必须被安装，因为 preset 行按包名从 profile 根解析它。

## 使用指南（技能）

包内自带 `skills/ctx-mem-config/SKILL.md`，随插件注册进宿主技能目录（名为 `ctx-mem-config`），供用户与模型按需查阅配置键、两个易踩的坑（`retainTokens` 覆盖 `retainRatio`；`fillEnabled: false` 不产出四节）与排查表。

## 开发

```bash
node build.mjs     # src/ → lib/（lib/ 不入版本控制，prepare/prepack 也会跑）
node --test        # 单元测试
```

## 上游

Fork 自 [`fan56/dsh-dcp`](https://github.com/fan56/dsh-dcp) `v0.11.0`（MIT）。同步清单见 `sync-policy.json`。

## License

MIT

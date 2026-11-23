# 并发：原生并行、单车道与扇出

只在「一轮里有多片互不依赖的工作」或需要决定用普通并行还是 `workflow` 扇出时读。

## 原生并行优先于派单

- 宿主按工具自身的 `isConcurrencySafe` 决定是否并行执行。常见声明可并发的工具包括 `read`、`read_image`、`web_search`、`web_fetch`、`subagent`、`subagent_fork`；`bash`、`grep`、`glob`、`edit`、`write`、`skill`、`workflow`、`job_*`、`mcp__*` 等属于独占工具，同一步发多个仍按顺序执行。
- 读 N 个独立文件应同一步发 N 个 `read`（真正并行且单个失败不连累其余），不要塞进一条 `bash` 的 `cat a b c`。
- 多个无共享写状态的独立切片，放在同一条消息里一起派 `subagent`／`subagent_fork`，真正实现多代理并行提速。

## 大规模扇出用 `workflow`

- 仅在用户明确要求 `workflow`，或「N 个同类对象 × 同一套处理流程」（批量审计、批量迁移、多角度检索、批量核查）时使用；只有 1–3 个性质不同的切片直接用普通 `subagent`。
- 优先用 `pipeline(items, ...stages)`（逐项流式走完、无阶段栅栏）；仅在下一阶段必须等齐全部结果时用 `parallel(thunks)`。
- 单个子代理失败在结果数组里落成 `null`（用 `.filter(Boolean)` 过滤），脚本自身异常才会中断整条流水线。
- 路由用 `agent(prompt, { provider, model })`；**`workflow` 的 `agent()` 不支持 `reasoning_effort`**（传入会被引擎以 `UNSUPPORTED_OPTION` 拒绝），省略路由则继承父级。
- `workflow` 派出的每个 `agent()` 同样受授权标记门禁约束，其 `prompt` 开头必须写明 `[只读]`／`[审核]`／`[编辑: <路径>]`，否则静默降为只读。
- 耗时较长的 `workflow` 传 `run_in_background: true`，拿到 job id 后继续推进其他工作线，再用 `job_output` 收集结果。

## 共享状态与边界

- 并行只用于无共享写状态的切片；有共享可变状态或先后依赖的工作必须串行化。
- 广泛探索未知领域前派有边界的只读子代理接管后，Root 不再重复探索同一领域，只负责综合与复验。

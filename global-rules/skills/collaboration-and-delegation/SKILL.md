---
name: collaboration-and-delegation
description: 子代理派单、路由、授权标记、原生并行与 workflow 扇出写法。拆解后已标出外派线、准备调用 subagent／subagent_fork／workflow，或一轮有多片互不依赖工作要并发推进时加载。不重复拆解原则，也不替代审查门禁（见 delivery-discipline 与 blind-review）。
---

# 协作与调度

外派判据与并行原则见 `~/.dsh/AGENTS.md` 核心原则，本技能专注「怎么派得成、怎么并发跑得快」。

## 派单边界

- **共享可变状态必须单一所有者**：同一文件的多处改动、共享符号定义及其调用点、并发原语与跨进程协议、生成物及其生成器，不拆给多个席位。
- **实现线与调研线给法不同**：实现类工作线尽量由 Root 给出精准上下文与编辑范围，避免子代理漫无目的探索；调研类工作线反过来，只划清目录／仓库／信源边界和要回答的问题，不预先喂大段原文。
- **派完不空转**：后台席位运行期间，Root 继续推进其他独立工作线。禁止高频轮询 `list_agents`、禁止 `sleep` 空转、禁止另派席位重复同一领域。`@logictan/dsh-force-rules` 会自动登记自唤醒检查点，仅在检查点唤醒或显著超时时调一次 `list_agents`。
- **子代理结论不直接采信**：关键事实与代码断言由 Root 用一手探针复验后再采纳。

## 路由与失败策略

- **路由默认省略，继承 Root 当前配置**：`subagent` 不传 `provider`／`model`／`reasoning_effort` 时自动继承父会话路由与思考强度。本技能不写死具体模型名；需要换某个切片的模型时以项目规范为准。两处例外：`blind-review` 的第二席必须换不同模型族（见该技能）；`workflow` 的 `agent()` 不支持传 `reasoning_effort`（见 `references/concurrency.md`）。
- **`provider` 与 `model` 必须成对**：只写其一会被门禁拒绝，要么都写，要么都省略；`reasoning_effort` 仅在目标模型支持该档位时填写。
- **`subagent_fork` 恒继承父级路由**：仅接受 `cwd`／`description`／`prompt`，会携带已有对话历史（token 更贵），只在子代理必须理解前文语境时使用。
- **不要为了写路由调 `list_subagent_models`**：仅在需要换异族模型、项目规范指定换路由、或路由报错核对可用项时调用；查某 provider 下的模型列表必须传 `provider` 参数，切勿把无参输出的 provider 名填进 `model`。
- **失败重试区分两类**：
  1. **派单调用本身被拒**（无子代理 id）：先核对路由／参数后再重派；若属模型不可用，需指向当场探针失败再换路由。
  1. **已启动席位报错或输出异常**：通过 `send_message` 向同一席位纠偏重试，最多 3 次；仍失败再新开席位。
- **核验实际路由看日志，不问席位**：子代理无法自知真实模型，核验看 `~/.dsh/sessions/<cwd 转义>/<childId>/session.v4.jsonl.zstd` 首条 `request/header` 的 `data.header.config`。

## 授权标记与并发细则

- **每条派单指令必须以授权标记开头**（`[只读]`／`[审核]`／`[编辑: <路径>]`），否则席位会被静默降为只读。标记锚定、路径匹配、派发深度限制见 `references/delegation-markers.md`——给席位开写权限前必读。
- **多工具并发与 `workflow` 扇出**（哪些工具可并发、`pipeline` 与 `parallel` 取舍、`workflow` 路由与标记约束）见 `references/concurrency.md`——准备多片并发或编写 `workflow` 时读。

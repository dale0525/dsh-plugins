# @logictan/dsh-context-envelope

把 DSH 自己注入的上下文注包进 `<system-reminder>`，**只在适配器边界**、只改发往上游的请求。

## 它解决什么

一轮 DSH 请求会带四条 user 消息：用户原话、`Current runtime context. …`、技能目录、`Time sampled while preparing turn N, step M: …`。后两条是发给模型看的注，用户并没有说过，但它们是**纯文本**。

网关若按「最后一条 user 消息」判定这一轮，读到的时间戳就顶掉了用户的问题。在 magpie 里受影响的是 `when="message …"` 与意图分类器——两者最终都走 `userWords`/`lastSaid`：

- magpie 会整块跳过 `<system-reminder>`，但不能靠文本认出这两条注，因为跳过前缀表是上游的，不含 DSH 的两条（issue [#6968](https://github.com/yetone/magpie/issues/6968)，main 上至今未修）。
- 后果是整轮落到该组的默认成员，分类器被拿去判定一个时间戳。

本插件在请求离开宿主前把这两条注包进 `<system-reminder>`，于是那些读法跳过它，模型照常读到内容。会话日志、对话记录与界面保持原样。

## 它不改动什么

消息不合并、不挪位置、不换 id——原话仍是第一条 user 消息，字节不变。这一条是硬约束：magpie 用**开场那条 user 消息的原始字节**推会话身份（`conversationID`），把带时间戳的注并进去会让身份每轮都变，丢掉会话亲和与缓存前缀；原话若被改写或挪后，`turn` 计数与 `firstWords` 也会跟着变。

## 它修不到什么

`when="last …"` 用的是另一套读法：`lastUserTexts` 取最后一条 user 消息的**原文，reminder and all**，不剥标签。所以包壳对它无效，本插件不声称修它。若某条规则必须用 `last` 条件，得让注根本不落在最后一条 user 消息里。

同一个上游函数里还有一条与本次无关的既有事实：`Current working directory:` 这种写法只在系统提示词或 `role:"system"` 的消息里被 magpie 的 folder 规则读到，放在 user 消息里（包不包 reminder 都一样）从来没生效过。要它生效得改用 `<cwd>…</cwd>` 或放进系统提示词。

还有一条取决于**适配器**的边界条件：原生 Messages 形状的适配器（`dsh-llm-deepseek`）会把连续的 user 消息并成一条 content 数组发出，而那一步发生在本插件之后。一旦并进去，magpie 用开场消息字节推出来的会话身份就会带上时间戳、每轮都变。pi-ai 路线的适配器（`openai-completions`、`openai-responses`、`anthropic-messages`）保持逐条独立，不受影响——本机 profile 用的正是 `openai-completions`。换用会合并 user 消息的适配器时，本插件不足以保证会话身份稳定。

## 为什么接缝是 `forAdapter`

这是唯一能改写 `messages` 的接缝：

- `llm/stream` 瀑布**不行**。`cordis` 的 `waterfall` 闭包捕获了参数列表，`next(replacement)` 会被静默丢弃；而且循环构造的请求本身是深度冻结的。
- `prepared.stream` **不行**。`LlmRuntime.prepareCall` 返回 `Object.freeze` 的对象。

`forAdapter` 位于两者之下，因此 `llm/stream` 瀑布（以及依赖 `isAgentLoopRequest` 的循环请求不变量）仍然看到未被改动、带标记的请求，而每个适配器都看到已包壳的注。`callConfigEquals` 不比较 `messages`，预备调用守卫不会被触发。

## 覆盖范围

按 `Message.source.kind` 精确识别，不靠文本匹配：

- `runtime-context`（`@deepseek-ai/dsh-system-prompt` 生成的运行时上下文快照）
- `time-context`（`@deepseek-ai/dsh-time-context` 的时间读数）
- `plugin:openviking-memory`（记忆召回块）
- `force-rules`（`@logictan/dsh-force-rules` 的每步嘀咕；该类在 0.4.10 已被上游删除，此处仅作防御性保留，不再有实际对象）

一个新建会话里只提了一个问题，magpie 曾数出 **12 轮**——提问 1 轮，其余全是这些注。包壳后新建会话是 **1 轮**。

三类刻意不动：

- `skill-catalog`、`agent-instructions` 宿主已用 `<system-reminder>` 包着，再包一层只会嵌套标签。
- `working-directory` 在「目录变更后新建会话」时会排在提问**之前**，而 magpie 用开场 user 消息的字节推会话身份——包壳等于换掉会话 id 的输入。

## 为什么是这几个 kind

v0.1.0 只包了 `runtime-context` / `time-context`。上线后实测一个新会话：`turn` 仍是 3 而不是 1，分类器读到的是记忆文本、判成「问题不明确」，之后每一步 `said` 全空。补上 `plugin:openviking-memory` 后新建会话才降到 1 轮。

修的时候有个坑：子代理派单的初始任务也是 `source.kind === 'user'`，那是子会话自己的提问，**不能**包。它和用户提问的区别在 source 上——用户消息带 `rpcId`，子代理任务只有 `{kind:'user'}`。这也是本插件不碰 `user` 这个 kind 的第二个理由。

消息里已有 `<system-reminder>` 开头的块不会重复包；文本中的 `</system-reminder>` 会被转义成 `<\/system-reminder>`，以免提前闭合、把注的剩余部分漏成"用户的话"。

## 安装

本包随聚合包 `@logictan/dsh-plugins-all` 一起安装，无需单独操作。安装后自动生效，没有任何开关。

## 构建与测试

```bash
pnpm install
pnpm --filter @logictan/dsh-context-envelope build
pnpm --filter @logictan/dsh-context-envelope test
```

## 许可证

MIT
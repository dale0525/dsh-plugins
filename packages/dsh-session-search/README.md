# @logictan/dsh-session-search

打开宿主自带的会话全文检索，并把剩下的一条限制告诉模型。

## 它解决什么

DSH 的会话全文检索是**默认关闭**的，而且不是故障——`@deepseek-ai/dsh-web-app` 的 bundle patch 明确写着这是 opt-in。本机实测有两个独立的问题：

1. **索引根本没建。** 宿主基础层配的是 `path: ':memory:'` + `openAt: never`，后者让每一次全文调用在碰 SQLite 之前就抛 `SESSION_QUERY_SEARCH_DISABLED`。
2. **检索工具根本没挂。** Web profile 挂了 `session-query-sqlite` 后端，但**从未挂载** `@deepseek-ai/dsh-tool-session-query`，所以模型手上没有 `session_search` / `session_event_search` 这两个检索工具。只打开索引，用户仍然搜不了。

本插件两件都做。

## 装完就能用，不需要改 profile

`cordis.patch.yml` 做两件事，都在 bundle 层完成：

- 按 `id: session-query-sqlite` **覆盖**宿主那一行（`applyEntryPatches` 按 id 匹配并合并 `config`，所以只改配置、不改包名），把索引指到 `$DSH_HOME/session-search/index.db`、`openAt` 改成 `first-search`。
- `insert` 一行 `@deepseek-ai/dsh-tool-session-query`，让这两个检索工具存在。

因为改的是 bundle 层而不是 profile 层，**新设备装上聚合包就自动生效**，不需要用户手写 patch。索引在第一次真正检索时才建，所以启动不做 I/O；建好之后跨进程复用。

## 打开的代价（实测）

- **首次建库约 3 分钟、索引约 840 MB。** 用宿主的真实提取器（reasoning 不入索引）在 40 个最大会话（370 MB、144237 文档、138M 字符）上实测 trigram 建库 129.4 秒 / 588 MB；本机 345 个会话共 528 MB，按字节外推。
- **多进程会撞锁。** 宿主没设 `busy_timeout`（实测 `PRAGMA busy_timeout` = 0），而 `_reconcile` 用 `BEGIN IMMEDIATE`。实测两个连接同时 `BEGIN IMMEDIATE`，第二个立刻抛 `database is locked`。Web 和命令行同时开着检索时会遇到。这是宿主侧缺陷，本插件改不了。

## 模型会被告知什么

索引能查到**被压缩掉的原文**——实测会话 `2d0811a6` 里 `shadowed` 文档 1852 条，抽样 50 条用正文片段回查 50/50 命中。所以「压缩前的细节找不回」这件事，打开索引就解决了。

但有一个限制必须告诉模型，否则它会以为查不到就是不存在：

> CJK 查询短于三个字符不生效。分词器把一整段连续中文当一个 token，所以两字查询（如「压缩」）只能命中那些恰好被标点或拉丁文断开的位置，通常什么都查不到。改用三个字以上（「压缩上下文」），或换用同一内容里的拉丁关键词。三个字以上的查询是精确的。

实测依据（`428f3552` 会话，3635 文档、4,777,025 字符，真值取自 `LIKE`）：

| 查询 | 长度 | 真值 | `unicode61`（宿主现用） |
|---|---|---|---|
| `小说` | 2 | 253 | 82 |
| `压缩` | 2 | 16 | 1 |
| `上下文` | 3 | 13 | 8 |
| `搜索接口` | 4 | 14 | 2 |
| `滑块验证` | 4 | 2 | 0 |
| `番茄小说` | 4 | 153 | 89 |

`unicode61` 那一列**没有一条是真实命中**——它们全部来自中文里夹拉丁文或标点造成的偶然分段。`滑块验证` 0/2 才是它的真实水平。三个字以上的查询在换成 `trigram` 后与真值逐条相等，但那需要改宿主包，本插件不做。

这条说明通过 `system-prompt/assemble` 事件追加到 `session_search` 与 `session_event_search` 的工具描述上（只读的 `session_trace` / `session_event_trace` / `session_event_read` 不做全文检索，不加），不注入 `systemPrompt` 服务（注入意味着「必需」，宿主缺该服务时整个插件会被禁用，连带丢掉这条说明）。

## 索引在启动时建，不在第一次检索时

宿主只在 `searchSessions` / `searchEvents` 里调用 `_reconcile`——挂载时不做。配 `openAt: first-search` 的后果是**第一次真检索要同步付掉整次冷建库**。本机实测：206 个会话，建库需数分钟，而工具调用 30 秒就被掐断，中止会丢掉已做的工作——两次尝试后索引仍是 **0 条**，永远建不完。

`openAt: startup` 解决不了：`[Service.init]` 只调 `_ensureReady`，那一步打开文件建表，不灌数据。

所以本插件在挂载后**自己**调一次 `searchSessions`，不受工具调用时限约束。`sessionQuery` 来自兄弟行，可能还没起来，因此用 `ctx.inject({ sessionQuery: true }, …)` 等它出现再跑。

预热不阻塞启动（不 await），失败也不影响宿主——坏索引只会退化成「搜不到」，不会把会话带崩。

## 索引会自动缩容

宿主的库是懒建的（第一次检索才建），而且**从不设 `auto_vacuum`**，所以文件生来是 `auto_vacuum = 0`——只增不减。行删了，页还占着。

本插件在挂载时（早于宿主的 `openAt: first-search` 打开任何东西）先把空库建好并设 `auto_vacuum = FULL`。宿主随后打开这个文件、建自己的表，设置会保留。实测：

```
pre-created, auto_vacuum = {"auto_vacuum":1}
host sees auto_vacuum = {"auto_vacuum":1}
host built schema, size = 19.61 MB
after host deletes all rows, size = 0.01 MB  <-- auto-shrunk
```

所以删会话时索引**自动跟着缩小**，不需要额外触发，也不需要本插件去动宿主正在用的连接。

为什么选 `FULL` 而不是 `INCREMENTAL`：`FULL` 在宿主自己的 `DELETE` 里就完成回收，无需收尾。`INCREMENTAL` 实测也能回收（39.21 MB → 0.21 MB），但要再执行一次 `PRAGMA incremental_vacuum`，那意味着本插件要往宿主的连接里跑 SQL。而全量 `VACUUM` 在另一个进程持写锁时**直接失败**（`ERR_SQLITE_ERROR`，宿主 `busy_timeout` 为 0）。

**一个既成事实的边界**：`auto_vacuum` 只能在建表前选定。**已经存在的旧库改不了**——要让旧库开始缩容，得删掉 `index.db` 让它按新方式重建一次（约 3 分钟）。

## 已知边界

- **两字中文查询查不到。** 见上表。修它要改宿主的 FTS5 tokenizer 与 `user_version` 判断，属于宿主包改动。
- **`LIKE` 回退不存在。** 本插件只开索引，不改查询构造，所以没有「两字查询走 `LIKE`」这条兜底。
- **不控制召回噪声。** `surface` 过滤器默认收全部三值（`current` / `shadowed` / `log-only`），所以被压缩的内容会与当前内容一起出现在结果里，靠排序而非过滤区分。
- **首建库期间检索会阻塞。** `first-search` 把建库放在第一次检索里同步做，Web 前端可能因此超时。

## License

MIT

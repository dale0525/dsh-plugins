# 会话载荷削减：三条可复用的路径与各自的边界

> 状态：一手实测结论。数字全部来自本机运行中的 DSH（宿主 0.2.1-rc.2）。
> 复现方式见 §5。结论已在 `@logictan/dsh-macos-theme` 0.1.13 落地
> （裁 `session/list`、压 `session/page`、压首屏 `session/follow` 并裁两个字段）。
>
> **2026-10-25 重要修正**：§3.3 原先写的「首屏不是瓶颈、插件改不到」**是错的**。
> 慢链路（Tailscale/外网）上首屏帧大小直接决定会话能不能打开 —— 传不完就超时重连，
> 表现为「一直载入历史 → 重新连接中 → 未命名 → 再循环」。详见 §3.3。

## 1. 问题

打开一个长会话要传多少数据、其中哪些是界面根本用不到的，一直没人量过。实测下来，
「打开会话」与「向上翻页」是两条完全不同的传输路径，载荷差一个数量级，而能削减的
手段也完全不同 —— 把它们混为一谈会得出错误的结论。

## 2. 两条路径先分清

| 动作 | 通道 | 实测载荷 |
|---|---|---|
| 打开会话（首屏） | WebSocket 事件流，`doOpen` | 855 KB / 505 条事件 |
| 向上翻页（加载更早） | HTTP `POST /api/session/page` | 9219 KB / 1253 条事件 |

首屏由 `dsh-api-session-controller` 的 `doOpen` 发起，用的是客户端常量
`HISTORY_PAGE_OPTIONS`；翻页由 `loadOlder` 发起，走 `session/page` 端点。
**首屏的预算不在请求体里，翻页的预算在** —— 这个差别决定了插件能改哪一个。

翻页载荷的构成（同一页）：

| 事件类型 | 条数 | 占用 |
|---|---|---|
| `assistant/message` | 176 | 7687 KB（83%） |
| `tool/result` | 180 | 464 KB |
| `request/header` | 3 | 307 KB |
| `user/message` | 24 | 191 KB |
| `job/settled` | 160 | 158 KB |
| `job/registered` | 160 | 141 KB |
| `tool/call` | 177 | 157 KB |

单条 `assistant/message` 最大 105 KB，主体是 `reasoning` 块（23.4 KB 起）。
单条 `request/header` 103 KB，其中 `tools` 数组（80 个工具的完整 JSON Schema）占 103 KB。

## 3. 三条削减路径

### 3.1 改请求参数（最优，但只在预算进请求体时可用）

`session/page` 把页大小作为**参数**接收：`maxMessages` 与 `turnWindow`。
客户端固定发 `{ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`。
把这两个值改小后重发，服务端就只生成小页 —— 请求和响应同时变小，宿主也少做功。

同一 `beforeSeq` 下的实测曲线：

| maxMessages / minMessages | 响应 | 记录数 | hasMore |
|---|---|---|---|
| 500 / 50（原值） | 3993 KB | 1675 | true |
| 200 / 50 | 3006 KB | 1302 | true |
| 150 / 50 | 1947 KB | 970 | true |
| **120 / 50** | **1415 KB** | **766** | true |
| 100 / 40 | 1066 KB | 649 | true |
| 80 / 30 | 423 KB | 200 | true |
| 40 / 20 | 423 KB | 200 | true |

两个必须知道的事实：

1. **两个数字要一起动。** 宿主的 `paginate` 校验
   `turnWindow.minMessages <= maxMessages`，只压上限会让每次翻页都以
   `gateway/bad-request` 失败。报错文本是
   `turnWindow.minMessages must be a positive safe integer no greater than maxMessages`。
2. **继续压不会继续减。** 80/30 与 40/20 都是 423 KB：`minTurns: 2` 要求一页至少凑满
   两个 turn 起点，页大小撞到这条对齐下限后就与 `maxMessages` 无关了。所以可用区间是
   `maxMessages ≳ 100`；120/50 是「拿大部分收益、语义变化最小」的折中档。

### 3.2 裁响应字段（次优，适合列表类响应）

`session/list` 返回每个会话的整块投影。实测 1875 个会话 3.1 MB，其中
`turnOutline`（每轮一条，含 prompt/response 全文）1.0 MB、`imageLimits` 233 KB、
`modelSelection` 197 KB。而列表行只显示标题、时间戳和一个运行点。

裁到行真正读取的键后：3.14 MB → 1006 KB。**前提是这些字段能从别处补齐** ——
打开会话时该会话自己的投影流会完整送达，`useProjection` 订阅的是当前打开的会话
而非列表，所以裁列表不会饿死聊天视图。

### 3.3 首屏（2026-10-25 修正：此前「不是瓶颈、改不到」的结论是错的）

**旧结论错在两处，都已实测推翻。**

**其一：首屏可以改，预算就在出站帧里。** 之前判定「预算写在客户端常量
`HISTORY_PAGE_OPTIONS` 里、插件改不到」，只对了一半：常量确实改不到，但首屏走的是
`session/follow` **流**，它的页大小是随 `open` 帧发出的请求参数
（`payload.args.request.maxMessages` / `.turnWindow`）。包一层
`WebSocket.prototype.send` 就能改写，和 3.1 改 `session/page` 是同一类操作。
`assistantStream` 那条路堵死：宿主把它声明为必需的 `const true`，传 `false` 直接被拒
（`gateway/input-invalid`），所以只能改预算或裁响应。

**其二：瓶颈不是体积，是「字节传不完」。** 局域网 6 MB 一两秒就完了，看不出问题；
慢链路上它决定会话能不能打开。把链路限到 2 Mbit/s / 80 ms（典型 Tailscale 中继）实测
最坏的本地会话（20 MB 日志）：

| 首屏预算 | 帧大小 | 结果 |
|---|---|---|
| 500/50（App 默认） | 6313 KB | 首帧**始终未到达**，socket 在 **16.4 s** 被以 1006 关闭 |
| 120/50 | 6313 KB | 同上（**完全没变**，原因见下） |
| 120/12 | 566 KB | 3.6 s 到达，连接存活 |
| 120/10 | 566 KB | 3.6 s 到达，连接存活 |

症状链正是用户报的现象：一直「载入历史…」→ socket 断开 → 侧边栏底部「重新连接中」→
重连成功但列表尚未加载、全显示「未命名」→ 恢复真实标题 → 再次打开会话 → 再次超时，
直到某次碰巧成功。**局域网几乎不出现，Tailscale/外网访问才复现**，这就是它的指纹。

**其三：`maxMessages` 在长 Turn 会话上可能是死参数，真正生效的是 `minMessages`。**
`paginate` 从最新往回扫，遇到 `turn/start` 时先判
`count >= minMessages && turns >= minTurns` 才允许在此截断，遇到 message 时判
`count >= maxMessages` 兜底。上面那个会话的 Turn 只有 `[91, 11, 1]` 条 message：
最近的 Turn 单独永远凑不到 `minMessages: 50`，于是扫描耗尽历史、把 103 条全给了你，
`maxMessages: 120` 一次都没触发。把 `minMessages` 降到 12 才在第二个 Turn 起点停下。
**拐点实测在 15→12 之间（6313 KB → 566 KB）。**

> 推论：凡是「压 `maxMessages` 却毫无变化」的会话，先看它的 Turn 里各有多少条
> message —— 单个 Turn 的 message 数小于 `minMessages` 时，那个 Turn 边界永远不算数。

**其四：帧里有一半是重复内容。** 同一个 6313 KB 帧的构成：

| 组成 | 大小 | 是否渲染需要 |
|---|---|---|
| `assistant/message` | 4864 KB | — |
| ├ `data.stream` | 3719 KB | **不需要**：分块日志，与 `message.content` 文本逐字符相同 |
| └ `message.content` | 1129 KB | 需要，正文 |
| `request/header` | 624 KB | — |
| └ `header.tools` | 623 KB | 只有轨迹面板渲染，本主题已隐藏 |

`data.stream` 是宿主为还原「打字机节奏」保留的分块记录。对**已落定**的消息，同样的文本
已经在 `data.message.content` 里：该会话全部 65 条 assistant 消息，`stream` 拼接文本与
`content` 拼接文本**逐字符相等**（reasoning 两侧都是 917153 字符）。前端只有
`streamUsage`（算 token 用量）和首 token 时间读它，而用量另有 `data.usage`。

裁掉这两项后：6313 KB → 1961 KB（省 69%）。再叠 120/10：→ **235 KB**，
2 Mbit/s 下 5.1 s 到达、连接存活（重启后实机复核）。

**为什么裁剪必须做在到达侧而不是请求侧**：宿主 `follow` 把事件直接推进 `buffered`，
没有插件可挂的裁剪点；`assistantStream: false` 又被 schema 拒绝。所以「少传」只能靠压预算，
「少解析」才靠裁字段——两者不互相替代，慢链路真正需要的是前者。

## 4. 实现约束：为什么必须用 head 注入

三条路径里，3.1 与 3.2 都要在**请求发出前**介入，而插件做不到这件事的常规写法
（在浏览器半边包 `globalThis.fetch`）是无效的：

> RPC 传输层在**模块初始化时**就绑定了 `globalThis.fetch`。
> 插件后加载，它的包装器永远看不到已经绑定好的那次调用。

实测：插件侧包装器只捕获到 4 次无关的轮询请求，真正的 `session/list` 原样通过。
唯一赢下这个竞态的位置是宿主公开的 `webserver/index-inject` 钩子，
`kind: 'script'` + `placement: 'head'` 渲染进 `<head>`，排在所有应用脚本之前。

**顺带一个排查陷阱**：注入「看起来没生效」时，先核对自己在 index HTML 里 grep 的标记。
本次曾按源码常量名 `SESSION_LIST_KEEP` 去搜，而注入脚本里实际写的是 `const KEEP` ——
注入一直是好的，是探针找错了字符串。

改请求体还有一条纪律：**认不出的形状必须原样转发**。请求体解析失败、缺少
`payload.args.request`、`maxMessages` 不是数字、重新编码抛错 —— 这四种情况都直接放行原请求。
翻页请求被吞掉会让用户完全无法回看历史，代价远大于一次大页。

## 5. 复现方式

页面在带调试端口的 Chrome 里打开后，用 CDP 的 `Network` 域分别测两条路径：

- 首屏：`Network.webSocketFrameReceived`，取最大的那一帧，`value.records` 即事件数组。
- 翻页：`Network.requestWillBeSent` 抓 `/api/session/page`，再用
  `Network.getResponseBody` 读响应体。

预算曲线不必反复点页面 —— 直接在页面上下文里调包装后的 `fetch`，
把 `maxMessages` 设成想测的值即可，响应大小与记录数会如实反映服务端实际用了哪个预算。

读 CDP 返回值时注意层级：`Runtime.evaluate` 的回复是
`{ id, result: { result: { value } } }`，取 `out.result.result.value`。

### 5.1 慢链路症状必须限速才能复现（2026-10-25）

局域网测不出「打开不了」——6 MB 一两秒就传完，一切正常。要复现必须限速：

```
Network.emulateNetworkConditions
  { offline: false, latency: 80, downloadThroughput: 2*1024*1024/8, uploadThroughput: 512*1024/8 }
```

2 Mbit/s / 80 ms 大致相当于 Tailscale 中继。判据不是「首帧多大」，而是
**首帧有没有到达、socket 什么时候被关**：

- 未修复：首帧 `null`（始终没到），socket 在 ~16 s 被以 **1006** 关闭。
- 修复后：首帧 ~5 s 到达、235 KB，35 s 后 socket 仍 `readyState === 1`。

测「首屏预算是否真的生效」时，直接手发一个 `session/follow` 的 `open` 帧、只取第一帧
就关 socket，比点页面可靠得多；同时把返回的 `records` 长度和 `hasMore` 记下来，
就能看出截断点落在哪个 Turn。

**验证 head 注入是否生效**：grep 服务端返回的 HTML 里的**实际字符串**
（如 `delete data.stream`、`minMessages":10`），不要 grep 源码里的函数名或常量名
（如 `openingPageBudgetScript`、`OPENING_PAGE_BUDGET`）—— 后者永远搜不到，会得出
「没注入」的错误结论。
少取一层会得到 `undefined`，很容易被误判成「页面取不到值」。

## 6. 未做与边界

- **字体子集化不可行**：现有 GB2312 子集已接近字形下限（再按同一 Unicode 范围子集化只减 3%）；
  激进子集（3500 常用字）能减 57%，但拿本仓库 798 个文件、1585 个不同汉字验证会缺 169 个（10.7%），
  显示为豆腐块。不值得用可读性换 900 KB。暖加载本来就全走 304。
- **`request/header.tools` 去重**（每份 103 KB，一页可达 3 份）与
  **`job/*` 与 `tool/*` 的重复**（同一批工具调用在两边各出现一次，`label` 两边都带完整命令行）
  都属宿主侧事件 schema 的改动，未做。
- ~~以上三项都在宿主侧或需要新增按需端点，不在插件能改的范围。~~
  **2026-10-25 修正**：`request/header.tools` 与 `assistant/message` 的 `data.stream`
  都可以在到达侧裁掉（见 §3.3），已落地在 `dsh-macos-theme` 的 head 注入里。
  「宿主侧才能改」只对**源头少生成**成立，对**少传给浏览器**不成立。

### 6.1 冷开耗时：插件够不到的那一半

载荷之外还有一笔账，插件完全碰不到 —— **打开一个长会话的耗时几乎全在宿主侧的日志解码与缓存容量上**，
与传输量无关。

| 观测 | 数值 |
|---|---|
| 冷开一个 18.3 MB 压缩日志的会话 | **9.0 s**（解出 93 MB 明文、1655 帧） |
| 同一会话再次打开 | **0.12 s** |
| 顺序跑一次 `session/list` | 0.80–1.70 s / 764 000 B / 365 条 |
| 其中 readdir + stat + 366 次首帧读 + 投影缓存读解析 | 759 ms + 37 ms + 409 ms + 334 ms |

冷开的成本是**逐帧同步 zstd 解码**，重复打开因为命中了 prepared-Session 缓存而降到 0.12 s。
缓存容量由 `dsh-session-query` 的 `preparedSessionCacheSize` 决定，默认 **5**；本机同时有 25 个
活跃 agent，于是缓存持续被淘汰、反复重算。

这条边界决定了插件能做什么：`@logictan/dsh-macos-theme` 的三个杠杆（裁 `session/list` 响应、
把 `session/page` 的 `maxMessages` 压到 120、把首屏 `session/follow` 压到 120/10 并裁掉
`data.stream` / `header.tools`）只减少**载荷与调用频次**，既不能降低宿主的解码 CPU，
也不能让一次冷开变快。要动冷开本身，只能改 profile 里 `session-query-sqlite` 行的
`preparedSessionCacheSize`（或宿主的解码路径）—— 那是宿主侧配置，不是插件能力。

> 两者要分开算账：**冷开慢**是宿主解码 CPU，本地和远程都一样慢；
> **远程打不开**是载荷传不完，只在慢链路出现。前者插件碰不到，后者可以。

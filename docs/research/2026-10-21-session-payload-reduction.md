# 会话载荷削减：三条可复用的路径与各自的边界

> 状态：一手实测结论。数字全部来自本机运行中的 DSH（宿主 0.2.1-rc.2，一个 28 MB 压缩日志的会话），
> 复现方式见 §5。结论已在 `@logictan/dsh-macos-theme` 0.1.9 落地。

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

### 3.3 什么都不做（首屏）

首屏 855 KB 不是瓶颈，且预算写在客户端常量里、不在请求体里，插件改不到。
硬要改只能裁响应，但 `assistant/message` 是会话正文，裁错了用户直接看不到历史。

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
少取一层会得到 `undefined`，很容易被误判成「页面取不到值」。

## 6. 未做与边界

- **字体子集化不可行**：现有 GB2312 子集已接近字形下限（再按同一 Unicode 范围子集化只减 3%）；
  激进子集（3500 常用字）能减 57%，但拿本仓库 798 个文件、1585 个不同汉字验证会缺 169 个（10.7%），
  显示为豆腐块。不值得用可读性换 900 KB。暖加载本来就全走 304。
- **`request/header.tools` 去重**（每份 103 KB，一页可达 3 份）与
  **`job/*` 与 `tool/*` 的重复**（同一批工具调用在两边各出现一次，`label` 两边都带完整命令行）
  都属宿主侧事件 schema 的改动，未做。
- 以上三项都在宿主侧或需要新增按需端点，不在插件能改的范围。

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

这条边界决定了插件能做什么：`@logictan/dsh-macos-theme` 的两个杠杆（裁 `session/list` 响应、
把 `session/page` 的 `maxMessages` 压到 120）只减少**载荷与调用频次**，既不能降低宿主的解码 CPU，
也不能让一次冷开变快。要动冷开本身，只能改 profile 里 `session-query-sqlite` 行的
`preparedSessionCacheSize`（或宿主的解码路径）—— 那是宿主侧配置，不是插件能力。

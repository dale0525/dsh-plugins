# 会话全文检索修复 —— 方案（事前冻结）

状态：**已盲审，待用户裁定 §5**。本文冻结「会话检索为什么查不到中文、OpenViking 为什么召不回被压缩的原文、修什么、代价多少」。

## 1. 问题

两条链路都查不到「压缩前到底说过什么」，但它们失败的原因完全不同，修法也不同。

### 1.1 宿主会话检索：中文查询基本不可用

`@deepseek-ai/dsh-session-query-sqlite` 的 FTS5 表固定 `tokenize = 'unicode61'`（`lib/index.js:114` 与 `:144`），查询用 `quoteFtsData` 包成一个**整串短语**（`lib/index.js:287-289`）：

```js
function quoteFtsData(query) {
  return `"${query.replaceAll("\"", "\"\"")}"`;
}
```

`unicode61` 不切分中文，只按「非字母数字字符」分段，于是一整段连续中文成为**一个 token**。实测（本机 `428f3552` 会话，3635 个文档、4,777,025 字符）：

| 查询 | 长度 | `LIKE` 真值 | `unicode61` | `trigram` |
|---|---|---|---|---|
| `小说` | 2 | 253 | 82 | **0** |
| `压缩` | 2 | 16 | 1 | **0** |
| `上下文` | 3 | 13 | 8 | **13** |
| `搜索接口` | 4 | 14 | 2 | **14** |
| `滑块验证` | 4 | 2 | 0 | **2** |
| `番茄小说` | 4 | 153 | 89 | **153** |

读法：

- `unicode61` 那一列**没有一条是真实命中**。它的命中全部来自中文里夹拉丁文或标点造成的偶然分段——`滑块验证` 0/2 才是它的真实水平，`番茄小说` 89/153 是那批文档里恰好有空格。所以问题不是「unicode61 能查一部分」，而是「它对纯中文恒为 0，能查到与否取决于那段文字旁边有没有英文」。
- `trigram` 对 ≥3 字的中文查询与 `LIKE` 真值**逐条相等**（13/13、14/14、2/2、153/153）。
- `trigram` 对 2 字查询返回 0 行。已实测：这是**静默返回空集，不抛异常**（`node:sqlite` / SQLite 3.53.4，`MATCH '压缩'`、`MATCH '"压缩"'`、`MATCH '"压缩"*'` 三条路径都返回 0 而无报错）。原因是 trigram 至少要 3 个码点才能建出一个索引项。

也就是说：换 tokenizer 只能修 3 字以上，2 字词（中文最常见的词长）仍然查不到。

### 1.2 默认关闭，且这是宿主有意为之

`openAt: never` 不是用户配置，是 `@deepseek-ai/dsh-web-app/cordis.patch.yml:22-31` 的 bundle patch，注释原文：

> Full-text session search is opt-in (the base row's `openAt: never`). This restatement keeps the Web values on one ephemeral in-memory index; a deployment enabling content search overrides `openAt` to `first-search` in a later patch layer, which defers the node:sqlite import and in-memory handle to the first search so Node 22 startup stays quiet.

`openAt: never` 让 `_assertSearchEnabled`（`lib/index.js:593-596`）在任何全文调用前直接抛 `SESSION_QUERY_SEARCH_DISABLED`。所以本机检索不可用是**宿主的默认设计**，不是故障；要开就得照它说的在更靠后的 patch 层覆盖——profile patch 正是这个扩展点。

### 1.3 OpenViking 召不回被压缩的原文：不是缺 source，是服务端没有索引

原文确实在库里。`grep` 在 `viking://user/dsh/sessions/dsh-session-346bee66-…/history/archive_001/messages.jsonl` 与 `archive_005/messages.jsonl` 里命中 `承泽影业` 共 10 处。

但语义召回查不到，而且**原因不是客户端缺 source**：

- `mcp__openviking__find` 带 `target_uri: viking://user/dsh/memories`、查询 `承泽影业` → 返回 2 条命中。
- 同一个查询，带 `target_uri: viking://user/dsh/sessions` → `No matching context found.`
- 同一个查询，带 `target_uri: viking://user/dsh/sessions/dsh-061e2100-…`（单会话）→ 同样空。

同一个查询在 memories 下能召回、在 sessions 下不能，说明**服务端从未对 `sessions/` 做文本提取与向量索引**；`sessions/` 只是原始 JSONL 归档。`shared/recall-core.mjs` 的 `SOURCES` 里没有 sessions 是**结果**，不是原因——把它加上去，服务端照样返回空。

补充：`archive_*/messages.jsonl` 里 `grep '"type": "reasoning"'` 命中 0 条，reasoning 在 OpenViking 侧是真的没存。

### 1.4 会话语料规模

本机 `~/.dsh/sessions` 有 **345 个会话、528 MB（zstd 压缩态）**。其中体量最大的 40 个占 370 MB = **70%**。这个数字决定了 §2.1 的冷启动代价。

## 2. 修什么

分三件。**T-3 的形态在评审后已改**（见 2.3）。

### 2.1 T-1：把 `openAt` 与索引路径改成可用

```yaml
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-search/index.db')
    openAt: first-search
    journalMode: wal
```

- `path` 从 `:memory:` 改到 `$DSH_HOME` 下的持久文件，索引跨进程复用。
- `openAt: first-search`：进程启动不做 I/O，第一次检索才建库。`startup` 不采用——它把启动时间绑到索引大小上。

**两个必须写进验收的代价（实测）：**

1. **首次建库约 3.1 分钟，索引约 840 MB。** 用真实提取器（`extractSessionEventText`，reasoning 不入索引）在 40 个最大会话（370 MB、144237 文档、138M 字符）上实测：trigram 建库 129.4 s / 588 MB；同语料 `unicode61` 是 45.8 s / 252 MB。按字节外推到全量 528 MB ≈ **185 s / 840 MB**。这期间第一次检索请求会一直阻塞，Web 前端大概率超时。
2. **多进程会撞 `database is locked`。** 宿主 `DatabaseSync` 没有设 `busy_timeout`（实测 `PRAGMA busy_timeout` = `{timeout: 0}`），而 `_reconcile` 用 `BEGIN IMMEDIATE`（`lib/index.js:679`）。实测两个连接同时 `BEGIN IMMEDIATE`，第二个立刻抛 `database is locked`（`ERR_SQLITE_ERROR`）。`_serialized`（`lib/index.js:621-640`）只能串行化**单进程内**的任务，对「Web GUI + CLI 同时开」无效。

这两条都只能通过改宿主包解决（加 `busy_timeout`、把建库做成后台任务），不在本仓库能力范围内。它们是否可接受，是 §5 的裁定项。

### 2.2 T-2：修中文分词——`trigram` + 两字查询回退

单纯换 `tokenize = 'trigram'` 不够：2 字查询会从「偶尔能查到」变成「确定查不到」。三个动作必须一起做：

1. 两张 FTS5 表（`persisted_docs` 与 `temp.live_docs`）的 `tokenize` 从 `unicode61` 改成 `trigram`。
2. **`user_version` 的判断与赋值必须同时改。** 现在 `lib/index.js:58-60` 是 `if (version !== 8) resetDerivedSchema(...)`，`:117` 是 `PRAGMA user_version = 8`。若只把 `:117` 改成 9 而 `:58` 仍判 8，那么每次启动都 `version !== 8` 成立 → **每次启动 drop 全表重建**，持久索引等于不存在，且与 §2.1 的「跨进程复用」互相抵消。两处必须一起改。
3. 查询侧按**码点数**分流：`Array.from(query).length >= 3` 走 FTS5 `MATCH`；`< 3` 走 `LIKE '%' || ? || '%'`。

**`LIKE` 回退的已知代价（实测，不是推测）：**

- `highlight()` 在无 `MATCH` 的查询里**不抛错**，退化为返回无标记原文（实测 `SELECT highlight(d,0,'[',']') FROM d WHERE t LIKE '%压缩%'` 返回原文且无标记）。所以搜索不会崩。
- 但 `match_count` 是「数标记出现次数」（`lib/index.js:969-975`，`ORDER BY match_count DESC` 在 `:826`/`:832`/`:853`），回退路径下**恒为 0** → 相关性排序退化为纯时间序。
- `makeSnippet` 拿不到匹配位置 → 摘要片段无法定位关键词。

回退的收益实测：`LIKE` 在 4.78M 字符上跑一次 **27–30 ms**。两字查询是中文最常见形态，这个代价换「查得到」是划算的。

`trigram` 的存储代价：同一份 4.78M 字符语料，`unicode61` 9.1 MB vs `trigram` 21.1 MB（**2.30×**）；在全量语料上是 252 MB → 588 MB。

这一条**必须改宿主包**，与「只改本仓库」冲突，是 §5 的核心裁定项。

### 2.3 T-3（已改）：写压缩区间指针记忆，而不是加召回 source

原方案「把 `sessions/` 加进 `SOURCES`」经评审推翻——服务端没有 sessions 索引，加了也返回空（§1.3）。改为：

在每次压缩发生时，往 `viking://user/dsh/memories/` 写一条**指针记忆**，内容是「seq A–B 的原文在 `<archive 区间>`」，让语义召回能命中这条指针，再由 agent 用 `read` 取原文。

- 写入点：**`compaction/summary` 之后**（不是 `compaction/start`——后者载荷只有 `{compactionId, turn}`，拿不到区间；见 §6.1）。
- 区间来源：`compaction/summary` 的 `data.shadowedRange {start, end}`。
- 改动面：本仓库的 `packages/dsh-verbatim-compaction`（已存在，见 `docs/plans/2026-10-30-verbatim-history-compaction-backend.md`），不是 `dsh-openviking`。
- 两个前置已实测通过，算法见 §6.2：seq → `time` → archive 目录（归档记录的 `created_at` 与事件 `time` 精确到毫秒一致，且 archive 时间单调）。

**注意 `packages/dsh-openviking/shared/recall-core.mjs` 不能直接改**：该文件首行是 `// GENERATED FROM packages/dsh-openviking-shared/lib. DO NOT EDIT.`，真源在 `packages/dsh-openviking-shared/lib/recall-core.mjs`，且两个包都是 `volcengine/OpenViking` 的 fork（各有 `upstream.json`）。改它会被 `sync.mjs` 无警告覆盖，并破坏上游同步基线。

## 3. 验收判据

自动化（进 `pnpm test`，用提交的脱敏夹具）：

- `trigram` 对 ≥3 字查询与 `LIKE` 真值逐条相等；对 2 字查询返回 0 行且**不抛异常**。
- 查询分流：2 字走 `LIKE`，≥3 字走 `MATCH`；两条路径对同一语料的命中数都等于 `LIKE` 真值。
- `user_version` 耦合：把常量改成 9 后，**第二次**打开同一索引文件不得发生重建（用「重建计数器」或比对 `persisted_docs` 的行数/`rowid` 是否变化来判定）。
- 索引体积不随会话数超线性增长：取两个体量差 10 倍的夹具，索引体积比 ≤ 12。
- `LIKE` 回退路径下 `match_count` 为 0 是**已知行为**，测试断言这一点（防止后人误以为修好了）。

本地一次性验证（不进 CI，需本机真实数据）：

- 本机语料建索引后，`小说` / `压缩` / `上下文` / `搜索接口` / `滑块验证` / `番茄小说` 六个查询的命中数与 `LIKE` 真值一致。
- 首次建库耗时与索引体积实测值记录在案（当前基线：≈185 s / 840 MB）。

## 4. 不做什么

- 不改 `dsh-session-query-sqlite` 与 `dsh-session-query` 之外的宿主包。
- 不给 FTS5 写自定义中文分词器（需要 SQLite 扩展，宿主没有加载扩展的路径）。
- 不补 OpenViking 归档里的 reasoning（`archive_*` 本来就不存，补它要改 capture 的写入面）。
- 不改 `packages/dsh-openviking*/shared/*`（生成物 + upstream fork，见 2.3）。

## 5. 待用户裁定

**T-2 必须改宿主包，且 §2.1 的两个代价也只能由宿主包解决。** 三条路：

1. **改宿主包**（fork `dsh-session-query-sqlite`，或提上游 PR）：加 `busy_timeout`、把建库挪到后台、改 tokenizer 与 `user_version`。最干净，但要维护 fork，每次宿主升级重新同步。**工作量：中等**（单包、约 5 处改动，外加迁移测试）。
2. **本仓库写替代 backend**：实现 `SessionQueryEngine` 抽象类（`dsh-session-query/lib/types/index.d.ts` 的 `abstract searchSessions` / `searchEvents` / `observeSession` 等）。不动宿主，但要重新实现 cursor 编解码、live/persisted 双源合并、`readWindowMax` 窗口、并发串行化，且与现有 `session-query-sqlite` 行二选一（`provide('sessionQuery')` 重复注册会抛错）。**工作量：大**（是整个 service，不是两个方法）。
3. **只做 T-1 + T-3**：会话检索对中文仍几乎无用（§1.1 已证 unicode61 对纯中文恒 0），但 T-3 的指针记忆能让 agent 找回被压缩的原文。**这是唯一不碰宿主包的完整路径**，代价是放弃中文全文检索。

**这一条不定，T-2 不动手。**

## 6. T-3 的两个前置：已实测

原先列为未验证的两条前提，现已测完，结论是**可行但必须用时间戳做桥**。

### 6.1 seq 范围从哪来：`compaction/summary`，不是 `compaction/start`

`compaction/start` 的载荷只有 `{compactionId, turn}`，**没有区间**：

```json
{"type":"compaction/start","data":{"compactionId":"c86a6406-…","turn":3}}
```

区间在 `compaction/summary` 里：

```json
{"type":"compaction/summary","data":{
  "compactionId":"c86a6406-…",
  "shadowedRange":{"start":9,"end":934},
  "shadowedSeqs":[9,10,…],
  "shadowedTokenCount":…, "provider":…, "model":…}}
```

所以 T-3 的写入点必须是 `compaction/summary`（`compaction/start` 太早，拿不到区间）。原方案写「写入点：`compaction/start`」是错的。

### 6.2 seq 区间 → archive 的映射：靠 `created_at` 时间戳

归档记录**没有 seq 字段**，只有 `created_at`：

```json
{"id":"msg_31a10a8620da492a9706cebf8efcce8c","role":"assistant","parts":[…],
 "created_at":"2026-10-20T11:44:46.123Z","peer_id":"…"}
```

但 DSH 日志里每个事件都有 `time`（毫秒），归档记录的 `created_at` 与它**精确到毫秒一致**。实测闭环（会话 `2d0811a6`，第一次压缩的阴影区间 seq 9–934）：

| 验证 | 结果 |
|---|---|
| 区间起点 seq 9 的时间 | `2026-10-20T19:23:11.118+08:00` |
| `archive_001` 首条 `created_at` | `2026-10-20T11:23:11.118Z` = 同一时刻 |
| 区间内 seq 700 的助手正文（`A1、A2、A3、B1、B2、C1、C2`） | `grep` 在 `archive_001` 第 90 行命中，`created_at` 同为 `11:44:46.123Z` |

archive 的时间单调递增（`archive_001` 11:23Z → `archive_013` 次日 05:52Z → `archive_025` 12:45Z），因此「取 `shadowedRange.start` 的时间 → 二分 archive 目录 → 在该 archive 内按 `created_at` 过滤」是可行的定位算法。

**代价与限制（必须写进实现）：**

- 归档由 OpenViking 自己的批量策略切分，**与压缩边界无关**，所以区间与 archive 不是一一对应。实测 33 次压缩的 archive 跨度：`(1,1)` 17 次、`(3,3)` 8 次、`(13,13)` 5 次，**只有 3 次跨多个 archive**（`(1,2)`、`(2,3)`、`(3,13)` 各一次）。所以指针要按「起止两个 archive」表达，不能假定单文件。
- 归档记录是消息级的（`role` + `parts`），DSH 事件是事件级的（含 `tool/result`、`compaction/prune` 等）。归档里 `tool/result` 被折进 `parts[].type == "tool"`，所以**不是逐事件可还原**——指针能找到「那段时间说过什么」，不能保证还原每个事件。
- 归档目录名是 `dsh-session-<uuid>`，DSH 会话目录名是 `session-<uuid>`，两者只差前缀，可稳定对应。

### 6.3 因此 T-3 的形态

指针记忆的内容固定为三样：`sessionId`、`shadowedRange {start, end}`、以及由两端时间推出的 archive 区间（多数情况是同一个 archive）。写入点是 `compaction/summary` 之后。

## 7. 未验证项

- `/api/v1/search/find` 对 `target_uri` 的桶名约定（`result.<bucket>` 数组）。当前 OpenViking 未在 `127.0.0.1:1933` 监听，只能经 MCP 工具间接观察。
- `trigram` 对日文/韩文的召回行为未测，只测了中文与拉丁。
- 指针记忆写进 memories 后，**语义召回能否命中它**（而不是只被 `grep` 找到）未验证——这依赖 OpenViking 对 memories 的索引，与 §1.3 的 sessions 索引问题不同源。

已排除（读源码或实测确认，原先列为未验证）：

- **`openAt: first-search` 的单进程并发建库**：不存在竞争。`searchSessions` / `searchEvents` 都在 `_serialized(signal, …)` 里调 `_ensureReady`（`:541-542`、`:562-563`），`_serialized` 用 `this._tail` 链串行化（`:621-640`）。**但跨进程仍会撞锁，见 2.1。**
- **`path: ':memory:'` 的来源**：来自 `dsh-web-app/cordis.patch.yml:28-31`，profile patch 在其之后应用，覆盖会生效。

## 8. 评审记录

盲审对象为本文件的前一版（sha256 `1ad3c11029fcf1c438bbc3a5e89725a287073e401cccb645f743e44277042979`，143 行）。第一席 Root 自审 12 条，第二席独立盲审 8 条，合并后 3 条共指、9 条 Root 独有、5 条子代理独有，1 轮辩论。

**采纳（17 条）**：`user_version` 判断与赋值必须同改（R1）；`LIKE` 回退下 `match_count` 归零、snippet 失定位（R2 + D1 后半）；`unicode61` 列混淆成因需重列（R4）；缺迁移验收判据（R5）；替代 backend 工作量被低估（R6）；§1.3 的 grep 证据与「无法区分」自相矛盾（R7）；缺「只做 T-1 有无净收益」的判断（R8）；sessions 源的噪声控制缺失（R9）；§4/§2.1/§5 对「改不改宿主包」措辞不一致（R10 + D8）；2.5× 体积判据是自证式（R12 + D7 前半）；`recall-core.mjs` 是生成物且属 upstream fork（D3）；sessions 无服务端索引、加 source 无效（D4）；跨进程 `database is locked`（D5）；首次建库代价（D6）；验收判据无法在本仓库 CI 闭环（D7 后半）。

**让步（2 条）**：D1 前半「`highlight()` 在 `LIKE` 下抛 `SQLITE_ERROR`」——实测不抛错，退化为无标记原文；D2「trigram 对 <3 字符查询抛异常」——实测静默返回 0 行，撤回。

**Root 自我撤回（1 条）**：R3 初判「trigram 下 `highlight()` 重叠标记导致 `match_count` 高估」。实测用 `<<`/`>>` 作标记时确实看到一条文档标出 21 处，但那是**标记串与文档里的 JS 位运算 `<<`/`>>` 撞车**造成的假象；换不撞车的分隔符后 `上下文` 25/25、`搜索接口` 14/14、`滑块验证` 3/3、`番茄小说` 297/297 四条全部相等。FTS5 会把相邻重叠的 trigram 合并成一个标记，不高估。

**评审后补测（2 条，把原 §6 的未验证项结清）**：`compaction/start` 载荷不含区间、区间在 `compaction/summary`（推翻原 2.3 的写入点）；seq → archive 可经 `created_at` 时间戳映射，已用 seq 700 的原文在 `archive_001` 第 90 行命中并毫秒对齐验证（§6）。

**判为已知边界（1 条）**：R11 `trigram` 不支持前缀查询。`unicode61` 下 `MATCH '"番茄"*'` 命中 599（`LIKE` 真值 646，仍漏 47）；`trigram` 下 `"番茄"*` 命中 0、`"番茄小说"*` 命中 153。现有 `quoteFtsData` 本就不产生 `*`，不影响当前功能。

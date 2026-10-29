---
name: dsh-session-payload
description: 改会话列表或历史的请求参数与响应字段、压缩首屏体积、给长会话做减负，或遇到「一直载入历史」「加载更早点了没反应」「远程打不开会话」时加载。
---

# 会话数据流与负载裁剪

会话数据同时供多个视图消费，删一个字段的代价往往不在它占的字节数上。改请求与改响应是两件不同的事，先读这里再动手。

- **优先改请求参数，而不是收下大响应再裁**：`session/page` 这类端点把预算作为参数接收
  （`maxMessages` / `turnWindow`），改小后重发让服务端只生成小页，请求与响应同时变小、
  宿主也少做功。改响应只能省带宽，宿主已经付过计算的代价。
  改请求体时**认不出的形状必须原样转发**（解析失败、缺 `payload.args.request`、
  字段类型不对、重编码抛错）：吞掉一个翻页请求会让用户完全无法回看历史，
  代价远大于一次大页。实测数据与预算曲线见
  `docs/research/2026-10-21-session-payload-reduction.md`。

- **首屏预算在出站帧里，`maxMessages` 却可能是死参数**（2026-10-25 修正了此前
  「首屏插件改不到」的错误结论）：首屏走 `session/follow` 流，页大小随 `open` 帧发出
  （`payload.args.request.maxMessages` / `.turnWindow`），包一层 `WebSocket.prototype.send`
  就能改。但 `paginate` 从最新往回扫，遇到 `turn/start` 时先判
  `count >= minMessages && turns >= minTurns` 才允许截断，遇到 message 才用
  `count >= maxMessages` 兜底 —— **当最近某个 Turn 的 message 数小于 `minMessages` 时，
  那个 Turn 边界永远不算数**，扫描会耗尽历史、`maxMessages` 一次都不触发。
  实测：一个 Turn 为 `[91, 11, 1]` 条 message 的会话，`120/50` 与 `500/50` 都是 6313 KB
  （完全没变），把 `minMessages` 降到 12 才变成 566 KB，拐点在 15→12 之间。
  所以「压了 `maxMessages` 却没变小」时，先数各 Turn 的 message 条数，别怀疑改写没生效。
  `assistantStream` 不能用来减负：宿主声明为必需 `const true`，传 `false` 直接被拒。

- **长会话「远程打不开」要在限速下才复现，判据是首帧是否到达**：局域网 6 MB 一两秒就传完，
  一切正常；慢链路（Tailscale/外网）上它决定会话能不能打开。症状链是
  「一直载入历史…→ socket 断开 →『重新连接中』→ 重连后列表未加载全显示『未命名』→
  恢复标题 → 再次打开 → 再次超时」的循环。用 CDP
  `Network.emulateNetworkConditions`（2 Mbit/s / 80 ms）复现，看**首帧有没有到达、
  socket 何时被关**：未修复时首帧 `null`、约 16 s 被以 1006 关闭。
  别用「首帧多大」当判据，也别在局域网下反复测 —— 测不出来。

- **裁响应字段前，先把该字段的每个读取点都找全，并确认「删掉」比「置空」安全**：
  删字段是**破坏性**的，只要有一个读取点没判空，整条数据流就会断。实测 2026-10-25：
  把 `assistant/message` 的 `data.stream` 删掉后，所有长会话变成空白屏、「加载更早」也
  点了没反应，控制台只有一句
  `[session-controller] event feed subscriber failed: TypeError: stream is not iterable`。
  成因是 `assistantStreamFirstTokenTime`（`dsh-client-ui-trajectory`）直接
  `for (const record of stream)`，**没有任何判空**；而 chat 侧那两处读取都有
  `?? state.sample` / `event.data.usage ??` 短路保护 —— 只查 chat 会得出「安全」的错误结论。
  判据：`grep -rn "data\.<字段>" --include=client.js` 把**所有** bundle 的读取点列出来
  （当时 4 处：chat 2、trajectory 1、experimental-session-inspector 1），逐个看有没有守卫。
  **更稳的默认做法是置空而不是删除**：`data.stream = []` 让所有读取方都安全
  （`for...of []` 零次迭代、`lastAssistantStreamChunk` 返回 `undefined`），体积收益不变
  （该字段占首屏 1685 KB）。同帧里 `assistant/attempt` 的 `stream` 只有 6 KB，不必动它。

- **判断「某字段是否可裁」不能只按体积，要按「渲染路径是否真的走不到」**：
  同一个字段，一个视图读、另一个视图不读。若该视图被主题隐藏（如本仓库隐藏了轨迹面板），
  裁掉看似安全，但**订阅者异常是全局面**：它不属于某个视图，一旦抛出就中断整个事件流，
  被隐藏的视图反而成了整屏空白的根因。

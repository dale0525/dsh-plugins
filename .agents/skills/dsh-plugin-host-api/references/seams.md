# 宿主半边接缝：逐条雷区

只在真的动宿主半边（路由、事件、`inject`、启动期路径、EventEmitter、设置 UI）时读。

- **插件自己的 `/api/...` 路由会绕过宿主信任围栏，别再自造访问控制**：宿主
  `dsh-host-webserver` 匹配路由时**先查 exact 表、再查 prefix 表**，而信任围栏
  `connection`（`@deepseek-ai/dsh-client-connection`）注册的是 `/api` **prefix** 路由。
  于是插件注册的 exact `/api/dsh-*/...` 排在围栏**之前**，围栏根本没机会执行。
  实测：四个插件各自手写「只允许 loopback」检查（认来源 IP 与 `Host` 是 localhost），
  不认识 profile 里 `connection` 声明的 `trustedHosts` 局域网地址，把合法局域网浏览器
  全部拒掉 —— 症状是局域网打开 DSH 时这些插件报「读取失败」，而 `127.0.0.1` 一切正常。
  修法：删掉自造检查，**每次请求**向 `connection.requestRejection(req)` 要结论
  （`undefined` 放行 / `401` / `403`；服务缺失时一律 `403` 拒绝）。
  两个必须遵守的点：① `connection` **按请求现取**，不要写进 `inject` —— 写进去会让
  「宿主没装该服务」从「少一个功能」升级成**整个插件静默消失**；② 浏览器半边不要
  用 `connection.isLoopback` 自行判断要不要发请求，它只认 `localhost` / `[::1]` / `127/8`，
  同样会拒掉围栏已放行的局域网页面（被拒时让请求失败并降级为 `unavailable` 即可）。

- **监听 waterfall 事件前先确认「有没有 peer 不调用 `next()`」，有就必须 `prepend: true`**：
  cordis 的 waterfall 里，监听器不调用 `next()` 就等于**截断**链条，注册在它后面的监听器
  **一次都不会执行**（不是拿到旧值，是完全不跑）。这类「决定者」在宿主里是常态：
  `fs-observation-policy` 的 `fs/write-intent` / `fs/edit-intent` 监听器
  （`(target, actor) => Promise.resolve().then(() => gate.writeIntent(target, actor))`）决定完直接返回，
  而插件行的加载顺序**不由你控制**（按 profile patch 的行序）。于是「逻辑写得对、测试也绿、
  真实部署里永不触发」——测试替身里没有那个 peer，所以永远复现不出来。
  `dsh-workspace-changes` 监听同一对事件时正是为此加的 `{ prepend: true }`。
  判据：注册时读一遍该事件的每个已知监听方，任一不调 `next()` 就 prepend；并补一条断言
  `listener.options?.prepend === true` 的测试，否则这条线没人守。

- **`inject` 是「必需」，只监听事件就不要 inject 那个服务**：`inject` 里的服务缺失时
  cordis **不调用该插件的 `apply`**，整个插件静默失效（实测：`inject: ['svc']` 且 svc 未提供
  → `apply` 从不执行；去掉 `inject` 即正常）。所以给插件加一条
  `ctx.on('some/event', ...)` 监听**不需要**把该事件的宿主服务写进 `inject` ——
  写进去只会让「宿主没装那个服务」从「少一个功能」升级成「插件整体消失」。
  宿主自己的监听方也这么写（`dsh-agent-preset-registry`、`dsh-session-reference` 都监听
  `system-prompt/assemble` 而不 inject `systemPrompt`）。

- **在 `system-prompt/assemble` 里查工具注册表，作用域必须取 `context.scope`，不能取装配条目自己的字段**：
  装配条目是**脱壳**的 `{name, description, parameters, deferLoading}`（`dsh-tools` 的 `schemaOf`），
  没有 `agent` 字段。写成 `ctx.tools.get(tool.name, tool.agent)` 就等于 `get(name, undefined)`，
  查的是**全局视图**；而 preset 组合把派单工具注册在**各 agent 自己的层**里（`dsh-tool-subagent`
  的 `installScoped` → `candidate.ctx.inject([...])`），全局视图一个都看不到，于是判定恒为 false、
  整个监听器静默空转——逻辑对、单测绿、真实部署零效果。
  实测 2026-10-29 `dsh-force-rules` 0.4.1：本应给派单工具描述追加 534+466 字符的要求，
  实际请求头里 `subagent` 停在宿主的 948 字符、零追加，派单模型从未看见「必须写授权标记」，
  于是一个审查席位漏写标记被静默降为只读、连 `git rev-parse HEAD` 都被拒。
  判据：`context.scope` 是宿主 `assembleContextFor(agent)` 传进来的 `{agent, scope: agent}` 那一份，
  waterfall 原样透传；`ctx.tools.get(name, scope)` 才走 `chainLayers(scope)`。
  测试替身必须能区分这两种查法（无 scope 时返回 `undefined`），否则这条线没有测试能守住。

- **HTTP 路由处理器里读服务必须用 `ctx.get(name)`，不能用 `ctx.<name>`**：cordis 的 context 是
  Proxy，属性读只对**声明在 inject 里的服务**成立，否则抛 `cannot get property "<name>" without
  inject`。而路由处理器由宿主 HTTP 服务器在**另一个 fiber** 里调用，不是 `apply` 里 `ctx.inject`
  那个 fiber，于是同一个 `ctx` 在事件监听里能用、在路由里抛错。
  症状：`dsh-host-webserver` 把逃出的处理器异常兜成**空 body 的 400**（`lib/index.js:403`），
  前端只看 `response.ok`，于是任何非 2xx 都显示成「读取失败」——看不出是抛错。
  实测 2026-10-19 `dsh-worktree-session` 0.1.4：状态路由只在请求带 `sessionId` 时读
  `ctx.sessions`，所以不带参数的探测返回 200，界面永远失败。
  **测试替身必须与真实 context 一样严格**：该包的 `makeCtx` 曾直接在 stub 上挂
  `sessions: { get }` 属性，路由在测试里永远读得到会话，52 个用例全绿而浏览器必挂。
  stub 不应提供任何「真实 context 上拿不到」的属性。

- **MCP 服务端自己会说 streamable HTTP 时，不要给它套 stdio 代理**：`dsh-mcp-client` 的
  `stdio` 分支每个挂载点起一个 Node 子进程，而插件通常按 root agent 挂载 —— 进程数与
  会话数成正比，与真正不同的 peer 数无关。实测 `dsh-openviking` 按 25 个活跃 agent 挂载，
  得到 **26 个 `mcp-proxy` 进程 / 705 MB `phys_footprint`**，只为 5 个不同 peer 服务；
  单个空闲代理约 17 MB footprint，而它 10 小时只花 0.6–2.5 s CPU —— **成本全在内存**。
  改法是把 `transport` 换成 `streamable-http` 并直连 `<endpoint>/mcp`，进程归零。
  换传输时**协议头要留给 transport**（`content-type` / `accept` / `mcp-protocol-version` /
  `mcp-session-id` 由它按交换过程推导），只补它不拥有的认证、身份、actor peer 与 UA。
  这些头**必须复用运行时那条 header builder**（`buildOvHeaders`），否则工具面与 recall 路径
  会在 actor peer 上漂移，表现为工具查到别的项目、recall 查到本项目的割裂。
  另外，若代码里存在「直连不行」的既有注释，先实测再采信：本项目 README 曾记录
  「服务端返回空闲 SSE 会让 `tools/list` 永不返回」，而 SDK 2.2.0 上该机制已不成立
  （90 秒 23 轮 `tools/list` + `callTool` 零失败，独立 `GET /mcp` 仍挂 8 秒，但 SDK 只在
  `initialized` 得到 202 时才去开那条流）。

- **插件里漏掉的 `'error'` 监听会杀死整个宿主进程，不是一个功能坏掉**：`EventEmitter` 对
  `error` 事件没有监听者时直接抛出，而宿主把它兜成 `dsh: fatal uncaught exception` 后退出。
  于是「连不上某台机器」这种日常失败会变成用户要重启 DSH。**`once('error')` 是最危险的写法**：
  一次失败可能连发多个 `error`（实测 `ssh2` 对一条被对端 `destroy` 的连接发两个，第二个是
  `Connection lost before handshake`），第一个被 `once` 消费掉，第二个无人接管即崩。
  一律用常驻的 `on('error')`，并在回调里自己保证幂等。判据：连一个「接受后立刻 `socket.destroy()`」
  的本地 `net` 服务器，装 `process.on('uncaughtException')` 收集器，断言它为空——这条测试在改回
  `once` 后必须转红，否则它没在守这条线。

- **设置 UI 保存会重写整个 `<profile>/cordis.patch.yml` 行，把该行里的注释全部丢掉**：
  官方设置表单按行重新序列化 config，不是就地改一个值。实测 2026-10-18（pi-ai 的
  `maxRequestImageBytes` 经插件卡片保存一次）：全文注释 134 → 127 行，缺的正是 `llm-pi-ai`
  行内那段理由注释；其他行的注释块原样保留，被改的键还从 profile 中部挪到了 profile 块末尾。
  所以**理由不要写在可被设置 UI 编辑的行里**——那里只放值，因果写进代码注释、README 或记忆；
  写进 patch 行的注释是一次性消耗品。

# 核验证据：怎么证明「这次改动真的生效了」

只在改完代码要确认生效、或怀疑「改了没反应」时读。

> **核对「宿主下发的 client bundle 是否已是新构建」，URL 里的 `??` 不能省，省了恒 404**：
> 页面 HTML 里该插件自带一条预载条目 `/plugins/??<pkg>/client.js&rev=<rev>`（`??` 是批次分隔符；
> 另有几条把整批包名逗号相连的条目，取单包那条即可，它带自己的 `rev`）。把这条 URL 原样
> `curl` 下来 `grep` 新逻辑的字符串才是证据，`rev` 变化即产物已重新发布；把 `??` 去掉变成
> `/plugins/<pkg>/client.js` 一律 404，别据此判定「没生效」。实测 2026-10-24：
> 去 `??` 404，带 `??` 200 / 38284 B 且含新代码。

> **重启后核对「新代码是否真的进了提示词」，要读会话日志里最后一条 `request/header`。**
> 同一会话里每条请求都留一份，第一条是**重启前**的旧快照。实测按第一条判定，得出「改动没生效」
> 的错误结论，实际最新那条已是新工具清单（133 工具/220,287 字符 → 77 工具/106,064 字符）。
> 工具清单在 **`data.header.tools`**，不在 `data.tools` 也不在 `data.request.tools` ——
> 按后两个路径取会得到 0 条，看起来像「插件没挂上」，实际是路径写错。判据是
> `data.header.tools[0]` 的键为 `name,description,parameters`。

> **该命令靠 `lsof` 找端口 owner，而 `lsof` 在 `/usr/sbin`**：调用方 PATH 缺 `/usr/sbin` 时
> `port_pid` 取空，输出 `owner pid none` 与 `==NOT LISTENING==`——**服务其实是好的**。
> 实测同一进程同一秒：PATH 无 `/usr/sbin` 判 NOT LISTENING，补上即 `Verdict: OK`。
> 见到 NOT LISTENING 先用 `lsof -nP -iTCP:10000 -sTCP:LISTEN`（绝对路径）复核，别直接重启。

> **同一端口上可能有两个监听者，`lsof -t | head -1` 会抓错**：宿主 0.2.1 起拒绝通配地址
> （`host "0.0.0.0" is an unspecified (wildcard) address`），一个监听无法同时覆盖回环与局域网，
> 于是回环靠一个独立的转发进程补齐。此时 `lsof` 返回两行，谁先返回不确定；`port_pid` 若只取
> 第一行，就会把转发进程当成端口 owner，输出 `==SPLIT== job pid != port owner` 并提示重启 ——
> **重启修不好，因为作业本身是好的**。修法是让 `port_pid` 优先在 `lsof` 结果里找作业自己的 pid，
> 找不到才退回第一行。判据：`lsof` 有两行、但其中一行等于 `launchctl print` 里的作业 pid 时，
> 服务健康。

> **监听地址是推导出来的，三处共用同一套规则，别写回字面量**：`~/.dsh/bin/local-address.mjs`
> 问默认路由走哪张网卡、取该网卡非内部 IPv4、问不到再枚举、兜底 `127.0.0.1`；`dsh-web` 用它定
> `HOST`（`DSH_WEB_HOST` 仍可覆盖），loopback 转发器接受字面量 `auto` 走同一函数（launchd 的
> plist 不能做命令替换）。profile 里 `webserver.host` 那行**故意不 import 它**——那行要随
> config-manager 同步到别的设备，而那些设备没有 `~/.dsh/bin`，所以那边留了一份等价的 `!!js`
> 内联副本。看到「两处重复的推导逻辑」不要合并，那是同步边界，不是冗余。

> **`~/.dsh/dsh-web.err` 是跨启动追加的，禁用行必须对得上进程启动时间才算数**：兼容门禁打的是
> `disabling profile plugin row "<row>": Plugin <pkg>@<ver> is incompatible with dsh <ver>`，里面的
> `<ver>` 是**当时**装的版本。升级插件后旧行仍在文件里，直接 `grep` 会得出「还在被禁用」的错误
> 结论（实测：8 条禁用行全部指向 `dsh-openviking@0.4.8` / `dsh-loop-guard@1.1.7` /
> `dsh-reasoning-strip@0.1.0`，而当次启动装的是 0.4.9 / 1.1.8 / 0.1.1，该次启动后 0 条）。
> 判据：先用 `ps -o lstart= -p <作业 pid>` 定出本次启动的时刻，只认那之后的行；再直接问宿主
> `evaluatePluginCompatibility(manifest, {}, <当前宿主版本>)`（`@deepseek-ai/dsh-app-boot` 导出），
> 它才是门禁本身。

> **新增启动期自动执行路径时，必须把路由层同名操作的全部护栏抄一遍**：路由层的 destructive 操作
> 走 `withMutationGate(op, …)` 统一封装（全局互斥锁 + SAFE MODE 谓词 + journal + snapshot 绑定），
> 而启动期路径是另写的一段代码，**不继承**这些封装。实测 2026-10-24 `dsh-config-manager` 的
> 启动期自动同步：初版直接 `makeSyncEngine(cfg).pullAndApply({})`，不取锁、不查
> `host.safeModeIsBlocked`、不传 `snapshotBinding` —— 于是「上次 destructive 操作崩溃残留、
> 待显式恢复」时它仍会改写配置与插件，**把可恢复状态变成不可恢复**；同时与另一个持锁进程
> 并发写同一批文件。判据：新路径落盘前，先列出同名路由的 handler 里调用了哪些封装，
> 逐条确认启动路径也有等价调用。

> **`apply` 返回 Promise 是让宿主「等它」的唯一办法，fire-and-forget 不会被执行完**：
> Cordis 的 `_execute` 对 apply 返回的 thenable 会 `return effect.then(safeCollect)`，
> 由 `loader.await()`（等每个 entry 的 fiber inertia）等到结束；`boot()` 的顺序是
> `mountRootInclude` → `loader.await()` → `auditStartupEntries`，所以启动期写入的配置
> 在启动判定之前就已就位。实测对照：返回 Promise 得到
> `apply-called → async-work-done → inertia-settled`；改成不 await 的版本得到
> `apply-called → inertia-settled → async-work-done-BUT-NOT-AWAITED`。
> 写盘触发的 HMR 重载不会打断启动：`runReload` 先 `await applicationReady`，该 promise
> 在 `boot()` 返回之后才 commit。

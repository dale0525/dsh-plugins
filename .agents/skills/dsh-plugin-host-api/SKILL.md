---
name: dsh-plugin-host-api
description: 在宿主半边注册 HTTP 路由或事件监听、用 `ctx` 取服务、往 `inject` 里加服务、给 EventEmitter 挂 `error` 回调、或新增启动期自动执行路径时加载。
---

# 宿主半边的接缝与陷阱

插件在宿主里不是独立进程：`inject`、context Proxy、路由匹配顺序、事件链、EventEmitter 的 `error` 语义都会让「逻辑正确」的代码静默失效或拖垮整个宿主。

## 七条硬门禁（违反即静默失效或宿主崩溃）

- **别自造访问控制**：插件自己注册的 `/api/...` exact 路由排在宿主信任围栏之前，围栏根本没机会执行。删掉自写检查，**每次请求**向 `connection.requestRejection(req)` 要结论；`connection` 按请求现取，**不要**写进 `inject`。
- **`inject` 是「必需」**：只监听事件就不要 inject 那个服务——inject 里的服务缺失时 cordis 不调用 `apply`，整个插件静默消失。
- **路由处理器里读服务用 `ctx.get(name)`**，不能用 `ctx.<name>`：路由在另一个 fiber 里跑，属性读会抛 `cannot get property ... without inject`，而宿主把它兜成空 body 的 400。
- **监听 waterfall 前先确认有没有 peer 不调 `next()`**：有就必须 `prepend: true`，否则你的监听器一次都不执行。
- **EventEmitter 的 `error` 一律用常驻 `on('error')`**，绝不用 `once`：一次失败可能连发多个 `error`，第二个无人接管即杀死整个宿主进程。
- **新增启动期自动执行路径时，把路由层同名操作的全部护栏抄一遍**：启动期路径不继承 `withMutationGate` 那套封装。
- **`system-prompt/assemble` 里查工具注册表要用 `context.scope`**：装配条目是脱壳的 `{name, description, parameters}`，没有 `agent` 字段，按它查等于查全局视图；preset 把工具注册在 agent 自己的层里，全局视图看不到，判定恒 false、监听器静默空转。

## 另外两条

- **MCP 服务端自己会说 streamable HTTP 时，不要给它套 stdio 代理**：进程数与会话数成正比，成本全在内存。
- **理由不要写在可被设置 UI 编辑的 patch 行里**：官方设置表单按行重新序列化 config，会把该行注释全部丢掉。

## 按需细则

每条的实测数据、症状链、判据与修法（含 `dsh-worktree-session` 的 400 空 body、`jsdom` 的 CJS 解析崩溃、`inject` 的静默消失、waterfall 截断、装配作用域查不到工具）见 `references/seams.md`——只在真的要动其中某处时读。

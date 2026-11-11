# dsh-tool-surface

把每轮随请求发送的工具定义收到一份实测白名单，并把被撤下工具的参数写进系统提示词。

## 它解决的问题

宿主在每一步都会把所有 provider 的工具 schema 拼成一份 `assembly.tools` 交给模型看。这份清单随**每一次**请求完整发送，跟这一轮用不用得上无关。

本机实测（2026-11-11，659 个会话的 `tool/call` 记录）：这份清单是 **81,473 字符**，占一次请求上下文约 **15.6%**；其中 18 只工具在这 659 个会话里**一次都没被调用**，占 20,183 字符（24.8%）。

## 机制：撤下公告 ≠ 取消能力

这是本插件的全部依据，无关的两件事必须分清：

1. **注册表**（`ctx.tools`）决定**能不能执行**。`tools.view(scope)` 只从注册层（`layers.chainLayers` + own + global）计算可见集，**从不读 assembly**。
2. **公告**（`assembly.tools`）决定**模型看见什么**。

所以从 `assembly.tools` 里删掉一只工具，只是让模型看不到它的参数表，按名调用照样成功。实测证据：659 个会话里有 63 次调用打给了已被撤下公告的工具，**57 次成功**，6 次失败全是上游工具自己的报错（`404`、参数不合法之类），没有一次是「工具不存在」。

## 代价与边界

1. **模型失去参数表**。所以每只被撤下的工具都要在这一节里写明参数——这是「工具只知名字就等于不可用」的对策，也是 `guidance` 配置存在的理由。
2. **缓存**。工具定义在缓存前缀里，撤下一次省一次；但**会话中途改动 `keep` 会让缓存整段失效**，代价是全部历史重算（本会话实测单次 53,400～140,716 未缓存 token）。因此本插件把 `keep` 当常量用：默认值写在源码里，改它等于换配置、等于新一轮缓存。
3. **结构复杂的工具不能只给一行**。`create_design_system` 的 `DesignSystem` 是三层 `$defs`、带 68 个字体枚举，一行说明写不下，写「读插件 README」比编一句错的强。

## 配置

```yaml
- id: tool-surface
  name: '@logictan/dsh-tool-surface'
  config:
    keep: [bash, read, grep]      # 可选；缺省见下
    guidance: ''                  # 可选；空串 = 只过滤不注入提示词段
```

`keep` 缺省是本机调用次数前 24 名（按次数降序）：

`bash` `read` `write` `edit` `glob` `grep` `web_fetch` `web_search` `read_image` `todo_write` `ask_user_question` `send_message` `present` `subagent` `list_agents` `job_output` `job_list` `job_kill` `skill` `ssh_exec` `get_goal` `update_goal` `mcp__openviking__read` `mcp__openviking__find`

按本机 659 个会话统计，这 24 只占 63,718 次调用里的 63,500（99.7%）；工具定义由 81,473 字符降到约 **20,800 字符（−74%）**。

`guidance` 缺省见 `guidance.mjs` 的 `GUIDANCE_GROUPS`，按插件分 11 组。它**按当前 `keep` 渲染**：某组工具如果都在 `keep` 里，那一组就不出现——避免模型读到一份它已经完整拥有的 schema 的转述。

## 实现要点

1. **监听 `system-prompt/assemble`，在 `await next()` 之后过滤**。waterfall 的下游先跑完，因此拿到的是所有其他 provider 过滤后的最终清单，**插入顺序无关**。
2. **过滤后无变化时返回原数组引用**。assembly 每步重建，返回新数组会让请求头与缓存前缀不一致，正好花掉它要省的缓存。
3. **section 必须 `interpolate: false`**。宿主把 section 里每个 `{{…}}` 当提示词变量解析，解析失败即抛 `malformed prompt variable reference`，整个插件在组装阶段挂掉——2026-11-11 已因此崩过一次。
4. **`systemPrompt` 用 `ctx.get` 而不是 `inject`**。`inject` 把服务当必需，缺了就跳过整个插件，那会变成「没有系统提示 = 完全不过滤」，与预期相反。

## 测试

```bash
node --test
```

18 条：白名单内容与顺序、白名单内不删、白名单外删、无变化返回同引用、非数组透传、无名定义保留、每组至少点名一只、全组都被公告时该组消失、部分保留时只写被撤下的那只，以及集成级的 hook 行为（含 `interpolate: false`、缺 `systemPrompt` 仍过滤、空 `guidance` 不注入）。

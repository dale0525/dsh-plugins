# @logictan/dsh-goal-resume

让被重启打断的 goal 在 DSH 启动后自动接着跑。

## 它解决什么

DSH 的 goal 有两层状态，一层能扛过重启，另一层不能：

| 层 | 取值 | 存在哪 | 重启后 |
| --- | --- | --- | --- |
| `phase`（持久） | `active` / `paused` / `blocked` / `complete` | 会话日志 | 保留 |
| `activation`（进程内） | `armed` / `disarmed` | 内存 | **归零为 `disarmed`** |

只有 `armed` 的 active goal 会让 round driver 自动排下一轮。而 `armed` 只有两个写入方——
`create` 与 `resume`，其中 `resume` 只由人的直接动作触发（模型调 `create_goal` /
`update_goal`、Goal 页面的按钮、`/goal resume`）。宿主自己**不会**在加载会话时重新 arm。

后果：重启前正在自动推进的 goal，重启后 durable 状态仍是 `active`，但已经不再推进，也没有
任何东西会把它重新启动——除非人记得逐个回去点 resume。

本插件从宿主侧补上这一步：**启动一小段延迟后，把重启前处于 active 的 goal 重新 arm。**

## 判定

一次启动只跑一遍，延迟 30 秒。这个延迟本身就是安全边界：会话语料、投影缓存、工作区
注册表届时都已完成各自的启动。

**人在此期间打开的会话不会被跳过，这正是本插件的主要目标。** 重新打开会话只把对话内容
载回来，`activation` 依然是 `disarmed`；而重启后的目标会话**必然**是活的（界面会自动恢复
上次开着的会话），所以「活着就跳过」会跳过每一个真实目标。给它重新上弦也不会打断人的
工作：round driver 只在 agent 空闲、且没有别的东西排队时才排下一轮。

一个 goal 会被恢复，当且仅当：

| 条件 | 结果 |
| --- | --- |
| `phase` 为 `active` | 恢复 |
| `phase` 为 `paused` / `blocked` / `complete` | 不动 |
| `roundsStarted` 已达 `maxGoalRounds` | 不动（预算耗尽，宿主会拒绝） |
| 已 `armed` | 不动（本来就在跑） |
| 会话已被归档 | 不动 |
| 会话是子代理（`origin: subagent`） | 不动（goal 只属于顶层 agent） |
| 会话已经是 live 的 | **照常恢复**（重启后它就是活的，跳过等于什么都不做） |
| 一个 goal 同时出现在父会话与它的 fork 里 | 只恢复一个（避免两条 round 循环） |

## 它不做什么

- 不恢复 paused、blocked、complete 的 goal，也不延长耗尽的 round 预算。
- 不覆盖人的手动暂停：人的「停」走的是 `pause` / `block` / `complete`，都会改 `phase`，
  上表第二行就会把它挡掉。`activation` 只有 round driver 自己会写 `disarmed`。
- 不做周期性轮询：只有启动后的那一次。

## 安装

```bash
dsh plugin --profile <profile> add @logictan/dsh-goal-resume
```

本包自带 `dsh.bundle.patch`，安装即挂载，无需改 profile 的 patch。它没有配置项，
Plugins 页不会出现表单。

## 开发

```bash
npm test        # node --test
npm run build   # src/ -> lib/
```

## 注意

恢复会以**当前默认模型**重新下发请求（不是该会话原本使用的模型），因此会产生无人盯着的
token 消耗。

跳过或恢复都会写一行日志（`goal-resume: ...`），说明每个会话为什么被恢复、或者为什么没被
恢复。

**但要注意：当前宿主上这些行默认看不见。** `ctx.logger` 在本宿主只注册了两个出口，一个把
消息塞进内存里最近 1000 条的环形缓冲（进程退出即丢），另一个只收集 `warn` / `error` 用于
组装启动失败报告。**没有任何出口把 `ctx.logger` 写进 `~/.dsh/dsh-web.log`** —— 那个文件里的
行全部来自 `config-manager` 自己另建的日志通道。所以排查时不要用「日志里没有 goal-resume」
推断「插件没跑」，那不构成证据。

**要看它到底有没有生效，去读目标会话自己的日志**，而不是进程日志。重新上弦会在那里留下
一条 `goal/change` 事件，其 `operation` 为 `resume`：

```bash
zstd -dc ~/.dsh/sessions/*/<会话 id>/session.v*.jsonl.zstd | grep '"type":"goal/change"'
```

两条判据同时成立才算本插件做的：

1. 事件时间落在**宿主启动时刻 + 30 秒**之后；
2. 该事件**之前**已有 `session/end-seed`，即会话当时已经开着。

第二条正是本插件存在的理由：重启后界面会自动重开上次的会话，只看「会话是活的」会跳过
每一个真实目标。

要排除「是人手动点的」：全宿主能调用 `goals.resume` 的只有四处——界面按钮、`/goal` 命令、
`goal` 工具和本插件：

```bash
grep -rn "goals\.resume" <宿主 node_modules> ~/.dsh/profiles/*/node_modules/@logictan
```

宿主侧那三处里，有两处会留痕、可直接排除：`/goal` 命令留下 `command/run` 事件，`goal` 工具
留下同名 `tool/call`。**界面按钮不留可区分的痕迹**，只能靠旁证排除——本插件是四处里唯一
不需要人操作的，因此「两处人工入口无痕 + 时间落在启动窗口内 + 无其他自动机制」即可判定。

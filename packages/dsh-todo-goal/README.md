# @logictan/dsh-todo-goal

让会话在任务超过三个时自动拥有一个 goal。

## 它解决什么

DSH 的 goal 是「跨轮自动推进」的唯一载体：一个 armed 的 active goal 会让
round driver 在 agent 空闲时自动排下一轮，直到目标完成或阻塞。但 goal 只会因为
模型调用 `create_goal`、或人敲 `/goal` 而存在——一个已经规划了十几项任务、
却没有主动建 goal 的会话，什么都不会自动继续。

本插件从宿主侧补上这一步：**当会话记录的未完成任务超过 3 个、且当前没有
非 complete 的 goal 时，自动创建并 arm 一个 goal。**

## 判定

触发点是 `todo_write` 的结果。判定读的是 DSH 自己的 todo 投影，不解析模型的话术：

| 条件 | 结果 |
| --- | --- |
| 未完成（`pending` + `in_progress`）任务 ≥ 4 | 创建 goal |
| 未完成任务 ≤ 3 | 不动 |
| 已有 active / paused / blocked goal | 不动（绝不覆盖） |
| 已有 complete goal | 替换 |
| 子代理的会话 | 不动（goal 只属于顶层 agent） |

新 goal 的 objective 由本次 todo 列表渲染而来，最多列出 8 项，其余折叠成
`+N more`——objective 会在每一轮的 prompt 里原样重复，不能随 backlog 无限增长。

## 它不做什么

- 不修改已有 goal 的 objective，不自动 pause、不自动 resume。
- 不重新 arm 已 resume 的会话：DSH 在会话 resume / fork 后会把 active goal 置为
  disarmed，而重新 arm 只接受人的直接指令。这是宿主的规则，本插件不绕过。

## 安装

```bash
dsh plugin --profile <profile> add @logictan/dsh-todo-goal
```

本包自带 `dsh.bundle.patch`，安装即挂载，无需改 profile 的 patch。它没有配置项，
Plugins 页不会出现表单。

## 开发

```bash
npm test        # node --test
npm run build   # src/ -> lib/
```


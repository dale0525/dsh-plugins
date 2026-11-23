---
name: dsh-web-runtime
description: 本机 DSH Web（macOS launchd 托管）的启停、重启与状态验收门禁。需要启停 DSH Web、或让改动过的 Host／插件代码生效并核验端口状态时加载。
---

# DSH Web 启停门禁

`dsh-web`（别名 `dshw`）为本机 launchd 托管的封装命令。

- **唯一入口**：使用 `dsh-web start|stop|restart`。让改动过的 Host 或插件代码生效执行 `dsh-web restart`。
- **禁止野路子启停**：禁止用 `pgrep`／`pkill`／`nohup dsh` 自建启停路径，禁止在终端前台直接运行 `dsh web`。
- **子代理保护**：禁止在仍有重要后台子代理运行时重启，等待子代理结算后再执行。
- **重启验收**：执行 `dsh-web status`，确认 `Verdict:` 为 `OK`（作业 PID 与端口 owner PID 一致）。若出现 `==SPLIT==`、`==FOREIGN==` 或 `NOT LISTENING`，视为未生效，排查 `dsh-web logs err` 并重新执行 `dsh-web restart`。

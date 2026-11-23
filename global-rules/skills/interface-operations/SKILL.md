---
name: interface-operations
description: 界面操作工具选择与按需加载：桌面应用、原生窗口、网页自动化各用哪个工具及前置条件。需要操作或验证真实界面、自动化浏览器或桌面应用时加载。
---

# 界面操作（computer-use / browser-use）

## 前置加载

`desktop_agent` 与 `browser_agent` 属于按需加载工具组，默认不在工具表里。使用前先调用：

```json
get_tools({ "toolset": "desktop_web" })
```

## 工具选择

| 场景 | 工具 | 前提 |
| --- | --- | --- |
| 原生窗口、桌面应用、游戏 | `desktop_agent({ app, windowId?, goal })` | 系统已授予辅助功能与屏幕录制权限 |
| 网页内的任务 | `browser_agent({ url, goal })` | Chrome 带 `--remote-debugging-port=9222` 且（macOS 下）配非默认 `--user-data-dir` 启动；插件已配模型鉴权 |

## 使用纪律

- **整体委托**：涉及多步界面交互时整体交给 `desktop_agent` 或 `browser_agent` 一次跑完，把循环内的截图与点击决策隔离在子工具内，避免几十张截图灌爆主对话上下文。
- **禁止盲猜隐藏原语**：底层 `cua_driver_native__*` 原语未广播进常规工具列表，模型看不到其名字与 schema，禁止凭记忆盲猜调用；桌面操作统一走 `desktop_agent`。
- **如实转述结论**：`done` 只是自动化代理对着截图的自我判断，不等同于独立验证，向用户汇报时须如实说明。
- **窗口可见性限制**：`desktop_agent` 无法驱动被完全遮挡的窗口；自绘或游戏窗口若过滤按 pid 路由的输入，需将该插件投递方式设为 `foreground`。

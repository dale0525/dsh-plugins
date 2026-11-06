---
name: dsh-plugin-local-verify
description: 用户说「本地测试插件」「用临时 profile 真机验证本地改动」「按本地测试流程走一遍」时加载。覆盖临时 profile 建档、本地包安装、非 web 端口启动、浏览器验证、清理、发版与不重启安装；发版细节仍按 dsh-plugin-release。
---

# 本地插件真机验证

本技能只编排「本地改动 → 隔离 profile → 真机验证 → 清理 → 发版 → 装回 web profile」这条链路。不改 web profile 的运行中进程，不在验证阶段动正式依赖。

## 边界与硬门禁

- **全程不改 `web` profile 的当前进程**，不运行 `dsh-web restart`。需要重启时只由用户手动执行；安装到 web profile 后明确告知「重启后生效」。
- **测试前必须把访问链接交给用户**。browser agent 之前先把完整 URL 告知用户；需要人工确认的交互才用 `ask_user_question` 请用户手测、写明要看什么，并阻塞等待回报（见 `references/browser-verification.md` 与全局 `AGENTS.md` 核心原则 9）。
- **临时 profile 只用于本次验证**。删除前核对解析后的绝对路径，确认它不是 `web`，且不是当前运行的 profile。
- **发版前确认没有 `file:` / `link:` / 本地 overrides 残留**。清理判据与三处落点见 `dsh-plugin-release` 技能的 `references/ci-failures.md:71-95`，本技能不复制。
- **浏览器验证用 `browser_agent({url, goal})`**，前置条件是 Chrome 带 `--remote-debugging-port=9222` 且插件有 TypeSafe API key。工具选择见 `interface-operations` 技能；不要自己逐步调底层原语。
- **发版与升版只走 `dsh-plugin-release`**。已发布包升版由 CI/CD 发布，Agent 直接推进；只有全新包才停在人工首发交接点，用 `ask_user_question` 把两条命令原样交给用户执行并阻塞等待回报。本技能不重写发布规则。
- **生效核验只走 `dsh-plugin-runtime`**。判断重启还是 HMR、核对 `dsh-web status`、读会话日志 `request/header` 时加载该技能；本技能不复制核验证据表。

## 执行顺序

1. 读 `references/profile-lifecycle.md`——建档、装本地包、选端口启动、验证与删除都要照它执行。
2. 读 `references/browser-verification.md`——启动服务后、调用 browser agent 之前读。
3. 建立临时 profile，确认名称与目录是新建的、与 `web` 隔离；记录绝对路径。按子包 `package.json` 的构建钩子先构建产物，再本地安装目标包。核对 profile 里实际落盘的是本地包而非 registry 旧版。
4. 空白隔离 home 没有模型凭据与配置块。启动浏览器验证前，按 `references/profile-lifecycle.md` 的「复制登录态」小节把 `.credentials.yaml` 与最小配置块复制到隔离 home；不整份拷贝 `web` profile，不触碰 web 进程。复制后重新告知新链接。复制完整凭据后服务本身不需要 DeepSeek 账号登录；不要把 CDP 里残留的 `platform.deepseek.com/sign_in` 标签当成当前页面状态。
5. 在 web profile 之外选一个未占用端口启动该 profile 的 Web 服务；确认进程参数指向临时 profile、端口 owner 正确、页面可访问。把完整访问链接告知用户后再开始浏览器测试。
6. 用 `browser_agent` 验证本次改动的可观察行为；必要时用 `ask_user_question` 请用户手动测试并阻塞等待回报。只通过「磁盘产物含新代码」不算真机验证通过；`done` 只是模型对截图的判断，关键结论再用会话日志或请求头独立取证。
7. 验证通过后停止临时服务并删除临时 profile，核对目录已消失、`web` profile 未受影响。按 `dsh-plugin-release` 清理本地验证脚手架。
8. 按 `dsh-plugin-release` 升版并走 CI/CD 发版；仅当目标是全新包时，用 `ask_user_question` 把两条命令交给用户执行并阻塞等待回报，确认 registry 已有该包后再继续聚合包。
9. 等 registry 出现目标版本后，把新版本安装到 `web` profile；不重启 dsh。核对实际落盘版本与产物内容包含本次改动。
10. 交付时写明：临时 profile 已删除、web profile 已装新版本、运行中仍是旧代码、重启后才生效；给出重启后的观察点。

## 停止条件

- 临时服务起不来、端口冲突、Chrome 调试端口不可用、browser agent 连不上：停止并报告具体命令输出，不要改 `web` profile 或重启 dsh 来绕。
- 浏览器验证没通过：保留临时 profile 供排查，不删除、不发版。
- 发版尚未上线 registry：不要提前安装 `@latest`，等 registry 核验通过。
- 用户要求「不重启」时：安装核验完成即停，不把「文件已含新代码」表述为「运行时已生效」。

## 按需细则

| 情形 | 读哪个 |
| --- | --- |
| 创建/启动/删除临时 profile、本地包安装、端口与进程核验 | `references/profile-lifecycle.md` |
| browser agent 前置、访问链接告知、真机验证判据 | `references/browser-verification.md` |
| 升版、CI 触发、registry 核验、清理脚手架 | 加载 `dsh-plugin-release` 技能；只在真的升版时读它的 `references/version-bump.md`，CI 红了/清脚手架时读 `references/ci-failures.md` |
| 重启/HMR、`dsh-web status`、运行中生效证据 | 加载 `dsh-plugin-runtime` 技能；核对生效证据时读它的 `references/verify.md` |

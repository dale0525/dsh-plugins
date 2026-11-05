# 浏览器验证：告知链接、跑 browser agent、判定通过

只在临时 profile 的 Web 服务已启动、拿到完整 token URL 之后读。

## 前置

- Chrome 必须带 `--remote-debugging-port=9222` 且用**独立** `--user-data-dir` 的专用 profile 启动；macOS 默认 profile 会被 Chrome 拒绝（`DevTools remote debugging requires a non-default data directory`）。前台 `&` 起的 Chrome 会随命令返回被回收，用后台作业。
- `browser_agent` 插件需配 TypeSafe API key。
- CDP 目标列表里必须已有本次隔离 URL 的 `type=page` 标签，否则 browser_agent 第 1 步就 `blocked`（回显 URL 丢 token）。服务起来后先 `curl -s -X PUT "http://127.0.0.1:9222/json/new?$(node -e "console.log(encodeURIComponent(process.argv[1]))" "<完整 token URL>")"` 建标签；多个同 URL 标签时关掉旧标签，旧标签缓存的失败页会误判当前状态。判断当前状态用带 cookie 的 curl 与最新标签的 DOM，不用 CDP 列表里的历史标题。
- 隔离 profile 已按 `profile-lifecycle.md` 复制 `.credentials.yaml` 与最小配置块；此后服务不要求 DeepSeek 账号登录。CDP 列表里残留的 `platform.deepseek.com/sign_in` 是旧标签，不能作为当前页面需要登录的证据；用本次 token URL 带 cookie 访问结果和当前 DOM 判断。
- 工具选择见 `interface-operations` 技能：网页任务整体交给 `browser_agent({url, goal})` 一次跑完；不要自己逐步调 `cua_driver_native__*` 原语。`done` 是模型对截图下的判断，不是独立验证，转述时如实说明。

## 硬顺序

1. 从 `/tmp/dsh-<P>.log` 取 `dsh web: <authenticatedUrl>` 的完整 URL（含 `?token=`），先 `curl` 确认 2xx/3xx。
2. **把完整 URL 原文告知用户**，再调用 `browser_agent`。需要人工确认的交互才请用户手测，写明要看什么、看到什么算通过。
3. 调 `browser_agent({url, goal})`，`goal` 写本次改动的可观察行为，不写「看看页面有没有问题」这类无判据目标。
4. 只有浏览器里的可观察行为符合预期才算通过。`shasum` 一致、`--dump-config` 有 patch 行、`node_modules` 含新代码都只是前置核对，**不是真机验证**。
5. 不通过就停：保留临时 profile 供排查，不删除、不发版，不通过改 `web` profile 或重启 dsh 来绕。把命令输出与截图结论一起报告。

## 纯 host-half 特性的诚实边界

`dsh-force-rules` 这类纯 host-half 插件不注册工具、无 client surface，页面里没有它的专属按钮或卡片，`/plugins/??<pkg>/client.js&rev=` 判据不适用。可观察行为是它在会话里对别的行为施加的约束（例如工具白名单、提示词片段、派单被拒时的原因文字），`goal` 要围绕这个具体行为设计。若找不到可从浏览器观察的行为，明确告诉用户「本次改动无浏览器可观察面」，请他决定是否改用手测会话行为或跳过 browser agent，不要编造通过。

## 发版前后的分界

- 浏览器验证通过 → 才允许删临时 profile、走发版。
- 发版尚未在 registry 出现目标版本 → 不装 `@latest`，等 registry 核验。
- 装回 `web` profile 后**不重启 dsh**；运行中模块缓存仍是旧代码，只报告磁盘核验结果，交付写「重启后生效」。核验清单与生效证据见 `dsh-plugin-runtime` 技能。

# @logictan/dsh-browser-search

让 DSH 的 `web_search` 走**你自己的 Chrome** 搜 Google，不再按次计费。

## 它解决什么

DSH 的 `web_search` 工具本身只是一层壳，真正的搜索能力来自 `ctx.web` 上注册的 provider。
默认装的是 `@deepseek-ai/dsh-web-deepseek` / `dsh-web-deepseek-api`，两者都要 DeepSeek API key
且按次收费。本插件注册一个自己的 provider，**工具名、参数、返回结构、引用格式全部不变**——
模型侧完全无感知，只是后端换成了免费的本机搜索。

## 搜索链路

```
web_search(query)
  └─ 1. Google，走 CDP 驱动本机 Chrome        ~1.2–1.5 s，结果质量最好
       └─ 失败/无结果 →
          2. Bing，纯 HTTP，不开浏览器            ~0.3–0.8 s
               └─ 失败 →
                  3. WebError，报错里列出两条路径各自的失败原因
```

两条路径都失败时，错误信息会同时给出两边的成因和启动 Chrome 的完整命令——因为模型只看到
一个字符串，"Google 挂了" 而不知道兜底也没跑成，是最难排查的形态。

## 前置：一个带调试端口的 Chrome

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.dsh/chrome-agent-profile"
```

Chrome **拒绝**在默认 profile 上开调试端口，所以 `--user-data-dir` 是必需的。这个专用 profile
与你的日常浏览器互不影响。`browser-agent` 插件用的是同一个实例，两个插件可以共用。

没开 Chrome 也能用——会自动降级到 Bing。只是结果质量不如 Google，且中文长尾查询的召回略差。

## 搜索时你看不到任何标签页

Google 路径在**独立的浏览器上下文**里开**后台标签页**：

- 标签不出现在标签栏（`Target.createBrowserContext` + `background: true`）；
- 不抢窗口焦点（页内 `document.hasFocus()` 实测为 `false`）；
- 搜索结束后整个上下文被 `Target.disposeBrowserContext` 一次清掉，不留残留。

这也是本插件**不用 Playwright** 的原因：Playwright 只暴露默认 context，它创建的页面必然
出现在标签栏里并抢焦点。

## 结果链接是怎么拿到的

Google 把所有结果链接包成 `/goto?url=<不可解码 token>`，token 无法在本地还原。本插件对每条
结果发一次**无 Cookie** 的请求，用 `redirect: 'manual'` 停在 302 上取 `Location`——那才是真实
地址。10 条结果并发解析约 170–390 ms。

Bing 那条路径的链接包成 `/ck/a?…&u=a1<base64url>`，`a1` 之后是可解码的真实 URL，直接本地解开，
不需要额外请求。

## 提取逻辑不依赖 class 名

Google 的 class 名是混淆的，且**每次布局改版都会变**（同一功能在不同抓取里分别是
`tF2Cxc IsZvec` 和 `N54PNb BToiNc`）。所以提取只用语义锚点：

| 要拿的东西 | 依据 |
|---|---|
| 结果条目 | 一个包含 `h3` 的 `a` |
| 显示域名 | 最近的 `cite` |
| 摘要 | 最近的、不含 `cite` 的、长度 ≥ 40 的**兄弟**块 |

`src/google.js` 的提取函数是**单个自包含函数**，它的 `toString()` 被原样注入页面执行——
测试跑的和线上跑的是同一份源码，不会漂移。

## 配置

设置 → 插件 → browser-search：

| 字段 | 默认 | 说明 |
|---|---|---|
| `cdpEndpoint` | `http://127.0.0.1:9222` | Chrome 调试端口 |
| `googleEnabled` | `true` | 关掉就只用 Bing |
| `bingEnabled` | `true` | 关掉就没有兜底 |
| `googleTimeoutMs` | `15000` | 一次 Google 搜索的总预算 |
| `bingTimeoutMs` | `15000` | 一次 Bing 请求的预算 |
| `googleMaxResults` | `20` | 向 Google 要多少条（工具层再截断） |
| `bingMaxResults` | `20` | 向 Bing 要多少条 |

## 启用它

插件装好只是**注册**了 provider，还要让 `web` 行选中它。在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: browser-search
```

> **不要用设置页的「Web search」卡片改这一项。** 那张卡片是 DeepSeek 自家 provider 的界面，
> 它的开关只会在 `deepseek-search-api` 和 `deepseek-official` 两个值之间切换；在那里保存一次，
> 就会把 `searchProvider` 覆盖回 DeepSeek，本插件随即不再被选中（provider 仍注册着，只是没人用它）。

## 已知边界

- **Google 可能要求验证码或软限流。** 两种都会被立刻识别并降级到 Bing，不会重试——它们是
  Google 对这个浏览器的判断，重发同一请求只会加深它。
  - `Verifying your request`：同一个 profile 反复搜同一查询时，Google 大约每隔一次就返回这个
    149 字符的中间页（无结果、也无验证码表单）。识别它很重要：不识别时它看起来像「页面一直没
    加载完」，会白等满 15 秒超时才降级（实测 15.4 秒）；识别后 0.3 秒就转 Bing。
  - 真正的验证码（`#captcha-form` / `unusual traffic`）同样直接降级。
- **不使用你的登录态。** 搜索走独立上下文，因此没有你的 Cookie。Google 的搜索结果不依赖登录，
  影响可忽略；需要登录态才能看到的页面请用 `web_fetch` 或 `browser_agent`。
- **`web_fetch` 不受本插件影响。** 它由 `fetchProvider` 单独选择，本插件只接管搜索。

## 为什么没有第三方运行时依赖

这个插件**不引入任何第三方运行时依赖**，Bing 的 HTML 用扫描器解析而不是 DOM 库。

原因不只是体积：`jsdom` 会让插件**根本加载不起来**。它是 CommonJS 包，内部 `require('fs')`
这类 Node 内置模块；而 DSH 宿主的 CJS 解析钩子（`ResolutionRouter.routeScoped`）会对每个裸
模块名调用 `createRequire(parent).resolve.paths(name)`，该调用对内置模块返回 `null`，紧接着的
`for...of` 就抛：

```
TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
```

宿主把这条错误记成 `failed to import`，插件的 provider 因此从未注册，`web_search` 报
`configured web provider "browser-search" is not registered`。0.1.0 就踩了这个坑，0.1.1 移除
`jsdom` 后修复。

Bing 结果页只需要四个平坦的标记（`li.b_algo` / `h2 a` / `cite` / `p`），扫描器读它们和 DOM
一样准，实测 9–10 条结果、424–573 ms。

## 开发

```bash
pnpm --filter @logictan/dsh-browser-search test
```

测试不碰网络也不碰浏览器：Google 的提取逻辑跑在抓取下来的真实 SERP 快照上，Bing 的解析跑在
真实响应快照上，CDP 协议层跑在假 socket 上。

`jsdom` 只作为 **devDependency** 出现在 Google 提取器的测试里（那里需要一个真实 DOM 来跑
注入页面的同一份源码），它不会进入发布的包。

## License

MIT

# 客户端 UI：逐条雷区

只在真的动下面某一处时读对应条目，不必整篇读。

- **往侧边栏会话行塞图标会抹掉它的视觉缩进**：会话行与它所属的工作区行同处一个
  `groupSection`，两者的 `padding-inline-start` 都取自同一个 `--dsh-workspace-indent`，
  所以「会话看着比工作区缩进一级」**不是靠 padding 实现的**，而是靠行首那格固定 16px 的
  `span.slot`：空着看不见，于是第一眼的最左内容是文字（实测 x=40）；一旦那格有内容，
  第一眼的最左内容就变成图标（实测 x=20），与工作区行的图标对齐、看起来成了同一层级。
  实测：`sidebar.session.row.leading` 槽位常驻一个 16x16 图标后，工作树下的会话行与工作区行
  左边缘齐平。宿主在会话忙碌时会**抢占**这一格显示转圈/状态点（`showStatus`），此时插件图标
  不显示 —— 所以该症状只在会话空闲时出现，忙碌时表现为宿主自己的图标同样齐平。
  结论：想让会话行保持缩进，就不要在这一格常驻图标；要标识会话属性，改用行的其他位置。
  **可行位置已实测**：挂在那一格的 `::after` 上并给 `left:100%`（绝对定位，不改槽位内容），
  图标便落在槽位右侧、缩进仍由空着的槽位提供；标题再用 `margin-left` 让出图标宽度
  （**不要用 `padding-left`**——标题的 hover 走马灯按 padding 盒裁剪，padding 会让长标题
  的文字滑到图标底下，margin 才把裁剪边正好留在图标右缘）。

- **插件的 `<style>` 注入不能写成「已存在就跳过」**：客户端 HMR 替换的是插件 fiber，
  不会重新执行整段启动逻辑，于是「已存在就跳过」的守卫让新构建的 CSS 永远注不进页面，
  样式改动直到手动刷新才可见 —— 违反「改 client 源码后不刷新即见新 UI」的承诺。
  正确做法是每次激活都重写已有标签的 `textContent`（复用标签，不重复追加）。
  实测症状：新加的规则在页面样式表里 0 处命中，而测试全绿。

- **要替换宿主渲染的元素，只能用纯 CSS，换 DOM 节点会被 React 重建回去**：宿主渲染的元素都带
  `__reactFiber$*` / `__reactProps$*`，React 按自己的 fiber 调和，不认 DOM 里实际是谁。实测
  （2026-10-22，侧边栏 `svg[data-state='ongoing']`）：把 3 个转圈 `replaceChild` 成自制元素，
  起初成功；连点 6 次展开/收起后自制元素剩 0 个、宿主 SVG 又变回 3 个。判据：取
  `Object.keys(el)` 里以 `__reactFiber` 开头的键，非空即 React 拥有，任何 DOM 手术都只是临时的。
  可行做法是「藏掉宿主元素 + 在父级用伪元素重画」：`svg[data-state='ongoing']{display:none}` 配
  `span:has(> svg[data-state='ongoing'])::after{content:'';…}`，实测重渲染后 `display` 与伪元素
  `animationName` 都不变。伪元素**不能**直接挂在 SVG 上（SVG 元素不生成伪元素），所以必须用
  `:has()` 反向选父格 —— 那一格的类名是构建哈希、`data-state` 在里层，除 `:has()` 没有别的锚点。

- **要拦截宿主的 RPC 请求，只能在 head 注入里做，插件侧包 `globalThis.fetch` 永远无效**：
  RPC 传输层在**模块初始化时**就绑定了 `globalThis.fetch`，插件后加载，它的包装器看不到
  已经绑定好的那次调用。实测：插件侧包装器只捕获到 4 次无关的轮询请求，真正的
  `session/list` 原样通过。唯一赢下这个竞态的位置是 `webserver/index-inject` 钩子的
  `kind: 'script'` + `placement: 'head'`，它渲染进 `<head>`、排在所有应用脚本之前。
  排查时注意：核对注入是否生效要 grep **注入脚本里的实际字符串**（如 `const KEEP`），
  不是源码里的常量名（如 `SESSION_LIST_KEEP`）—— 按后者搜会得出「没注入」的错误结论。

- **同一个 `Menu` 原语渲染出的两个座位，只能靠 `[data-slot]` 区分，形状认不出来**：输入框里
  `conversation.input.left`（工作树选择）与 `conversation.input.model`（模型选择）都用
  `Primitives.Menu`，都渲染成 `div[role="menu"]`、都紧跟在 `button[aria-haspopup="menu"]` 之后。
  于是「按形状找菜单」（`previousElementSibling` 是不是那个按钮）在另一个座位打开时会**命中别人的
  菜单**——实测 2026-10-19 `dsh-better-reasoning-effort`：手机点分支按钮，弹出的分支列表里混进了
  推理等级滑块和模型行。形状相同不是巧合，是同一个原语；判据只能是宿主的座位包装：
  内核给每个座位包 `<div data-slot="<slot>" style="display:contents">`，用
  `element.closest('[data-slot]')` 取座位名即可。注意 `display:contents` 让该包装不产生盒，
  但它**在 DOM 树里**，所以 `closest` 有效、`getBoundingClientRect` 无效。
  模型座位的弹层会 portal 到 `body`（此时没有 `[data-slot]` 祖先），所以这条要写成
  「有座位就按座位判，没座位才退回形状」，不能反过来。

- **槽位渲染崩溃在页面上是「空的」，原因只在控制台**：`plugins.row.config` 这类槽位的渲染
  抛错时，宿主把它换成 `<div data-slot-error="<slot>">`（空元素，无文案），页面表现为
  「插件标题在、下面什么都没有」，看起来像没配字段而不是报错。诊断只能去浏览器控制台取
  `slot entry crashed in '<slot>':` 后的原始 Error，别对着 DOM 猜。实测两个成因：
  ① 迁移后消费端仍在读已删除的字段，抛 `settings card has no field <x>`；
  ② `useSyncExternalStore` 的 `getSnapshot()` 每次返回新对象、或 handle 在渲染体内新建，
  抛 React error #185（最大更新深度）——**引用不稳定即无限重渲染**。
  这两个都不是「没渲染出内容」，而是渲染失败，加字段或改样式永远修不好。

- **`useChat` / `useSession` 这类槽位注入的 hook 只能在渲染期调用，事件处理器里调会抛 React #321**：
  槽位把宿主能力以 `use<Name>` 形式注入到组件 props（`props.useChat`、`props.useSession`…），
  它们本质是 React hook。把「读快照」写进点击/提交处理器里（`onClick` 里直接
  `props.useChat(s => s)`）会抛 `Invalid hook call`（minified #321）。危险之处是**它被
  `try/catch` 吞掉后表现为业务逻辑静默降级**，而不是报错：实测 2026-10-29 `dsh-easyrewrite`
  编辑历史消息，边界计算恒为 `null` → 每次都判成「首条无边界」→ 重置整个对话，控制台里
  只有一条被 catch 掉的告警。正确做法是渲染期取一次存进 ref（`useChatSnapshotRef(props, ref)`
  内部调 hook、写 `holder.current`），处理器只读 `ref.current`。
  判据：在处理器函数体里 grep `props.use[A-Z]` / `props.useChat(` / `props.useSession(`。
  同类陷阱还有**作用域**：跨组件共用的辅助函数若定义在某个组件体内，另一个组件调用会报
  `X is not defined`——这类函数必须提到模块作用域，且用静态测试钉住（见 easyrewrite 的
  `tests/test-edit-confirm-scope.mjs`）。

# 依赖声明：逐条雷区

只在真的改某一类依赖声明、或撞上对应症状时读对应条目。

- **换包一律先删再加，不要并存**：两个包若声明同一个 patch 行 `id`，全新启动即
  `duplicate loader entry id` 硬崩；运行中并存则只有先加载的那个在服务。

- **`@deepseek-ai/dsh-client-ui-slots` 的版本必须全仓库一致**：宿主用 `declare module`
  往 `SlotMap` / `LocaleNamespaceMap` 里合并槽位契约，合并只对**同一个物理模块**生效。工作区里
  各子插件自带不同版本的 `dsh-client-ui-slots` 时，pnpm 会各留一份，合并落进另一份，消费方的
  `keyof SlotMap` 就塌成 `never` —— 症状是 `typecheck` 报
  `'"plugins.row.config"' does not satisfy the constraint 'never'`，而**运行时完全正常**
  （浏览器只加载一份实例）。把每个子插件的 `dsh-client-ui-slots` 对齐到宿主当前世代即可；
  同理，参与 `Context` 声明合并的宿主包（如 `dsh-attachment`）也要收敛到同一版本，
  否则插件通过 `ctx.get(...)` 拿到的类型与自己的 import 不是同一个符号。

- **宿主包一律写 `peerDependencies`，绝不写 `dependencies`**：`dependencies` 里钉的宿主包
  范围一旦不被当前宿主满足（如 `^0.1.6-alpha.2` 遇上宿主 `0.2.0-rc.2`），pnpm 会**另装一份
  实体副本**进 profile。该副本遮蔽指向宿主安装树的共享软链（`~/.dsh/profiles/node_modules`），
  patch 行于是按副本的 peer 被宿主兼容门禁拒绝 —— **静默禁用该行**，功能无声消失。
  实测：`dsh-desktop-agent` 曾把 `@deepseek-ai/dsh-mcp-client` 写成 `dependencies`，令全局
  patch 的 `mcp-stitch` 行被禁用。patch 行只写包名、不钉版本，故修法就是改成 optional peer：
  profile 从宿主安装树解析，**跟着宿主升级自动走，无需改任何 patch 文件**。

- **devDeps 的世代滞后会制造假绿**：`devDependencies` 里的宿主包是**编译期**类型来源，
  钉在旧世代意味着 `tsc` 校验的是**旧 API 表面** —— typecheck 全绿，但校验了错的对象。
  对齐到宿主世代后暴露的类型错误是**真实的**（实测 `dsh-imagegen` 对齐后暴露 7 个：
  宿主已删除 `SettingsScope` / `SettingsScopeSnapshot` / `SettingsSectionHooks`）。
  症状与上面 slots 那条相反：那条是「编译失败、运行正常」，这条是「编译通过、校验错对象」。

- **插件不要引入 require Node 内置模块的第三方 CJS 运行时依赖**：这类包会让插件**根本加载不起来**，
  且报错完全看不出是依赖引起的。宿主 CJS 解析钩子（`ResolutionRouter.routeScoped`）对每个裸模块名调
  `createRequire(parent).resolve.paths(name)`，该调用对 Node 内置模块（`fs` / `path` / `url` / `stream` …）
  返回 `null` 而不是数组，紧跟着的 `for...of` 就抛：

  ```
  TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
  ```

  `barePackageName` 本有 `isBuiltin(request)` 守卫，但内置模块是**被依赖包在 CJS 里 require 的**，
  那一步由钩子的 CJS 分支接手，守卫拦不到。实测 `jsdom`（`dsh-browser-search` 0.1.0）与宿主
  0.2.1-rc.2 必然撞上；移除后同一份代码立刻可加载。判据是**在宿主同款环境里 import 该包**——
  普通 `node` 下 `import` 与 `require` 都会成功，所以本地绿不能证明宿主能加载。

  **排查这类「插件行不激活」不要从报错行号往下读源码**，先花一条命令确认 provider / 导出是否注册。
  对 `ctx.web` 这类可枚举的接缝，最省事的探针是临时把 profile 里指向它的选择项摘掉
  （如 `searchProvider: browser-search`），让它报「多个可用 provider」：

  ```
  multiple usable web providers are registered (deepseek-official, deepseek-search-api, browser-search)
  ```

  名字出现在列表里就证明该插件**加载成功且已注册**；报 `configured web provider "x" is not registered`
  才是真没加载。探针改完立刻恢复，别留在工作区。

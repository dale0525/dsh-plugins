# Changelog

本文档记录 dsh-config-manager 的发布亮点（中英双语）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
This file records release highlights of dsh-config-manager (bilingual: 中文 + English). Format: [Keep a Changelog](https://keepachangelog.com/).

> **发布流程**：打 tag 发布时 CI（`.github/workflows/publish.yml`）自动抽取**当前版本段**作为 GitHub Release 描述亮点；
> 如果忘记写当前版本段，CI 会 **fail fast** 拒绝发版，避免漏写。
>
> **Release workflow**: on tag push, CI extracts the current version's section as the release notes highlights;
> the build fails fast if the section is missing, so you cannot forget to update it.

## [0.1.60] - 2026-09-18

> 本版包含**两块互不重叠**的工作：
> 1. **issue 修复**（第一小节）——仓库中 8 条 open issue（#27–#37）的逐条修复，是本版的发布主题；
> 2. **Phase 1 灾备基线**（第二小节）——由竞品源码审计驱动的能力补齐，**代码随本版发布但默认整体关闭**
>    （两个开关均为 `false`，路由返回 503），不改变本版对外可见的行为。
>
> 本版**没有**修复的、以及只做到一半的，都在 `docs/spec/known-gaps.md` 里如实登记（G-15 明确标为「部分修复」）。

### 🐞 issue 修复（#27 / #28 / #29 / #30 / #31 / #35 / #36 / #37）

- **#37 复检发现的越界读取（本轮自查修复）**：跟随链接时，**文件**符号链接（`skills/link.md`
  → home 外文件）此前只对「目录链接」做了 home 边界检查，内容会被读进备份——CLI 既有回归
  `T2-P3` 当场抓到。现在目录链接与文件链接共用同一 realpath 判据：目标越出 `$DSH_HOME`
  一律跳过并记 `outside-home`（内容绝不读入）。同时把「目录读取失败」也纳入告警
  （此前 ACL/竞态导致的目录读失败被静默吞掉，症状与 #37 同类）。
- **#37 CLI 离线备份路径（`dsh-config-manager backup`）同样静默跳过链接**：issue 点名的
  两条路径里，Web UI 已修而 CLI 未修（`core/backup-plan.ts` 自带的遍历写死「绝不跟随链接」
  且零告警）。现在两条路径共用 `utils/recursive-walk.ts`，CLI 也会跟随 home 内链接并在
  报告 warnings 里写明「跟随了 N 个」「哪些链接/目录没进来及原因」。
- **#35 复检发现的顺序与越权缺陷（本轮自查修复）**：patch 文件项原本排在
  `plugins:pnpm-workspace` **之后**，而配置项的 applyItem 又会替它把 patch 文件写掉——
  ① 会留下「声明在、文件未到」的窗口（中途中断后目标机 pnpm 从此拒绝一切 add）；
  ② 绕过了用户在 patch 文件冲突项上的 `keepCurrent` 选择（正是 issue #35 要消除的静默覆盖）。
  现在 patch 文件项**先于**配置项执行，配置项只按**磁盘真实状态**决定是否剔除声明，不再越权写文件。
- **#35 附带（工具链变更可见可取消）**：`plugins:pnpm-workspace` 在本次同步中**移除了**
  patchedDependencies 声明时（带 detail），进入一键同步的确认列表（默认仍采用，但用户可取消）；
  普通内容变更不进列表，不制造噪音。
- **#31 收口**：autosync 的 `acquire` 抛错分支（锁目录 IO/权限故障）此前同样不写历史——
  现补写，使「自动同步不再更新」这一症状不再有任何静默出口。
- **#36 残留锁在 Windows 上无法回收**（`src/utils/env-lock.ts`）：Windows 拿不到 OS
  process identity，PID 又会被复用，于是「心跳过期 + pid 存活」永远停在 `UNKNOWN_STATE`，
  连官方 `recover-stale-lock` 都拒绝，用户只能手工删锁文件。现在引入**心跳长过期**判据
  （阈值 = `max(30 × staleAfterMs, 30 分钟)`，可注入）：越过阈值即判为残留锁，
  **显式**回收可成功。acquire 侧依旧绝不自动摘锁——放宽的只是「显式回收」这一条人工路径，
  且 `inspectLockState` 与回收二次验证 `reProveStale` 使用**同一**判据（否则首次判定可回收、
  二次验证又判非 stale → quarantine，等于没修）。
- **#37 skills 等文件类分区静默跳过 junction / 符号链接**（`src/utils/recursive-walk.ts`、
  `src/adapters/link-report.ts`）：`readdir` 对目录链接返回 `isSymbolicLink() === true`，
  旧实现只处理 `isDirectory()/isFile()`，链接目录连同其**全部真实内容**被静默排除，备份照样
  报成功（实测 8 个链接目录约 12 MB 内容丢失）。现在**跟随**目录链接收集内容，用 realpath
  去重防环（自引用/重复链接/深度上限），并把「跟随了 N 个链接（导入按普通目录还原，链接结构
  不会重建）」「跳过了 N 个链接且**其内容未进备份**（原因 + 路径）」写进备份报告——
  缺了后半句，用户依然无从察觉缺失。越出 `$DSH_HOME` 的目标仍不进备份（既有边界不变），但会留痕。
- **#35 只搬 `pnpm-workspace.yaml` 的 `patchedDependencies` 声明、不搬 patch 文件**
  （`src/adapters/pnpm-workspace.ts`、`src/adapters/plugins.ts`）：目标机拿到「声明在、
  `patches/*.patch` 不在」的组合后，pnpm 会拒绝**一切** `add`（含与补丁无关的插件），
  实测一次「一键同步 → 确认导入」13/13 插件安装全灭、而同步仍报成功。现在：
  ① 导出时把 `patches/**` 作为 `plugins.patchFiles` 随分区携带（源机缺文件 → 显式告警）；
  ② 导入时先落 patch 文件，再写入**剔除目标机无法满足的声明**后的配置（按行改写，保留注释与
  CRLF，不整文件重写；单行 flow 形态不猜着改，改为告警）；③ 剔除在计划里以 **Warning 项**
  显式可见（一键同步的确认列表现在也渲染 Warning，不再静默自动采用）；
  ④ 安装失败分类新增 `patch-file-missing`，给出可操作修复路径，而不是 13 条「插件装不上」；
  ⑤ 供应链：`patchFiles` 非空在**发布侧与导入侧**双端拒收（与 `localTarballs` 同级），
  `patchFiles[].relativePath` 进结构校验（拒绝绝对路径 / 上跳路径）；
  ⑥ 每个 patch 文件都是**计划项**（Create/Skip/Conflict）并进入**导入前快照**——否则导入覆盖了
  目标机原有 patch 文件后再回滚，原文件会永久丢失（新增 ref 前缀 `patchFile:` 与 patch **行** id
  区分开，`resolveFileTarget`/`captureTarget` 同步支持）。
- **#35 附带（可观测性）**：插件安装失败返回 `{ok:false, warning:true}`（§34.17 非致命语义），
  而 journal 把「非 ok / 非 failed」一律记成 `skipped` 且不落 message → 事后审计（人 / CLI / agent
  读 `transactions` 或 `migration-history`）会得出「用户跳过了这些插件、同步成功」的错误结论。
  现在 `warning` → `attention`（不可证明已应用），`skipped` 只留给真正的跳过，并持久化
  `message`（`src/core/analyzer.ts`、`src/core/journal.ts`）。
- **#28 「装了插件但备份没识别到」的剩余形态**（`src/core/plugin-cli.ts`）：已装清单此前只遍历
  `package.json` 的 `dependencies`，仅通过 `dsh.profile.bundles` 声明的层**完全不可见**——
  而 DSH 启动时确实会挂载它们（`reconcileBundles` 对这类条目是保留的）。现在 bundles 中
  非依赖、非 in-box 的条目也进入清单（版本取 `node_modules` 落盘版本）。
- **#27 / #29 / #30 / #31**：核对并保留已落地的修复（残锁分类文案与 `--help` / README 可见性、
  未配置 token 视为「未登录」而非 500、插件私有出站代理、定时备份与自动同步的锁跳过文案与
  历史、以及 423 文案所指向的「事故恢复 → 回收残留锁」GUI 入口），并补上 #31 遗漏的两处：
  自动同步被挡时**补写 sync-history**（此前连历史都不写，用户只能看到「自动同步不再更新」）、
  客户端 `describeSkipReason` 对 `mutation-locked` 给出可读中文。

### 📄 文档与契约同步

- `docs/spec/bundle-format-v1.md`：登记 `plugins.patchFiles` 字段、市场双端拒收、以及
  **实现者注意**「`pnpmWorkspace` 与 `patchFiles` 必须同进同出」。
- `docs/spec/known-gaps.md`：新增 **G-14**（同步只搬声明不搬 patch 文件）并标记已修复。
- `README.md`：`recover-stale-lock` 症状表补「PID 被复用」一行；插件清单来源补
  `dsh.profile.bundles` 说明。

### Phase 1：灾备基线（P0）—— 代码随本版发布，**功能默认关闭**

> 本节补齐与同类 DSH 撤销/回退插件的**能力基线差距**：自动快照、撤销/重做、
> 启动救援模式、崩溃归因。全部为新增能力，不改动既有分区模型与导入/导出契约。
> 尚无对应 issue（由竞品源码审计驱动）。
>
> **阅读提示**：下面这些能力在本版中**用户不可达**（开关为 false）。列出它们是为了让
> 发布内容可被完整审计，而不是宣称它们已可用。

### ⚠️ 默认关闭（本版不对用户开放）

- **灾备子系统整体下线**：`LIFECYCLE_ENABLED = false`（`src/index.ts`）关闭
  自动快照监听、`boot-state` 写入与 `/lifecycle` / `/crash` / `/rescue` 三条路由
  （一律 `503 feature-disabled`）；客户端导航入口同步关闭
  （`SHOW_LIFECYCLE_NAV = false`）。**两个开关必须同开同关**，否则会出现
  「入口可见但功能 503」的错位。
- **为什么下线**：自动快照的采集覆盖**全部 adapter**，其中 `sessions` 分区（历史会话）
  在本机实测 340 MB，远超快照 64 MiB 上限，必然持续失败并刷
  `[lifecycle] 自动快照失败: 配置快照超出上限（479313046 > 67108864 字节）` 告警。
  在该缺陷修好前，撤销/重做/救援也没有可信的快照基线可用，故整体下线而非只停监听。
- 引擎代码与测试**全部保留**（core 模块、客户端组件、路由实现均未删除），修好缺陷后
  把两个开关改回 `true` 即可恢复。已有守卫测试锁定开关确实挂在启动路径上
  （`src/core/phase1-wiring.test.ts` 的「灾备总开关」三条），防止只改注释不改行为。

### 新增

- **自动快照（P0-1）**：监听 DSH 配置目录与用户插件源码目录，防抖合并文件事件后
  自动落一份配置状态快照。含**两层回声抑制**——写操作窗口内直接丢弃事件，窗口外按
  内容指纹识别「恢复动作自写文件」的延迟投递事件。缺了这层，恢复动作会立刻产生一个
  等于刚写回内容的快照，把重做通道堵死。
- **撤销 / 重做（P0-2）**：撤销 = 回退到与当前状态**内容不同**的最新快照（自动快照在
  变更之后采集，所以「最新快照」通常等于当前状态，必须跳过）；撤销前先落 `pre-restore`
  快照使重做可逆；撤销后若又发生真实变更，重做**被拒**而非覆盖用户新改动。全部相同时
  明确报告「没有可撤销的变化」，不做空操作。
- **启动救援模式（P0-3）**：DSH 因插件/bundle 起不来时，备份 `cordis.patch.yml`（home 与
  profile 两层）与 `package.json`，改写为只挂载本插件自身的最小 patch，并把
  `dsh.profile.bundles` 收窄为 **DSH 核心（`@deepseek-ai/*`）+ 本插件**——其余用户插件本次
  启动不挂载（只中和 patch 层救不了「bundle 能解析但插件代码把 DSH 搞挂」这类）；退出时逐
  字节完整还原。含家目录指纹——换机/重建 home 后残留状态自动降级不激活。**救援路由刻意不
  进入 mutation gate**：否则会被它要解决的那个状态挡住，形成死锁。
- **崩溃归因（P0-5）**：`boot-state.json` 记录每次启动结果，上次未正常结束时按日志尾部
  签名分类（`session-corrupt` / `bundle-check` / `patch-tree` / `unknown`）并给出建议动作与
  「最后正常快照」id。归因在启动时一次性持久化——日志会被滚动覆盖，错过就没了。
- 三条新路由：`GET /api/dsh-config-manager/lifecycle/status`、`POST .../lifecycle/{snapshot,undo,redo,remove}`、
  `GET /api/dsh-config-manager/crash`、`GET|POST /api/dsh-config-manager/rescue`。

### 修复（自审 + 独立审计发现的缺陷）

- **退出救援对路径写法敏感（用户实测卡死）**：家目录指纹原先直接哈希 `homeDir` 原始字符串，
  同一目录换个写法（`C:/…` vs `C:\…`、尾分隔符、`.`/`..`）就判 stale 并**拒绝还原、一个文件
  都不动**。从插件 UI 进出时两次都原样传 `host.homeDir` 所以看不出来，从 CLI / 脚本手动进出
  必踩。现在指纹输入经 `normalizeHomeDir` 归一化（resolve + win32 折叠大小写），并兼容历史
  （归一化前）指纹，使**已处于救援态**的用户升级后仍能正常退出。
- **救援没有真正禁用其它插件**：原先只中和 patch 层 + 剪掉「不可解析」的 bundle，bundle 只要
  能解析就照旧挂载，治不了「插件代码自己把 DSH 搞挂」。现在进入救援会把 `dsh.profile.bundles`
  收窄为 DSH 核心 + 本插件；保留了 `@deepseek-ai/dsh-base` / `dsh-web-app`，否则 DSH 自身
  都起不来。UI 文案与代码注释同步改为如实描述。
- **自动快照会丢失中间状态**：watcher 在回调前已把事件批摘除，而 flush 进行中到来的批次被
  直接丢弃且**不再重排**——实测连写 v2、v3 只落 1 份快照，撤销于是无从回到 v2。现在改为排队
  补拍。
- **恢复通道的回声抑制只覆盖撤销/重做**：导入、备份恢复、Profile 切换、同步应用同样会写配置
  文件，却不在抑制窗口内，恢复完会立刻多出一份「等于刚恢复内容」的快照，把重做通道永久堵死。
  现在按「采集状态是否等于最新快照 / 刚回放的目标状态」兜底，覆盖全部通道。
- **撤销可能「假成功」**：某个分区采集失败时状态会少一个分区，与内容其实相同的快照判为
  「不同」→ 选中它 → 回放写不回任何东西却返回 `ok:true`，且 `canUndo` 永远为真。现在采集
  不完整即拒绝撤销（`capture-incomplete`）并让 `canUndo=false`。
- **回放失败仍消费 pre-restore**：重做通道就此消失，而配置正停在半应用的中间态。现在仅回放
  成功才消费。
- **`pre-restore` 记录的可能不是「撤销前状态」**：原先挑目标与落 pre-restore 是两次独立采集，
  之间的用户改动会溜进去，重做时把用户没见过的内容写回去。现在复用同一次采集。
- **一条损坏快照能让整个灾备面板 500**：`meta.state` 未做形状校验，`statesEqual` 会抛
  `TypeError`。现在读取侧丢弃形状不对的 meta，比较侧改为全函数（缺字段不抛）。
- 救援卡片把「自动快照未开启」当成「救援未开启」显示；启动后新出现的 `skills` /
  `.agent-presets` 目录此前在整个进程生命周期内都不会被监听（与注释承诺不符），现已自愈纳入。

### 说明

- 配置状态快照存放于 `<dataDir>/config-snapshots`，与导入前快照 `<dataDir>/snapshots`
  **分目录**：后者由导入计划驱动（只登记本次将写入的目标），无法回答「配置整体变没变」。
  两者保留策略与回放方式都不同，混用会产生错误语义。
- 快照回放复用 adapter 管线（`validate → analyzeImport → applyItem`），与导入/Profile 切换
  同一条写入路径，因此不引入第二套写入逻辑。
- 监听器与定时器全部依赖注入，自动快照时序在测试中由假定时器驱动——不 sleep、不受机器负载
  影响。

### 测试

- 新增 6 个 core 模块与 7 个测试文件；全量套件 1910+ 项通过。
- 含接线守卫（`src/core/phase1-wiring.test.ts`）：断言路由/闸门/dispose 确实在盘上，
  防止「注释承诺 > 实际防线」；守卫自身已按 LF 与 CRLF 双形态验证。
- 上述缺陷各有对应回归测试（含确定性故障注入：`exportGate` 钉死 flush 竞态、
  `failExport` / `failApply` 注入采集与回放失败）。

> 更早版本（v0.1.59 及以前）的变更记录见上游仓库 xiajiajun516/dsh-config-manager 的 CHANGELOG —— 本 fork 已删除导出/导入/市场/档案等子系统，那些条目不再描述本仓库的形态。

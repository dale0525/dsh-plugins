# 🔄 DSH Config Manager

**DeepSeek Harness 配置远程同步插件。**

在你的多台机器之间，通过**自有的私有通道**（Git 仓库或 WebDAV）同步完整的 DSH 配置 ——
设置、模型 provider、插件清单、MCP server、技能、Agent 预设、工作区，以及 provider 密钥。

- ☁️ **Git / WebDAV** 双通道，各自独立配置
- 📄 **明文快照** —— 私有通道自用，勾选即同步，不加密、不脱敏、不做 diff/合并
- 🧩 分区可勾选：设置 / provider / 插件 / MCP / 技能 / 预设 / 工作区 / 凭据 等
- ↩️ 应用前自动落回滚快照，失败整体回滚
- 🔐 通道凭据走 DSH credentials 槽位，值永不回传浏览器

---

## 它解决什么

DSH 把配置散落在 `$DSH_HOME` 的多个文件里（`settings.yaml`、`.credentials.yaml`、
`cordis.patch.yml`、插件清单、技能目录…）。换一台机器就要重配一遍。

本插件把这些分区打包成**快照**推到你自己配置的私有通道，另一台机器拉下来覆盖写入。
**不加密、不脱敏** —— 这是刻意的产品选择：通道是你自己的私有仓库，明文自用比丢配置更划算。
因此**绝不要**把同步通道指向公开仓库。

---

## 安装

```sh
dsh plugin --profile web add @logictan/dsh-config-manager@latest
```

> 也可通过聚合包一次装上本仓库的全部插件：`@logictan/dsh-plugins-all`。

## 使用

设置 → 插件 → **DSH Config Manager**（只有一个「同步」标签页）：

1. **通道**：选 Git（私有仓库地址 + token）或 WebDAV（地址 + 用户名 + 口令）；
   两者配置**互相独立**。
2. **同步范围**：默认模式同步全部推荐分区；高级模式手动勾选。
3. **推送**：把本地配置直接覆盖到远端（无预览、无确认）。
4. **拉取**：把远端最新快照直接覆盖到本地（应用前自动落回滚快照，失败整体回滚）。

### 启动前校验（拉取时自动执行）

拉取会先写完 patch 行、装完插件，然后**用宿主自己的启动口径**判定「这份组合下一次启动会不会起不来」：
用宿主导出的配置 JSON Schema 校验必需启动行（`connection`、`webserver` 等），并检查 loader entry id 重复。

- 判定只有两种结果：**通过**，或**整体回滚**（文件与插件一起回到拉取前）并提示升级插件后重试。
  没有「丢掉坏行再试」——宿主的启动口径里只有必修行会拒绝启动，而必修行恰恰不许丢
  （丢 `connection` 等于关掉局域网信任围栏）。
- patch 文件本身读不了（YAML 语法坏）判为**硬失败**：宿主下次启动同样读不了它，
  此时放行等于把用户送进「起不来、又只能在能启动的宿主里开配置管理器」的死锁。
- 宿主 schema 自己产出不完整（`x-cordis.complete=false`）时如实告警，不凭它回滚。
- 判定跑在子进程里（约 7–10 秒）：profile 里挂的是第三方 bundle，在宿主进程内 import 它们可能挂死宿主。
  子进程起不来时降级为告警，不阻断拉取。
- loader entry id 重复只作告警：宿主是 `store[id] ??= …`（后写覆盖前写），不会崩。
- 逃生阀：`DSH_CONFIG_MANAGER_BOOT_GATE=off` 跳过该校验。

> 它挡的是「插件先被换到新版本、配置后到」这个顺序问题：校验按**拉取后磁盘上的插件版本**算 schema。
> 所以手工 `dsh plugin add …@latest` 再拉配置时，判定用的就是新版本的规则。

### 启动时自动同步（AUTO-SYNC）

配过同步通道后，**每次启动都会自动同步一次**，方向由**本机角色**决定：

| 本机角色 | 启动时做什么 | 谁该选它 |
|---|---|---|
| **发起者**（`source`） | 无条件 **push**：本机配置覆盖远端 | 那台修改配置的机器 |
| **从属者**（`follower`，缺省） | 无条件 **pull**：远端配置覆盖本地 | 其余设备 |

```
终端运行 dsh web
  └─ 检测到同步通道 → 按本机角色同步（发起者推送 / 从属者拉取）
       └─ 宿主等到同步结束，才判定「这次能不能起来」
```

**为什么不是无条件拉取**：当前宿主是配置的修改来源。若它也无条件拉取，
「改了配置、重启前忘了推送」就会被线上旧配置覆盖 —— 恰好毁掉本地最新的那份。
角色是**按设备**决定的，不是靠比较「谁更新」（本地改动时间不可得，比时间戳判不出方向）。

角色存在 `sync-config.json` 里，**不进任何同步分区**，所以每台设备各自独立、不会互相覆盖。
在「同步」设置卡的「本机角色」里切换。

失败策略按角色区分：

- **发起者推送失败 → 只告警，不阻断启动。** 本地配置本身是对的，只是没传出去；
  断网时仍应能正常用。
- **从属者拉取失败 → 重试 3 次**（间隔 2s → 4s）；仍失败则**明确报错并拒绝启动**，退出码 1。
  报错会说明是「配置同步失败」并带原始原因，不会伪装成程序崩溃。
- 拉取被启动校验判失败并回滚，同样算失败并继续重试——否则会带着旧配置「成功启动」，
  让人误以为新配置已生效。
- 没有配过同步通道 → 完全不介入（不会把「没配同步」变成「起不来」）。

**为什么这样不会打断启动**：`apply` 返回 Promise 时宿主会等它（Cordis 的 `_execute` 对 thenable
会 `return effect.then(...)`，`loader.await()` 等的是它），而启动判定 `auditStartupEntries`
排在 `loader.await()` 之后。写盘触发的 HMR 重载则会等 `appReady.commit()`（启动成功之后）才执行。

> 代价：每次启动都要走一遍同步，启动时间取决于网络。**从属者**在断网且配过通道时会被拒绝启动
> （发起者不会：推送失败只告警）。
>
> 与逃生阀的交互：`DSH_CONFIG_MANAGER_BOOT_GATE=off` 关掉的是「拉取后这份配置能不能启动」
> 的唯一判据，因此它同时让自动同步失去把关能力 —— 不可启动的配置会被落盘并正常启动。
> 只在确认配置无误、临时绕过误报时使用。

### 回滚会连插件一起带回

导入/拉取失败时的整体回滚原先只恢复配置，插件留在导入后的版本 —— 而「旧 patch 行 + 新插件版本」
正是启动校验要防的组合，那会让「已整体回滚」变成半句话。现在按快照里的导入前插件清单补偿：

- 导入期间**新增**的插件 → 卸载
- 导入期间**升级**的插件 → 降级回原版本（`dsh plugin add <name>@<version>`）
- 导入期间**消失**的插件 → 装回来

顺序是**先配置、后插件**：反过来的中间态是「新插件 + 旧 patch 行」，可能起不来；现在最坏也只是
「旧插件 + 旧配置」，可启动。降级失败**不谎报**：如实标为回滚不完整，并给出手动命令。
旧快照没有插件清单基线时不动插件（猜就等于乱删）。

---

## 安全边界

| 项 | 说明 |
|---|---|
| 快照内容 | **明文**，含 provider 密钥等一切隐私信息（`manifest.security.containsSecrets` 按实际内容如实标注） |
| 通道要求 | 必须是你自有的**私有**仓库；本插件不会、也无法阻止你把它指向公开仓库 |
| 通道凭据 | 存于 DSH credentials（Git 用 `DSH_CONFIG_MANAGER_SYNC_TOKEN`，WebDAV 用 `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD`）。**这些值会随「凭据」分区明文进入同步快照**（跨机恢复的前提），但绝不回传浏览器、绝不写入日志 |
| 凭据分区 | 同步快照携带 `.credentials.yaml` 的 `refs` 明文值，拉取时直接写回目标机；普通备份 ZIP 仍然不含任何凭据值 |
| 日志 | 全程脱敏（`security/redaction.ts`） |
| 导入 | 应用前强制落回滚快照；任一失败整体回滚 |

---

## 架构

双面 Cordis 插件：

- **宿主半边** `src/index.ts` —— `/api/dsh-config-manager/sync/*` 路由族 + 同步引擎
  （`src/sync/sync-engine.ts`）+ Agent 工具（`config_sync_push` / `config_sync_pull`）
- **浏览器半边** `src/client/` —— 设置页里唯一的「同步」标签

`src/core/` 与 DSH 解耦（`ConfigAdapter` / `HostContext` + 内存 mock），
业务逻辑放 `src/ui/`，React 壳只做装配。

传输通道：`src/sync/git/` 与 `src/sync/webdav/`，共同的 `SyncTransport` 契约在 `src/sync/transport.ts`。

---

## 开发

```bash
npm install --legacy-peer-deps   # 部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit
npm test                         # node --test
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm run dev:watch                # 改 src/client/** 自动重建产物（浏览器原位替换）
```

- 无 lint/format 脚本，只以 typecheck 兜底。
- 样式全在 `src/client/config-manager.module.css`（CSS Modules，tsdown 编译为内联注入）。
- **import 一律带 `.ts` 后缀**（Deno-style）。

### 测试的 TMPDIR 陷阱（macOS）

`src/utils/recursive-walk.test.ts` 建真实符号链接，而 macOS 的 `/var/folders/...` 是
`/private/var/...` 的符号链接 —— `realpath` 会把 home 解析到 `/private/...`，导致
「home 内」判定失败。跑测试前：

```bash
mkdir -p /private/tmp/realhome
TMPDIR=/private/tmp/realhome/ node --test "src/**/*.test.ts" "tests/**/*.test.ts"
```

---

## 许可证

MIT

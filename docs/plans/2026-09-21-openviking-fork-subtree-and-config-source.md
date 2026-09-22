# OpenViking 纳入 fork 子插件，并让插件配置成为唯一真源

> 状态：事前冻结的计划，待评审。实施中的偏离以实际代码为准。
> 触发问题：「能不能让 openviking 直接使用插件中的配置，而不是使用 ~/.openviking 目录中的 ovcli.conf 配置？」
> **路径约定**：本文所有 `packages/...`、`scripts/...`、`docs/plans/...` 均相对仓库根。
> 上游路径（如 `examples/dsh-memory-plugin`）相对 volcengine/OpenViking 仓库根。

## 0. 结论摘要

1. **诉求分两层，现状不一样。** 连接字段（服务器地址、API Key）**今天就已经是插件配置优先**；
   调参字段（`recallTokenBudget` 等）**被 ovcli.conf 的 `plugin` 段反压**。后者是上游刻意设计，
   源码注释原文：`ovcli.conf's plugin section outranks the host's input`。
2. **调参被反压这件事，当前并未发生。** 实测本机 `~/.openviking/ovcli.conf` 只有 `url` 与
   `api_key` 两个顶层键，**没有 `plugin` 段**。所以只有连接字段实际来自该文件 —— 而它本就可以被插件配置覆盖。
3. **真正让「仍在用 ~/.openviking」成立的是：当前 patch 行只填了调参项，没填连接字段。**
   地址与密钥因此回落到 ovcli.conf。**填入 `endpoint` + `apiKey` 即可切换真源，零代码改动。**
4. **要彻底不读该文件，需要切断文件读取**：`OPENVIKING_CREDENTIAL_SOURCE=env` **无效**（实测它只管凭据链，
   `plugin` 段照样反压）；唯一有效杠杆是让插件找不到文件。注入环境变量的通道**尚未验证成功**
   （patch 行无 `env` 字段），故计划采用「删除文件」路线，并把它列为需用户确认的动作。
5. **收养本身可行，但既有同步设施不支持 monorepo 子目录。** `git subtree add` 不接受
   `ref:subdir` 语法（实测 `fatal: '...' does not look like a ref`）；直接拿上游 url + tag 对
   插件目录 `subtree pull`，实测灌入 **4269 个文件、1,191,186 行插入**，插件目录被替换成上游仓库根结构。
   必须给 `sync-upstream.mjs` 增加「临时 worktree + `subtree split`」的取子目录能力。
6. **端到端已实测通过**：两次 split → 两次 `subtree add` → 改造生成器 → 生成 20 个 shared 模块 →
   插件 12 个 import 全部可解析 → `npm test` **73 通过 / 0 失败 / 1 跳过**。

## 1. 事实与证据

以下全部为本次会话实测，非推断。探针脚本用假 key，未触碰真实凭据。

### 1.1 插件配置 vs ovcli.conf 的优先级（动态探针）

构造一个只含 `url` / `api_key` / `plugin.recallTokenBudget: 9999` 的受控 ovcli.conf，
经 `OPENVIKING_CLI_CONFIG_FILE` 指给插件，直接调用 `resolveConfig()`：

| 探针 | 宿主配置传入 | 实际生效 |
|---|---|---|
| A | 无 | 全取 ovcli.conf（`baseUrl=https://cli-file.example/v1`，budget=9999） |
| B | `endpoint` + `apiKey` | **宿主胜出**：`baseUrl=https://host.example/v1`，key 为传入值 |
| C | `baseUrl`（别名） | **被忽略**：仍为 ovcli.conf 的 url |
| E | `recallTokenBudget: 1111` | **被反压**：实际 9999 |

**结论**：连接字段宿主优先；调参字段 ovcli.conf 的 `plugin` 段优先；连接字段必须用 `endpoint`，
不能用 `baseUrl`（`config.mjs` 只把 `input.endpoint` 映射进 `hostInput.baseUrl`）。

### 1.2 切断 ovcli.conf 的候选（动态探针）

| 候选 | 结果 |
|---|---|
| `OPENVIKING_CREDENTIAL_SOURCE=env` | **无效**：budget 仍被反压成 9999 |
| `OPENVIKING_CLI_CONFIG_FILE` 指向不存在的路径 | **有效**：budget=1111，全部走宿主配置 |
| `OPENVIKING_CLI_CONFIG_FILE` 指向空文件 | **有效**：budget=1111，baseUrl 与 key 均来自宿主 |
| 不设该环境变量、HOME 下无该文件 | **有效**：全部走宿主配置 |

### 1.3 插件配置足以独立驱动插件（动态探针）

在「无 ~/.openviking」前提下，用当前 patch 行的完整 config（补上 `endpoint` / `apiKey`）调用
`resolveConfig()`，输出完整正确：

```
baseUrl              https://plugin.example/v1
apiKey               len16（来自宿主）
authMode             api_key
recallPeerScope      actor
recallTokenBudget    3000
recallMaxContentChars 1500
recallPreferAbstract false
captureToolResults   false
skipSubagentSessions true
mcpEnabled           true
```

无一项缺失，**「不依赖 ovcli.conf」在技术上完全成立**。

### 1.4 本机 ovcli.conf 的真实内容（只读，未打印值）

顶层键仅 `['api_key', 'url']`，**无 `plugin` 段**。故 §1.1 探针 E 的反压场景本机并不存在。
文件权限 `600`，体积 170 字节。本机**无 `ov` / `ovcli` 命令**，该文件无其他消费者。

### 1.5 当前 patch 行的实际内容

`$DSH_HOME/profiles/web/cordis.patch.yml` 的 `openviking-memory-runtime` 行，
config 仅含调参项（`recallPeerScope` / `recallTokenBudget` / `recallMaxContentChars` /
`recallPreferAbstract` / `captureToolResults` / `skipSubagentSessions`），
**无 `endpoint`、无 `apiKey`** —— 这正是地址与密钥仍来自 ovcli.conf 的直接原因。

### 1.6 上游结构：插件依赖的 shared/ 不入库

- 插件目录 `examples/dsh-memory-plugin` 上游跟踪 **29 个文件**；
  `shared/` 与 `skills/` 被 `.gitignore` 排除（`v0.4.21` 起 `shared/` 不再跟踪）。
- 插件有 **6 个源文件** import `./shared/` 下 **12 个模块**；缺了插件无法启动
  （`ERR_MODULE_NOT_FOUND`）。
- 生成器在兄弟目录 `examples/memory-plugin-shared/sync.mjs`（上游跟踪 75 个文件），
  `prepack` 钩子调用它。
- 生成器还依赖**第三个**兄弟目录 `examples/skills`（`SKILLS_DIR`），以及硬编码的 7 个 target。
- `ROOT` 由脚本位置推导为「仓库根」（`join(dirname(import.meta.url), "..", "..")`），
  `SHARED_DIR = ROOT/examples/memory-plugin-shared/lib`。**原样搬进 `packages/` 直接崩**：
  实测在扁平布局下报 `ENOENT .../examples/memory-plugin-shared/lib/MANIFEST.<pid>.tmp`。

### 1.7 收养与同步的实测结论

| 操作 | 结果 |
|---|---|
| `subtree add --prefix=... <url> v0.4.21:examples/dsh-memory-plugin` | **失败**：`fatal: '...' does not look like a ref` |
| 先 `subtree split --prefix=<子目录>` 再 add 该分支 | **成功**，树根即插件文件，保留祖先标记 |
| 直接对插件目录 `subtree pull <上游 url> v0.4.21` | **灾难**：4269 文件 / 1,191,186 行插入，目录变成上游仓库根 |
| 临时 worktree + `subtree split` 后 pull 本地分支 | **成功**：上游改动到位、我方改造幸存、无冲突标记 |

### 1.8 fork 后功能完好（端到端）

在 `/tmp/proto` 完整复现两子树收养 + 生成器改造后：

- 生成器产出 20 个 shared 模块，插件 12 个 import 全部可解析；
- `node --check` 全部通过；
- `npm ci` 装 121 个包，`npm test` = **73 pass / 0 fail / 1 skip**。

## 2. 方案

### 2.1 已冻结的决策（用户 2026-09-21）

1. **安装形态**：随聚合包 `@logictan/dsh-plugins-all` 自动带上，用户不需单独 add。
2. **shared/ 补齐方式**：生成器一起 fork（上游修 bug 能同步进来）。
3. **基线**：`v0.4.21`（上游最新 tag；`shared/` 本就不跟踪，我们补的产物不会被同步误删）。
4. **生成器归属**：并进插件包内 `scripts/`。
5. **shared 源码同步**：一并建同步（各自独立 `sync-policy.json`）。

### 2.2 配置真源（本次诉求的核心）

**第 1 步（零代码，立即可做）**：在 patch 行的 `config` 里补 `endpoint` 与 `apiKey`。
补上后地址与密钥立即以插件配置为准，不再读 ovcli.conf。**注意用 `endpoint`，不是 `baseUrl`。**

**第 2 步（切断文件读取，需用户确认）**：删除 `~/.openviking/ovcli.conf`。
这是让**调参项也归插件配置**的必要条件。本机该文件无其他消费者（无 `ov` CLI），
但删除属改动用户既有文件，**须经用户明确确认后执行**。

**关于注入环境变量的路线**：patch 行无 `env` 字段，`settings.yaml` 也无插件环境设置项，
该路线**未验证成功**，本计划不采用；若将来需要，另立议题。

**不动的部分**：`~/.openviking/state`、`pending`、`workspaces` 是**本地运行时状态**而非配置，
不影响「配置真源」。是否搬迁由用户偏好决定，本计划默认不动。

### 2.3 收养与登记

1. **给同步设施加子目录能力**（唯一代码改动）：
   - `sync-policy.json` 的 `target` 增加可选 `subdir` 字段（如 `examples/dsh-memory-plugin`）；
   - 同步时用临时 worktree 检出目标 ref → 在该 worktree 内 `subtree split --prefix=<subdir>` →
     回到主仓库 `subtree pull --prefix=<target.prefix> . <split-branch>`；
   - 无 `subdir` 的既有 5 个 fork 走原路径，行为不变（回归风险最高处）。
2. **两次收养**：插件与 shared 各建一次 subtree 祖先，基线同为 `v0.4.21`。
3. **改造生成器**：`sync.mjs` 落进 `packages/dsh-openviking/scripts/`，
   `SHARED_DIR` 指向 shared 包内路径，`TARGETS` 收敛为插件一项，
   `ASSEMBLED_ROOTS` 与 `SKILL_TARGETS` 清空或改指插件自带 `skills/`。
4. **登记聚合**：`packages/all/aggregate.yml` 的 `patchFrom` 与 `deps` **两节都要写**。

### 2.4 约束

- **包名与 patch 行 id**：本仓库 fork 约定改名为 `@logictan/<name>`。
  patch 行 `id` 必须全仓库唯一且等于插件宿主半边的 `export const name`
  （上游为 `openviking-memory`）；**无自动检查，须人工比对**。
- **`target.prefix` 硬校验**：`sync-upstream.mjs` 强制 `prefix === 'packages/' + 目录名`，
  故 shared 侧也必须是 `packages/` 下一个目录。
- **上游 `repository.directory`** 需改为本仓库对应路径，否则 OIDC provenance 被拒。
- **`package.json` 属 owned**：其 `name` 被我方改造，同步不会带入上游新增依赖；
  `sync-upstream.mjs` 已有「上游新增依赖」的预检拦截。

## 3. 验证

| 检查 | 判据 |
|---|---|
| 聚合生成物一致 | `node scripts/aggregate.mjs --check` 无 drift |
| 全仓测试 | `pnpm test` 通过 |
| 全仓类型检查 | `pnpm typecheck` 通过 |
| 插件自测 | fork 后 `npm test` = 73 pass / 0 fail |
| 生成器可用 | 改后的 `sync.mjs` 产出 20 个 shared 模块，12 个 import 全可解析 |
| 收养内容中性 | 收养前后 `git diff --stat` 对 `packages/<pkg>` 无输出 |
| 同步不炸 | 对既有 5 个 fork 跑 `node scripts/sync-upstream.mjs --dry-run`，行为与改造前一致 |
| 配置真源 | 断开 ovcli.conf 后，插件实际连接的 baseUrl 等于 patch 行配置值 |
| patch 行 id 唯一 | 人工比对全仓 `cordis.patch.yml` 无重复 `id` |

## 4. 风险

| 风险 | 说明 |
|---|---|
| **同步设施改动影响既有 5 个 fork** | 风险最高。`subdir` 为可选字段，既有 policy 不填即走原路径；需用 `--dry-run` 逐目标回归。 |
| **删除 ovcli.conf 不可逆** | 该文件含明文 API Key，删除前须备份或确认可重建。**须用户确认**。 |
| **`plugin` 段反压仍在** | 若用户日后重建带 `plugin` 段的 ovcli.conf，调参项会再次被反压。计划文档需说明此陷阱。 |
| **`baseUrl` 别名静默失效** | 误用 `baseUrl` 不会报错，只会静默回落到 ovcli.conf。patch 行必须写 `endpoint`。 |
| **shared 与插件版本错配** | 两者独立同步，可能一个已升、一个未升。需在验收里比对两者的上游 tag。 |
| **upstream 结构再变** | 上游若再次调整 `examples/` 布局或删除生成器，同步与生成都会断。 |

## 5. 范围外发现（只报告，不修）

1. `~/.openviking/state` 有 13 个 `ws-identity-*.json`，属运行时状态，本次不处理。
2. config-manager 的 `pluginFiles` 分区数据源限定 `~/.dsh` 根下，够不到 `~/.openviking`。
   若最终选择「插件配置在 patch 行」，则该分区**无需扩展**（patch 层同步已覆盖）。
3. 上游 `sync.mjs` 的 `SKILLS_DIR` 指向第三个兄弟目录 `examples/skills`，改造时须一并处理。

## 6. 未决问题

1. **是否删除 `~/.openviking/ovcli.conf`**：需用户明确授权（属改动既有文件）。
2. **shared 包名与目录名**：暂定 `packages/dsh-openviking-shared`，待定。
3. **插件包名**：暂定 `packages/dsh-openviking`，待定。
4. **patch 行 id**：暂用上游 `openviking-memory`，需与全仓比对确认不撞车。
5. **apiKey 明文落盘位置**：写入 profile patch 行意味着明文存在于
   `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。**须用户确认此存储方式**，
   并明确该文件是否纳入版本控制。

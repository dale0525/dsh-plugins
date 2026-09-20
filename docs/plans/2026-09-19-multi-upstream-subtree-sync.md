# 全部子插件改为上游 fork + 定时同步

> 事前冻结的计划。实施中若偏离，以实际代码为准并回填 §12。

## 已冻结的裁定（用户 2026-09-19）

| # | 议题 | 裁定 |
|---|---|---|
| 1 | 范围 | **本仓库 `packages/` 下 5 个子插件**（不含 profile 内未入库的其它插件） |
| 2 | policy 布局 | **每包一份** `packages/<pkg>/sync-policy.json`（含 config-manager 迁移，删根文件） |
| 3 | 历史策略 | **全量历史**（不用 `--squash`） |

## 0. 结论摘要

1. **四个新子插件当前都不是 fork**，是「从本机安装副本整目录拷进来」的普通提交（`4a051e9`）。它们**没有上游祖先**，因此 `git subtree pull` 直接失败（`refusing to merge unrelated histories`，§3 实测）。
2. **四个上游身份已全部查实**（§2.1）。四个包各自基于**与本地 `package.json` 版本号一致的那个 tag**（§2.2 反证）。
3. **不能只加配置就完事**：需要先做一次性「收养」（adoption）建立 subtree 祖先，再把现有的单目标同步设施（`sync-policy.json` + `scripts/sync-upstream.mjs` + `sync-upstream.yml`）**泛化为多目标**。
4. **收养配方已端到端验证通过**（§5，`/tmp/clean` 真实 spike）：收养后 `subtree pull` 能正确带入上游新文件、保留我方改造、按 policy 归零冲突。
5. **收养必须是「内容中性」的**——这是本计划最强的验收不变量（§5.3）。
6. 两个既有设计缺口在放大到 4 个包后必须一并修掉：`added` 清单的静默覆盖风险（§6.2）、`package.json` 被 `owned` 后上游新增依赖不会带入（§10.2）。
7. **根因在流程，不在四个包**：`docs/adding-a-child-plugin.md` 缺「必须先收养上游」这一步。不补上，下一个从别处上游引入的插件会重演同一问题（§15）。

## 1. 目标、范围与不做什么

**目标**：`packages/` 下**有上游**的子插件都是对应上游的 fork，保留上游历史，并能像 `dsh-config-manager` 一样**每天定时从上游同步**（只开 PR，绝不直推 main）。**自制的插件（无上游）不在此列**——它们不 fork、不参与同步，本计划的收养与同步设施对它们不适用。

**范围**：本仓库 `packages/` 下的 5 个子插件。

| 包目录 | 上游 | 现状 |
|---|---|---|
| `dsh-config-manager` | `xiajiajun516/dsh-config-manager` | **已完成**（subtree，已有定时同步） |
| `dsh-workbuddy-connect` | `corrinehu/dsh-workbuddy-connect` | 待收养 + 待接入同步 |
| `dsh-easyrewrite` | `Renzic-Stone/DSH-EasyRewrite` | 待收养 + 待接入同步 |
| `dsh-market` | `dsh-market/dsh-market` | 待收养 + 待接入同步 |
| `dsh-imagegen` | `dickpy/dsh-imagegen` | 待收养 + 待接入同步 |

**不做什么**（已按裁定冻结）：

- **不**收编 profile 里其它未入库的插件（`dsh-pet` / `dsh-global-rules` / `dsh-better-reasoning-effort` / `dsh-plugin-sandbox-escalation-fix` / `@openviking/dsh-memory-plugin`）。它们各自有上游（§13 附录 A 已列），但**不在本仓库 `packages/` 内**，属另一个议题。（`dsh-agy-link` 曾在此列，后已单独收养，见附录 A 注。）
- **不**改各包的对外行为、不改 `name` / patch 行 `id` / 路由 / settings 命名空间（既有改名不变量，见仓库 `AGENTS.md`）。
- **不**重写 Git 历史（§2 禁区）。收养只**新增**提交。

## 2. 现状取证（全部实测，非推断）

### 2.1 四个上游的身份与基线

用 npm registry 反查原始包名与仓库（本地 `package.json` 的 `repository` 已改指本仓库，上游信息被抹掉，故必须外部取证）：

| 包目录 | 上游仓库 | 基线 tag | tag commit | peeled | 上游活跃度 |
|---|---|---|---|---|---|
| `dsh-workbuddy-connect` | `corrinehu/dsh-workbuddy-connect` | `v0.5.4` | `a4ea176a` | `edbc41c9` | 135★ / 15 tags / 最近推送 09-17 |
| `dsh-easyrewrite` | `Renzic-Stone/DSH-EasyRewrite` | `v2.5.4` | `b7192a76` | `ecd336ec` | 115★ / 42 tags / 最近推送 09-18 |
| `dsh-market` | `dsh-market/dsh-market` | `v1.48.0` | `6555495d` | `6e4b8041` | 4177★ / 100 tags / 最近推送 09-19 |
| `dsh-imagegen` | `dickpy/dsh-imagegen` | `v1.5.13` | `5b492f9c` | （轻量 tag，无 peel） | 81★ / 37 tags / 最近推送 09-19 |

四个上游均为 MIT / Apache-2.0，各包内已有 `LICENSE`。**上游最新 tag 与本地版本对照**：三个已对齐（`v0.5.4` / `v2.5.4` / `v1.48.0`），**imagegen 落后一个版本**（本地 1.5.13，上游已 `v1.6.0`）——首次真实同步就会拉 `v1.6.0`。

### 2.2 本地副本的真实来源（基线判定的反证）

本地副本**不是**上游 tarball 的原样拷贝，也**不是** npm 包的原样拷贝，而是「上游某版本 + 我方改造」。用「与 tag 的差异数 vs 与 main 的差异数」反证基线：

| 包 | vs 基线 tag | vs 上游 main | 结论 |
|---|---|---|---|
| `dsh-workbuddy-connect` | 14 differ | 17 differ | main 领先于 tag，本地基于 **tag** |
| `dsh-easyrewrite` | 5 differ | 7 differ | 同上 |
| `dsh-market` | 19 differ | 18 differ | 同上 |
| `dsh-imagegen` | 11 differ | 20 differ | main 已到 v1.6.0，本地基于 **v1.5.13** |

**我方改造确实存在，不是纯改名**（三条独立证据）：

1. `packages/dsh-market/src/self-names.ts` —— 在**上游任何来源里都不存在**（tag `v1.48.0`、`main`、npm `dshmarket@1.48.0` 全部无此文件；`grep -c self-names` 于上游 `src/routes.ts` 为 0）。它是为 fork 改名写的「三个拼写都认」模块。
2. `packages/dsh-workbuddy-connect/src/index.ts` 用 `provider` 措辞，上游 tag 与 main 都用 `card`（差异全在注释，但确实是我们的编辑）。
3. `packages/dsh-workbuddy-connect/tests/slot-registration.spec.ts` 151 行差异，内容是 **DSH 0.1.6 的槽位迁移**（`settings.plugin.item` → `plugins.row.config`）——上游代码里没有这段。

### 2.3 现有同步设施是单目标的（硬证据）

- `sync-policy.json` 的 `upstream` 是**标量对象**（`url` / `prefix` / `baseline` / `baselineCommit`），`owned` / `deleted` / `added` 是**一组**包相对路径。结构上只能表达一个目标。
- `scripts/sync-upstream.mjs` 全文只读 `policy.upstream`（第 72–78 行），`full()` 拼单一 `PREFIX`。
- `.github/workflows/sync-upstream.yml` 只有一个 job，`cron: '17 3 * * *'`，PR 标题写死 `sync upstream dsh-config-manager`。
- 四个新包在同步体系里**零存在感**：workflow 里 grep 不到任何一个；各自目录内无 `.github/`、无 sync 脚本；无 subtree merge commit（只有 `6cf5a6d` / `03aca60` 两条 config-manager 的）。

### 2.4 本地副本相对上游基线的改动面（policy 初始清单的来源）

只统计**被 git 跟踪**的文件（policy 的实际口径），上游侧排除 `.git` / `node_modules` / `lib`。完整清单见 §9。

| 包 | owned（内容不同） | deleted（仅上游有） | added（仅本地有） |
|---|---|---|---|
| `dsh-workbuddy-connect` | 14 | 7 | 1 |
| `dsh-easyrewrite` | 5 | 13 | 1 |
| `dsh-market` | 19 | 24 | 2 |
| `dsh-imagegen` | 11 | 18 | 0 |
| **合计** | **49** | **62** | **4** |

`deleted` 的构成高度一致，全是**宣传面与上游 CI**：`assets/*.png`、`docs/images/*`、`.github/**`、`pnpm-lock.yaml` / `pnpm-workspace.yaml`、`dsh-plugin-sync.ps1`、`client/client.js`（market，产物）。

## 3. 核心障碍：四个包没有 subtree 祖先（实测）

`git subtree pull` 需要共同祖先做三方合并。四个包是普通提交导入的，**没有祖先**，因此：

```
$ git subtree pull --prefix=packages/pkga <upstream> v1.0.0
fatal: refusing to merge unrelated histories
```

`--squash` 也不行（`fatal: can't squash-merge: 'packages/pkga' was never added.`）。

**必须先用 `git subtree add` 建立祖先**——而 `subtree add` 要求该 prefix **当前不存在**，所以要先把目录移开再以基线 tag 加回来。

> **反例（实测的陷阱）**：用 `git merge -s ours --allow-unrelated-histories <upstream>` 也能让祖先存在、命令不报错，但随后 `subtree pull` **静默 no-op**（`Already up to date.`）——因为 `merge -s ours` 没有建立 `git subtree` 需要的 split/映射元数据。**这条路径已否掉**（§4.2）。

## 4. 方案选型

### 4.1 为什么仍选 subtree

与 `dsh-config-manager` 的既有选择一致，理由是它在 §3 的约束下**仍然成立且唯一**：

1. **只有它能区分「上游改的」与「我改的」**。四个包合计 49 个 owned 文件、62 个 deleted，这个区分能力是刚需；tarball 覆盖没有这个概念。
2. **冲突可预测**：冲突文件 = 我们改过的 ∩ 上游改过的。
3. **历史可追溯**：`git log packages/<pkg>` 能同时看到上游 commit 与我方 policy 合并。
4. **`subtree add` 能建立祖先**，正是 §3 所缺的。

**真实价值边界（必须说清，避免预期错位）**：我们砍掉了大量上游文件，**这个同步不带来「版本对齐」**。它唯一的价值是：**把上游在「我们保留的文件」里的 bug 修复拉进来**（如 `src/routes.ts`、`src/index.ts`、`src/client/index.ts` 这些既在上游高频改动、又被我们改过的文件）。请按这个预期使用。

### 4.2 被否掉的候选方案

| 候选 | 否掉的原因（均为实测或硬约束） |
|---|---|
| **上游 tarball 解包覆盖** | 无三方合并概念：我方 49 个 owned 文件的改造会被整片覆盖，且没有任何机制报错。要救只能靠人工全量 diff。 |
| **`git merge -s ours --allow-unrelated-histories` 建祖先** | 实测**静默 no-op**：祖先看似存在，`subtree pull` 报 `Already up to date` 却什么都没拉。故障无声，比报错危险。 |
| **`subtree pull --squash` 建祖先** | 实测报 `can't squash-merge: '<prefix>' was never added.` —— prefix 未被 subtree 记录过，squash 路径同样要求先 `add`。 |
| **npm 包（tarball）作为上游源** | npm 包只含 `lib/` 等发布子集（easyrewrite 8 个文件、workbuddy 11 个），**没有 `src/` 与 `tests/`**，无法做源码级同步。 |
| **继续维持「拷贝安装副本」** | 就是现状：无祖先、无同步、每次上游更新只能人工重拷，且会再次丢掉我方改造。 |

### 4.3 全量历史 vs squash（已裁定：全量历史）

| 维度 | 全量历史（**采用**） | `--squash`（不用） |
|---|---|---|
| 上游 commit 数（四包合计） | **980**（124 + 236 + 527 + 93） | 1/次同步 |
| `git log packages/<pkg>` | 可见上游全部历史 | 只有「某次覆盖」 |
| 三方合并能力 | 有 | 有（实测同样能带入新文件、同样报冲突） |
| 仓库体积 | 增量估算 +30–40MB（market 裸克隆实测 18MB，现 `.git` 12MB） | 极小 |
| 与 config-manager 一致性 | 一致（它是全量） | 不一致 |

**采用全量历史**：与既有 `dsh-config-manager` 的形态一致，保留 `git log` 可追溯性（这是 §4.1 理由 3 的兑现）。收养与同步命令**均不加** `--squash`。

## 5. 收养配方（已在 `/tmp/clean` 端到端验证）

### 5.1 逐包步骤

对四个包**各做一次**。以 `dsh-market`（`<PKG>`、`<URL>`、`<BASE_TAG>` 代入 §2.1 的值）为例：

```bash
# 0) 只备份「被跟踪」的文件（不碰 lib/ 与 node_modules/）
git ls-files -z packages/dsh-market | tar --null -T - -cf /tmp/adopt-market.tar

# 1) 移开目录（subtree add 要求 prefix 不存在）
git rm -r packages/dsh-market
git commit -m "chore(market): 暂离 plain-import 目录，准备 subtree 收养"

# 2) 以基线 tag 建立 subtree 祖先（带入上游历史）
git subtree add --prefix=packages/dsh-market \
  https://github.com/dsh-market/dsh-market v1.48.0

# 3) 恢复我方版本
mkdir -p /tmp/adopt-market && tar -xf /tmp/adopt-market.tar -C /
#    （tar 内路径已是 packages/dsh-market/...，解到仓库根即可）

# 4) 关键：重删上游专有文件 —— 否则上游的 .github/ 与宣传图会被带进仓库
git rm -f --ignore-unmatch -- <§9 的 deleted 清单，逐个加 packages/dsh-market/ 前缀>

# 5) 提交
git add -A
git commit -m "chore(market): 恢复我方改造（subtree 收养基线对齐）"
```

> **第 4 步不可省**。`subtree add` 会把上游**全部**文件放进工作区；第 3 步只恢复了我方版本，上游专有文件仍然在。实测中这一步漏掉会让 `up-only.txt` 之类的文件被 `git add -A` 提交进仓库。

### 5.2 收养后首次同步（验证配方有效）

实测在收养后的树上执行 `subtree pull` 到下一个 tag：

- 上游**新增**文件被正确带入（`new2.txt` ✓）
- 我方**改造**被保留（`file.txt` = `OUR EDITED` ✓、`src/main.ts` = `our src` ✓）
- 冲突经 policy 三步（`--theirs` → `--ours` → `git rm`）归零，`grep -rl '<<<<<<<'` 无输出 ✓

### 5.3 最强验收不变量：收养必须「内容中性」

收养**只应改变 Git 的祖先关系，不应改变任何一个字节的工作区内容**。

**判据**：取收养前最后一个提交 `B` 与收养完成后（含第 4 步）的提交 `A`，要求

```bash
git diff --stat B A -- packages/<PKG>    # 必须无输出
```

这条判据能一次性抓住：漏做第 4 步（上游文件被带入）、恢复我方版本不完整、`deleted` 清单漏项。**四个包逐包检查，全部必须为空**。

## 6. `sync-policy.json` 多目标化

### 6.1 已裁定：policy 跟随包（`packages/<pkg>/sync-policy.json`）

把单一根 `sync-policy.json` 拆成**每包一份**，放在该包目录内。理由：

1. **归属**：policy 描述的就是这个 fork，与仓库既有的「文档/资产跟随其描述对象」原则一致。
2. **`--refresh-policy` 变成局部写**：只重写一个包的文件，不会在 5 个包的清单之间产生无关 diff。
3. **PR 粒度天然对齐**：一次同步只碰一个包的 policy 文件。
4. **避免巨型文件**：单包 policy 已约 300 行，5 个包合并成一个 JSON 会到 1500 行量级。

单包 schema（在现有结构上包一层 `target` 元数据，字段语义不变）：

```json
{
  "_comment": ["…（保留现有说明，改为单包口径）…"],
  "target": {
    "id": "market",
    "url": "https://github.com/dsh-market/dsh-market",
    "prefix": "packages/dsh-market",
    "baseline": "v1.48.0",
    "baselineCommit": "6e4b8041a697ff12bba7800bca820e7186b76b1c"
  },
  "owned":   ["…"],
  "deleted": ["…"],
  "added":   ["…"]
}
```

`dsh-config-manager` 的根 `sync-policy.json` **一并迁移**（否则存在两套口径）；迁移后删除根文件（§2 激进清理：新版本是唯一真源）。仓库 `AGENTS.md` 中所有 `sync-policy.json` 的引用需同步改为 `packages/<pkg>/sync-policy.json`。

**考虑过的替代**：保留单一根文件、把 `upstream` 改成 `upstreams` 数组、每个元素内嵌自己的 `owned/deleted/added`。改动更小（脚本只读一个文件），但会得到 ~1500 行、5 个包混在一起的清单，且每次 `--refresh-policy` 都重写整份文件。**不推荐**；若倾向低改动量，这条可回退。

### 6.2 `added` 清单必须参与「冲突检测」（修既有缺口）

现状：`added` 是**只写**字段——`--refresh-policy` 会算并落盘，但 apply 流程（第 2/3/4 步）**从不读它**。对 config-manager 无实际影响（其 `added` 是一个测试文件），但放大到 4 个包后，`packages/dsh-market/src/self-names.ts` 这类**核心模块**在 `added` 里，风险变成真实：

> 若上游**将来**引入同名路径（`src/self-names.ts` 并非不可能），`git checkout --theirs` 会用上游版本覆盖我方文件，而第 3 步只恢复 `owned`，**我方模块被静默替换**。

**修正**：apply 时对 `added` 做**显式冲突检测**——若某个 `added` 路径在本次合并中出现在上游侧，**直接 fail（退出码 2）并列出该路径**，交人工裁定。既不能静默保留我方（可能丢上游新实现），也不能静默采用上游（丢我方模块），**必须报出来**。

## 7. `scripts/sync-upstream.mjs` 多目标化

### 7.1 CLI

| 用法 | 语义 |
|---|---|
| `--list` | 列出所有发现的 target（id / url / baseline / 清单条数），零写入 |
| `--dry-run [--target <id>]` | 打印计划；无 `--target` = 全部 |
| `--target <id>` | 只同步该目标 |
| （无参数） | 同步**全部**目标（本地用；CI 用 matrix 逐目标调，见 §8） |
| `--refresh-policy [--target <id>]` | 重算并写回该目标的 policy 文件 |
| `--baseline <commit>` | 仅 `--refresh-policy` 用；缺省读该目标的 `target.baselineCommit` |

**目标发现**：glob `packages/*/sync-policy.json`，`id` 取 `target.id`。找不到任何 policy → 退出码 1。

### 7.2 需要改的函数

| 位置 | 现状 | 改为 |
|---|---|---|
| 第 64–78 行 | 读单一 `policy.upstream`，`OWNED/DELETED` 为全局常量 | 读全部 target；每个 target 一组 `OWNED/DELETED/ADDED`，随 target 传入 |
| `full()` 第 81 行 | 闭包引用单一 `PREFIX` | `full(target, rel)` |
| `resolveRef()` 第 102 行 | 用全局 `URL` 取最新 tag | 按 target 的 `url` 各取各的（tag 前缀都是 `v`，可直接复用） |
| `assertCleanWorktree()` | 全局 | 不变（多目标串行执行时必须每步后仍干净） |
| `classifyConflicts()` 第 210 行 | 用全局 `DELETED` | 用当前 target 的 `DELETED` |
| `refreshPolicy()` 第 136 行 | 写单一 `POLICY_PATH` | 按 target 写 `packages/<pkg>/sync-policy.json` |
| 分支名 第 239 行 | `sync-upstream/<ref>-<ts>` | `sync-upstream/<id>-<ref>-<ts>`（**matrix 下必须唯一**） |

### 7.3 必须保留的不变量（回归风险最高）

- **顺序铁律**：`--theirs` → `--ours` → `git rm`。顺序反了会让我们的改造被上游覆盖（既有 spike 已证）。多目标化时**每个 target 内部**仍严格保持这个顺序。
- **无冲突也必须走完 2/3/4**：git 的自动合并不会重删我们删过的文件，也不会恢复被上游覆盖的我方改造（既有注释已写明）。
- **归零判据用「工作区无冲突标记」+「`git add` 后索引无 unmerged」**，不是 checkout 之后的 diff 状态（`checkout` 只改工作区，索引要 `add` 才收敛）。
- **退出码**：0 成功 / 1 参数环境 / 2 冲突未归零 / 3 git 失败。

## 8. `.github/workflows/sync-upstream.yml` 多目标化

改为 **matrix over targets**，每个目标一个 job：

```yaml
strategy:
  fail-fast: false          # 一个目标失败不拖垮其余
  matrix:
    include:
      - id: config-manager
        pkg: '@logictan/dsh-config-manager'
        test: 'pnpm --filter @logictan/dsh-config-manager test'
      - id: workbuddy
        pkg: '@logictan/dsh-workbuddy-connect'
        test: 'pnpm --filter @logictan/dsh-workbuddy-connect test'
      - id: easyrewrite
        pkg: '@logictan/dsh-easyrewrite'
        test: 'pnpm --filter @logictan/dsh-easyrewrite test'
      - id: market
        pkg: '@logictan/dshmarket'          # ← 注意：包名无连字符
        test: 'pnpm --filter @logictan/dshmarket test'
      - id: imagegen
        pkg: '@logictan/dsh-imagegen'
        test: 'pnpm --filter @logictan/dsh-imagegen typecheck'   # 该包无 test 脚本
concurrency:
  group: sync-upstream-${{ matrix.id }}    # ← 每目标独立，避免互相取消
  cancel-in-progress: false
```

其余保持现状：`schedule`（`'17 3 * * *'`）、`workflow_dispatch`、第三方 action 锁 SHA、`fetch-depth: 0`（subtree 要共同祖先）、`pnpm/action-setup` 显式 `version`、`peter-evans/create-pull-request` 只开 PR 不推 main、`delete-branch: true`。

**每 job 的步骤**：checkout → setup pnpm/node → git identity → **校验该 target 的 policy**（`url`/`prefix`/`baseline` 非空）→ `node scripts/sync-upstream.mjs --target <id>` → `pnpm install --frozen-lockfile=false` → 该包的 typecheck/test → 开 PR（标题带 `<id>`）。

**启用时机**：必须在 §5 收养**全部完成**后再启用定时。否则 cron 会对未收养的目标反复失败。实施顺序上建议：收养 → 手工 `workflow_dispatch` 验证 → 再放开 `schedule`。

## 9. 各包初始 policy 清单

以下为**计划时点的实测值**。实施时必须用 `--refresh-policy` 重新生成并以此为准（脚本按当前 fork 状态重算，是唯一真源）。路径均为**包相对**。

### 9.1 `dsh-workbuddy-connect`（baseline `v0.5.4`）

- **owned（14）**：`.gitignore`、`cordis.patch.yml`、`package.json`、`src/index.ts`、`src/client/index.tsx`、`src/client/locales.ts`、`src/client/WorkBuddyPluginCard.tsx`、`src/client/WorkBuddyProbeControl.tsx`、`tests/slot-registration.spec.ts`、`tests/settings-integration.spec.ts`、`tests/catalog-lifecycle.spec.ts`、`tests/client-fallback.spec.ts`、`tests/reasoning-merge.spec.ts`、`tsdown.config.ts`
- **deleted（7）**：`assets/1.png`、`assets/2.png`、`assets/3.png`、`assets/4.png`、`assets/5.png`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`
- **added（1）**：`src/client/WorkBuddyPluginConfig.tsx`

### 9.2 `dsh-easyrewrite`（baseline `v2.5.4`）

- **owned（5）**：`.gitignore`、`build.mjs`、`cordis.patch.yml`、`package.json`、`src/client.src.js`
- **deleted（13）**：`assets/logo.png`、`assets/logo-dark.png`、`docs/_removed-drop-block.txt`、`docs/images/bubble-edit-active.png`、`docs/images/bubble-edit-images.png`、`docs/images/bubble-edit-model-select.png`、`docs/images/drag-drop-dual-dropzone.png`、`docs/images/message-hover-actions.png`、`docs/images/recall-confirm-capsule.png`、`docs/images/recall-editing.png`、`docs/images/settings-panel-1.png`、`docs/images/settings-panel-2.png`、`docs/images/version-pager.png`
- **added（1）**：`src/index.js` ⚠️ **待核实**：上游 `src/` 只有 `client.src.js`，无 `index.js`；本地这个文件是 550+ 行的 node 半边源码。需在实施时确认它是**我方手写**（则应保持 `added`）还是**误入库的构建产物**（则应 `git rm --cached` 并加 `.gitignore`）。

### 9.3 `dsh-market`（baseline `v1.48.0`）

- **owned（19）**：`.gitignore`、`cordis.patch.yml`、`package.json`、`scripts/check-web-auth-capture.mjs`、`src/routes.ts`、`src/groups.ts`、`src/presets.ts`、`src/pnpm-compat.ts`、`src/region-probe.ts`、`src/verify.ts`、`src/client/index.ts`、`src/client/locales.ts`、`src/client/MarketSection.tsx`、`src/client/SettingsCard.tsx`、`src/client/market-data.ts`、`tests/dsh-cli.spec.ts`、`tests/client/market-section.client.spec.tsx`、`tests/client/settings-card.client.spec.tsx`、`tsdown.config.ts`
- **deleted（24）**：`.gitattributes`、`.github/ISSUE_TEMPLATE/bug_report.yml`、`.github/ISSUE_TEMPLATE/config.yml`、`.github/ISSUE_TEMPLATE/feature_request.yml`、`.github/PULL_REQUEST_TEMPLATE.md`、`.github/workflows/build-site.yml`、`.github/workflows/ci.yml`、`.github/workflows/release.yml`、`assets/demo-en.png`、`assets/demo-zh.png`、`assets/logo-512.png`、`assets/logo-mono.svg`、`assets/themes-en.png`、`assets/themes-zh.png`、`assets/wordmark-dark.svg`、`client/client.js`、`site/assets/demo-en.png`、`site/assets/demo-zh.png`、`site/assets/logo-512.png`、`site/assets/pr-primitives.png`、`site/assets/settings-en.png`、`site/assets/settings-zh.png`、`site/assets/themes-en.png`、`site/assets/themes-zh.png`
- **added（2）**：`src/self-names.ts`、`tests/self-names.spec.ts`

> `client/client.js` 是构建产物：本仓库 `.gitignore` 用 `/client/`（前导斜杠是承重的，去掉会连 `src/client/` 与 `tests/client/` 一起吞掉）。它进 `deleted` 后，`git add -A` 不会把它加回来。

### 9.4 `dsh-imagegen`（baseline `v1.5.13`）

- **owned（11）**：`.gitignore`、`README.md`、`cordis.patch.yml`、`package.json`、`scripts/smoke.mjs`、`src/updater.ts`、`src/client/index.ts`、`src/client/locales.ts`、`src/client/ImageGenPanel.tsx`、`src/client/SettingsCard.tsx`、`tsdown.config.ts`
- **deleted（18）**：`.github/ISSUE_TEMPLATE/bug_report.yml`、`.github/ISSUE_TEMPLATE/config.yml`、`.github/ISSUE_TEMPLATE/feature_request.yml`、`docs/images/community-qq.png`、`docs/images/ecommerce-mode.png`、`docs/images/gallery-workspace.png`、`docs/images/image-generation-studio-four.png`、`docs/images/image-generation-studio-three-column.png`、`docs/images/imagegen-overview.png`、`docs/images/infinite-canvas-demo.gif`、`docs/images/infinite-canvas.png`、`docs/images/multi-model-comparison.png`、`docs/images/plugin-settings.png`、`docs/images/prompt-template-library.png`、`docs/videos/agent-chat-edit.gif`、`docs/videos/agent-chat-edit.mp4`、`dsh-plugin-sync.ps1`、`pnpm-lock.yaml`
- **added（0）**

> 上游另有 `src/client/config-entry.tsx` 属 deleted（上游有、我方无）。**该文件被上游在 v1.6.0 迭代过**，首次同步需重点看它是否已被我方逻辑取代。

## 10. 风险与雷区

### 10.1 收养期间的

| 风险 | 后果 | 对策 |
|---|---|---|
| 漏做 §5.1 第 4 步 | 上游 `.github/`、宣传图、`pnpm-lock.yaml` 被提交进仓库 | §5.3 内容中性判据逐包卡 |
| 用 `merge -s ours` 建祖先 | `subtree pull` 静默 no-op，同步永不生效 | §4.2 已否掉；收养后必须用 §5.2 验证「上游新文件确实被带入」 |
| `cp -R` 备份带入 `node_modules` / `lib` | 备份体积爆炸、可能污染工作区 | 用 `git ls-files` + `tar` 只备份被跟踪文件（§5.1 第 0 步） |
| 五个包的 subtree 历史一次全拉 | 单次操作耗时长、`.git` 增长 ~30–40MB | 逐包独立提交，可中断续做；体积不可接受时切 `--squash`（§4.3） |

### 10.2 `package.json` 被 `owned` 导致上游新增依赖不会带入（**本计划新增的必修项**）

四个包的 `package.json` 都在 `owned` 里（因为要改 `name` / `repository`），因此**上游新增运行时依赖时，同步不会把它加进来**——源码被同步成上游版本，但依赖缺失，症状是构建失败或运行时 `Cannot find module`。这是四个包里**最容易漏、后果最直接**的失败模式。

**对策**：同步流程中加一步**依赖差异检查**——把该 target 基线/新 tag 的 `package.json` 的 `dependencies`（必要时含 `peerDependencies`）键集合与我方对比，**上游有我方没有的键就报出来**（写入 PR 正文，或直接让脚本以非 0 退出）。这是小改动，但覆盖了一整类静默故障。

### 10.3 版本号与自更新器

- **版本号不同步是有意的**：同步上游 `v1.6.0` 后，我方 `package.json` 版本**仍是自己的版本线**（如 `1.5.13`），因为发布的是 `@logictan/*`。上游版本只记录在 policy 的 `baseline` / `baselineCommit` 里。**不要**让同步脚本自动 bump 版本（发布是另一件事）。
- **`dsh-imagegen` 有自更新器**（`src/updater.ts`）：`RELEASES_URL = https://api.github.com/repos/dale0525/dsh-plugins/releases/latest`，`PACKAGE_NAME = '@logictan/dsh-imagegen'`，并会执行 `dsh plugin --profile <p> add @logictan/dsh-imagegen@<version>`。
  - **当前是惰性的**：本仓库**没有任何 GitHub Release**（`releases/latest` 返回 `Not Found`），也没有 git tag。
  - **一旦开始发版要当心**：`git push origin v*` 只创建 tag，**不创建 Release**；只有 Release 存在时该 updater 才会动作。若将来创建 Release，它会尝试把用户装到最新版本——行为本身对 fork 是**正确**的，但要确保 `PLUGIN_VERSION` 与发布版本一致。
  - **版本常量耦合**：`packages/dsh-imagegen/src/protocol.ts` 的 `PLUGIN_VERSION`（当前 `'1.5.13'`）**必须**与 `package.json` 的 `version` 一致；config-manager 的 `src/index.ts` 同理（`PLUGIN_VERSION = '0.1.60'`）。同步上游**不**改这两个常量，但**发布前**必须人工确认二者一致。
- **`dsh-market` 有更新检查**（`src/updates.ts`，查 `registry.npmjs.org` 的 `latest`）与 `src/self-names.ts` 的三拼写识别（`dshmarket` / `dsh-market` / `@logictan/dshmarket`）——它是 fork 改名的正确实现，同步时**必须保持 `owned`**，否则被上游版本覆盖会让市场认不出自己。

### 10.4 上游 CI 与宣传面

`deleted` 里大量是上游 `.github/**` 与 `assets/*.png` / `docs/images/*`。这是**有意**的：本仓库自用，不承担上游 listing 的宣传面。**但每次上游新增宣传图或 CI 文件，`--refresh-policy` 都会把它们列入 `deleted`**——这是预期行为，不是缺陷；但若上游新增的是**功能件**（被 `README` 或站点 HTML 引用、或构建输入），误删会破坏构建。既有先例：easyrewrite 的 `assets/{edit,recall}.png` 是 `build.mjs` 的 base64 内联输入，**必须入库**；market 的 4 个 SVG 被 README 与站点引用，属功能件。

**对策**：每次同步后，对新增的 `deleted` 条目做一次「是否被代码/构建引用」的快速判断（`git grep <文件名>`）。

### 10.5 其它

- **`@deepseek-ai/dsh-client-ui-slots` 版本必须全仓库一致**：不一致会让 `keyof SlotMap` 塌成 `never`，`typecheck` 报 `'plugins.row.config' does not satisfy the constraint 'never'`，而**运行时完全正常**。新增/同步包时若上游升级了该依赖，需对齐到宿主当前世代（工作区 `pnpm-workspace.yaml` 已有 `overrides` 收敛机制）。
- **`dsh-market` 的包名是 `@logictan/dshmarket`（无连字符）**，`--filter` 与 matrix 里写错会静默跳过测试。
- **`dsh-imagegen` 没有 `test` 脚本**：它的同步只能用 `typecheck` + `build` 兜底，是四个包里**验收最弱**的一个（见 §11）。

## 11. 验收

### 11.1 收养阶段（逐包）

| 检查 | 判据 |
|---|---|
| **内容中性** | `git diff --stat <收养前> <收养后> -- packages/<pkg>` **无输出** |
| 祖先已建立 | `git subtree pull --prefix=packages/<pkg> <url> <baseline-tag>` 报 `Already up to date`（而非 `unrelated histories`） |
| 上游历史可见 | `git log --oneline packages/<pkg> \| wc -l` 显著大于我方提交数 |
| 工作区干净 | `git status --porcelain` 无输出 |

### 11.2 同步阶段（每目标）

| 检查 | 判据 |
|---|---|
| policy 可重算 | `node scripts/sync-upstream.mjs --refresh-policy --target <id>` 后 `git diff` 仅该包 policy 文件变化 |
| dry-run 可用 | `--dry-run --target <id>` 打印步骤与清单，零写入 |
| 首次真实同步 | 对落后一个版本的 `dsh-imagegen` 同步到 `v1.6.0`：上游新文件带入、我方 11 个 owned 文件保持我方版本、冲突归零 |
| 各包门禁 | `workbuddy`：`typecheck` + `vitest run`；`easyrewrite`：3 个 node 测试 + `build`；`market`：`typecheck` + `vitest run` + `build`；`imagegen`：`typecheck` + `build`（无 test） |
| 聚合未破 | `node scripts/aggregate.mjs --check` 无 drift |
| 全仓库 | `pnpm -r typecheck` 退出码 0；`npm test`（根）通过 |
| workflow | `workflow_dispatch` 手动触发，5 个 job 各自开出 PR；`fail-fast: false` 下单个失败不影响其余 |
| 运行时 | `dsh-web restart` 后 `dsh-web status` 输出 `Verdict:  OK`，5 个插件行仍可解析 |

### 11.3 实施前的前置门禁（重要）

**收养前必须先跑通各包现有测试**，否则同步后的失败无法归因（分不清是同步引入的还是本来就红）。若某个包在收养前就是红的，先修或先记录基线，再收养。

## 12. 待办与派单

切片单位是「一次可独立验证的改动」。**外派**需同时满足：①有可独立判定的验收契约；②与其它切片的共享触点 ≤ 2。

| # | 任务 | 验收契约 | 归属 | 理由 |
|---|---|---|---|---|
| T0 | 跑通四包基线门禁并记录 | 各包 `typecheck`/`test` 基线结果留档 | Root | 前置；无独立契约，是后续一切归因的基准 |
| T1 | 收养 `dsh-workbuddy-connect` | §5.3 内容中性 + §11.1 | **外派** | ①契约 = 内容中性 diff 为空 + 祖先建立；②触点 = 仅该包目录 + 自己的 policy 文件 |
| T2 | 收养 `dsh-easyrewrite` | 同上（含 §9.2 的 `src/index.js` 定性） | **外派** | 同上 |
| T3 | 收养 `dsh-market` | 同上 | **外派** | 同上 |
| T4 | 收养 `dsh-imagegen` | 同上 | **外派** | 同上 |
| T5 | policy 多目标化（拆分为 `packages/<pkg>/sync-policy.json`，含 config-manager 迁移 + 删根文件 + 改 `AGENTS.md` 引用） | 5 个 policy 文件齐备；根文件已删；`--list` 列出 5 个目标 | **Root** | 改的是**跨文件不变量与单一真源的归属处**：一份数据要同时被脚本、workflow、`AGENTS.md` 引用，拆分口径必须一次定死 |
| T6 | `sync-upstream.mjs` 多目标化（§7） | `--list` / `--dry-run` / `--refresh-policy --target` 全部可用；顺序铁律与退出码不变 | **Root** | 共享可变状态 + 按顺序拼接：脚本是 policy 的唯一消费方，且 §7.3 的四个不变量必须在同一处保持 |
| T7 | `added` 冲突检测（§6.2） | 构造「`added` 路径上游也存在」的用例 → 退出码 2 并列出路径 | **Root** | 与 T6 同一文件、同一控制流，拆开会造成同一函数两处并发修改 |
| T8 | 依赖差异检查（§10.2） | 构造上游新增依赖的用例 → 被报出 | **Root** | 同上（同一脚本的同步流程内） |
| T9 | workflow 多目标化（§8） | `workflow_dispatch` 5 job 各自开 PR | **外派** | ①契约 = 手动触发的 job/PR 矩阵；②触点 = 仅 `.github/workflows/sync-upstream.yml` |
| T11 | 防复发文档（§15）：`docs/adding-a-child-plugin.md` 加「先收养上游」步骤与判据；仓库 `AGENTS.md` 加「必须是 subtree fork」硬规则 | 新增子插件文档含可执行判据；`AGENTS.md` 有该硬规则 | **已落地**（本轮完成；判据已用 5 包实测正/反例） |
| T11b | `AGENTS.md`「🔀 上游同步」节与形态图改多目标口径 | 无残留的单一根 `sync-policy.json` 引用；形态图含 5 包 | **Root** | 与 T5/T6 **必须同批**：改早了文档会描述尚不存在的布局 |
| T10 | 端到端验证：imagegen 同步到 `v1.6.0` | §11.2 全表 | Root | 跨全部切片的集成验收 |

**依赖顺序**：T0 → (T1..T4 **逐包串行**) → T5 → T6/T7/T8 → T9 → T10（T11 已落地，T11b 并入 T5 同批）。

> T1–T4 虽可外派，但四个收养都会改 Git 历史（新增提交）。**Git 索引是共享可变状态**，故四者**必须串行执行**，不可并行提交。

**子代理模型**（仓库 `AGENTS.md` §3 唯一真源）：`antigravity/gemini-3.8-flash`；不可用时用与 Root 相同的 provider/model。禁止一次性子代理。

## 13. 证据索引

全部为本会话实测，非推断：

| 事实 | 取证方式 |
|---|---|
| 四上游身份与 tag SHA | npm registry API + `git ls-remote --tags` |
| 上游活跃度（★/tags/推送时间） | GitHub REST API |
| 本地副本含我方改造 | `packages/dsh-market/src/self-names.ts` 在上游 tag/main/npm 三处均不存在；workbuddy `provider` vs `card` |
| 基线 = 与本地版本号一致的 tag | 「vs tag 差异数 < vs main 差异数」四包一致 |
| `subtree pull` 无祖先失败 | `/tmp/subtreespike` 实跑：`refusing to merge unrelated histories` |
| `merge -s ours` 静默 no-op | `/tmp/spike2` 实跑：`Already up to date.` 且工作区未变 |
| `--squash` 无 add 失败 | `/tmp/spike3` 实跑：`can't squash-merge: '<prefix>' was never added` |
| 收养配方端到端可用 | `/tmp/clean` 实跑：收养 → pull 带入 `new2.txt`、保留 `OUR EDITED`、policy 归零冲突 |
| 漏第 4 步会带入上游文件 | `/tmp/clean` 收养中间态：`up-only.txt` 出现在工作区 |
| 四包 tracked 差异清单 | 自写 `delta.mjs`（`git ls-files` ∩ 上游 tag 树，逐文件字节比对） |
| 上游 commit 数 980 | GitHub REST API `Link: rel="last"` |
| market 裸克隆 18MB | `git clone --bare` 实测 |
| 无 GitHub Release | `GET /repos/dale0525/dsh-plugins/releases/latest` → `Not Found`；`git tag` 为空 |
| imagegen 自更新器指向本仓库 | `packages/dsh-imagegen/src/updater.ts:9,101` |
| imagegen 无 test 脚本 | `packages/dsh-imagegen/package.json` scripts |

### 附录 A：profile 内其它未入库插件的上游（**不在本计划范围**，仅备查）

| profile 依赖 | 上游仓库 |
|---|---|
| `dsh-pet` | `PC2005-cloud/dsh-pet` |
| `dsh-global-rules` | `badai147/dsh-global-rules` |
| `dsh-better-reasoning-effort` | `HaoyueQin/dsh-better-reasoning-effort` |
| `dsh-plugin-sandbox-escalation-fix` | `inmny/dsh-sandbox-escalation-fix` |
| `@openviking/dsh-memory-plugin` | `volcengine/OpenViking` |

若「所有插件」包含这一批，需另立计划（它们要先入库成 `packages/<name>/`，才谈得上 subtree 收养）。

> **注**：`dsh-agy-link`（上游 `amlyczz/dsh-agy-link`）原在本表，已于后续会话**单独收养**为 `packages/dsh-agy-link/`（subtree，`target.id: agy-link`，policy `owned=13 deleted=7 added=1`），并已接入 `sync-upstream.yml` matrix 与聚合包。该次收养沿用本计划的配方与 §11.1 验收，故本计划的范围裁定**未被推翻**，只是表内条目已履行。

## 14. 自审记录（本文写作过程中发现并修正的问题）

按仓库 `AGENTS.md` §3：计划类文档不触发盲审，Root 自审照常执行。本文自审发现并修正：

1. **首轮 spike 夹具是错的**，差点得出反向结论。最初把假上游造成「上游目录内也含 `packages/pkga/`」，于是 `--prefix=packages/pkga` 生成了嵌套的 `packages/pkga/packages/pkga/`，`--squash` 测试因此出现 `rename packages/pkga/{packages/pkga => }/...` 这类诡异输出。重建夹具（上游文件在仓库根、我方在 `packages/<pkg>/`，与真实上游一致）后重跑，§4.3 与 §5.2 的结论才成立。**真实上游的 `package.json` 就在仓库根**，不是嵌套目录。
2. **`git subtree --help` 退出码为 1，但 subtree 功能正常**（缺 man page，非功能缺失）。已用真实 `subtree add` 验证可用，避免误判「环境不支持 subtree」。
3. **基线判定从「猜」改为「反证」**。最初按版本号假设基线 = 对应 tag，后补做「vs tag 差异数 < vs main 差异数」的四包一致反证（§2.2）。差异不显著时该反证不足以定论，故 §9 明确「实施时以 `--refresh-policy` 为准」。
4. **`easyrewrite` 的 `src/index.js` 定性未决**，已在 §9.2 标为待核实，不掩盖。它是 550+ 行 node 半边源码，上游 `src/` 只有 `client.src.js`；是「我方手写」还是「误入库产物」会直接影响它是 `added` 还是该被删，**不能靠猜**。
5. **`added` 的静默覆盖风险**（§6.2）是在计算清单时发现的：`self-names.ts` 进了 `added`，而 apply 流程从不读 `added`。对 config-manager 无实际影响，放大到 4 个包后变成真实风险，故列为必修项而非「顺手优化」。
6. **`package.json` 被 owned 的依赖盲区**（§10.2）同样是放大后才成立的：config-manager 单独一个包时不明显，四个包各自有独立依赖树后成为高频失败模式。

**未做的验证（如实声明）**：本计划**没有**在真实仓库上执行过收养（那会改动 Git 历史，属实施行为，需先获授权）。§5 的配方只在 `/tmp` 的合成夹具上端到端验证过；真实仓库的 62 个 `deleted` 条目、`tar` 备份路径、以及四个上游的实际合并冲突面，都要在实施时首次面对。

## 15. 防复发：把「有上游就要收养」写进新增子插件的强制步骤

**问题的根因不是四个包，是流程**。`docs/adding-a-child-plugin.md` 目前只讲「怎么把一个插件放进 `packages/`、登记进聚合包、发布」，**完全没有「有上游的插件必须先是 fork」这一步**。于是「从本机安装副本整目录拷进来」成了最省事的路径，而它的代价（无祖先、无法同步、改造会在下次人工重拷时丢失）要等到有人想同步时才暴露——四个包就是这么来的。

**修正**：`docs/adding-a-child-plugin.md` 增加一节「有上游就先收养，再登记进仓库」，把收养变成**第 1 步**，并给出**可执行的判据**（不是「记得要 fork」这种无法验收的提醒）。

**这条规则的适用边界（关键）**：它**只约束有上游的插件**。自制的插件（无上游）不 fork、不需要 `sync-policy.json`、不参与同步——把它们也套上 subtree 是错的。所以指南与 `AGENTS.md` 都写成**先判断来源，再决定做法**，而不是无条件「必须 fork」。

要写进去的内容：

1. **判据（关键，仅限有上游的）**：`packages/<name>/` 存在之前，必须先有 `git subtree add` 建立的祖先。可验收的检查是：
   ```bash
   git log --oneline --grep="git-subtree-dir: packages/<name>" | head -1   # 非空
   ```
   或等价地 `git subtree pull --prefix=packages/<name> <url> <tag>` **不报** `refusing to merge unrelated histories`。**空输出即未收养**。
2. **为什么不能事后补**：§3 实测——普通导入的目录补 `subtree pull` 会失败；唯一出路是先移开目录、`subtree add`、再恢复，即 §5 的整套收养。**一开始就做，成本是一个命令；事后补，成本是一整套收养流程。**
3. **指回本计划**：给出 §5 收养配方与 §2.1 的上游登记表的链接，说明「新上游要登记进 §2.1 那张表，并新建 `packages/<name>/sync-policy.json`（§6.1）」。
4. **一句话代价说明**（防「以后再说」）：不收养 = 该插件永久无法自动同步，且我方改造在每次人工重拷时都会丢。

**同时要改的引用**：`docs/adding-a-child-plugin.md` 的验收表加一行「上游祖先已建立（上述 `git log` 判据非空）」。

**判据已在真实仓库上验证**（正例与反例都过）：

```
dsh-config-manager       ✓ 命中 6cf5a6d "Add 'packages/dsh-config-manager/' from commit '04cb9181…'"
dsh-workbuddy-connect    ✗ 空
dsh-easyrewrite          ✗ 空
dsh-market               ✗ 空
dsh-imagegen             ✗ 空
```

即：该判据在已收养的包上给出正例、在四个未收养的包上给出反例，**不是**一条永远为真的空话。`git subtree add` 写入的 trailer 实际形态为：

```
Add 'packages/dsh-config-manager/' from commit '04cb91811375c455e4d5fe6538691a63d2dfb652'

git-subtree-dir: packages/dsh-config-manager
git-subtree-mainline: 98256bd3677aefd5ac5b8f15a03117a974bef17a
git-subtree-split: 04cb91811375c455e4d5fe6538691a63d2dfb652
```

**注意文档治理边界**（全局 `AGENTS.md` §2）：这是**指南**（如何操作），写「当前可用状态」，**不写**历史变迁词（不写「以前拷贝、现在 fork」）。四个包的历史归本计划与 OpenViking，不进指南。

**已落地的两处**（2026-09-19）：

1. `AGENTS.md`（仓库根）「仓库形态」节加了规则「**子插件的来源决定它要不要 fork**」（有上游 → 必须 subtree fork；自制 → 不 fork）+ 上述判据 + 「补不回来」的后果说明。放这里而非只放指南，是因为它是**改动前必知**的约定，正是该文件的定位。
2. `docs/adding-a-child-plugin.md` 新增「步骤 1. 先把上游收养为 `git subtree`」（原步骤顺延为 2–5），验收表加两行判据（祖先已建立、该包有 sync-policy）。

**尚未落地、依赖 T5/T6 的一处**：`AGENTS.md`「🔀 上游同步」节仍写死 `packages/dsh-config-manager` 与单一根 `sync-policy.json`。**这不能在 policy 路径迁移之前改**，否则文档会描述一个尚不存在的布局。已并入 T11。

### 15.1 相邻入口的处置

| 文件 | 处置 | 状态 |
|---|---|---|
| `docs/adding-a-child-plugin.md` | 加「步骤 1. 先把上游收养为 `git subtree`」（原 1–4 顺延为 2–5）；验收表加「祖先已建立」「该包有 sync-policy」两行 | **已落地** |
| `AGENTS.md`「仓库形态」节 | 加规则「子插件的来源决定它要不要 fork」+ 判据 + 「补不回来」说明 | **已落地** |
| `AGENTS.md`「🔀 上游同步」节 | 仍写死 `packages/dsh-config-manager` 与单一根 `sync-policy.json` | **待 T11**（必须与 T5/T6 同批，否则描述的是尚不存在的布局） |
| `AGENTS.md` 顶部仓库形态图 | 只列 `dsh-config-manager` 一个子包；`sync-policy.json` 画在根 | **待 T11**（同上） |

前两处**独立于 policy 迁移即可落地**（它们讲的是「新插件必须收养」，与 policy 存哪无关），已在本轮完成；后两处描述的是**当前布局**，必须等布局真的变了再改。这个切分是有意的：不把能落地的正确规则拖延到一个大改里。

## 16. 待用户裁定

（无。三项裁定见文首「已冻结的裁定」，已冻结。）

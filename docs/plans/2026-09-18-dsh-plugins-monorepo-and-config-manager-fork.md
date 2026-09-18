# dsh-plugins 插件仓库化 与 dsh-config-manager 精简改造

> 状态：已按用户裁定更新，待开工。本文是事前冻结的计划，实施中的偏离以实际代码为准。

## 0. 结论摘要

1. **问题 3 的残留已删除**（两个含明文密钥的 ZIP + 孤儿 `mcp_connector.json`），已复核全机无残留明文。
2. **用户已裁定五项**（见 §2）：发布 npm（账号 `logictan`）、**宽读法**、随宽读法删导出、上游同步机制见 §6、**问题 2 整体砍掉**。
3. **npm 路径已打通并实测**：`npm whoami` = `logictan`（**不是** `dale0525`，用户已更正），账号 2FA 关闭，`@logictan` 作用域可用，`npm publish --dry-run` 通过。**因此 §3.3 的路 B（git 直装 + `blockExoticSubdeps: false`）整体删除**，不再需要。
4. **宽读法的实测删除面远小于初稿估计**：净删 **24105 行**（源码 20636 + 测试 3469），**不是**初稿说的「约 2.5 万行源码」。初稿把「引用面」当成了「删除面」（§11 自审发现 #9）。
5. **宽读法真正的代价不是删除，而是 `src/index.ts` 的手术式收缩**：该文件 5212 行里 65 条路由只有 18 条属于同步，删除面 78 个文件只是删掉，而 index.ts / client/index.ts / run-store.ts / locales.ts 等 16 个「装配层」文件（12309 行）必须**改写而非删除**。这是本次改造最大的工作量。
6. **「热重载」必须拆成两件事**（§7.4）：配置/补丁的热重载**宿主已无条件提供**，插件现在那句「重启后生效」是**错的**；而「改插件源码即时生效」默认**关闭**，需要另开。
7. **⚠️ 开工前必须解决的新发现（本次取证）**：同步路径 `sync-engine.ts` 第 966 行把 `containsSecrets` **硬编码为 false**，而第 329 行**拒绝** `containsSecrets=true` 的快照。改造一要让同步携带明文密钥，就必然同时改这两处，否则**问题 1 的「标注与内容不符」会在同步路径原样复现**（§7.2.4）。

---

## 1. 前置动作：问题 3 残留清理（已完成）

| 目标 | 路径 | 处置 |
|---|---|---|
| 含明文 `X-Goog-Api-Key` 的导出 ZIP | `~/.dsh/dsh-config-manager/exports/dsh-config-20260918-213016-e21236.zip` | 已删除 |
| 同上 | `~/.dsh/dsh-config-manager/exports/dsh-config-20260918-213653-3c90eb.zip` | 已删除 |
| 已卸载插件残留（444 KB，含同一密钥） | `~/.dsh/storages/mcp_connector.json` | 已删除 |
| 上者的空目录 | `~/.dsh/storages/mcp_connector_grants_v1/` | 已删除 |

**删除前的证据**：对 `exports/` 下全部 10 个 ZIP 逐个 `unzip -p | grep -c "X-Goog-Api-Key"`，**只有上述 2 个命中（各 1 处）**，其余 8 个为 0，删除面精确无误伤；删 `mcp_connector.json` 前 `grep -rl "mcp_connector" ~/.dsh/profiles/web/node_modules` **无输出**；删后全机 `grep -rl "AQ.Ab8RN"` **无输出**。

**仍存在的事实（知情项）**：密钥明文仍在 `~/.dsh/cordis.patch.yml` 第 54 行（权限 `0600`，`$DSH_HOME` 非 git 仓库，是有意保留）；`~/.dsh/profiles/web/cordis.patch.yml` 权限 `0664`（宿主 patch 与 settings.yaml 为 `0600`），本次未动。

---

## 2. 用户裁定（本次会话）

| # | 问题 | 裁定 | 对计划的影响 |
|---|---|---|---|
| 1 | npm scope 与是否发布 | **发布**；账号是 `logictan`（用户更正了先前口述的 `dale0525`） | 只走路 A；路 B 整套删除（§5） |
| 2 | 「只保留同步标签页」窄读/宽读 | **宽读法** | §7.3 全部重写；删除面实测 78 源码 + 23 测试文件 |
| 3 | 导出路径是否去脱敏 | **随宽读法删导出** | 导出路径消失，问题 1 的误标在该路径自然消失；**但同步路径的同类误标仍在**（§7.2.4） |
| 4 | 上游同步选 subtree 还是 tarball | 用户反问「有什么区别？你的建议？」 | §6 给出实测对比与建议 |
| 5 | 旧对话问题 2（裸包名） | **整体砍掉** | 原 §4.5 与 T10 删除 |

---

## 3. npm 发布路径（已验证）

### 3.1 账号与作用域

| 事实 | 实测值 |
|---|---|
| 登录身份 | `logictan`（`npm whoami` 与 registry `/-/whoami` 双向确认） |
| 邮箱 | `logictan89@gmail.com`（已验证） |
| 2FA | `tfa: false`（无需 OTP 即可发布） |
| 既有包 | `hexo-gpt-tag@1.3.3`（`npm access list packages` → `read-write`） |
| `.npmrc` | `~/.npmrc`，权限 `0600`，含 `//registry.npmjs.org/:_authToken=<token>` |

### 3.2 包名与发布验证

- 作用域 `@logictan`；`@logictan/dsh-plugins-all` 与 `@logictan/dsh-config-manager` 当前均 **404（可用）**。
- `npm publish --dry-run --access public` 在一个带 `dsh.bundle.patch` 的最小包上**通过**（`PUBLISH_DRYRUN_EXIT=0`），确认「用户作用域 + 公开访问」这条路无需额外配置。

### 3.3 安装形态（唯一路径）

```sh
dsh plugin --profile web add @logictan/dsh-plugins-all@latest
```

聚合包 `packages/all/package.json` 的 dependencies 写普通版本号（`"@logictan/dsh-config-manager": "^0.2.0"`）。**无任何 pnpm 特殊配置需求**——不需要 `blockExoticSubdeps: false`，不需要 `git+...#&path:`，不需要 profile 侧任何改动。

> **已删除的候选方案（不再重提）**：初稿为「暂不发 npm」设计了路 B（`github:` 直装 + 子包 `git+...#<ref>&path:` + `blockExoticSubdeps: false`），并做了 5 轮 pnpm 实验。用户裁定发布 npm 后，**这一整套连同 profile 配置改动全部删除**。实测被否的四个子方案（`workspace:*` 跨 git、`file:../x`、commit SHA 自引用、tag + 默认设置触发 `ERR_PNPM_EXOTIC_SUBDEP`）仅作为「为何不走 git 直装」的存档，见 §13。

---

## 4. 目标仓库形态：dsh-web 做对了什么

分析对象：`github.com/zhu1090093659/dsh-web`（浅克隆到 `/tmp/dsh-web-analysis`）。

```
dsh-web/
├── package.json          ← 根包，声明 dsh.bundle.patch 指向聚合 patch，private:true
├── pnpm-workspace.yaml   ← packages/*, packages/skins/*, shared
├── packages/
│   ├── dsh-web-all/      ← 聚合载体（@linxin666/dsh-web-all）
│   │   ├── aggregate.yml        ← 手写清单：patchFrom / deps / rows / inactive
│   │   ├── cordis.patch.yml     ← AUTO-GENERATED，由 aggregate.mjs 生成
│   │   └── package.json         ← dependencies 用 workspace:* 拉全部子包
│   ├── dsh-doctor/  dsh-pet/  dsh-ssh/ ...  ← 19 个功能插件，各自是独立可发布包
│   └── skins/skin-center/ ...
├── scripts/aggregate.mjs ← 从 aggregate.yml 生成 cordis.patch.yml + package.json deps
└── .github/workflows/    ← release.yml（tag 触发发布 npm）、ci.yml
```

**关键点**：根 `package.json` 只有 `dsh.bundle.patch` + `files` + 一个 `dependencies`（值为 `"@linxin666/dsh-web-all": "0.3.23"`），**它自己就是被安装的那个包**。

**DSH 侧如何加载**（`dsh-app-boot/lib/index.js` 第 916-924 行 `loadProfileDirectory`）：从 profile 的 `dsh.profile.bundles` 列表 → `resolveBundleDir` 定位包目录 → 读该包 `dsh.bundle.patch` → `join(packageDir, declared)` 加载 patch。实测 git 安装的包目录里 `packages/all/cordis.patch.yml` 确实随包带出，故该链路成立。

**容错壳（不建议 MVP 照搬）**：`packages/dsh-web-all/src/shell.ts` 是一层「永不失败的壳」，每个子插件的 patch 行 `name` 指向 `@linxin666/dsh-web-all/<family>`，真实包名放在 `config.plugin`，由壳在运行时动态 import 并捕获异常。动因是 DSH loader 把全部 patch 行当作**一个事务组**，任何一行失败会回滚整组。**本仓库 MVP 不做**：目前只有 1 个插件，隔离收益为零，等真的有第二个再补。

**上游没有做「定时同步」**：全量查过 `.github/workflows/`（16 个文件），**没有任何 upstream-sync / fork-sync 机制**。用 `cron` 的只有 `contributors.yml` 与 `stale-assignment.yml`（清理陈旧 issue/PR，与本主题无关）。唯一出现 "upstream" 字样的是 `pr-contribution-rules.yml` 第 64/110/113 行，那是**要求贡献者自己同步**的 PR 检查项。**所以这块没有现成实现可抄**。

---

## 5. 本仓库（dsh-plugins）设计

```
dsh-plugins/
├── package.json              # 根包：dsh.bundle.patch → ./packages/all/cordis.patch.yml，private:true
├── pnpm-workspace.yaml       # packages/*
├── AGENTS.md                 # 仓库级规范（含生效门禁，见 §7.4）
├── docs/plans/               # 事前冻结的计划（本文）
├── packages/
│   ├── all/                  # 聚合载体（@logictan/dsh-plugins-all）
│   │   ├── aggregate.yml     # 手写清单
│   │   ├── cordis.patch.yml  # 生成物
│   │   └── package.json
│   └── dsh-config-manager/   # 第一个 fork 进来的插件（@logictan/dsh-config-manager）
├── scripts/
│   ├── aggregate.mjs         # 从 aggregate.yml 生成 patch
│   ├── sync-upstream.mjs     # 上游同步的 policy 应用脚本（见 §6.4）
│   └── dev-watch.mjs         # 源→产物自动重建（热重载用，见 §7.4）
└── sync-policy.json          # 声明哪些文件是「我删的」「我改的」（见 §6.4）
```

**构建产物策略**：每个 `packages/<name>/lib/` 加入各自 `.gitignore`，靠 `"prepare"` 在安装时构建（与上游一致，也与你「构建产物不入版本控制」的既有偏好一致）。

**命名与 scope**：`@logictan`（§3.2）。

---

## 6. 上游同步机制（回答「有什么区别？你的建议？」）

### 6.1 两种机制的本质区别

| 维度 | `git subtree` | 上游 tarball 解包覆盖 |
|---|---|---|
| 上游历史 | **保留**（`git log` 可见上游全部 148 个 commit） | 丢失，只剩「某次覆盖」一个提交 |
| 三方合并 | **有**：git 能区分「上游改的」/「我改的」/「双方都改的」 | **无**：只有「覆盖」一个动作 |
| 我们删掉的 78 个文件 | 合并时保留删除（报 delete/modify 冲突，机械解决） | **每次同步都会被静默复活**，必须靠脚本再删一遍 |
| 我们改过的文件 | 报标准 merge 冲突，人工/脚本解决 | **被静默覆盖**，本地改造直接丢失 |
| 上游新增文件 | 自动带入 | 自动带入 |
| 冲突可预测性 | 高（冲突文件 = 我们改过的文件 ∩ 上游改过的文件） | 无冲突概念，但代价是静默错误 |
| 自动化难度 | 中（需 policy 脚本） | 低 |
| 出错后果 | 显式冲突，看得见 | **静默丢改动**，看不见 |

**一句话**：tarball 覆盖不是「更简单的 subtree」，而是「把合并问题换成静默覆盖问题」。在**我们删掉 20636 行源码**的前提下，tarball 每次同步都会复活这 78 个文件——这不是「简单」，是「不可用」。

### 6.2 实测：冲突面到底有多大

上游发布节奏（`git fetch --unshallow` 后实测，**不是**浅克隆数据）：**60 个 tag、148 个 commit，全部落在最近 90 天内**；`v0.1.46 → v0.1.60` 仅 26 天，高峰期一天 2-3 个 tag。

按「我们改过的文件（19 个装配/同步文件）」「我们删掉的文件（78 个）」分类：

| 窗口 | 上游改动文件 | A 编辑×编辑（真冲突） | B 删除×修改（机械） | C 自动合并 |
|---|---|---|---|---|
| `v0.1.59 → v0.1.60`（1 个版本） | 82 | **9** | 16 | 57 |
| `v0.1.55 → v0.1.60`（5 个版本） | 181 | **16** | 41 | 124 |
| `v0.1.50 → v0.1.60`（10 个版本） | 261 | **19** | 55 | 187 |

**读法**：单个版本的**真冲突只有 9 个文件**（`ConfigManagerSection.tsx`、`client-types.ts`、`client/index.ts`、`locales.ts`、`run-store.ts`、`sync-view.ts`、`messages.ts`、`index.ts`、`i18n.ts`），且集中在「装配层」而非逻辑层。B 类（删除×修改）是机械的——脚本重新删一次即可。

### 6.3 实测：policy 脚本能把冲突降到 0

我做了两轮真实 spike（`/tmp/p1`、`/tmp/p2`，subtree 与 plain-remote 各一轮），验证「**先全取上游 → 再恢复我改的 → 再重删我删的**」这个顺序能确定性归零：

```
git subtree pull --prefix=packages/dsh-config-manager <upstream> <ref>   # 产生冲突
git checkout --theirs -- packages/dsh-config-manager                     # 1) 全取上游
git checkout --ours  -- <我改过的文件列表>                                 # 2) 恢复我的改造
git rm -f --ignore-unmatch <我删过的文件列表>                              # 3) 重删我的删除
git commit
```

**实测结果（两个 spike 一致）**：原始冲突 7-8 个 → 应用 policy 后 **0 个残留冲突**；我方补丁文件内容保持我方版本；上游新增文件正确带入；我方删除的文件保持删除。**顺序是关键**：先 ours 后 theirs 会让我们的改造被上游覆盖（我在第一轮 spike 里就踩了这个坑，见 §11 #10）。

### 6.4 我的建议：`git subtree` + policy 脚本 + PR-only

**建议 `git subtree`**，理由按权重排序：

1. **只有它能区分「上游改的」和「我改的」**。我们要删 20636 行、改 19 个文件，这个区分能力是刚需；tarball 覆盖没有这个概念。
2. **删除面必须被记住**。78 个删除文件写进 `sync-policy.json`，policy 脚本每次重删；tarball 方案下这个清单无处安放（没有合并语义，只能靠脚本 diff 猜）。
3. **实测可归零**：§6.3 已证明 policy 顺序能把冲突确定性降到 0。
4. **历史可追溯**：`git log packages/dsh-config-manager` 能直接看到上游每个 commit 与我们的每次 policy 合并。

**但必须说清它的真实价值边界**：上游一天 1-2 个版本、我们砍掉了 3/4 的代码，**这个同步不会带来「版本对齐」**。它的实际价值只有一个：**把上游在「我们保留的那 129 个文件」里的 bug 修复拉进来**（例如 `sync-engine.ts`、`webdav-transport.ts`、`git-transport.ts`、`env-lock.ts` 这些高频修改且我们未大改的文件）。请按这个预期使用它，不要指望「一键跟上上游」。

**因此 workflow 的设计**：
- **只开 PR，绝不直接推 main**。冲突由人裁定。
- 每版本一次（上游一天 1-2 版，但**每天最多开一个 PR**，避免噪音）；由 `workflow_dispatch` 也可手动触发。
- PR 里附上「A 类真冲突清单」与「B 类机械重删清单」，让人一眼看出要审什么。
- 若某个文件被我们大改到无法自动合并，把它加进 `sync-policy.json` 的 `owned` 列表，policy 一律取我方版本，彻底消除该类冲突。

---

## 7. fork dsh-config-manager 与三项改造

### 7.1 fork 方式

**采用 git subtree，保留上游历史**：

```sh
git subtree add --prefix=packages/dsh-config-manager \\
  https://github.com/xiajiajun516/dsh-config-manager v0.1.60
```

**基线**：`v0.1.60`（与当前 npm 安装版本一致）。**许可证**：上游 MIT（`LICENSE`，Copyright (c) 2026 xiajiajun516），fork 后保留。

**基线规模（实测）**：源码非测试 **207 文件 / 64031 行**；测试 **159 文件 / 41646 行**；合计 366 文件 / 105677 行。

---

### 7.2 改造一：大幅简化同步逻辑

#### 7.2.1 目标语义（按你的要求）

勾选即同步，**不加密、不脱敏、不做 diff/合并**；**可以**同步插件配置、provider 密钥、MCP header 等一切隐私信息；私有同步渠道自用，明文可接受。

#### 7.2.2 现状与目标对照

| 维度 | 现状 | 目标 |
|---|---|---|
| 分区可见性 | `portability` 三态过滤，`portableAdapters()` 只保留 portable；`mcp`/`workspaces` 是 `platformSpecific`，`credentials`/`pluginFiles`/`sessions` 是 `deviceSpecific` —— **一律进不了同步** | 取消 portability，所有分区都可勾选 |
| 密钥 | `includeSecrets=true` 强制 `encrypt=true`，否则抛 `sync.includeSecretsRequiresEncryption`；自动同步恒 `false` | 删除该约束，恒导出真实值 |
| 加密 | `snapshot-crypto.ts`（scrypt + AES-256-GCM） | 删 `snapshot-crypto.ts` |
| 脱敏 | `SecretScanner.scanAndRedact` 在同步路径剥离敏感字段 | 同步路径去掉脱敏；**保留日志脱敏**（`security/redaction.ts` 供 logger 用） |
| 合并 | `ancestor.ts` + `merge.ts` + `risk.ts` + `review-queue.ts` | 全删。pull = 按选择覆盖写入 |
| 远端裁剪 | `MAX_REMOTE_SNAPSHOTS = 10`（`sync-engine.ts` 第 221/483-500 行），与备份的 GFS 保留策略是两套机制 | **保留** |
| 同步选择 | `sync-selection.json` v2：`{mode, sections, encrypt, includeSecrets}` × 双通道 | 收敛为 `{schemaVersion, channels: {git\|webdav: {sections: SectionId[]}}}` |

#### 7.2.3 删除清单（改造一专属）

- `src/sync/snapshot-crypto.ts`（51 行，**仅同步快照**加密）
- `src/sync/ancestor.ts`（82）、`src/sync/merge.ts`（361）、`src/sync/risk.ts`（125）、`src/sync/review-queue.ts`（158）
- 对应测试：`src/sync/{ancestor,merge,risk,review-queue,snapshot-crypto}.test.ts` 等

> **注意（自审确认）**：`src/sync/snapshot-json.ts` **保留**。它是 WebDAV/Git 通道的二进制安全序列化（`Uint8Array` ↔ `{"$bin": base64}`），`git-transport.ts` 与 `webdav-transport.ts` 都直接依赖它；删 `snapshot-crypto` 不影响它。

#### 7.2.4 ⚠️ 新发现：同步路径的 `containsSecrets` 误标必须一并处理

**这是本次取证发现的、初稿完全遗漏的联动**（见 §11 #11）。两条硬证据：

1. `sync-engine.ts` 第 936-977 行 `snapshotToZip()`：构造 `buildManifest({... containsSecrets: false ...})` —— **硬编码 false**，无论 `sections` 里实际装了什么。
2. `sync-engine.ts` 第 329 行：pull 时 `if (snapshot.manifest.containsSecrets) { 拒绝 }`，配套文案 `sync.remoteContainsSecrets: '远端快照声明 containsSecrets=true，拒绝同步（同步通道永不携带秘密）'`。

**后果**：改造一若只删掉脱敏、让同步携带明文密钥，而不同时改这两处，那么**问题 1 的缺陷（含明文却标注 false）会在同步路径原样复现**——只是从导出 ZIP 搬到了同步快照。更糟的是第 329 行的守卫会让「如实标注」的快照**无法被拉取**。

**因此改造一必须同时**：
- `snapshotToZip()` 的 `containsSecrets` 改为按实际内容如实置位；
- 删除第 329 行的 `containsSecrets` 拒绝分支（该守卫只有这一处，位于 `prepareSnapshot()` 内；第 528/643 行是它的**调用点**，随守卫一并失效），因为明文同步现在是**预期行为**；
- 删除/改写 `sync.remoteContainsSecrets` 文案（`core/messages.ts` 第 275/587 行）；
- 保留 `encrypted` 分支的拒绝逻辑（旧加密快照仍应被明确拒绝，而不是静默当明文处理）。

**验收**：push 一个含 provider 密钥的快照 → 读远端 manifest 确认 `containsSecrets: true` → 另一 profile pull 成功且密钥可用。

#### 7.2.5 需要重写的部分

- `src/sync/sync-engine.ts`（984 行）：保留 transport 调用、状态记录与远端裁剪，删掉 encrypt/includeSecrets/merge/baseline 全部分支。**这是改造一的核心工作量**。
- `src/sync/sync-selection.ts`：schema 降级。
- `src/client/sync/SyncSettingsView.tsx`（1652 行）：去掉加密密码框、includeSecrets 勾选。
- `src/client/sync/sync-locales.ts`、`src/core/messages.ts`：删除加密/密钥相关文案。
- `src/adapters/index.ts`：`createAdapters` 移除 `portability` 字段。

#### 7.2.6 验收契约

1. `pnpm typecheck` 通过；2. `pnpm test` 全绿；3. `grep -rn "includeSecrets\|encryptSectionsPayload\|decryptSectionsPayload\|portableAdapters" src/` **零命中**；4. **端到端**：私有 git 渠道 push → 读远端 manifest 见 `containsSecrets: true` → 人工确认 `providers` 含 `apiKey` 真实值；5. **回环**：另一 profile pull，确认 provider 密钥可用（发一次真实模型请求成功）。

---

### 7.3 改造二：宽读法（只保留同步标签页）

#### 7.3.1 口径

按你的裁定采用**宽读法**：导航栏只剩「同步」，导出、导入、市场、档案、总览、灾备、关于、生命周期**全部删除**。

> **初稿的数字是错的**：初稿写「删除面会扩大到约 2.5 万行源码」。实测**净删 24105 行（源码 20636 + 测试 3469）**。错因是把「引用面」（47 个文件引用了被删模块，27873 行）当成了「删除面」。已更正。

#### 7.3.2 实测删除面

| 类别 | 文件数 | 行数 |
|---|---|---|
| **A 原样保留**（同步闭包，非测试） | 113 | 31086 |
| **B 手术式收缩**（装配层，须改写而非删除） | 16 | 12309 |
| **C 删除（非测试）** | 78 | 20636 |
| **D 删除（测试）** | 23 | 3469 |
| **净删除** | **101** | **24105** |

（207 非测试 = 113 + 16 + 78 ✓；64031 行 = 31086 + 12309 + 20636 ✓）

**B 类 16 个「装配层」文件**（必须改写，是本次最大工作量）：

| 文件 | 行数 | 收缩要点 |
|---|---|---|
| `src/index.ts` | 5212 | 65 条路由删到只剩 18 条同步路由；facade 装配、路由表、ctx wiring 全部重写 |
| `src/client/run-store.ts` | 1601 | `PanelId` 收敛为 `'sync'`；删除 export/import/snapshots/market/profiles/recovery/about/history 分支 |
| `src/client/locales.ts` | 1082 | 删除非同步面板文案 |
| `src/cli/index.ts` | 1064 | 删除 `backup`/`verify`/`snapshots`/`reinstall`/`recover-stale-lock` 子命令 |
| `src/client/api.ts` | 740 | 只保留 sync 相关 API 客户端 |
| `src/core/messages.ts` | 670 | 删除备份/导出/导入/市场文案 |
| `src/ui/i18n.ts` | 591 | 同上 |
| `src/client/ConfigManagerSection.tsx` | 467 | `NAV_ITEMS` 只留 `sync` |
| `src/core/model-tools.ts` | 467 | 只留 `config_sync_push` / `config_sync_pull` |
| `src/client/index.ts` | 123 | 客户端入口收缩 |
| `src/adapters/index.ts` | 95 | `createAdapters` 去 portability |
| `src/schema/index.ts` | 72 | 桶导出收缩 |
| `src/core/index.ts` | 57 | 桶导出收缩 |
| `src/client/client-types.ts` | 42 | 只留 sync API 类型 |
| `src/security/index.ts` | 17 | 见下方悬空导出说明 |
| `src/profiles/index.ts` | 9 | 随 profile 面板删除而收缩 |

#### 7.3.3 C 类删除清单（78 个非测试文件，实测）

按目录汇总：

| 目录 | 文件数 | 行数 |
|---|---|---|
| `src/client` | 29 | 9914 |
| `src/core` | 20 | 5721 |
| `src/sync` | 9 | 1940 |
| `src/ui` | 11 | 1378 |
| `src/market` | 5 | 659 |
| `src/security` | 2 | 439 |
| `src/utils` | 1 | 336 |
| `src/adapters` | 1 | 249 |

**完整清单**：

```
src/adapters/test-helpers.ts                        249
src/client/about/about-view.ts                      169
src/client/about/AboutPanel.tsx                     171
src/client/about/release-notes-view.ts              311
src/client/about/ReleaseNotesDialog.tsx             449
src/client/common/ConfirmDialog.tsx                 109
src/client/common/ProgressBar.tsx                    62
src/client/common/ReportView.tsx                    125
src/client/common/SectionComposition.tsx             37
src/client/common/ToastViewport.tsx                  74
src/client/css-modules.d.ts                           9
src/client/export/ExportView.tsx                    371
src/client/history/history-locales.ts               173
src/client/history/HistoryPanel.tsx                 242
src/client/import/ConflictList.tsx                  168
src/client/import/import-file-select.ts              70
src/client/import/ImportWizardView.tsx              956
src/client/import/PathMappingForm.tsx                79
src/client/lifecycle/LifecyclePanel.tsx             525
src/client/lucide-icons.d.ts                         39
src/client/market/disclaimer.ts                      44
src/client/market/market-locales.ts                 316
src/client/market/MarketPanel.tsx                   717
src/client/market/MyConfigsView.tsx                1192
src/client/overview/OverviewPanel.tsx               523
src/client/profiles/ProfilesPanel.tsx               593
src/client/recovery/recovery-locales.ts             245
src/client/recovery/recovery-view.ts                168
src/client/recovery/RecoveryPanel.tsx               590
src/client/snapshots/SnapshotsPanel.tsx            1387
src/core/backup-plan.ts                             328
src/core/backup-verify.ts                           307
src/core/boot-rescue.ts                             738
src/core/cache-cleaner.ts                           205
src/core/config-lifecycle.ts                        574
src/core/config-snapshot.ts                         523
src/core/config-state.ts                            208
src/core/consult-source.ts                          294
src/core/crash-report.ts                            370
src/core/local-plugin-host.ts                       153
src/core/phase3-child-crash.ts                       96
src/core/phase3-prod-child.ts                        37
src/core/phase4-crash-child.ts                      102
src/core/recovery-orchestrator.ts                   367
src/core/reinstall.ts                               368
src/core/startup-barrier.ts                         100
src/core/transaction-coordinator.ts                 304
src/core/undo.ts                                    117
src/core/verify-recovery.ts                         266
src/core/watcher.ts                                 264
src/market/market-config.ts                         110
src/market/reader.ts                                191
src/market/repo-url.ts                               46
src/market/security.ts                              220
src/market/star-cache.ts                             92
src/security/encryption.ts                          336
src/security/integrity.ts                           103
src/sync/ancestor.ts                                 82
src/sync/backup-files.ts                            248
src/sync/backup-schedule-config.ts                  237
src/sync/backup-scheduler.ts                        391
src/sync/merge.ts                                   361
src/sync/retention-policy.ts                        287
src/sync/review-queue.ts                            158
src/sync/risk.ts                                    125
src/sync/snapshot-crypto.ts                          51
src/ui/backup-inspect.ts                            100
src/ui/backup-schedule.ts                           167
src/ui/history-model.ts                             190
src/ui/import-stepper.ts                             74
src/ui/next-steps.ts                                 62
src/ui/overview-view.ts                             335
src/ui/path-mapping.ts                              104
src/ui/profiles-view.ts                              55
src/ui/release-notes-prompt.ts                       50
src/ui/star-prompt.ts                                56
src/ui/test-helpers.ts                              185
src/utils/bundle-scan.ts                            336
```

#### 7.3.4 D 类删除清单（23 个测试文件，实测）

```
src/client/about/about-view.test.ts                  92
src/client/about/release-notes-view.test.ts         175
src/client/bundle-selfcontained.test.ts              86
src/client/market/disclaimer.test.ts                 58
src/core/cache-cleaner.test.ts                      363
src/core/crash-report.test.ts                       381
src/core/phase1-wiring.test.ts                      140
src/core/watcher.test.ts                            327
src/market/repo-url.test.ts                          61
src/market/star-cache.test.ts                       103
src/sync/backup-files.test.ts                       219
src/sync/review-queue.test.ts                       121
src/sync/risk.test.ts                               132
src/ui/backup-schedule.test.ts                      180
src/ui/import-stepper.test.ts                        53
src/ui/overview-view.test.ts                        201
src/ui/release-notes-prompt.test.ts                  28
src/ui/star-prompt.test.ts                           54
src/utils/bundle-scan.test.ts                       188
tests/architecture-boundaries.test.ts               233
tests/client/import-wizard-redaction.test.ts         87
tests/packaging-contract.test.ts                    111
tests/route/status-plugin-diagnostics.test.ts        76
```

> **其余 136 个测试文件保留**（38177 行）。判据：它是否 import 了「保留集」中的模块。

#### 7.3.5 ⚠️ 两个「名字像备份、其实是共享原语」的文件（自审与盲审共同确认）

初稿把这两个文件列进删除清单，**都是错的**：

- **`src/security/encryption.ts`（336 行）不能按「加密模块」简单删除**。它有两个消费面：①同步快照加密（随 `snapshot-crypto.ts` 一起废弃）；②**导出/导入的归档加密**。宽读法删掉了导出/导入，所以**这次它确实可以删**——但删之前必须处理它的 6 个消费方：`core/backup-verify.ts`（同时删）、`core/model-tools.ts`（改）、`security/index.ts`（删桶导出行）、`security/security.test.ts`（就地裁剪）、`sync/snapshot-crypto.ts`（同时删）、`tests/conformance/roundtrip.test.ts`（就地裁剪）。
  > **联动硬门禁**：`src/security/index.ts` 第 13 行有 `export * from './encryption.ts'`。删除 `encryption.ts` 而不同时删这一行，`pnpm typecheck` 会因**悬空导出直接失败**。

- **`src/core/backup.ts`（606 行）不能删**。它不是「备份功能」，而是**全插件的事务原语**，被 6 个保留集文件引用：`adapters/plugins.ts`、`core/analyzer.ts`、`core/restore.ts`、`core/rollback.ts`、`profiles/profile-manager.ts`、`sync/sync-engine.ts`。删掉它会让同步的失败回滚静默失效。

#### 7.3.6 ⚠️ 保留集里一个「必须保留」的意外成员：`src/core/exporter.ts`

宽读法删掉导出功能，但 **`core/exporter.ts` 必须保留**——`sync-engine.ts` 第 22 行 `import { defaultSecretScanner } from '../core/exporter.ts'`，第 255 行 `this.scanner = opts.scanner ?? defaultSecretScanner()`。

> **顺带发现的重复（登记，本次不修）**：`core/exporter.ts` 第 60 行的 `defaultSecretScanner()`（35 行，自带 `SENSITIVE_FIELDS` 与 `REFERENCE_FIELDS` 两份列表）与 `security/secret-scanner.ts` 第 404 行的 `createSecretScanner()`（委托给 `scanAndRedact`）是**两套并行实现**。改造一只需删掉同步路径对 scanner 的**调用**，不必动这两处定义。是否合并留作后续独立任务（属 §2「MVP 导向」的范围外）。

#### 7.3.7 验收契约

1. `grep -rn "config_backup\|config_restore\|config_list_snapshots\|SnapshotsPanel\|ImportWizardView\|ExportView\|MarketPanel\|ProfilesPanel\|RecoveryPanel\|OverviewPanel" src/` **零命中**。
2. 插件设置页**只剩「同步」一个标签**。
3. `/api/dsh-config-manager/` 下除同步路由外全部 **404**。
4. `dsh-config-manager --help` 只列出与同步相关的子命令。
5. `pnpm typecheck` 通过、`pnpm test` 全绿。
6. 同步功能端到端仍可用（§7.2.6 的 4/5 复跑）。

---

### 7.4 改造三：支持热重载

这一条必须先把两件事分开，否则会做错。

#### 事实 A：配置/补丁的热重载**宿主已无条件提供**（已验证）

代码证据（`@deepseek-ai/dsh-hmr@0.1.6-alpha.2`）：

- `dsh-base/cordis.patch.yml` 第 28-32 行挂载 `hmr` 行，`config.root: []`，`disabled: !!js "!ctx.get('profileContext')"`。
- `dsh-hmr/lib/index.js` 第 365-376 行：收集 `patchFiles = [profile.patchPath, join(profile.home, "cordis.patch.yml")]`，逐个 `watchConfig`，回调里调 `reconcileProfilePatches(...)`。
- 即：**`~/.dsh/profiles/web/cordis.patch.yml` 与 `~/.dsh/cordis.patch.yml` 都在监听范围内**。
- 旁证：`lsof -p 23575` 显示宿主同时持有两个 patch 文件的 fd（fd 29 与 fd 52）。
- `@deepseek-ai/dsh-settings-file` 第 180 行、`@deepseek-ai/dsh-credentials-local` 第 448 行各有独立的 chokidar watcher。
- `dsh-plugin-manager` 第 1130 行有 `reload()`，安装/卸载插件后主动重组，不等文件事件。

**但「重启」并非一律错误**（盲审条目 10 采纳，修正初稿的过强断言）：宿主确有真实的 `restart-required` 路径——`dsh-plugin-manager/lib/index.js` 第 941 行（安装一个**已存在于 profile package.json** 的包时，磁盘文件被替换但模块缓存仍是旧代码）；第 1141 行（`hmr` 服务缺席时一律 `restart-required`）。这正好呼应事实 B。

| 改动类型 | 是否真的需要重启 |
|---|---|
| patch 文件（MCP 条目、插件挂载行、config） | **否**，宿主已热重载 |
| `settings.yaml` / `.credentials.yaml` | **否**，各有独立 watcher |
| 插件包**代码**更新（同版本覆盖安装） | **是**（`restart-required`） |
| 首次安装新插件 | 取决于 hmr 是否存在；存在则 `reload()` 生效 |

**因此交付不是「删掉所有重启提示」，而是「按上表把提示改准确」**。涉及位置：`src/core/messages.ts` 第 228/236 行（`adapter.patchWritten` / `adapter.mcpWritten`）、`src/ui/i18n.ts` 第 85-86 行（`error.needsRestart.title`）、`src/ui/next-steps.ts`（`restartItems`）。
> **注意**：宽读法下 `src/ui/next-steps.ts`（62 行）已在 §7.3.3 的删除清单里；若确认删除，则只需改 `messages.ts` 与 `i18n.ts` 两处。

#### 事实 B：改**插件源码**默认**不**热重载

`dsh-hmr` 的 `root` 控制 module watch，`dsh-base` 设的是 `root: []`——即**模块级热替换默认关闭**。两条路径：

- **B1（推荐，零新增）**：在 profile patch 里开 module watch（`config.root: ["."]`）。需实测确认 `base` 解析到哪个目录、以及是否会把 `node_modules` 之外的无关文件也纳入（`ignored` 默认已含 `**/node_modules`）。
- **B2（照搬 dsh-web）**：仓库内加 `scripts/dev-watch.mjs`，监听 `packages/*/src/**`，防抖后重建 `lib/client.js`。宿主的 client HMR（`@deepseek-ai/dsh-client-hmr`）每 500 ms 轮询产物 mtime/size，变化即推 SSE 让浏览器原位替换插件 fiber。

**注意**：B1 管 host 侧模块替换，B2 管 client bundle 重建，**两者互补不是二选一**。且**不要**把构建产物纳入监听（会自激成死循环）。

#### 验收契约

1. 改 `~/.dsh/cordis.patch.yml` 中 MCP 条目的 header，**不重启**，调用 `mcp__stitch__list_projects` 生效。
2. 改 `settings.yaml` 的某个 section 值，**不重启**，GUI 中可见。
3. 改 `packages/dsh-config-manager/src/client/**` 后跑 `pnpm dev:watch`，浏览器**不刷新**即见新 UI。
4. 改 `packages/dsh-config-manager/src/index.ts`（host 半）→ 依选定路径确认生效方式，并写进仓库 `AGENTS.md`。
5. `grep -rn "重启后生效" src/` 的剩余命中每一处都有对应的事实依据。

---

## 8. 验证方案

| 层 | 手段 |
|---|---|
| 单元/集成 | `pnpm test`（改造后仍需全绿；保留 136 个测试文件） |
| 类型 | `pnpm typecheck`（重点验 `security/index.ts` 等桶导出的悬空引用） |
| 契约 | §7.2.6 / §7.3.7 / §7.4 各自的 grep 零命中检查 |
| 端到端 | 私有 git 渠道 push → 读远端 manifest 确认 `containsSecrets: true` → 另一 profile pull，密钥可用 |
| 界面 | 用当前可用的 browser/computer-use 技能在真实 GUI 里走一遍「同步」标签 |
| 生效 | 按 `dsh-web status` 的 PID 与 patch 文件 mtime 对比，证明未重启即生效 |
| 安装形态 | `npm pack` + 在**干净的临时 profile** 上 `dsh plugin add @logictan/dsh-plugins-all@latest`，确认不依赖本机既有 `node_modules` |

---

## 9. 待办清单与派单

按全局 §3「派单」规则：切片单位 = 一次可独立验证的改动。

| # | 切片 | 验收 | 归属 | 判据 |
|---|---|---|---|---|
| T1 | 建仓库骨架：根 package.json、pnpm-workspace.yaml、packages/all、scripts/aggregate.mjs、.gitignore、AGENTS.md | `pnpm install` 通过；`node scripts/aggregate.mjs --check` 通过 | Root | 跨文件不变量（根清单↔生成物），新仓库单一真源归属处 |
| T2 | `git subtree add` 拉入 config-manager v0.1.60 | `git log` 可见上游历史；`pnpm typecheck` 通过 | Root | 机械导入，无验收契约可独立判定 |
| T3 | 改造一核心：重写 `sync-engine.ts` + `sync-selection.ts`，删 snapshot-crypto/merge/ancestor/risk/review-queue，**含 §7.2.4 的 containsSecrets 联动** | §7.2.6 验收 1-5 | Root | 改的是跨文件不变量（同步分区可见性 + 密钥标注不变量）与单一真源投影 |
| T4 | 改造一 UI 侧：`SyncSettingsView.tsx` / `sync-locales.ts` | §7.2.6 验收 1-3 | **外派** | ①契约 = 既有 UI 测试文件；②触点仅这 2 个文件，**不含 `messages.ts`**（见注 4） |
| T5 | 宽读法删除面：删 C 类 78 个 + D 类 23 个文件 | §7.3.7 验收 1、5 | **外派** | ①契约 = grep 零命中 + 测试全绿；②纯删除，触点仅 `tsconfig` 与桶导出 |
| T6 | 宽读法装配层收缩：`src/index.ts` 路由表（65→18）、`run-store.ts`、`ConfigManagerSection.tsx`、`model-tools.ts`、`cli/index.ts` | §7.3.7 验收 2-4、6 | Root | 改的是跨文件不变量与按顺序拼接的源文件；单一真源投影归属处 |
| T7 | 改造三（热重载）：改文案 + `scripts/dev-watch.mjs` + 写 AGENTS.md 门禁 | §7.4 验收 1-5 | Root | 涉及宿主行为实测结论，跨 profile patch 与仓库两个面 |
| T8 | 上游同步：`sync-policy.json` + `scripts/sync-upstream.mjs` + workflow | PR 能开出来且冲突已按 policy 归零 | **外派** | ①契约 = 在测试分支上跑通并开出 PR；②与仓库源码零共享触点 |
| T9 | 端到端：私有 git 渠道 push→pull 回环 | §8 端到端行 | Root | 需要真实凭据与真机状态 |
| T10 | npm 发布与安装验证：`npm pack` + 临时 profile 安装 | §8 安装形态行 | Root | 依赖 T1-T7 全部落地 |

**顺序**：T1 → T2 → T3 → T5 → T6 → T4 → T7 → T9 → T10 → T8。

> **注 1**：**T3 必须先于 T5**。T5 的 C 类清单包含 T3 的删除目标（`snapshot-crypto`/`ancestor`/`merge`/`risk`/`review-queue`），顺序反了会让 `sync-engine.ts` 引用不存在的模块。
> **注 2**：**T5 必须先于 T6**。T6 收缩装配层时，被删文件的 import 已清空，才有一致的收缩面。
> **注 3**：**T4 必须在 T6 之后**。`src/core/messages.ts`（670 行）是 T3/T4/T6 三者的共享写目标——T3 删同步引擎的密钥文案、T4 删同步 UI 文案、T6 删其余全部文案。为避免三方同时改一个文件，**该文件归 Root（T3、T6）所有**，T4 只改 `SyncSettingsView.tsx` 与 `sync-locales.ts` 两个文件，**不得触碰 `messages.ts`**；T4 排在 T6 之后，此时文案删减已收敛，它只需处理自己那两个文件。
> **注 4**：`core/backup.ts`、`core/exporter.ts` **不属任何删除切片**（§7.3.5/§7.3.6 的共享原语结论）。

**子代理模型**：按全局规范统一用 `antigravity/gemini-3.8-flash`；该路由不可用时用与 Root 相同的 provider/model。

---

## 10. 关键风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **同步路径 `containsSecrets` 误标复现**（§7.2.4） | 明文密钥落盘却标注 false —— 问题 1 的缺陷换个位置重演 | T3 把「改标注 + 删 pull 守卫」列为**同一验收契约**，不可拆 |
| `src/index.ts` 手术式收缩引入回归 | 同步路由被误删或参数错位 | 保留 `src/index.sync.test.ts`（218 行）与 `tests/route/` 下的同步用例；T6 完成后逐路由冒烟 |
| 桶导出悬空引用 | `pnpm typecheck` 直接失败 | `security/index.ts` 第 13 行、`core/index.ts`、`schema/index.ts` 与删除面**同切片**处理 |
| sync-engine 重写引入回归 | 同步静默丢分区或写坏配置 | 保留 `sync-engine.test.ts`（1170 行）中与 transport/状态相关的用例；端到端回环必做 |
| 删加密后误删日志脱敏 | 日志泄漏密钥 | `security/redaction.ts` 保留；验收时确认 logger 仍调用它 |
| 上游同步与本地改造冲突 | 每次上游发版都要解 9-19 个冲突 | policy 脚本 + `sync-policy.json`；workflow 只开 PR；高频冲突文件加入 `owned` |
| **删错原语**：把跨功能的事务原语当成某功能的实现删掉 | 同步兜底/失败回滚静默失效 | **每个候选删除文件先跑 `grep -rn "from '.*<module>'"`**，引用方 ≥ 2 个不同功能域时一律保留 |
| 公开仓库与私有同步渠道混淆 | 密钥推上公开仓库 | `dale0525/dsh-plugins` 当前是 **public**；fork 的插件源码公开无妨，但**同步渠道必须指向独立的私有仓库**，两者物理分离 |

---

## 11. 自审发现（本文的更正记录）

按「重复 / 冲突 / 矛盾 / 遗漏 / 过度设计」五维自审，实测推翻/补充 11 处：

| # | 原说法 | 实测 | 更正 |
|---|---|---|---|
| 1 | 「删除约 1.5 万行源码 + 约 40 个测试文件」 | 终值：**净删 24105 行**（源码 20636 / 测试 3469） | §0 与 §7.3.2 已改为实测值 |
| 2 | 把 `security/vault.ts` 列入删除清单 | 它是 export/import 的「整文件即秘密」本机镜像（`.credentials.yaml` 这类文件字节不进归档，只镜像到 `<dataDir>/vault/`）。**两个消费方都在保留集内**：`core/analyzer.ts` 第 27 行 `restoreVaultFiles`、`core/exporter.ts` 第 18 行 `refreshVault`，而这两个文件因 `sync-engine.ts` 依赖它们而保留 | **移出删除清单，保留**（C 类清单里本就没有它，此处修正的是文字表述） |
| 3 | `core/restore.ts` / `rollback.ts` 标为「待定」 | 两者**均须保留**：`rollback.ts`（`sync-engine.ts` 第 50 行）、`restore.ts`（`client/api.ts`、`client/run-store.ts`） | §7.3.5 已定性 |
| 4 | `security/security.test.ts`「可整删」 | 47 个 test 块里只有 16 个与加密相关；zip-security / integrity / scanner / **redaction（明确要保留）** 共 31 个块必须留 | 改为「就地裁剪 16 个块」 |
| 5 | **遗漏**：未覆盖旧对话问题 2 | 裸包名 `dsh-mcp-client` 写回 patch → `MODULE_NOT_FOUND` → profile 起不来 | 用户裁定**整体砍掉**，已从本文删除 |
| 6 | 暗示「改造一顺带消除了问题 1 的泄漏面」 | 问题 1 的缺陷本质是**标注与内容不符**，不是「有明文」 | §7.2.4 独立成节 |
| 7 | 「dsh-web 的 GitHub 直装可用」暗示它不依赖 npm | 其聚合包依赖写 `workspace:*`，profile 非 workspace → pnpm **回退拉 npm registry** | §4 已补差异说明 |
| 8 | **最严重**：把 `core/backup.ts` 列入删除清单 | 它是**事务快照原语**，被 6 个保留集文件引用 | §7.3.5 移出删除清单 |
| 9 | **方法论错误**：把「引用面」当「删除面」 | 初稿称宽读法删「约 2.5 万行源码」；实测源码删除仅 **20636 行**，另有 16 个装配层文件（12309 行）是**改写而非删除** | §0 #4 与 §7.3.2 已改为实测值 |
| 10 | 假定 policy 合并「先 ours 后 theirs」 | spike 实测：该顺序会让**我方补丁被上游覆盖** | §6.3 明确正确顺序为 **theirs → ours → 重删**，并已实测归零 |
| 11 | **遗漏**：改造一只写了「删脱敏」，未提 `containsSecrets` 硬编码 | `sync-engine.ts` 第 966 行硬编码 `containsSecrets: false`；第 329 行拒绝 `containsSecrets=true` | 新增 §7.2.4，并入 T3 验收契约 |

**这 11 条里有 4 条（#2 #4 #6 #8）是「删错东西」，2 条（#9 #11）是「方法论/联动遗漏」**，集中在两类误判：①「模块名看起来属于某功能、实际是跨功能原语」；②「只看了显式删除清单，没查隐式的标注/守卫不变量」。后续实施时遇到任何 `backup*` / `security*` / `snapshot*` 命名，都应先跑一次 `grep -rn "from '.*<module>'"` 确认引用面。

自审另确认了三条**无需改动**的设计判断：

- `sync/ancestor.ts` / `merge.ts` / `risk.ts` / `review-queue.ts` **仅被 `sync-engine.ts` 引用**，所以「删合并逻辑」与「重写 sync-engine」是同一个切片。
- `MAX_REMOTE_SNAPSHOTS`（远端快照裁剪）与 `retention-policy.ts`（本地备份的 GFS 保留）是**两套独立机制**，删备份只删后者，前者保留。
- `security/secret-scanner.ts` **不整体删除**：它除 export/sync 外还被 `core/migration-history.ts`（历史记录脱敏）与 `security/redaction.ts`（日志脱敏，单一真源）使用。

---

## 12. 评审记录

### 12.1 Root 自审

见 §11。按「重复/冲突/矛盾/遗漏/过度设计」五维自审，实测推翻/补充 **11 处**。

### 12.2 子代理盲审

席位：`antigravity/gemini-3.8-flash`（首次派发因席位长时间无产出被中断，向同一席位重试后成功）。只给路径与审查维度，未给背景或额外指令。返回 **12 条**。

### 12.3 逐条裁定

**Root 对 12 条全部做了独立探针复验**（不接受二手转述）：

| 条目 | 内容摘要 | 复验结果 | 裁定 |
|---|---|---|---|
| 1 | §4.2 与 §4.3 重复列备份面删除清单 | 属实 | **采纳**，§4.2 改为只列同步面 |
| 2 | `sync/backup-files.ts` 误删 | 属实（含导出必需的 `isValidExportFileName`） | **采纳**（宽读法下该文件整体删除，结论随之变化） |
| 3 | `security/encryption.ts` 误删 | 属实（导出/导入归档加密） | **采纳**（宽读法下删导出，故该文件确实可删，但须处理 6 个消费方） |
| 4 | `ui/backup-inspect.ts` 误删 | 属实（`ProfilesPanel.tsx` 依赖 `groupPlanItems`） | **采纳**（宽读法下随面板一起删） |
| 5 | `core/restore.ts` 判「可删」 | 属实（`client/api.ts`、`run-store.ts` 依赖） | **采纳**，保留 |
| 6 | 「`core/backup.ts` 引用 `retention-policy.ts`」是伪证 | 属实（第 318 行注释明确说「故意不 import」） | **采纳**，删除该错误断言 |
| 7 | 测试清单遗漏 + 数量自相矛盾 | 属实 | **采纳**，改为实测行数 |
| 8 | 遗漏 `OverviewPanel.tsx` 降级改造 | 属实 | **采纳**（宽读法下该文件整体删除） |
| 9 | 遗漏 `security/index.ts` 悬空导出 | 属实（第 13 行） | **采纳**，加联动说明 |
| 10 | 「重启后生效文案全是错的」断言过强 | 属实（`dsh-plugin-manager` 第 941/1141 行确有真实 `restart-required`） | **采纳**，改为按改动类型分类 |
| 11 | 路 B 的 `git+&path:` 链属过度设计 | 属实 | **采纳**（用户裁定发布 npm，路 B 整体删除） |
| 12 | 为魔改 fork 设计定时上游同步属过度设计 | 不成立（**用户显式要求**） | **不采纳**，进入辩论轮 |

### 12.4 辩论轮（条目 12）

按协议，凡判「不采纳」必须再开一轮。**结果：席位让步**——接受「用户显式要求的功能不构成过度设计」，并认可 T8 排序最后、§6.4 已含降级路径。

### 12.5 共识状态

12 条全部处于「采纳」或「让步」，**无坚持项，无共识破裂**。

---

## 13. 证据索引

| 结论 | 出处 |
|---|---|
| 两个 ZIP 含明文 key，其余 8 个不含 | `unzip -p *.zip \| grep -c "X-Goog-Api-Key"` 全量扫描 |
| `mcp_connector.json` 是孤儿 | `grep -rl "mcp_connector" ~/.dsh/profiles/web/node_modules` 无输出 |
| npm 身份 = `logictan` | `npm whoami` 与 `GET /-/whoami`（Bearer token）双向确认 |
| 账号 2FA 关闭 | `GET /-/npm/v1/user` → `{"tfa":false}` |
| `@logictan` 可发布 | `npm publish --dry-run --access public` 退出码 0 |
| 上游发布节奏 | `git fetch --unshallow` 后 60 tags / 148 commits（90 天内）；`v0.1.46→v0.1.60` 26 天 |
| 真冲突面 9/16/19 | `git diff --name-only <tag> v0.1.60` ∩ 我方编辑集 |
| policy 合并可归零 | `/tmp/p1`、`/tmp/p2` 两轮 spike，应用 policy 后残留冲突 0 |
| policy 顺序必须 theirs→ours | 第一轮 spike 用 ours→theirs，我方补丁被覆盖 |
| 宽读法删除面 24105 行 | import 图闭包分析（`/tmp/authoritative.cjs`） |
| `containsSecrets` 硬编码 false | `sync-engine.ts` 第 966 行 `snapshotToZip()` |
| pull 拒绝 `containsSecrets=true` | `sync-engine.ts` 第 329 行 + `messages.ts` 第 275/587 行 |
| `defaultSecretScanner` 与 `createSecretScanner` 重复 | `core/exporter.ts` 第 60 行 vs `security/secret-scanner.ts` 第 404 行 |
| 根包 `dsh.bundle.patch` 是安装入口 | `dsh-web/package.json`；`dsh-plugin-manager/lib/index.js` 第 30-32 行 `bundleManifest()` |
| 两个 patch 文件都被宿主监听 | `dsh-hmr/lib/index.js` 第 365-376 行 + `lsof -p 23575` 的 fd 29/52 |
| module watch 默认关闭 | `dsh-base/cordis.patch.yml` 第 32 行 `root: []` |
| `settings.yaml`/`.credentials.yaml` 热重载 | `dsh-settings-file/lib/index.js` 第 180 行；`dsh-credentials-local/lib/index.js` 第 448 行 |
| dsh-web 无上游同步 workflow | `.github/workflows/` 16 个文件全量检查 |

**被否掉的候选方案（存档，供后续会话不再重提）**：子包用 `workspace:*` 从 git 装（`Cannot resolve package from workspace...`）；`file:../x`（consumer 侧路径不存在）；commit SHA 自引用（`git checkout failed: unable to read tree`）；tag + 默认设置（`ERR_PNPM_EXOTIC_SUBDEP`）；`blockExoticSubdeps` 写 `.npmrc`（无效，只认 `pnpm-workspace.yaml`）。**以上均因「发布 npm」的裁定而整体作废。**


---

## 14. 实施记录（实施完成后回填；偏离以实际代码为准）

实施已完成，T1–T10 全部落地。以下是**实测结果与本计划的偏离**。

### 14.1 与计划的偏离

| # | 计划 | 实际 | 原因 |
|---|---|---|---|
| 1 | C 类 78 + D 类 23 共 101 个文件 | 净删更多：路由删除后**整条依赖链不可达**，追加删除 `src/market/**`、`src/sync/backup-*`、`retention-policy`、`src/cli/**`、12 个 `src/ui/*`、`core/transaction-coordinator` | 计划按「面板→模块」人工列清单，漏了「路由删除后没人再引用的整棵子树」。用 import 图闭包重算后才暴露 |
| 2 | `packages/dsh-config-manager` 改名 @logictan 但未提 loader id | tsdown banner 里 `id` 硬编码为 `dsh-config-manager`，与改名后的包名不一致 | 实测 npm 上 `@linxin666/dsh-ssh` 产物 id 与其包名逐字一致；已改为由 `LOADER_ID` 派生 |
| 3 | `build`/`prepare` 直接 `tsc && tsdown` | 前置 `npm run clean` | tsc 不删除已删源文件对应的产物，导致 npm pack 里带 28 个陈旧 `lib/market/**` |
| 4 | CLI 删除只列子命令 | 整个 `src/cli/**` + `backup-plan`/`backup-verify`/`reinstall` + `tests/cli/` 一并删除 | CLI 的全部子命令都属导出/恢复/重装，同步面没有任何 CLI 入口 |
| 5 | 未提 `core/cache-cleaner` | 收缩为 tmp + exports 两个面 | 市场缓存面随 `src/market` 删除而失效 |
| 6 | 未提 `sync/github-auth` | 新增 `getUser(token)` | `/sync/github/validate` 原本借用 `market/github-repos` 的 `GitHubAuthRest`；该模块随市场删除 |

### 14.2 实施中发现并修掉的自研缺陷

| # | 缺陷 | 证据 |
|---|---|---|
| 1 | `sync-upstream.mjs` 版本排序被 peeled tag 破坏 | `git ls-remote --tags` 同时返回 `refs/tags/vX` 与 `refs/tags/vX^{}`；后者的数字段解析成 NaN，使比较器失去全序，实测把 `v0.1.9` 当成「最新」（而真实最新是 `v0.1.60`） |
| 2 | `sync-upstream.mjs` 把 `git grep` 的「无命中」当成失败 | `git grep` 无匹配时退出码为 1，被 `execFileSync` 当异常抛出，导致「零冲突」这条成功路径反而报错 |
| 3 | 冲突归零判据用错了对象 | `git checkout --ours/--theirs` 只改工作区，**索引仍是 unmerged**，直到 `git add` 才收敛；原实现用 `git diff --diff-filter=U` 判定，恒报「仍有冲突」 |

### 14.3 验收证据（全部实跑）

| 验收 | 结果 |
|---|---|
| `pnpm typecheck` / `tsc --noEmit` | 0 error |
| `node --test` | **1273/1273 通过** |
| §7.2.6 端到端（真实 Git 通道） | push → 远端 manifest `containsSecrets: true` → pull → applyItems → 另一侧读到真实 provider 密钥（PASS） |
| §7.3.7-1 面板组件名零命中 | 通过 |
| §7.3.7-2 设置页只剩「同步」 | `NAV_ITEMS` 只有 `sync` |
| §7.3.7-3 路由仅同步 | 17 条，全部 `/api/dsh-config-manager/sync/*` |
| §7.3.7-4 CLI 子命令 | `bin` 字段与 `src/cli/**` 均已删除 |
| §7.4 热重载（配置/补丁） | 改 `~/.dsh/cordis.patch.yml` 的 `toolCallTimeoutMs`，**PID 23575 未变**，新调用即按新值生效；改回后 md5 与备份一致 |
| §7.4 热重载（客户端产物） | `dev-watch.mjs` 监听源码 → 重建 `lib/client.js`（mtime/size 变化、标记入包） |
| §8 安装形态 | `npm pack` + 干净 profile `dsh plugin add`：bundle 注册成功、patch 行 name 正确、`prepare` 构建出 host+client 产物、产物内无 `market`/`cli` 残留、bundle id == 包名 |
| §6 上游同步 policy | 合成上游 v0.1.61 上实测：原始冲突 2 个 → 应用 policy 后 **0 个**；我方改写保留、我方删除保留、上游新增文件带入 |


### 14.4 里程碑盲审（Root 自审 + 独立席位）

**触发依据**：本次交付新增了对外契约（同步引擎的明文语义、聚合包安装入口）与跨文件不变量
（containsSecrets 标注、基线对齐），且收尾一个可独立验收的交付单元（T1–T10）——两个正条件同时成立。

**席位**：`antigravity/gemini-3.8-flash`（只给路径与五维审查维度，未给背景）。

#### Root 自审

按「重复 / 冲突 / 矛盾 / 遗漏 / 过度设计」五维自审，实测确认：
- 聚合 patch 与子包 patch 一致（`aggregate.mjs --check`）；
- 同步路由仅一套 17 条，无重复注册；
- 明文语义在引擎层处处一致（`sync-selection` 零 `encrypt` 残留）；
- `containsSecrets` 三处标注点（push / recordBaseline / snapshotToZip）均如实取值。

**自审另发现两处缺陷（已修）**：
1. `tsdown.config.ts` 的 loader `id` 硬编码为 `dsh-config-manager`，与改名后的包名不一致（实测 npm 上 `@linxin666/dsh-ssh` 产物 id 与其包名逐字一致）；
2. `build`/`prepare` 未先清理 `lib/`，tsc 不删已删源文件的产物 → npm pack 带 28 个陈旧 `lib/market/**`。

#### 子代理盲审

返回 **14 条**。Root 对**每一条都做了独立探针复验**（不接受二手转述），结论：**14 条全部属实，全部采纳**。

| 条目 | 内容 | 复验证据 | 裁定 |
|---|---|---|---|
| 1 | `applyItems` 基线写成新生成的本地 id，`hasNewRemoteSnapshot()` 恒真 → 自动同步空转 | `sync-engine.ts:660` 与 `:469` 对读 | **采纳**（新增 `opts.snapshotId`） |
| 2 | HTTP `/sync/pull` 缺省 `'merge'`，与引擎/产品语义的 `replace` 冲突 | `index.ts:2171` vs `sync-engine.ts:427/518` | **采纳** |
| 3 | 根文档写的 `scripts/dev-watch.mjs` 实际在子包内 | `ls scripts/` 无该文件 | **采纳** |
| 4 | sync 路由仍解析并伪传 `encrypt/includeSecrets/password`，注释与现状相反 | `index.ts:2118-2141` | **采纳** |
| 5 | 中英文案仍称自动同步「拉取合并」 | `sync-locales.ts:136/139/337/340` | **采纳** |
| 6 | model-tools JSDoc 写「5 个工具」，strategy 枚举含已不可达的 `merge` | `model-tools.ts:68/111` | **采纳** |
| 7 | `sync-policy.json` 漏登 64 个已删文件、owned 含已删文件 → 上游会静默复活 | 实测 deleted 应为 143 而非 79 | **采纳**（并加 `--refresh-policy`） |
| 8 | `SyncConfirmView` 调已被删除的 `/consult` 路由 → 永远 404，ConsultCard 永不渲染 | `grep -c API.consult` = 0 | **采纳** |
| 9 | autosync 未清理 `preview()` 的临时 ZIP（契约要求调用方清理） | `autosync-scheduler.ts:418-428` | **采纳** |
| 10 | `adapters/self` 白名单残留 `backup-schedule.json`/`market-config.json` | `self.ts:37-38` | **采纳** |
| 11 | `index.ts` 残留 48 个已废弃 API 常量与空段落注释 | 脚本比对 used vs declared | **采纳** |
| 12 | README 凭据槽位名留空 | `README.md:55` | **采纳** |
| 13 | `sync-upstream` 在无冲突时提前 `exit(0)`，跳过 policy 全部步骤 | `sync-upstream.mjs:195` | **采纳** |
| 14 | `run-store` 对不存在字段做 `Omit` | `run-store.ts:60-63` | **采纳** |

**共识状态**：14 条全部处于「采纳」，**无「不采纳/部分采纳」，故按协议无需再开辩论轮**。

**盲审后回归**：typecheck 0 error；测试 1272/1273（唯一失败为改造前既有的 `config-lifecycle`
防抖时序 flake，与本次改动无关——改造前后三次重跑均有 1/3 概率出现）。


### 14.5 安装链与产物级验证（补做）

计划 §8 的「安装形态」只写了「`npm pack` + 干净 profile 安装」。实际补做了**完整依赖链**验证，
并发现一处会让用户装不上的缺陷。

**新发现并修复**：根包 `package.json` 未声明聚合包依赖 —— 根包自己就是被安装的那个包
（`dsh.bundle.patch` → `packages/all/cordis.patch.yml`），但它的 `dependencies` 是空的，
所以 profile 里只装到根包、**子插件不会随包带出**。已补
`"@logictan/dsh-plugins-all": "0.2.0"`（普通 semver range + `linkWorkspacePackages: true`，
与 dsh-web 根包同款；计划 §3.3 明确否掉了 `workspace:*` 跨 git 安装，故不写 `workspace:*`）。

**完整链验证**（把 registry 换成本地 tarball，其余不变）：

| 环节 | 结果 |
|---|---|
| 根包 tarball 内容 | `package.json` / `packages/all/cordis.patch.yml` / `packages/all/package.json` / `README.md` |
| 根包 `dsh.bundle.patch` 可解析 | 是（`packages/all/cordis.patch.yml`，1570 B） |
| `dsh plugin add <根包>` | 依赖链 +5 个包：根 → 聚合 → 子插件 |
| 聚合 patch 的子插件行 | `id: config-manager` / `name: '@logictan/dsh-config-manager'` |
| 子插件宿主产物 | `lib/index.js` 存在 |
| 子插件客户端产物 | `lib/client.js` 存在（`prepare` 构建） |
| patch 行 `name` 从 profile 根可解析 | 是 |

**产物级加载验证**（不依赖浏览器）：把 `lib/client.js` 放进最小 `window`/`document` shim 里执行，
注入真实 react —— 断言它按 loader 协议注册 1 次、`id` 等于包名、`factory` 可调用、
导出的模块带 `apply` 函数与 `inject: ["slots","locale"]`。**PASS**。

> 这补上了「打包成功」与「真机加载成功」之间的空档：此前只验证了文件存在，
> 未验证产物能否在 loader 协议下真正注册。

### 14.6 已知未做（如实登记）

| 项 | 状态 | 原因 |
|---|---|---|
| `npm publish` | **未执行** | 需要 npm 账号写操作；本机已确认 `npm whoami` = `logictan`、2FA 关闭、`@logictan` 作用域可用（计划 §3.1/§3.2 已实测），但发布是外部不可逆动作，留给用户执行 |
| 真实 GUI 界面验证 | **未执行** | 运行中的 web profile 装的是上游 `dsh-config-manager@0.1.60`，不是本 fork；要让本 fork 生效需改 profile 依赖并重启宿主，会中断当前会话 |
| 真实上游同步 PR | **未执行** | 上游 `main` 当前就停在 `v0.1.60`（即我们的基线），没有更新可同步；policy 算法已在**合成上游**上端到端验证（冲突 2 → 0） |


### 14.7 真实浏览器内的 loader 验证（补做）

运行中的 web profile 装的是**上游** `dsh-config-manager@0.1.60`（不是本 fork），
因此无法直接走本 fork 的同步标签页。但可以在**真实浏览器**里验证本 fork 产物的加载契约。

**先取证宿主侧的 id 约定**：读运行中页面的 `window.__DSH_BOOT__`（插件图载荷），
69 个 entry 的 id 全是**完整包名**：

```
@deepseek-ai/dsh-api-gateway / @deepseek-ai/dsh-client-ui-settings / ...
@dickpy/dsh-imagegen / dsh-agy-link / dsh-config-manager / dsh-pet / ...
```

即 scoped 包用完整 scoped 名、非 scoped 包用裸名 —— 与 §14.1 #2 的结论一致。

**再验证本 fork 产物**：在真实页面里包一层 `window.__ModuleLoader__.load` 捕获注册，
把本 fork 的 `lib/client.js`（415 KB）作为 `<script>` 注入：

| 断言 | 结果 |
|---|---|
| 注册次数 | 1 |
| 注册的 `id` | `@logictan/dsh-config-manager`（== 包名，符合宿主约定） |
| `factory` 类型 | `function` |
| 注入后控制台错误数 | **0** |

**结论**：loader id 修复在真实浏览器里得到确认。此项虽未覆盖「同步标签页的实际交互」，
但覆盖了「产物能否被真实宿主加载」这一此前完全空白的环节。

**仍缺的一项**：让本 fork 在 GUI 里真正跑起来（改 profile 依赖 → 重启宿主）会中断当前会话，
故留给用户执行；重启后按 §7.3.7 验收 2 检查「设置页只剩同步一个标签」即可。


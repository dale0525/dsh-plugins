# dsh-config-manager 同步链路对 `cordis.patch.yml` 双层的覆盖缺口

> 状态：事前冻结的计划，待评审。实施中的偏离以实际代码为准。
> 触发问题：「当前的 config manager 同步时，是否会同步全局和 web profile 下的 cordis patch yaml？」
> **路径约定**：本文所有 `src/...`、`docs/...` 均相对 `packages/dsh-config-manager/`；
> 只有明确写出 `docs/plans/...` 的是仓库根路径。

## 0. 结论摘要

1. **不同步 profile 层。** 当前同步只覆盖 home 层（`$DSH_HOME/cordis.patch.yml`）的 patch 行；
   profile 层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）**完全不参与**导出、快照、上传与导入。
2. **不是「漏读一个文件」，而是五处独立缺口叠加**：读取层硬编码单文件（1.1）、寻址层两个常量撞车（1.2）、
   diff 基准只读 home 层（1.3a）、计划项只以 `lineId` 为键（1.3b）、快照/回滚项丢了层（1.3c）。
   只补其中任一处都不够。
3. **真实产物实测**：最新同步快照的 `patch` 数组共 11 行，全部来自 home 层；
   profile 层 10 行配置（含 webserver 端口、trustedHosts、openviking 召回参数、computer-use / browser-use 两组 `insert:` 挂载、ctx-mem-bridge 开关）
   在同步产物中**一条都不存在**。两层并集 21 行，快照只覆盖 11 行。换机恢复会丢掉 profile 层全部配置。
4. **附带确认一处死代码**：`patchPath` 的 `PROFILE_PATCH_FILE` 分支永不可达
   （两个常量值相同），`ensureActivationRow` 以为在写 profile 层，实际写的是 home 层。
5. **范围外发现 1 项**：本包两个密钥扫描器判据不同，导出路径用的那个不命中 `AQ.` 形态的 Google API key。只报告，不纳入本次改动。

## 1. 事实与证据

### 1.1 读取层：adapter 只认一个文件

三个会读写 patch 行的 adapter 全部硬编码 home 层文件名常量：

| 位置 | 语句 |
|---|---|
| `src/adapters/plugins.ts:29` | `export const USER_PATCH_FILE = 'cordis.patch.yml'` |
| `src/adapters/plugins.ts:175-176` | 读 `USER_PATCH_FILE`，逐行推入 `{ file: USER_PATCH_FILE, lineId, raw }` |
| `src/adapters/mcp.ts:98,114,160` | 读 / 读 / 写，均为 `USER_PATCH_FILE` |
| `src/adapters/prompts.ts:119,135,195,201,205` | 读 / 读 / 写 / 读 / 写，均为 `USER_PATCH_FILE` |

profile 层的文件名常量确实存在（`src/index.ts:650` `PROFILE_PATCH_FILE`），但它的全部引用只有三处：
`ensureActivationRow` 内的两次（`src/index.ts:537,540`）与 `patchPath` 内的一次（`src/index.ts:667`）。
**没有任何 adapter 用过它。**

### 1.2 寻址层：两个常量同值，profile 分支永不可达

`src/index.ts:665-669`：

```ts
private patchPath(file: string): string {
  if (file === USER_PATCH_FILE)    return join(this.homeDir, USER_PATCH_FILE)
  if (file === PROFILE_PATCH_FILE) return join(this.homeDir, 'profiles', this.profile, PROFILE_PATCH_FILE)
  throw new Error(this.msg('host.patchUnsupported', { ... }))
}
```

`USER_PATCH_FILE`（`src/adapters/plugins.ts:29`）与 `PROFILE_PATCH_FILE`（`src/index.ts:650`）
**字面量相同**，都是 `'cordis.patch.yml'`。因此第二条分支恒不可达，第三条拒绝分支是死代码。

后果：`ensureActivationRow`（`src/index.ts:535-543`，调用点 `src/index.ts:594`）本意是给非 bundle
插件补 profile 层激活行，实际把 `pm-<slug>` 行写进了 **home 层**。home 层对每个 profile 生效，
于是「只在 web profile 装过的插件」会对其他 profile 也生效。

> 未观察到已发生的错位：本机两份 patch 中都没有 `pm-` 行（`grep -n 'pm-' ` 均无命中），
> 说明该路径在本机尚未被触发过。此处按「机制已确认、故障未发生」对待，不夸大。

### 1.3 另外三处：写入路径通用，但 diff / 计划项 / 快照项都丢层

`PatchLine` 带 `file` 字段（`src/schema/types.ts:111`），**写入调用本身是通用的**：
`src/adapters/plugins.ts:567` 的 `applyPatchChanges(pl.file, ...)` 直接使用数据里的文件名。
缺口在它前后的三处：

| # | 位置 | 现状 | 后果 |
|---|---|---|---|
| a | `src/adapters/plugins.ts:417` | `diff` 阶段 `readPatchLines(USER_PATCH_FILE)`，只读 home 层 | profile 层行在目标机即使已存在也判 `Create`；目标机 profile 层已有不同值也判不出 `Conflict` |
| b | `src/adapters/plugins.ts:420,426` 与 `565` | 计划项 `id = \`patch:\${pl.lineId}\``、`target.ref = pl.lineId`、`applyItem` 用 `find((p) => p.lineId === ref)` | 跨层同名 `lineId` 的项 id 撞车，且 `find` 只会命中数组里先出现的那个（home 层）→ profile 层行被写进 home 层 |
| c | `src/core/backup.ts:209` 与 `src/core/rollback.ts:76` | `patchLine` 快照项与回滚都硬编码 `const file = 'cordis.patch.yml'` | 层信息未随快照项保存；回滚一律写回 home 层 |

(b)(c) 合起来意味着：**只要开始搬运 profile 层行，回滚就会把 profile 层的原值写进 home 层。**
这是本次改动会**新引入**的缺陷，因此修 `diff` / 计划项 / 快照项不是顺手加固，是必要前置。

### 1.4 真实产物实测

最新同步快照 `~/.dsh/dsh-config-manager/sync/snapshots/sync-87dbe6c9-7208-417a-bcc1-81b0d57bd13d`
（`createdAt` 2026-09-19T17:46:44.575Z，`containsSecrets` true）：

| 检查项 | 实测结果 |
|---|---|
| `plugins/plugins.json` 的 `patch` 行数 | 11 |
| `patch[].file` 去重后的取值集合 | `["cordis.patch.yml"]`（单一值） |
| 快照内 `patch` 行 id | `ui-skin-*` ×10 + `mcp-stitch` |
| home 层实际行 id（`readPatchLines` 口径） | 同上 11 个 |
| profile 层实际行 id（`readPatchLines` 口径） | `webserver` / `connection` / `dsh-market` / `openviking-memory-runtime` / `computer-use` / `computer-use-cua-driver-native` / `browser-use` / `browser-use-playwright-mcp` / `web-fetch-http` / `ctx-mem-bridge` |
| profile 层 10 行是否出现在快照中 | **否，一条都没有** |
| 两层并集 | 21 行（快照覆盖 11） |
| 跨层同名 `lineId` | 0 个（当前无重叠） |
| 快照目录内是否存在 `cordis.patch.yml` 整文件 | **否**（`find` 无结果） |

**口径说明**：profile 层的顶层 `- id:` 只有 6 个，另有 2 个 `- insert:` 块各挂 2 项
（`~/.dsh/profiles/web/cordis.patch.yml:55,82`）。`readPatchLines` 会把 `insert` 数组逐项展开
（`src/index.ts:690-698`），所以按引擎口径是 **10 行**，不是 6 行。本节的计数以引擎口径为准。

同步产物是「按分区平铺的 JSON + 文件类分区目录」，patch 行只作为 `plugins` 分区内的数据存在，
不存在整文件搬运通道。

### 1.5 为什么两层都得管：宿主侧的层语义

宿主组装 patch 栈的顺序（`@deepseek-ai/dsh-app-boot` 的 `readProfilePatches`，lib 第 1005-1012 行）：

```
bundle 层  →  profile 层 cordis.patch.yml  →  home 层 cordis.patch.yml  →  --patch overlays
```

**后应用者胜**，即 home 层**覆盖** profile 层（`homePatchPath` 的文档注释亦如此声明）。
两层是「每 profile 配置」与「全机偏好」的分工，不是冗余。

而应用端按 id 建**全局**索引（`applyEntryPatches`，lib 第 62-69 行 `buildMap` 递归遍历所有
`id`，不区分层级），所以跨层同 id 会后者覆盖前者 —— 这是宿主语义，不是本插件要解决的问题。

同一个设计意图在本地回滚路径上**已经落地**：`src/core/backup.ts:28` 的注释与第 46 行
`candidates.push({ relPath: \`profiles/\${ctx.profile}/cordis.patch.yml\` })` 明确把 profile patch
纳入导入前整文件备份（第 48 行还一并纳入同目录的 `pnpm-workspace.yaml`）。

**即：本地整文件备份覆盖两层，同步只覆盖一层。这是实现缺口，不是产品选择。**

## 2. 方案

### 2.1 推荐取值（逐条裁定）

| # | 待决项 | 推荐 | 理由 |
|---|---|---|---|
| A | 是否让同步覆盖 profile 层 patch？ | **覆盖** | 1.5 已证明设计意图是两层；profile 层承载换机必需配置（端口、trustedHosts、召回参数、两组 `insert:` 挂载、bridge 开关），漏掉它等于「同步成功但换机后配置减半」。 |
| B | 层标识怎么表示？ | **`PatchLine.file` 承载层 token**：home 保持 `'cordis.patch.yml'`（存量快照零改动），profile 用新 token `'profile:cordis.patch.yml'` | 用逻辑 token 而非相对路径，避免跨 profile 导入时寻址到源机的 profile 名；home 值不变 ⇒ 存量快照无需兼容垫片。命名前缀沿用包内既有先例 `PLUGIN_PATCH_REF_PREFIX = 'patchFile:'`（`src/core/backup.ts:95`）。 |
| C | 跨层同 id 如何处理？ | **计划项 id 与 `target.ref` 改为层限定复合键 `\`\${file}#\${lineId}\``**，不合并、不告警 | 应用端本来就是全局按 id 覆盖（1.5），合并会篡改宿主语义；而复合键是 1.3(b)(c) 的必要前置——否则回滚会把 profile 层原值写进 home 层。`file` 与 `lineId` 都不含 `#`，分隔符无歧义。 |
| D | profile patch 中的疑似敏感字段是否额外遮蔽？ | **不做，维持明文语义** | 同步通道明文是已冻结的产品选择（包 `AGENTS.md`「同步通道的明文语义」）。`X-Goog-Api-Key` 在 home 层 patch 里本就明文（0600 权限），同步只是照搬。 |
| E | 文档口径 | **更新 `docs/spec/bundle-format-v1.md`** | 改格式行为必须同步 spec（包 `AGENTS.md` 文档同步表）。需把 `plugins.patch[].file` 的取值域从隐式单值明确为两个层 token，并点明它与 `plugins.patchFiles`（`patches/**`，issue #35）是**两件事**。 |
| F | 是否加契约测试？ | **加** | 这是跨文件不变量（两层可见性 + 层限定键），现有 `plugins.test.ts` / `index.facade.test.ts` 只覆盖单层。 |
| G | 计划文档落哪？ | `docs/plans/2026-09-20-config-manager-patch-layer-sync.md` | 已定：仓库根 `docs/plans/` 与既有 `2026-09-20-*` 命名一致；包内无 `plans/`，包 `AGENTS.md` 亦未约定。 |

### 2.2 改动清单（按切片）

| 切片 | 内容 | 触点 | 归属 |
|---|---|---|---|
| S1 | 寻址层：让两个常量取值不同（home 不变、profile 用 `'profile:cordis.patch.yml'`），`patchPath` 两个分支都可达 | `src/index.ts`、`src/adapters/plugins.ts` | Root（跨文件不变量：patch 文件寻址） |
| S2 | 读取层：`PluginsAdapter.export` 同时读两层，`file` 字段如实标注来源层 | `src/adapters/plugins.ts` | Root（S1 的调用方，共享寻址契约） |
| S3 | diff 层：`analyzeImport` 按行自带的 `file` 读目标端对应层（1.3a） | `src/adapters/plugins.ts` | Root（同文件，不可与 S2 并行） |
| S4 | 键层：计划项 `id` / `target.ref` 改复合键，`applyItem` 按复合键查找（1.3b） | `src/adapters/plugins.ts` | Root（同文件，不可与 S3 并行） |
| S5 | 快照/回滚层：`patchLine` 快照项携带层、回滚写回该层（1.3c） | `src/core/backup.ts`、`src/core/rollback.ts` | Root（S4 定义的 ref 形态是它的输入契约） |
| S6 | 契约测试：两层读写 + 复合键 + 回滚落层 | `src/adapters/plugins.test.ts`、`src/index.facade.test.ts` | 可外派（有独立验收契约 = 测试文件；共享触点仅 1 处） |
| S7 | 文档：spec 的 `file` 取值域 | `docs/spec/bundle-format-v1.md` | Root（对外契约单一真源） |

S1–S5 共享同一不变量与同一批文件，必须串行且留 Root。S6 依赖 S1–S5 的接口形状定稿后再写。

S1 的涟漪面已实测：`mcp.ts:98,114,160` 与 `prompts.ts:119,135,195,201,205` 共 8 处传
`USER_PATCH_FILE`。这两处 adapter 只操作 home 层，改动是机械替换为新的 home token，
但**必须与 S1 同批**，否则常量语义变化后编译/行为不一致。

### 2.3 明确不做

- **不改宿主**：跨层 id 覆盖是 `applyEntryPatches` 的既定语义，插件侧不插手。
- **不新增 schema 字段**：`PatchLine.file` 与 `SnapshotEntry.ref` 都是既有字段。
- **不为 `mcp` / `prompts` adapter 补 profile 层读取**：本次只扩 `plugins` 分区。
  注意 `~/.dsh/profiles/web/cordis.patch.yml:133-135` 的注释
  「MCP 服务器条目不放这里：dsh-config-manager 的 MCP 分区硬编码只读顶层 `$DSH_HOME/cordis.patch.yml`」
  **是当前缺陷逼出来的规避措施，不是设计意图**——不要把它当作「MCP 条目本来就该放 home 层」的证据。
  两个 adapter 的 profile 层支持是同一缺陷的延伸，作为后续项另开，本次不夹带。

## 3. 验证

### 3.1 契约测试（S6）

```bash
mkdir -p /private/tmp/realhome
cd packages/dsh-config-manager
TMPDIR=/private/tmp/realhome/ node --test "src/adapters/plugins.test.ts" "src/index.facade.test.ts"
```

新增用例（名称即验收契约）：

| 用例 | 判据 |
|---|---|
| `plugins.export: 两层 patch 行都进 section，file 字段区分来源层` | home 层 2 行 + profile 层 2 行 → `patch` 长度 4，`file` 取值集合恰为两个不同 token |
| `plugins.export: profile 层文件缺失时降级为仅 home 层` | 仅 home 层存在 → `patch` 长度 = home 行数，且不产生 error 级 issue |
| `plugins.analyzeImport: 目标端 profile 层已有同行 → Skip（不是 Create）` | 覆盖 1.3a |
| `plugins: 跨层同名 lineId → 两个独立计划项，各自落各自层` | 覆盖 1.3b：`patch.length=2` 时计划项 2 个，applyItem 后两层各出现一行 |
| `rollback: profile 层 patchLine 回滚写回 profile 层` | 覆盖 1.3c：home 层文件字节不变 |
| `ensureActivationRow: 非 bundle 插件补行落在 profile 层` | 断言 profile 文件出现 `pm-<slug>`，home 文件不变 |
| `plugins.export: 存量快照的 file='cordis.patch.yml' 仍解析到 home 层` | 兼容性回归（1.2 / 2.1B） |

现有 `src/index.facade.test.ts:210-262` 的 4 个 `ensureActivationRow` 用例需一并复核：
它们当前用 mock facade（`index.facade.test.ts:24-35` 的 `MemPatchFile`），会掩盖常量撞车 ——
新增的寻址类用例必须走真实 `DshPatchFileFacade`。

**不写**对私有方法 `DshPatchFileFacade.patchPath` 的白盒用例：它已被上述集成用例覆盖，
单测私有实现违反包 `AGENTS.md` §2「禁止给私有函数写发散性边界测试」。

### 3.2 快照核对（**非门禁**，仅本机一次性核对）

本节的差集数字强耦合当前这台机器的 patch 内容，**不进 CI、不作为验收判据**；
验收以 3.1 的契约测试为准。保留它只为把「改动前基线 = 差集 10 个 id」留成可复算的现场记录。

```bash
cd packages/dsh-config-manager
# 用 node --experimental-strip-types 起临时脚本：
#   读两份真实 cordis.patch.yml，按 readPatchLines 口径展开 insert，得 home ∪ profile 的 lineId 全集
#   读最新 sync 快照的 plugins/plugins.json 的 patch[].lineId 全集
#   打印差集
node --experimental-strip-types /tmp/patch-layer-diff.ts
```

**当前基线（改动前）**：差集 = profile 层 10 个 id（见 1.4）。
**改动后目标**：差集为空，且 `patch[].file` 去重后有两个值。

### 3.3 端到端

1. 触发一次 push（Git 或 WebDAV 通道均可）；
2. 读远端快照的 `plugins/plugins.json`，确认 21 行齐全（home 层 11 行 + profile 层 10 行），
   且 `file` 字段去重后有两个值；
3. 在另一个 profile pull，确认 profile 层的 `webserver` 端口与 `ctx-mem-bridge` 开关落到**目标 profile 层**
   （不是 home 层，也不落到源机的 profile 目录）；
4. 确认 home 层文件字节未被 profile 层内容污染。

### 3.4 回归门禁

```bash
node scripts/aggregate.mjs --check
pnpm test
pnpm typecheck
```

## 4. 风险

| 风险 | 说明 | 处置 |
|---|---|---|
| 跨层同 id 静默覆盖 | 若用户两层写了同一个 id，宿主按后应用的 home 层胜出 | 导出/导入原样搬运两层，不合并、不警告（宿主语义）；在 spec 里写明 |
| 目标机无该 profile 目录 | pull 到未初始化的 profile 时 profile 层文件不存在 | **无需改动**：`atomicWriteFile` 已 `mkdir(dir, { recursive: true })`（`src/utils/atomic-write.ts:274`），`DshPatchFileFacade.applyPatchChanges` 走的正是它。已复验，不新增建目录代码。 |
| `ensureActivationRow` 落点变化 | 修复后非 bundle 插件行改落 profile 层，与既有 home 层残留行可能并存 | 本机无 `pm-` 残留（1.2 实测），无迁移负担；若其他机器有，属用户手工清理范畴，本次不写迁移逻辑 |
| 复合键进入快照 `ref` | 旧快照的 `ref` 是裸 `lineId` | 旧快照的 `patch[].file` 恒为 home token，`applyItem` 解析时按「无 `#` 即视作 home 层」兼容；该分支由 3.1 的兼容性用例钉住 |

## 5. 范围外发现（只报告，不修）

**两个密钥扫描器行为不一致，导出路径漏 `AQ.` 形态密钥。**

本包有两个扫描器，判据不同：

| 扫描器 | 位置 | 字段名判据 | 用途 |
|---|---|---|---|
| `createSecretScanner` / `createConfiguredSecretScanner` | `src/security/secret-scanner.ts:404,431` | 规范化后**精确 / 前缀 / 后缀**匹配（`isSensitiveFieldName`，第 179-188 行） | **导出路径**（`ExporterOptions.scanner`，`src/index.ts:2912`） |
| `defaultSecretScanner` | `src/core/exporter.ts:60-94` | 规范化后**子串** `includes('apikey')` | **同步路径的 `sectionsCarrySecrets`**（`src/sync/sync-engine.ts:751-753`） |

`X-Goog-Api-Key` 规范化成 `xgoogapikey`：**不以** `apikey` 开头、**不**等于 `apikey`、
**不**以 `token/secret/password/passwd/credential` 结尾 → 前者 0 命中；含子串 `apikey` → 后者 1 命中。
值形状表 `SECRET_VALUE_PATTERNS`（第 67-75 行）只覆盖 `sk-` / JWT / AKIA / `gh[pousr]_` /
`github_pat_` / PEM / `Bearer `，也没有 `AQ.` 前缀。

实测（对最近一次同步快照的 `mcp/servers.json`，其中 `X-Goog-Api-Key` 为真实明文）：

```
createSecretScanner()                      hits=0
createConfiguredSecretScanner(undefined)   hits=0
defaultSecretScanner() [core]              hits=1
```

**影响面与严重度**：

- **导出路径**：字段未被识别 → 值不被剥离 → 明文进 ZIP；而 `manifest.security.containsSecrets`
  在无加密提供者时**恒为 false**（`src/core/exporter.ts:284` 初始化，仅在第 325 行的
  `if (this.encryption)` 分支内被置位）。即「含明文却标注 false」——与原问题 1 **同类**。
- **未在真实产物中观察到**：`~/.dsh/dsh-config-manager/exports/` 下三个有效 ZIP
  （`dsh-config-20260916-081513-6a6bca.zip` / `dsh-config-20260918-100351-dc6896.zip` /
  `final-check.zip`）中 `plugins/plugins.json` 与 `mcp/servers.json` 的 `AQ.` 命中数**均为 0** ——
  它们都早于 `mcp-stitch` 行被写入 home patch 的时间。故这是**已确认的机制缺口、尚未产生实际泄漏产物**。
- **同步路径不受影响**：`sectionsCarrySecrets` 用 core 扫描器，对同一数据报 1 命中 →
  如实标注 `containsSecrets: true`（实测最近快照即为 true）。方向保守，不构成同步侧缺陷。

是否修复、以及是否要把两个扫描器收敛为单一真源（当前二者都自称「复用 exporter 的扫描器」，
实际是两套判据），需另开决策，不在本次范围。

## 6. 评审记录

独立盲审席位 `antigravity/gemini-3.8-flash`（座位 A），对初稿提出 9 条。逐条复验后的处置：

| # | 盲审意见 | 复验 | 处置 |
|---|---|---|---|
| 1 | 声称「通道已通、只差来源」与导入端实际只支持单文件/单 `lineId` 矛盾 | 成立：`plugins.ts:417` / `420,426` / `565` 实测如述 | **采纳**，1.3 重写为三处缺口，S3/S4 独立成切片 |
| 2 | profile 层实测 10 行而非 6 行（漏算 `insert:` 展开） | 成立：探针按 `readPatchLines` 口径得 10；`index.ts:690-698` 逐项展开 | **采纳**，1.4 与 3.2/3.3 全部改为 21 行口径 |
| 3 | 把「MCP 条目不放 profile 层」的规避注释当作设计意图，倒果为因 | 成立：该注释原文自述原因是「硬编码只读顶层」 | **采纳**，2.3 改写并显式警告 |
| 4 | S1 的「(layer, file) 二元组」属过度设计、破坏既有接口 | 部分成立：改接口确实不必要；但两常量必须**取值不同**，否则层信息无法持久化 | **部分采纳**，改为「home 值不变 + profile 用新 token」，不动 `PatchFileFacade` 签名 |
| 5 | 改动清单遗漏 `PluginsAdapter.diff` 的双层适配 | 成立 | **采纳**，见 #1 |
| 6 | 未定义 profile 层的持久化标识与跨 profile 映射规则 | 成立 | **采纳**，2.1B 定为逻辑 token `'profile:cordis.patch.yml'` |
| 7 | 未规划旧快照 `file: 'cordis.patch.yml'` 的兼容 | 部分成立：若改 home token 才有此问题 | **部分采纳**，因 home token 保持不变，仅 `ref` 复合键需要兼容分支，写入 4 节风险与 3.1 用例 |
| 8 | `patchPath` 是私有方法，为其写白盒用例违反反防御性编程 | 成立 | **采纳**，删除该用例并在 3.1 显式记录不写 |
| 9 | 摘要/正文/方案多处重复陈述同一实测数据 | 部分成立：摘要与正文的重复是文档惯例；但错误数据被复制到多处放大了 #2 的影响 | **部分采纳**，只保留一处权威计数（1.4），其余改为引用 |

独立盲审席位 `antigravity/gemini-3.8-flash`（座位 B），对**修订后**的版本提出 8 条。逐条复验后的处置：

| # | 盲审意见 | 复验 | 处置 |
|---|---|---|---|
| 1 | 跨层同 id 的复合键裁定与现行代码矛盾，且遗漏 `analyzeImport` / `applyItem` 的复合键改造 | 成立，但已在修订版中修掉（1.3b、2.1C、S4） | **已覆盖**：该条针对的是修订前的初稿 |
| 2 | 遗漏 `PluginsAdapter.analyzeImport` 对目标机 profile 层的比对 | 成立，但已在修订版中修掉（1.3a、S3） | **已覆盖**：同上 |
| 3 | S1 的「(layer, file) 二元组」破坏 `PatchFileFacade` 契约 | 成立 | **已覆盖**：修订版已改为「不动签名，只改常量取值」 |
| 4 | 未定义 `PROFILE_PATCH_FILE` 新取值与旧快照兼容策略 | 部分成立：home token 不变，旧快照的 `file` 仍解析到 home 层；`ref` 复合键才是真缺口 | **已覆盖**：2.1B 定 token，4 节风险与 3.1 兼容性用例钉住 `ref` |
| 5 | 「目标机无 profile 目录」的处置归错切片：建目录在 `DshPatchFileFacade` 而非 adapter | 结论方向对，但**前提不成立**：`atomicWriteFile` 已 `mkdir recursive`（`src/utils/atomic-write.ts:274`），该风险根本不存在 | **采纳修正**：4 节该行改为「无需改动」并附实测依据 |
| 6 | §3.2 的临时脚本强耦合本机状态、不可在 CI 复现，属冗余 | 成立 | **采纳**：3.2 标注为非门禁，验收判据只认 3.1 |
| 7 | 切片表触点路径缺 `packages/dsh-config-manager/` 前缀 | 成立 | **采纳**：文档头部加路径约定 |
| 8 | 待决项 E、切片 S7、明确不做项文字逐字重复 | 成立 | **部分采纳**：删去 2.3 的重复表述（2.1E 与 S7 是「裁定」与「切片」两个不同视角，保留） |

## 7. 实施记录

### 7.1 切片落地

| 切片 | 落地位置 |
|---|---|
| S1 寻址层 | 新增 `src/core/patch-layers.ts`（两个层 token + 层限定复合键的读写）；`src/index.ts:666-670` 的 `patchPath` 两个分支都可达 |
| S2 读取层 | `src/adapters/plugins.ts:175-183`：home + profile 两层都读，`file` 如实标注来源层 |
| S3 diff 层 | `src/adapters/plugins.ts:422-448`：按行自带的 `file` 读目标端对应层（逐层惰性读一次） |
| S4 键层 | `src/adapters/plugins.ts:432,452,579-590`：计划项 id / `target.ref` = `<file>#<lineId>`，`applyItem` 按复合键定位 |
| S5 快照/回滚层 | `src/core/backup.ts:212-214`（快照按 ref 的层读原行）、`src/core/rollback.ts:77-81`（写回同一层） |
| S6 契约测试 | 新增 `src/adapters/patch-layers.test.ts`（7 用例）；`src/index.facade.test.ts` 新增真实门面用例；`src/adapters/plugins.test.ts` 复合键断言 |
| S7 文档 | `docs/spec/bundle-format-v1.md`（`plugins.patch[].file` 取值域 + 层寻址注意）；`docs/spec/compat-matrix.md`（R13 与 1.3 的取证行） |

### 7.2 与计划的偏离

1. **层 token 收成单一真源**：计划 S1 写的是「让 `USER_PATCH_FILE` 与 `PROFILE_PATCH_FILE` 取值不同」，
   实际实施把两个 token 放进新模块 `src/core/patch-layers.ts`，并**删除 `USER_PATCH_FILE`** ——
   该名字的字面语义（「用户的 patch 文件」）在两层世界里必然二义，留着它就是下一个撞车点。
   `mcp.ts` / `prompts.ts` 的 8 处引用改为直接 import `HOME_PATCH_FILE`（行为不变）。
2. **夹具影响是计划未预见的**：`MemPatch` 按单文件语义实现，对任何 `file` 都返回同一批行 ——
   两层读取会让同一行被算成两行（`tests/core/exporter.test.ts` 里两行共享同一 `raw` 对象，
   还会触发扫描器的循环引用报错）。新增按层键控的 `MemLayeredPatch` 与 `ctx.useLayeredPatch()`，
   受影响夹具改用它。
3. **`DshPatchFileFacade` 由模块私有改为导出**：3.1 要求「寻址类用例必须走真实门面」，不导出就写不了。
4. **`compat-matrix.md` 同步更新**：计划 E 只列了 `bundle-format-v1.md`，但 R13 与 1.3 的取证行
   引用了被改动的实现位置，不更新即与代码不符。

### 7.3 验收证据

| 检查 | 结果 |
|---|---|
| 契约测试 | `patch-layers.test.ts` 7/7、`plugins.test.ts` 10/10、`index.facade.test.ts` 11/11 全绿 |
| 包内全量 | 1290 pass / 0 fail（改动前基线 1282，新增 8 个用例） |
| `node scripts/aggregate.mjs --check` | OK（8 source block / 8 dep） |
| `pnpm typecheck` | 全绿 |
| `pnpm test` | 除 `dsh-agy-link` 外全绿；该包 test 脚本用 `--experimental-transform-types`，本机 Node 26.8.2 已移除该 flag，**改动前即失败**，属范围外环境问题 |
| 本机真实产物核对（替代 3.2） | 用真实 `DshPatchFileFacade` + `PluginsAdapter` 对 `~/.dsh` 导出：patch 行 **21 条**（home 11 + profile 10），`file` 取值恰为两个 token，warnings 为空 |
| 3.3 端到端 push/pull | **已执行**（用户授权后）：真实 Git 通道推一次快照 → 回读远端 = patch 行 21 条、`file` 取值恰为两个 token、profile 层 10 行齐全（含 `webserver` / `ctx-mem-bridge`）；隔离 stateDir 上 pull 识别出 20 个 patch 计划项（profile 层 10 项），差额 1 项 `mcp-stitch` 由 mcp 分区接管。验证用快照已从远端删除 |

### 7.4 里程碑盲审记录

独立席位 `antigravity/gemini-3.8-flash`（座位 A）对改动后状态做只读盲审，按五个维度逐项裁决：

| 维度 | 裁决 | 关键证据（盲审给出） |
|---|---|---|
| 重复 | 无缺陷 | 层 token 与复合键编解码各只有一处定义（`src/core/patch-layers.ts:19,22,25,28,38`），四处调用点统一复用；测试夹具 `MemLayeredPatch` 单一实现 |
| 冲突 | 无缺陷 | 复合键消除跨层同名 `lineId` 撞车；`patchPath` 两分支互斥且都可达，死分支消除 |
| 矛盾 | 无缺陷 | 快照读层与回滚写层由同一解析函数决定；spec 声明的 token 取值与实现逐字一致；激活行落点契约由真实门面用例钉住 |
| 遗漏 | 无缺陷 | 存量快照裸 `lineId` 的兼容分支有用例；`mcp.ts` / `prompts.ts` 的常量替换涟漪完整 |
| 过度设计 | 无缺陷 | 未改 `PatchFileFacade` 签名；未加冗余参数校验与降级；未越界扩到 mcp/prompts 的 profile 层 |

门禁复核（盲审自跑）：包内 1290/1290、`tsc --noEmit` 零错误、`aggregate.mjs --check` OK。

**全部采纳（零缺陷，无需辩论轮）。** 一处说明：盲审提到「`USER_PATCH_FILE` 仅作为兼容别名转发」，
该别名在盲审快照之后已被删除（见 7.2 偏离 1），结论不受影响。


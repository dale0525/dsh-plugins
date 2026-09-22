# 会话格式 v4 退役 `source.kind === 'plugin'`：三个注入型插件的迁移

> 状态：**实施记录**（已落地，见本次提交；随聚合包 `v0.5.14` 发布）。
> 触发问题：用户报「本轮运行失败 `format v4 message requires a producer-owned source kind`」。
> **路径约定**：本文所有 `packages/...`、`scripts/...` 均相对本仓库根。
> 本文的「实测」均为本次会话在本机真实宿主树与真实会话日志上跑出来的输出，非推断。

## 0. 结论摘要

1. **与 settingsScope 同处 0.1.7 世代边界，但是独立的一条**，而且比那条更隐蔽：
   它**只在写入路径严格**。v3→v4 的**迁移**会把旧记录经 `producerKind()` 提升成
   producer-owned kind，所以**历史会话照常能读**，只有**实时注入**必失败。
   症状因此是「某一轮运行失败」，而不是「会话打不开」。
2. **`typecheck` 抓不到它。** 仓库钉的是 `dsh-llm@0.1.6-alpha.2`，其 `MessageSourceMap`
   **仍然声明** `plugin: { kind: 'plugin'; plugin: string }`；宿主自己的
   `dsh-agent/README.md:56` 至今还在教插件作者写这个形态。旧世代类型合法 + 官方文档
   背书 = 编译器与作者都不会报警。**只能靠源码 grep 发现。**
3. **用户猜测的 `@logictan/dsh-workbuddy-connect` 不是来源。** 它 src/ 与 lib/ 里
   没有任何会话消息构造，`source:` 只出现在鉴权 / 目录 / 版本元数据上。
   真实来源是 **`@logictan/dsh-openviking`（`openviking-memory`）**，且它在 live
   `web` profile 里启用。
4. **替换值不是自由选择。** 宿主 `dsh-session-format-v3-to-v4/README.md` 的映射表规定：
   同名一方插件用裸名，**其它一律 `plugin:<原名>`**。取 `plugin:<包名>` 的额外好处是
   它与**迁移后的历史记录逐字相同**——已在真实数据上核对（见 §2.2），
   所以读回判定在新旧数据上一致。
5. **顺带修掉一处同源缺陷**：openviking 的 `captureMessage` 原本用
   `source.kind === 'plugin'` 表达「不要把合成上下文当人类输入写进记忆」。
   v4 下每个生产者各持自己的 kind，这个黑名单**静默失效**，会开始把别的插件的注入
   当人类输入捕获。已改为白名单。

## 1. 机制：为什么旧会话能读、实时写入却失败

校验函数是 `dsh-session-format-v3-to-v4` 的 `source(message)`
（同一段逻辑也内联在 `dsh-session-persistence-jsonl/lib/worker.cjs`）：

```js
if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
    || value["kind"].length === 0 || value["kind"] === "plugin")
  throw new SessionFormatError("format v4 message requires a producer-owned source kind");
```

注意它拒绝的不止 `'plugin'`：**缺 source、source 不是对象、kind 缺失或为空**同样拒绝。

被校验的持久槽位（`mapEventMessages` / `assertV4SourceRowAdmission`）：
`user/message`、`developer/message`、`system/message`、`assistant/message`、`tool/result`、
`agent/inbox/spliced` → `data.inserted`、`session/title-llm-request` → `data.messages`。

落到实践上就是：**插件交给 `agent.inject` / `steer` / `followup` 的消息、作为
`additionalContexts` 返回的消息、以及追加进 `agent/pre-step` 决策的消息**，全部在列。

迁移路径则相反——`rewriteV3MessageSource` 把 `kind:'plugin'` 交给 `producerKind()`，
未知插件得到 `plugin:<原名>`，因此**旧记录不会触发这条拒绝**。两条路径的不对称就是
「读得进、写不进」的全部原因。

最坏的一类是**会话启动时注入**：`agent/session-start` → `agent.inject(...)`，
它会让每条新会话的第一轮直接失败。

## 2. 失效点与证据

### 2.1 已启用的失效点（在 `~/.dsh/profiles/web/node_modules/@logictan/` 逐个核对）

| 插件 | live | 注入路径 |
|---|---|---|
| `dsh-openviking` | ✅ | `lifecycle.mjs` 的 `agent/session-start` → `agent.inject(profile)`；`index.mjs` 的 `agent/pre-step`（profile + recall）；`uri-guard.mjs` 的 `tools/post-execute` → `additionalContexts` |
| `dsh-loop-guard` | ✅ | `src/index.ts` 的 `agent.inject` / `agent.steer` / `agent.followup` |
| `dsh-imagegen` | ❌ 未启用 | `src/index.ts` 的 canvas `agent.followup` |

**不在列（重要）**：`ctx-mem` 与 `dsh-browser-agent` 也带这个字面量，但只用在
`llm.stream({ messages })` 的**请求**消息上，不落在任何持久槽位。

### 2.2 用真实会话日志反证

会话存储 `~/.dsh/sessions/<project-slug>/session-<uuid>/`，三代格式共存
（`session.jsonl.zstd` / `.v3.` / `.v4.`，均为 zstd）。

v3 会话里真正落盘的插件来源：

```
"source":{"kind":"plugin","plugin":"@deepseek-ai/dsh-system-prompt"
"source":{"kind":"plugin","plugin":"openviking-memory"      ← 确认是持久消息
"source":{"kind":"plugin","plugin":"compact"
"source":{"kind":"plugin","plugin":"tool-jobs"
"source":{"kind":"plugin","plugin":"model-selection"
"source":{"kind":"plugin","plugin":"tools-ptc"
"source":{"kind":"plugin","plugin":"dsh-session-title-llm"
```

`openviking-memory` 在多个会话中出现 → 它的注入**确实是持久消息**。
`ctx-mem` 与 `browser-agent` **从不出现** → §2.1 的「不在列」结论得到数据支持。

已迁移的 v4 会话里则是：

```
"kind":"plugin:openviking-memory"
```

与本次采用的取值**逐字相同**，因此新旧记录在读回判定上一致。

### 2.3 「错误不在任何日志里」是预期现象

被准入拒绝的行**根本不会写盘**，所以 `~/.dsh/sessions/**`、
`~/.dsh/dsh-web.err`、各插件自己的日志里都查不到这条错误。这不是「另有原因」的证据。

## 3. 同源缺陷：通用排除静默失效

`capture.mjs` 的 `captureMessage` 原本用单一名字做通用排除：

```js
// v3 时代：所有插件注入共享 kind:'plugin'
if (message.source?.kind === "plugin") return null;
```

v4 下每个生产者各持自己的 kind（`time-context`、`repeat-tool-reminder`、
`plugin:openviking-memory`…），这个判定**匹配不到任何东西**，于是
「不要把合成上下文当人类输入写进记忆」这条约束**静默失效**，
别的插件的注入会被当成人类输入捕获进记忆。

改为白名单 `CONVERSATION_KINDS = { user, model, tool }`。这不是新语义，而是**恢复 v3 语义**：
v3 下非会话来源一律是 `kind:'plugin'`，v4 下它们散成各自的 kind，白名单是唯一稳定的表达。
新增测试覆盖两种形态（裸名 `time-context` 与带前缀 `plugin:time-context`）与无 source 的情形。

## 4. 修法与验证

三处写入 + 三处读回，取值统一 `plugin:<包名>`：

| 文件 | 改动 |
|---|---|
| `packages/dsh-openviking/capture.mjs` | `OPENVIKING_PLUGIN_SOURCE = "plugin:openviking-memory"`；写入去掉 `plugin` 字段；`promptText` 读回；`captureMessage` 改白名单 |
| `packages/dsh-openviking/runtime.mjs` | `isStartupProfile` 读回 |
| `packages/dsh-openviking/README.md` | 记录的形态 |
| `packages/dsh-loop-guard/src/index.ts` | `PLUGIN_SOURCE` + `declare module '@deepseek-ai/dsh-llm'` 合并 `MessageSourceMap` |
| `packages/dsh-imagegen/src/index.ts` | `IMAGEGEN_SOURCE` + `followup` 签名 |

**TS 包必须做声明合并**：`MessageSource` 是 `MessageSourceMap[keyof MessageSourceMap]` 的严格
联合，新 kind 不声明则 `tsc` 直接失败（这正好是想要的强制机制）。纯 `.mjs` 的 openviking
不需要（它的消息不过类型检查）。

验证：

- `packages/dsh-openviking`：`npm run check` 通过；`node --test *.test.mjs` **74 pass / 0 fail / 1 skip**（skip 为 live 测试）。
- `packages/dsh-loop-guard`：`tsc --noEmit` 通过；`npm test` **137/137 pass**。
- `packages/dsh-imagegen`：`tsc --noEmit` 通过（该包无测试套件）。

### 4.1 用干净 worktree 复现 CI 门禁（本地测试不可信）

`publish.yml` 的门禁顺序是：`pnpm install --frozen-lockfile` → `typecheck` → `pnpm test` →
`aggregate.mjs --check` → 逐包 publish。**必须在干净 worktree 里跑**，因为工作区常有无关 WIP
（本次就有 `dsh-config-manager` 的几十个改动文件），会把无关失败混进来：

```bash
git worktree add /tmp/dsh-ci-verify <commit>
cd /tmp/dsh-ci-verify
pnpm install --frozen-lockfile          # 第一步就能抓出锁文件失配
pnpm -r --if-present run typecheck
node scripts/aggregate.mjs --check
pnpm test
```

结果（`b7ef5186`，17 文件提交）：

| 门禁 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ exit 0（**修锁文件之前是 `ERR_PNPM_OUTDATED_LOCKFILE`**） |
| `pnpm -r --if-present run typecheck` | ✅ exit 0（13 个包） |
| `node scripts/aggregate.mjs --check` | ✅ `check OK (12 source block(s), 12 dep(s))` |
| `pnpm test` | ⚠️ exit 1，但**失败是既有的、且不稳定**（见下） |
| `dsh-openviking` / `dsh-loop-guard` 单跑 | ✅ 74 pass/0 fail/1 skip；137/137 pass |

**`pnpm test` 的本地失败不是本次引入的**，判据是它与未改动的 `f15cdb83`（= v0.5.13，
CI 在 Linux/Node 24 上判为绿）**表现一致，且失败集合每次都在变**：

| 轮次 | commit | 失败的包 |
|---|---|---|
| A | `bda2ccfc`（本次，修 package-lock 之前） | openviking、agy-link、config-manager、market |
| B | `f15cdb83`（基线，与 C 并行跑） | agy-link、better-reasoning-effort、config-manager、market |
| C | `b7ef5186`（本次，与 B 并行跑） | agy-link、better-reasoning-effort、config-manager、easyrewrite |
| D | `b7ef5186`（串行） | agy-link、config-manager、market、workbuddy-connect |
| E | `f15cdb83`（串行） | config-manager、market、workbuddy-connect |

`market` / `agy-link` / `better-reasoning-effort` / `workbuddy-connect` 各自都出现过「失败」与
「通过」两种结果。逐个复核：

- `dsh-agy-link`：**单独跑 216/216 全绿**（耗时 32s）。它在递归跑里失败是资源竞争
  （`--test-concurrency=1` + 长耗时），不是缺陷。
- `dsh-config-manager`：失败项是 issue #37 的软链接用例 + 一组 HTTP 重定向 / WebDAV 用例
  （`重定向：GET index.json 302 → 200` 等），都是 macOS 本地环境相关；not-ok 条数在 5～8 之间浮动。
- `dsh-market` / `dsh-workbuddy-connect`：涉及 registry / 网络探测，同样在本地不稳定。

**本地 `pnpm test` 因此不能用来判断 CI 会不会过**：本次改动的三个包单跑全绿，其余失败在
未改动的基线上同样出现。真正的判据是 tag 推送后的 CI 运行。

**副作用排查**：`packages/dsh-openviking-shared` 生成的文件只被 `dsh-openviking/shared/` 消费
（无其它包引用），且 `pnpm install` 的 prepare 步骤是幂等的——两个 worktree 跑完 install 后
`git status` 均为空，没有产物漂移。

## 5. 发布与 fork 约束

**openviking 是上游 fork**（`volcengine/OpenViking` 的 `examples/dsh-memory-plugin`），
而 `capture.mjs` / `runtime.mjs` **原本不在 `owned` 里**。`owned` 由内容比对重算，
所以改完必须跑：

```bash
node scripts/sync-upstream.mjs --refresh-policy --target openviking
# owned 7 → 12（新增 capture.mjs / runtime.mjs 及 3 个测试文件）
```

否则下一次上游同步按 `--theirs` 取回上游版本，**静默回退本次修复**。

**版本与发布**：三包都在 `packages/all/aggregate.yml` 里，一次聚合包发布即可覆盖。
但 **`dsh-imagegen` 的 trusted publisher 未配置**，不能进 tag 触发的发布链：
`publish.yml` 用 `set -euo pipefail` 逐包发布，imagegen 一旦失败会**中止循环、聚合包永不发布**。

判定方法是看 registry 上的 `_npmUser`（`npm trust list` 强制 OTP，无法非交互探测）：

| 包 | `_npmUser` | provenance | 结论 |
|---|---|---|---|
| `dsh-openviking@0.4.4` | GitHub Actions + `trustedPublisher` | ✅ | CI 可发 |
| `dsh-loop-guard@1.1.0` | GitHub Actions + `trustedPublisher` | ✅ | CI 可发 |
| `dsh-imagegen@1.5.13` | `logictan <logictan89@gmail.com>` | ❌ | **人工发的，trust 未配** |

因此本次：`dsh-openviking` 0.4.4 → **0.4.5**（同时改 `config.mjs` 的 `PLUGIN_VERSION`，
`check:version` 会校验）、`dsh-loop-guard` 1.1.0 → **1.1.1**、聚合包 0.5.13 → **0.5.14**；
**`dsh-imagegen` 保持 1.5.13 不动**（修复照常入库，发布等 trust 配好）。
`publish.mjs` 对已发布版本会跳过，所以 tag 推送只会发这三个。

`dsh-imagegen` 补 trust 后才能随 CI 发布：

```bash
npm trust github @logictan/dsh-imagegen --file publish.yml --repo dale0525/dsh-plugins --allow-publish
```

### 5.1 版本号改了就必须同步锁文件（否则 CI 死在第一步）

`packages/all/package.json` 的依赖 specifier 由 `aggregate.mjs` 从子包版本生成，所以
**升子包版本 → 聚合包 specifier 变 → `pnpm-lock.yaml` 失配**：

```
ERR_PNPM_OUTDATED_LOCKFILE
  * in importers["packages/all"]:
    - @logictan/dsh-loop-guard (lockfile: ^1.1.0, manifest: ^1.1.1)
    - @logictan/dsh-openviking   (lockfile: ^0.4.4, manifest: ^0.4.5)
```

`publish.yml` 第一步就是 `pnpm install --frozen-lockfile`，失配即整条流水线失败——
**不是「测试挂了」，是根本没跑到测试**。历史上每次 specifier 变更都与锁文件同提交
（`e27e494f` v0.5.12、`09bdaca8` 收养 better-reasoning-effort），这是既有约定而非偶然。

```bash
pnpm install --lockfile-only   # 只改锁文件，不碰 node_modules
git add pnpm-lock.yaml
```

**为什么 `--lockfile-only` 在目标版本尚未发布时也能跑通**：锁文件里 workspace 包解析为
`version: link:../dsh-loop-guard`，不走 registry 解析，所以 `^1.1.1` 在 npm 上还不存在也不影响。
若哪天改成非 link 解析，这一步就会在发版前卡住。

**只改版本号时这一条极易漏**：本次 16 个文件里 15 个是代码/文档，锁文件那 2 行 diff 混在
335 行改动里几乎看不见。**判据是 CI 第一步，不是本地测试** —— 本地不跑 `--frozen-lockfile`
就永远发现不了。改动后自查：

```bash
pnpm install --frozen-lockfile   # 应输出 Done，不是 ERR_PNPM_OUTDATED_LOCKFILE
```

### 5.2 openviking 的版本号有三处载体

`packages/dsh-openviking/bundle.test.mjs:54` 的
「the runtime and package lock report the published package version」会交叉校验三处：

| 载体 | 字段 |
|---|---|
| `package.json` | `version` |
| `config.mjs` | `PLUGIN_VERSION` |
| `package-lock.json` | `version` **和** `packages[""].version`（两处） |

只改前两处 → 断言 `'0.4.4' !== '0.4.5'` 失败。**这个包是仓库里唯一带嵌套
`package-lock.json` 的包之一**（另一个是 `dsh-market`），因为它原本是独立 npm 包被收进来的；
其余子插件没有这个载体。`package-lock.json` 本来就在 `owned` 里，改它不需要重跑
`--refresh-policy`。

**为什么容易漏**：`npm run check`（含 `check:version`）只比对 `PLUGIN_VERSION` 与
`package.json`，**不看 `package-lock.json`** —— 本地跑 `check` 全绿，只有 `npm test` 才暴露。
而且升级前的「74 pass」是**改版本号之前**的结果，升完版必须重跑。

## 6. 未做 / 后续

1. **类型对齐未做**（用户选择另开一条）：各包钉的 `dsh-llm` 世代不一
   （loop-guard `0.1.6-alpha.2`、imagegen `0.1.2-alpha.2`）。升到 0.1.7 世代后，
   `MessageSourceMap` 里的 `plugin` 项会消失，编译器就能自动拦住这一类退役 kind。
   在那之前，**发现手段只有源码 grep**。
2. **`ctx-mem` 与 `dsh-browser-agent` 的请求消息未改**：它们不落持久槽位（§2.2 已用数据反证），
   改它们只增加风险。若将来它们的请求消息被写入任何持久槽位，需重新评估。
3. **`dsh-imagegen` 待发布**（§5）。
4. 上游 `volcengine/OpenViking` 的同名缺陷未反馈——本次只在本地 fork 修，
   下次同步靠 `owned` 保住。

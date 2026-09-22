# dsh-better-reasoning-effort 纳入 fork 子插件，并迁到 0.1.7 的 configForms

> 状态：**实施记录**（已落地，见提交 `09bdaca8`，其上是 subtree add `6f398dcb`）。
> 触发问题：宿主 0.1.6-alpha.2 → 0.1.7-alpha.1 后，`~/.dsh/dsh-web.err` 反复报
> `[dsh-better-reasoning-effort] autofill failed: settings.get is not a function`。
> **路径约定**：本文所有 `packages/...`、`scripts/...` 均相对本仓库根；上游路径相对
> `github.com/HaoyueQin/dsh-better-reasoning-effort` 仓库根。
> 本文的「实测」均为本次会话在本机真实宿主树上跑出来的输出，非推断。

## 0. 结论摘要

1. **这条与 loop-guard / browser-agent 同处一个世代边界，但是独立的一条。** 那两条是
   浏览器半边的 `settingsScope` → `configForms` 改名与 `settings.register is not a function`；
   本条是**宿主半边**的 `settings.get(ns)` 被删。三者共因、各自独立报错。
2. **0.1.7 的 `dsh-settings` 删掉了整套按 namespace 注册的设置表**
   （`installSection` / `register` / `get` 全无），改为「按 loader entry id 从
   `entry.fiber.runtime.Config` 推导表单」，`describe()` 成为唯一读路径。调用已删除的
   `get(ns)` 即 TypeError —— 这就是那句 `settings.get is not a function`。
3. **读写键恰好不用改。** 基础 bundle 把 pi-ai 挂成 `- id: llm-pi-ai`，而本插件旧代码用的
   settings namespace 也是 `llm-pi-ai`。**entry id 与旧 namespace 是同一个字符串**，
   所以 `PI_AI_NS` 常量、`describe()` 的匹配条件、`update()` 的第一个参数都原样保留。
4. **上游至今没有 0.1.7 支持**（最新 tag `v0.4.0`，master 亦无 `configForms`/`volatile` 痕迹）。
   因此本次迁移**全部是我方改造**，逐条登记进 `sync-policy.json` 的 `owned`，
   否则下一次上游同步会把修复整个覆盖掉。
5. **表单要出现有两个硬前提**：schema 必须能从**包入口**取到
   （`entry.fiber.runtime.Config`），且**每个字段**都 `.volatile()`。任一不满足，
   `volatileForm()` 返回 `undefined`，`describe()` **静默跳过该 entry** ——
   设置页里整条消失，且不报任何错。
6. **已实测通过**：包内 build + `tsc --noEmit` 干净、vitest **393/393**；用宿主**真实**的
   `SettingsForms.describe()/update()` 跑通表单契约（含两条反例）；拷贝真实 profile 启动
   **74 条 entry 全部激活**，无 `did not activate`，无任何 entry 声明 `settingsScope`。

## 1. 事实与证据

### 1.1 宿主世代与断裂点（在已安装的宿主树上实测）

宿主固定在 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`，版本 `0.1.7-alpha.1`。

| 探针 | 结果 |
|---|---|
| 全树搜 `settingsScope` | **0 命中** —— 不是改名后的别名，是彻底不存在 |
| `dsh-client-ui-settings` 提供什么 | `super(ctx, "configForms")`，含 `get(entryId)` / `describe()` / `whileServed(ns, register)` / `developerTools` |
| `dsh-settings` 的导出 | 仅 `SettingsConflictError` / `SettingsForms` / `redactSecrets`（`volatileForm`、`projectForm`、`plainConfig` **都不导出**） |
| `SettingsForms` 的依赖 | `static inject = ["configEditor", "profileContext"]` |

**`settings` 这个服务名本身还在**（它现在指向 `SettingsForms`），所以本插件 `inject` 里的
`'settings'` 不必改 —— 这也解释了为什么本插件从未出现在
`pending (waiting for service: …)` 里。

### 1.2 表单的推导路径（读宿主源码）

`SettingsForms.describe()`（`lib/index.js:413`）逐条扫描
`configEditor.configuration()`，对每个 entry：

- `schema(entry)` 取 `entry.fiber?.runtime?.Config`（`:538`），取不到即 `return []`；
- 要求 `entry.fiber.runtime !== null` 且 **`entry.fiber.state === 2`**（ACTIVE）；
- `volatileForm(schema)` 返回 `undefined` 即 `return []`（**静默跳过**）；
- `write()`（`:501`）在表单缺失时抛
  `Plugin entry "X" has no volatile fields`；字段非 volatile 时抛
  `Config field "y" is not volatile`。

`volatileForm`（`:122`）的语义：`schema.meta.volatile` 为真 → `plainSchema(schema)`；
否则**递归进 `dict`**，保留 volatile 的子字段，一个都没有则 `undefined`。
**推论：根对象不必 volatile，只有叶子必须 volatile。**

### 1.3 `schema.toJSON()` 是引用压缩形态（实测输出）

这条是本次排查中**最容易误判**的一点。descriptor 的 `schema` 是 `form.toJSON()`，
形状是 `{ uid, refs: { <id>: node } }` —— `dict` 的值是**数字引用**，不是内联节点：

```json
{"uid":29,"refs":{"23":{"type":"boolean","meta":{"default":true}},
 "29":{"type":"object","meta":{"default":{}},
   "dict":{"autofill":23,"modalityAutofill":24,"probeTimeoutMs":25,
           "bootRetryDelaysMs":27,"defaultGuard":28}}}}
```

所以读顶层 `.dict` 得 `undefined`，**与「字段全被 volatileForm 丢弃」长得一模一样**。
正确读法是 `refs[schema.uid].dict[k] → refs[<id>]`。
另注意 `plainSchema` 会**删掉** `meta.volatile` —— 表单里看不到该标记是**正确**的，不是故障。

### 1.4 entry id 与旧 namespace 重合（实测）

`@deepseek-ai/dsh-base/cordis.patch.yml` 挂载 `- id: llm-pi-ai` /
`name: '@deepseek-ai/dsh-llm-pi-ai'`；该包 `Config = z.object({ providers: z.dict(profile).default({}).volatile() })`
且从**包入口** `export { Config }`。故 pi-ai 那条 entry 确实能出表单，
且 `describe()[].ns === 'llm-pi-ai'` —— 与插件常量 `PI_AI_NS` 逐字相同。

### 1.5 上游状态（只读克隆）

最新 tag `v0.4.0`；`master` 的 `src/` 里 `settingsScope` 0 命中，也**没有任何 0.1.7 支持**。
npm 上已发布的最新版是 `0.3.10`（profile 里装的正是它）。→ 迁移必须由我方完成。

### 1.6 拷贝 profile 启动（端到端实测）

`cp -R ~/.dsh/profiles/web /tmp/dsh-gate4/profiles/web`，把副本端口从 10000 改到 10099，
把不带 scope 的 `dsh-better-reasoning-effort` 从 bundles/deps 移除、软链本仓库的
聚合包与本 fork，然后 `DSH_HOME=/tmp/dsh-gate4 node /opt/homebrew/bin/dsh --profile web --no-open`：

| 判据 | 实测 |
|---|---|
| 启动报错流 | `stderr` **全空** |
| `did not activate` / `waiting for service` | 0 次 |
| 启动图 `globalThis.__DSH_BOOT__` | **74 条 entry，全部激活** |
| 任何 entry 声明 `inject: [... 'settingsScope']` | **0 条** |
| 线上取回的 `client.js` 注册 id | `id: "@logictan/dsh-better-reasoning-effort"` == 包名 |

**线上服务未受影响**：全程另一个端口、另一个 `DSH_HOME`，事后 `dsh-web status` 仍为
`Verdict: OK` 且 PID 未变。

### 1.7 工程门禁实测（两个会卡 CI 的坑）

| 探针 | 结果 |
|---|---|
| 新 devDep 引入 esbuild 后的 `pnpm install --frozen-lockfile` | **exit 1**：`ERR_PNPM_IGNORED_BUILDS: esbuild@0.28.2` |
| 同上，在 `allowBuilds` 里写 `esbuild: false` 后 | **exit 0** |
| esbuild 未跑 install.js 时是否可用 | **可用**：`version = 0.28.2`，`transformSync` 正常（平台二进制来自 optionalDependencies） |
| `sync-policy.json` 的 `added` 在文件未 `git add` 时 | **恒为空** —— 它由 `git ls-files`（只认已跟踪文件）算出 |

`pnpm-workspace.yaml` 的 `allowBuilds` 是**白名单语义**：没被点名的包是「未决」，
而未决是**报错**而非警告。这是 publish.yml 的第一步，必须显式表态。

## 2. 方案（已实施）

### 2.1 收养

- `git subtree add --prefix=packages/dsh-better-reasoning-effort <上游 url> v0.4.0`
  （**要求工作区干净**；先 stash 了用户 `dsh-config-manager` 的在途改动，
  pop 后 `git status --short` 与 stash 前逐字节比对一致）。
- 包名 → `@logictan/dsh-better-reasoning-effort`，版本 `0.4.0 → 0.5.0`，
  `repository.directory` 指向本仓库路径（否则 OIDC provenance 被拒）。
- 删掉上游自带、与本仓库门禁冲突的文件：`.github/workflows/{ci,release,sync-to-gitee}.yml`、
  `.npmrc`、`package-lock.json`。
- `sync-policy.json`：**12 owned / 5 deleted / 1 added**。清单由
  `node scripts/sync-upstream.mjs --refresh-policy --target better-reasoning-effort` 重算后
  与我手写的版本 diff 一致，故该清单是脚本自己的输出，不是我猜的。

### 2.2 宿主半边

1. **结构化声明 `SettingsFormsLike` / `SettingsDescriptorLike`，不 import
   `@deepseek-ai/dsh-settings`。** 本工作区按 **0.1.6** 世代做类型检查，而 0.1.6 的
   `declare module '@deepseek-ai/cordis'` 合并**仍把 `settings.get(ns)` 标成可调用** ——
   正是这次故障的调用。若 import，编译期会把刚修掉的 bug 重新藏起来。
2. `PI_NS = PI_AI_NS`（去掉 `as SettingsNamespace` 断言）；`inject` 保持 `['settings']`。
3. `Config` 五个字段全部 `.volatile()`，并保留显式 `Schema<Config>` 标注（缺它会在
   schemastery 双副本时 TS2742）。`@deepseek-ai/schemastery` 从 `peerDependencies`
   移进 `dependencies`（`^3.18.3`）——optional peer 不会被自动安装。
4. `apply(ctx, config: ConfigRefs)` 收 `{ get() }` 引用；`currentConfig()` 每次现读。
5. **`defaultGuard` 的包装改为无条件安装 + 每次调用现读开关。** 开关是活引用，
   插件页可在运行时翻转；按开关装卸包装会让「翻转后不生效」。旧测试
   `stays off the wire when defaultGuard is false` 断言的是**旧契约**（包装不装），
   已按新契约改写，并新增一条「挂载后翻转开关，下一次调用即生效」。
6. devDependencies 钉在工作区当前世代 `^0.1.6-alpha.2`：拉 0.1.7 会让工作区同时存在
   两代 harness，`dsh-loop-guard` 的 `tsc` 立刻报 brand 不兼容。

### 2.3 浏览器半边

- 死掉的 `ctx.get('settingsScope')?.bind({ namespace })` 换成
  **嵌套** `ctx.inject(['configForms'], scoped => …)` + `scoped.configForms.get(PI_AI_NS)`。
- **用嵌套而不是写进插件自己的 `inject`**：顶层声明会在设置外壳缺席/更旧时把整个浏览器半边
  挂起，而启动审计把一条 pending 直接算成抛错。嵌套写法下服务缺席只损失「镜像快捷读」，
  退化成走线读。
- 表单面以 **live getter** 暴露（`get form()`），因为 `apply` 返回时服务还不存在。

### 2.4 登记

- `packages/all/aggregate.yml` 的 `patchFrom` **与** `deps` **两节都写**
  （只写一节会发出「包不存在」的行，或发出没有行的包）。
- `sync-upstream.yml` matrix 新增一行（`id: better-reasoning-effort`）——
  新增 fork 忘了加 matrix 行 = 该包**永不同步**，且**所有测试仍全绿**。
- 聚合包 `0.5.12 → 0.5.13`（`aggregate.mjs` 只重写 `dependencies`，`version` 无其他来源）。

## 3. 验证

| 检查 | 判据 | 实测 |
|---|---|---|
| 包内构建 | `npm run build` | lib/index.js + lib/client.js(134KB) + 类型，exit 0 |
| 包内类型 | `tsc --noEmit -p tsconfig.json` | 干净 |
| 包内测试 | `vitest run` | **393 pass / 0 fail** |
| 全仓类型 | `pnpm typecheck` | 13 个项目全过 |
| 表单契约（真宿主） | 用 `SettingsForms.describe()/update()` | 见下 |
| 反例（门禁非空跑） | 非 volatile 兄弟字段被丢弃；全非 volatile entry 被整体跳过 | 两条均如预期 |
| 启动图 | 拷贝 profile 的 `__DSH_BOOT__` | 74 entry 全激活，0 条声明 `settingsScope` |
| 客户端注册 id | `lib/client.js` 的 `load({ id })` | == 包名，且 `settingsScope` 仅出现在注释 |
| 聚合一致 | `aggregate.mjs --check` | 12 source block / 12 dep，无 drift |
| 发布顺序 | `npm run publish:plan` | 子包在聚合包之前 |
| 锁文件一致 | `pnpm install --frozen-lockfile` | exit 0 |
| 同步清单 | `--refresh-policy` 后 diff | 与手写版本一致（12/5/1） |
| matrix 覆盖 | `node --test scripts/sync-upstream.test.mjs` | 28/28（含 matrix↔policy 一致性） |

**表单契约**用宿主真实的 `SettingsForms`（`Object.create(SettingsForms.prototype)`，
跳过 cordis `Service` 构造函数）跑：entry 被描述、5 个字段全部在 `volatileForm()` 里存活、
默认值可投影、`update()` 不抛 `not volatile`。两条反例证明该门禁**不是空跑**。

## 4. 风险

| 风险 | 说明 |
|---|---|
| **线上 profile 换包顺序** | 线上同时装着不带 scope 的 `dsh-better-reasoning-effort@0.3.10` 与聚合包。两者 patch 行 id 相同，装新聚合包**前**必须先 `dsh plugin --profile web remove dsh-better-reasoning-effort`，否则启动 `duplicate loader entry id` **硬崩**。 |
| **上游将来跟到 0.1.7** | 上游若自行实现 0.1.7 支持，同步时会在 `owned` 文件上冲突。按 policy 顺序（`--theirs` → 恢复 owned → `git rm`）我方版本胜出，但**上游的实现方式值得人工对比**，可能比我们的更好。 |
| **上游改 `export const name`** | 那会改变 patch 行 id，进而改变设置表单的 key。同步 PR 合并前须人工核对行 id 是否仍唯一。 |
| **`owned` 清单随改动漂移** | 本次迁移后若再改 `src/`，必须重跑 `--refresh-policy`，否则新改的文件不在 owned 里，会被下次同步覆盖。 |
| **0.1.8 可能再改一次** | 表单推导这套是 0.1.7 新引入的，仍在演进。`SettingsFormsLike` 结构化声明保证这类改动会以**编译错误**出现，而不是运行时静默失效。 |
| **`schemastery` 双副本** | 插件自带 `^3.18.3`，profile 里也有一份。volatile 协议走 `Symbol.for('cosmokit.volatile.write')` 且宿主侧按 `meta.volatile` 鸭子判定，故跨副本安全；但**若降到 <3.18.3 就会退化成运行时 `.volatile is not a function`**。 |

## 5. 范围外发现（只报告，不修）

1. **`packages/dsh-config-manager` 有 3 条测试失败**：
   `src/utils/recursive-walk.test.ts` 的 issue #37 符号链接用例。测试与其被测文件
   `recursive-walk.ts` **都在 HEAD 且未修改**（该包的在途改动是 `self.ts` / `credentials.ts`
   等 52 个文件），故为既有失败，与本次改动无关。失败信息为「链接目录内容必须进备份」
   一类断言，疑似与符号链接跟随有关。
2. **`pnpm test`（根脚本）在本机沙箱下会假失败**：`dsh-loop-guard` 的 `test` 脚本先跑
   `node build.mjs`，其 `rm -rf lib` 会撞上沙箱的批量删除保护
   （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，515 文件 > 阈值 50），`pnpm -r` 随即
   `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` 中止，**后续包被记为 Failed 但并非真的失败**。
   CI（GitHub Actions）无此保护。本机验证时应逐包跑，或直接调 `node --test` 跳过重建步骤。
3. **`.workbuddy-ai/` 未纳入版本控制**（`??` 状态），内含本仓库的工作记忆。是否入库由用户决定。

## 6. 未决问题

1. **首发与信任（需用户操作）**：`@logictan/dsh-better-reasoning-effort` 在 npm 上尚不存在
   （实测 404），故首次发布**必须人工** `npm publish`，再配 trusted publisher
   （`--allow-publish` 必填，否则 CI 的 `npm publish` 被拒）。
2. **本机 npm 版本不足**：本机 npm `10.9.7` **没有** `trust` 子命令（需 ≥ 11），
   需 `npx npm@latest trust …` 或走 npmjs.com 网页配置。
3. **聚合包推送与发布**：等用户完成上述两步并通知后，再 push + 发
   `@logictan/dsh-plugins-all@0.5.13`。

# CI 发布失败的处置

只在 CI 发布 run 红了、或怀疑「发出去了没有」时读。

判据只能是 registry，不是 CI 日志。

> **失败的 run 可能已经发出去一部分**：发布按依赖顺序逐个包进行，任何一个包失败都会让整条
> run 红掉，但它**前面的包已经上线了**。实测 v0.5.73：子插件 `0.5.3` 发布成功、聚合包在
> `npm error code IDENTITY_TOKEN_READ_ERROR`（取 OIDC 身份令牌失败，瞬时故障）上失败，
> run 整体 success=**false**。此时**先查线上实际版本再决定动作**——
> `gh run rerun <id> --failed` 即可续跑，判重会跳过已发布的包；
> 看到红 run 就重新升版，会白白多发一个版本。

> **`gh run rerun --failed` 对「作业被超时取消」无效，改用 `gh workflow run` 续跑**：取消的 run
> 没有失败步骤，`--failed` 会直接报没有可重跑的作业。实测 v0.5.90：整个 `publish` 作业撞
> `timeout-minutes: 30` 被 `cancelled`，17 个包里只发完 7 个；`gh workflow run publish.yml
> --ref main -f dry_run=false` 起一条新 run，判重跳过已发布的 7 个、从第 8 个继续。
> 判据是 run 的 `conclusion`：`failure` 用 `--failed`，`cancelled` 用 `workflow run`。

> **`+ <pkg>@<ver>` 不是「已上线」，只是 npm 受理了请求**：`npm publish` 输出 `+ @scope/pkg@1.2.3`
> 之后，CI 会轮询 registry 直到该版本可解析，超时就以
> `@scope/pkg@1.2.3 is still not resolvable after 15 minutes` 失败，并提示
> `Usually a publish held for approval (staged)`。**这是已发布包也会撞上的情况**，与上文
> 「新包不能 staged」是两件事：staged publishing 对新包是「不支持」，对已存在的包是
> 「默认开着、需人工批准」。实测 v0.5.99：`dsh-better-reasoning-effort@0.5.7` 正常上线
> （`_npmUser` 为 GitHub Actions），而 `dsh-openviking@0.4.10` 停在 staged，聚合包因依赖
> `^0.4.10` 解析不到而整条 run 失败。
>
> **判据只能是 registry，不是 CI 日志**：`npm view <pkg> version` 与
> `curl -H 'Cache-Control: no-cache' https://registry.npmjs.org/<urlencoded-pkg>?t=<ts>`
> 里查 `versions` / `dist-tags`。`npm view <pkg>@<ver>` 报 404 即确认未上线。

> **staged 记录可能是「孤儿」：`npm stage list` 为空**≠**没有 staged 版本，此时只能跳号。**
> 别把「列表为空」当成「不是 staged」去另找原因。判据是**发布时**的报错文本，不是列表：
> ```
> npm error code E409
> 409 Conflict - PUT https://registry.npmjs.org/<pkg>
> Cannot publish over previously staged version "<ver>".
> ```
> 这句话证明 registry 侧**确实存在**该版本的 staged 记录。而实测它同时满足：
> `npm stage list <pkg>` 报 `No staged versions`、`GET /-/stage` 三页翻完 `total: 0`
> （`--json` 也是 `[]`）—— **记录存在却不出现在任何队列里，于是拿不到 stageId**：
> `DELETE /-/stage/<pkg>@<ver>` 报 `"stageId" must be a valid GUID`，没有 id 可删；
> 页面上也没有条目可批准。`gh workflow run` 续跑会撞**同一个 E409**（已实测），
> 所以它不是瞬时故障、重跑无意义。**唯一出路是跳过这个版本号**（`0.4.10` → `0.4.11`）。
> 代价为零：该版本从未落库，没有客户端解析过它。
>
> **不要因为撞到 staged 就转去手动 `npm publish`**：本规则开头「一律走 CI/CD、不跑
> `npm publish`」在这里同样成立。手动发要 OTP（本机认证走浏览器轮询，实测三次均以
> `E404 GET /-/v1/done?authId=` 收场），且**撞的是同一个 E409**——绕远路而已。
> 实测 v0.5.99：我在这一步误判成「registry 丢了版本、须手动重发」，让用户去终端操作，
> 白白耗时；正确动作是直接改版本号重走 CI（v0.5.100 一次通过）。

- **registry 404 不等于未发布**：发布后短时间内查询会命中 CDN 缓存。核验时带
  `Cache-Control: no-cache` 与时间戳查询串，并以 npm 日志的 `PUT 200` / 退出码 0 为准。

- **发布时的 `PUT ... E404` 是「缺 trusted publisher」，不是缓存**：与上面那条相反 ——
  缓存只会让人**读到**旧版本，不会让**写入**被拒；且同一次 run 里其余包都正常处理。
  判据是发布者身份：`npm view <pkg>@<ver> _npmUser` 显示
  `GitHub Actions <npm-oidc-no-reply@github.com>` 才说明该包走过 CI，
  显示人名则是人工发的。实测 `dsh-stitch-designer` 1.0.0 由人工发布、从未走过 CI，
  于是 CI 首次发它时 `PUT` 被拒 —— 这是**当初漏配 trust**，不是 CDN。
  修法：让用户在该包设置页补配 trusted publisher，然后 `gh run rerun <id> --failed` 续跑。

- **`pnpm/action-setup` 必须显式给 `version`**：本仓库没有 `packageManager` 字段，
  两者都缺时该 action 直接失败。

- **provenance 需要 `repository`**：包的 `package.json` 缺 `repository`（指向本仓库且
  `directory` 正确）时，OIDC 发布的 provenance 生成被拒。已发布的旧版本无法补，只能等下一个版本。

- **本地验证脚手架发布后要清三处，漏一处就还在读本地**：`pnpm-workspace.yaml` 的
  `overrides:` 块、`package.json` 里聚合包的 `file:` 指针、以及重装后的 `pnpm-lock.yaml`。
  判据：`grep "<仓库绝对路径>" pnpm-lock.yaml` 无输出，且包目录是真目录（非软链）、
  版本等于线上版本。只删 overrides 而不改 `package.json` 的 `file:`，聚合包仍指向本地目录。

- **`dsh plugin add` 还会往 `dsh.profile.bundles` 追加一行 —— 装聚合包时那是第 4 处要清的地方**：
  `dsh plugin --profile <p> add file:<本地包>` 同时写 `dependencies` 与 `bundles`，而聚合包的 patch
  已经带着该子插件的挂载行，于是同一 `id` 有了两个来源（机制见 `dsh-plugin-deps` 技能「换包一律先删再加，不要并存」）。
  实测 2026-10-18：装 `file:…/dsh-better-reasoning-effort` 后 `bundles` 多出该项；摘掉它、只留
  `dependencies` 里的 `file:` 指针后安装与加载都正常。

  **不摘不会硬崩，而是让该包从解析表里消失（2026-10-28 实测补全）。** 机制不是「重复 id」那条：
  `collectProfileScopePackages` 先算依赖闭包，末尾再
  `for (const layer of profile.layers) bundleLinks.delete(layer.packageName)`
  —— 出现在 `bundles` 里的包会被当成独立 layer，于是刚进闭包的它又被**自己删掉**。
  后果是 `createRuntimeResolution().entries` 里查不到该包，插件行的 `name` 无法路由，
  宿主记 `failed to import`、该行 `did not activate`，**provider 从未注册**。
  判据是解析表本身，不是日志（日志跨启动追加，旧报错会一直留在文件里）：

  ```bash
  node -e "const m=require('<宿主>/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  const prof=m.loadProfile('dsh','<profile>','<宿主>/package.json','<DSH_HOME>');
  Promise.resolve(m.createRuntimeResolution({installAnchor:'<宿主>/package.json',home:'<DSH_HOME>',profile:prof}))
    .then(r=>console.log(r.entries.some(e=>e.name==='<包名>'), r.entries.length))"
  ```

  返回 `false` 即命中本条；摘掉 `bundles` 里那一项后应变成 `true`（本次 573 → 574）。

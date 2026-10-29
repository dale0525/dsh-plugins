---
name: dsh-plugin-release
description: 发版、升版本号、配 trusted publisher、CI 发布失败（`PUT ... E404`、`E409` staged、依赖解析不到、作业被超时取消），或要把本地验证脚手架从工作区清干净时加载。
---

# 发布、版本与 registry

发布链路的坑几乎都表现为「看似发布成功、实则没发」，或「红 run 里其实已经发出去一部分」。判据只能是 registry，不是 CI 日志。

## 铁律

- **已发布包一律走 CI/CD，禁止手动 `npm publish`**。本机发布要 OTP，必失败；撞到 staged 时手动发撞的是同一个 `E409`。
- **新包不能走 CI 首发**：先由用户人工发一次并配 trusted publisher，之后才交给 CI。
- **顺序由 `scripts/publish.mjs` 拓扑推导**，不写死包名（新增子插件/聚合包无需改脚本）：子插件必须先上线，聚合包才能解析到它的依赖版本。跑 `npm run publish:plan` 预览。
- **改了版本号才能发出去**：npm 拒绝覆盖已发布版本，版本没升的包被 CI 判重跳过。子插件升版后聚合包也要升版，否则聚合包解析到的还是旧的子插件 range。
- **发布前必过 `AGENTS.md` 的「✅ 验证命令」四条门禁。**

## 认证

走 **trusted publishing (OIDC)**，不存 npm token：npm 正在移除 bypass-2FA token 的直接发布能力（官方 targeting 2027-01），且 write token 需定期轮换。

## 两条触发路径（`.github/workflows/publish.yml`）

| 路径 | 命令 | 用途 |
|---|---|---|
| 推 tag（正式发版） | `git tag v<x.y.z> && git push origin v<x.y.z>` | 常规发版，tag 记录发版点 |
| main 手动触发 | `gh workflow run publish.yml --ref main -f dry_run=false` | 补发/重发；**tag 指向的提交不含门禁修复时用这条** |

发布步骤的门禁是 `github.event_name == 'push' || (github.ref == 'refs/heads/main' && !inputs.dry_run)`
—— 只有 tag push 或 main 上的显式 `dry_run=false` 才能换取 OIDC 凭证。

> 发布门禁用**真值**判定而非 `== true`：经 CLI/REST 触发时 `inputs` 可能以字符串传入，
> 而 `==` 会两侧转数字（`Number("true")=NaN`），`"true" == true` 实为 `false`，
> 那样真发布会被静默跳过。已实测 `-f dry_run=false` 能正常发布（run `35508114244`：
> Publish 步骤 success、Dry run notice skipped），无需改用 `gh api`。

## 新增包与首发交接

### 新增包：人工首发 + 配 trust（**由用户执行**）

新包**不能**走 CI 首发，两个独立原因均来自 npm 官方文档：

1. trusted publisher 只能配在**已存在包**的设置页上；
2. staged publishing 明确排除全新包（`you cannot stage a brand-new package`）。

所以新包必须先由用户人工发一次，再配 trust，之后才交给 CI。**命令见 `README.md` 的「发布」。**

**Agent 不得代为执行新包发布**：本机 `npm publish` 需要 OTP，会以 `npm error code EOTP` 失败。

### 首发交接：必须把两条命令原样给用户

新插件做完、门禁全绿之后，**Agent 的交付不算完成**，直到它把下面两条命令按实际包名填好、
逐字交给用户执行。不要只说「请你人工发布一次」——用户需要能直接粘贴的命令：

```sh
cd packages/<name> && npm publish --access public
npm trust github @logictan/<name> --file publish.yml --repo dale0525/dsh-plugins --allow-publish
```

交付消息里要同时给出：① 这两条命令；② 一句「执行完告诉我，我再升聚合包版本走 CI」；
③ 该包的版本号，因为用户要确认发出去的是哪一个。缺任何一项，用户就得回头问。

> `--allow-publish` 不可省：2026-09-03 之后创建的 trust 配置默认只允许 `npm stage publish`，
> 少了这个 flag，CI 首次直接发布会被拒（`PUT ... E404`）。
>
> **两条命令的顺序也不能反**：trusted publisher 只能配在已存在的包上，
> 先 `npm trust` 会因包不存在而失败。

用户确认 trust 配好之后，Agent 才继续：升 `packages/all` 版本 → 聚合包走 CI/CD。
在此之前聚合包不能发——它会把 `^<子包版本>` 写成一个 registry 上还不存在的版本，
`pnpm install --frozen-lockfile` 在 CI 第一步就解析失败。

## 更新已发布包

**规则**：本地测试通过后，一律由 CI/CD 发布，**不跑 `npm publish`**。CI 的 publish 步骤带
`npm view "$name@$version"` 判重，已在线版本自动跳过，所以整仓发布是幂等的、可放心重跑。

发布顺序：

```bash
npm run publish:plan                 # 确认顺序：子插件在聚合包之前
```

## 按需细则

| 情形 | 读哪个 |
| --- | --- |
| CI run 红了、`PUT ... E404`、`E409` staged、作业被超时取消、判断「到底发出去没有」、清理本地验证脚手架 | `references/ci-failures.md` |
| 要升某个包的版本号：锁文件、一个版本的多个落点 | `references/version-bump.md` |

# 升版：锁文件与多落点

只在真的要升某个包的版本号时读。

> **升版后必须重生成 `pnpm-lock.yaml`，否则 CI 在装依赖那步就红**：CI 用
> `pnpm install --frozen-lockfile`，而 `pnpm-lock.yaml` 的 `importers` 里逐条记着每个 workspace
> 依赖的 `specifier`。`node scripts/aggregate.mjs` 只改 `packages/all/package.json` 的
> `dependencies`，**不动锁文件**；漏跑 `pnpm install --lockfile-only` 时，锁文件仍是
> `^<旧版本>` 而清单已是 `^<新版本>`，发布 run 在 `Setup pnpm` 之后的安装步骤直接失败，
> 一个包都发不出去。实测 2026-10-19 升 `dsh-worktree-session` 0.1.7→0.1.8 时复现：
> 把锁文件改回 `^0.1.7` 跑 `pnpm install --frozen-lockfile`，报
> `specifiers in the lockfile don't match specifiers in package.json` 并点名
> `in importers["packages/all"]: @logictan/dsh-worktree-session (lockfile: ^0.1.7, manifest: ^0.1.8)`。
> 顺序固定为：改两个 `version` → `node scripts/aggregate.mjs` → `pnpm install --lockfile-only` → 提交，
> 锁文件那一行和两个 `package.json` 进同一个 release 提交。

> **一个包的版本号不止写在 `package.json` 里**：`dsh-openviking` 在 `config.mjs` 有 `PLUGIN_VERSION`
> 常量，且 `bundle.test.mjs` 同时钉住它与包自带 `package-lock.json` 的两处 `version`。
> 只改 `package.json` 会让该包测试红，而**本地单包测试若在升版前跑过就发现不了**——
> 实测 v0.5.84 因此被 CI 的 Test 步骤拦下。升版前先 `grep -rn '"<旧版本>"' packages/<pkg>/`
> 找出所有落点，改完再跑一次该包测试。

> **`npm trust list <pkg>` 无法免交互核验**：它要求 OTP（`npm error code EOTP`），
> Agent 跑不了。所以「trust 是否配好」不能靠它判定 —— 真正的判据是**看该包历史版本的发布者身份**：
> `npm view <pkg>@<ver> _npmUser` 显示 `GitHub Actions <npm-oidc-no-reply@github.com>` 即已走过 CI，
> 显示人名则只被人工发过。新包在人工首发+配 trust 后，判据只能是**下一次 CI 发布是否成功**。

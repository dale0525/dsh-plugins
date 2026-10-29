---
name: dsh-plugin-upstream
description: 把某个 fork 子包同步到上游新版本，或用 `sync-upstream.mjs` 查上游改了什么、预演这次同步会撞哪些冲突时加载。
---

# 上游同步（手工）

同步是手工的，没有定时任务也没有自动应用。本技能只覆盖 fork 子包；自制与已去 fork 化的包不参与。

## 🔀 上游同步

**同步是手工的。** 仓库只保留 `git subtree` 祖先和一个**只读**的查询工具：没有定时任务、
没有自动应用、没有自动 PR。每个 fork 子包自带一份 `packages/<pkg>/upstream.json`，
只声明它的上游身份（`id` / `url` / `prefix`）。

```bash
node scripts/sync-upstream.mjs --list              # 各 fork 的上游、上游最新 tag、我们相对它的状态
node scripts/sync-upstream.mjs --changed <id>      # 上游从真正的同步点到最新 tag 改了什么
node scripts/sync-upstream.mjs --preflight <id>    # 预演这次同步会撞哪些冲突，并按裁定难度分好类
```

脚本不 pull、不 checkout、不 rm、不 commit（`scripts/sync-upstream.test.mjs` 钉住这条契约）。
`--changed` 把 tag fetch 到 `refs/dsh-sync/<id>` 再 `git diff --stat`，不动工作区。

> **同步点是 `merge-base(HEAD, 上游 tag)`，不是 subtree trailer。** 手工同步的合并提交不带
> `git-subtree-split:` trailer（它只出现在**收养**提交里），拿它当同步点等于把收养点当成上次同步点，
> `--changed` 会把已经合并进来的历史再报一遍（实测 bre：48 文件 / 5185 行）。
>
> **fetch 到自己的 ref 命名空间，绝不复用上游 tag 名。** 本仓的发布 tag 也叫 `v0.5.2`，
> 直接 `git fetch <url> tag v0.5.2` 会撞车，以 `! [rejected] would clobber existing tag` 失败（实测）。
> 但**加 `--force` 就不再失败，而是静默改写**——本仓 121 个 tag 里有 29 个与上游同名
> （`git ls-remote --tags --refs <上游>` 与本仓 `git tag -l` 取交集），实测 `--force` 把本仓的
> `v0.5.2`、`v0.5.0` 直接指向了上游提交，**报错都没有**。要探上游 tag，一律 fetch 进
> `refs/dsh-sync/<id>`，永不写 `refs/tags/`。
>
> `--preflight` 用 `git merge-tree -X subtree=<prefix>` 复现 `subtree pull` 的三方合并，**只报告不落地**：
> 把我方已故意删除的构建产物 / 锁文件（维持 `git rm`，机械可裁定）与真正要人看的冲突分开列。
> 实测它与真 pull 的冲突集**完全一致**（bre 4 处、workbuddy 11 处）；不带 `-X subtree` 会多报假冲突。
> 它只把「机械的那部分」直接给出命令，**不替人裁定**，也不改工作区。

### 手工同步一个 fork

```bash
git subtree pull --prefix=packages/<pkg> <url> <tag>
```

然后**逐个冲突手工裁定**，`git commit`。没有「我方文件清单」这回事。

> **为什么删掉了 `owned` / `deleted` / `added` 清单**：那套清单把「可三方合并」压成「整文件二选一」。
> 上游与我们改在同一文件的**不同区域**时，git 本来能干净三方合并，清单却用
> `git checkout <pull 前的 HEAD> -- <owned>` 把整个文件覆盖回我方版本 —— 上游在该文件里的改动被
> **静默丢弃**，连冲突标记都不出现。实测 workbuddy v0.5.4 → v0.6.2：`locales.ts` 干净自动合并，
> `WorkBuddyPluginCard.tsx` 3 处冲突、`index.ts` 7 处冲突，全部可见、可逐处裁定。

### 手工同步要自己盯住的三件事

| 事项 | 判据 |
|---|---|
| 我方架构与上游冲突 | 上游把功能加进我方也改过的文件时，取上游的**内容**、留我方的**架构** |
| 宿主依赖世代 | 上游按新世代宿主写的代码，需要把 `package.json` 的宿主依赖抬到同世代 |
| 上游新增的导出 | 上游在 `src/index.ts` 里新增的导出不会自己出现在我方版本里，要手工补 |

真实价值边界：上游一天 1-2 个版本、我们砍掉了大部分代码，**这个同步不会带来「版本对齐」**，
它只把上游在「我们保留的文件」里的 bug 修复拉进来。代价是没有自动通知了 —— 靠人记得跑 `--list`。

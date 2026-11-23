---
name: wrap-up-worktree
description: worktree 收口（只能由用户显式输入 /wrap-up-worktree 调用，模型不可自行加载）：推送 worktree 分支、合并回默认分支、推送默认分支、移除该 worktree 并安全删除本地与远端分支。只在 linked worktree 中使用，要求该 worktree 内改动已由 wrap-up 清理并提交干净。
disable-model-invocation: true
---

# worktree 收口

**本技能只由用户显式输入 `/wrap-up-worktree` 触发**，已在模型目录中隐藏；收到本技能正文即表示用户已显式调用。本技能只管**合并与拆除**，不代做清理、沉淀与提交（那些属于 `wrap-up`）。

## 前置检查

- 不是 Git 仓库就直接说明并停止。
- 必须在 linked worktree 中：`git rev-parse --git-dir` 与 `git rev-parse --git-common-dir` 输出不同才合法；两者相同说明在主工作区，停止并改用 `wrap-up`。
- 记录四个路径／名称：当前 worktree 路径（`git rev-parse --show-toplevel`）、主工作区路径 `<main_root>`（`git worktree list --porcelain` 第一条 `worktree`）、当前分支名、默认分支名（取 `origin/HEAD` 去掉 `origin/`，拿不到时查本地 `main`／`master`，仍有歧义用 `ask_user_question` 确认）。
- **工作区必须干净**：若当前 worktree 的 `git status --porcelain` 非空，**直接停止执行**，列出未提交／未跟踪文件，提示用户先触发 `wrap-up` 清理提交完毕后再重新输入 `/wrap-up-worktree`；既不代为清理提交，也不在无法完成的前提下阻塞等待。

## 推送当前分支

将当前分支推送到远端。

## 合并回默认分支并推送

1. 用 `git worktree list` 检查默认分支是否已检出在某个目录：
   - 若已检出在某目录 `<default_dir>`：先检查该目录 `git status --porcelain` 必须为空（脏则停止报告，不污染未提交改动），再以 `workdir: <default_dir>` 执行 `git pull --rebase` 并合并当前分支。
   - 若默认分支未检出在任何 worktree：先检查 `<main_root>` 的 `git status --porcelain` 必须为空（脏则停止报告），再以 `workdir: <main_root>` 执行 `git checkout <默认分支>`、`git pull --rebase` 并合并当前分支。
1. 冲突就地解决后，推送默认分支到远端。

## 拆除 worktree 与删除分支

1. **必须将执行 `workdir` 设为 `<main_root>`**（`git` 子进程无法更改父会话 cwd，若留在待删目录内执行，目录移除后紧接着的命令会因 cwd 失效报错）。
1. 在 `<main_root>` 执行 `git worktree remove <worktree 路径>`。若报 `contains modified or untracked files`，说明 worktree 内仍有未清理或未提交文件，停止并让用户先处理干净，**禁止用 `--force` 绕过**。
1. worktree 移除后再删分支：本地执行小写 `git branch -d <分支>`（保留 Git 未合并校验，拒删即停，禁止改用 `-D` 强删）；远端仅在确有该分支时执行 `git push origin --delete <分支>`。

## 报告与边界

- 报告须列出：worktree 路径、分支名、推送结果、合并与冲突处理结果、默认分支推送结果、worktree 与分支删除结果。
- 冲突解决不了或推送被拒（权限、保护分支、网络）：立即停止并报告原因，绝不继续拆除 worktree 或删除未合并分支。
- 涉及发布（`npm publish`、打 tag、流水线）须先确认明确授权；本技能默认不含发布。

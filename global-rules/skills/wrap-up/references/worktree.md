# linked worktree 里的收尾

只在 `git rev-parse --git-dir` 与 `git rev-parse --git-common-dir` 输出不同（当前处于 linked worktree）时读。

## 全量盘点与无归属区分

在 linked worktree 中收尾时，该目录内的全部变更都要处理完毕，不区分是否出自本次会话——包括遗留的未提交与未跟踪文件（沉淀判据不变，不为他人遗留补写知识），因为 worktree 最终会被整目录移除，遗留即丢失。

先 `git status` 全量盘点并逐项归类清理或提交；确实无法归类的报告并保留，同时明确提醒该 worktree 此时**不可**进入 `/wrap-up-worktree` 收口流程。

在「提交」一节里，盘出的每一处改动都须落入按主题拆分的提交中；显式指定路径暂存的禁令不变，逐个列出路径，不改用 `git add -A`。

## 本技能止步边界

本技能在 linked worktree 中只做到提交为止：不推送分支、不合并、不移除 worktree、不删分支。这些操作全部归 `wrap-up-worktree`（已设 `disable-model-invocation: true`），只能由用户显式输入 `/wrap-up-worktree` 触发。口头说「收尾」「合并分支」只授权本技能，绝不越权代跑合流或移除。

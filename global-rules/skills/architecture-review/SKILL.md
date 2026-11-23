---
name: architecture-review
description: 代码库架构评审（只读诊断，仅由用户输入 /architecture-review 触发，模型不可自行加载）：聚焦近期热点模块，用深模块设计标准找出浅模块、透传废层与高摩擦结构，产出重构候选项报告并请用户挑选探索方向；未授权不改代码。
disable-model-invocation: true
---

# 代码库架构评审

只读架构诊断流程，帮助定位真正值得投入的深模块重构机会。执行前先加载 `codebase-design` 技能统一词表与判定标准。

## 按 YAGNI 界定扫描范围

- 用户指定了目录或模块，直接锁定该范围。
- 用户未指定范围时，先运行 `git log --oneline -n 40 --stat` 找出近期高频改动的热点区域，优先扫描热点——绝不对长期稳定、无人触碰的冷代码制造无收益重构建议。
- 同步查阅仓库 `CONTEXT.md` 及相关 OpenViking 决策记忆，了解既定架构取舍。

## 独立扫描与候选过滤

- 派一个 `[只读]` 子代理用干净上下文扫描目标范围（遵循 `collaboration-and-delegation`，指令以 `[只读]` 开头），专门识别：层层透传的浅模块、改一处需求要同时改 5 个文件的低局部性散落逻辑、只有单实现的假想抽象缝隙、以及绑死内部结构的脆弱测试面。
- Root 对子代理上报的候选用 `codebase-design`「删除测试」复验，剔除为了优雅而拆、实际无维护收益的伪候选。
- 若某候选方案与既有 OpenViking 架构决策冲突，必须显式标出冲突点与原决策背景，不静默推翻。

## 产出报告与收敛

- 每个候选项写明：涉及文件清单、核心结构摩擦、拟加深方案、预期收益与代价、推荐等级（`Strong`／`Worth exploring`／`Speculative`），并标出首推项。
- 候选项较多（≥3 项）或含复杂模块拓扑变化时，可生成一份自包含 HTML 前后对比报告写至 `$TMPDIR/architecture-review-<timestamp>.html`（不污染仓库工作区）；候选项少时直接以精简结构汇报。
- 报告后停止，按 `~/.dsh/AGENTS.md` 核心原则 9 调用 `ask_user_question` 请用户挑选想深入的候选项（或选择「仅作参考暂不重构」）。用户选中后，再按需衔接 `requirement-grilling`、`codebase-design` 技能的 `references/design-it-twice.md` 或 `to-spec`；**未获明确授权绝不修改仓库代码**。

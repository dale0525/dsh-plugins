---
name: skill-creator
description: 创建、修改、拆分、审查或排障 DSH 技能（skill），规定所有技能均按「SKILL.md 只放每次都成立的内容、其余按需加载」组织。新建技能、固化工作流、拆分过大 SKILL.md、调整技能结构或排查技能未被收录／触发不准时加载。
---

# Skill Creator

本技能只覆盖技能的**设计、创建、维护与排障**。本技能自身即示范：每次都成立的判据与契约概要留在 `SKILL.md`，形态细则与注册细节放在 `references/` 按需读取。

## 先选形态

| 形态 | 何时用 | 细则 |
| --- | --- | --- |
| **单层** | 一个技能讲清一件事；最多带 `references/`、`scripts/`、`assets/` | `references/flat-skill.md` |
| **嵌套（编排式）** | 同一套件有多条独立子流程、顶层需路由、且共享 `references/` 或 `scripts/` | `references/nested-skill.md` |

不确定一律选单层；只有满足全部三条嵌套判据时才建 `subskills/`。

## 按需加载（所有技能默认结构）

`SKILL.md` 一经触发即**整份**进入上下文，因此只放**每一次使用本技能都成立**的内容：边界、路由、硬门禁、必过步骤。其余只在特定情形才用到的内容下沉，并在 `SKILL.md` 写明「什么情形读哪个文件」：

| 下沉内容 | 去处 |
| --- | --- |
| 需路由的独立子流程 | `subskills/<child>/SKILL.md` |
| 特定情形才查的细则、清单、参考表 | `references/<topic>.md` |
| 确定性脚本 | `scripts/` |

- **规模信号**（非硬上限）：`SKILL.md` 超过约 150 行或 6 KB 时按上述判据过一遍，把过不了判据的段落拆出。
- **反例**：把 20 条只在少数场景踩到的雷区平铺进 `SKILL.md`。
- **反向的坑**：不要把几十行内容硬拆成多个必读文件；拆完若每次仍要全读，等于没拆还多一次跳转。

## 注册契约概要

- 目录与命名：技能根下只认 `<name>/SKILL.md` 或 `<name>.md`（不递归发现）；`name` 须 kebab-case 且与目录名一致，否则整份技能静默丢弃。
- frontmatter：必填 `name` 与 `description`；旧驼峰键（`disableModelInvocation`、`modelInvocable`、`userInvocable`）会让整个技能被丢弃；**`whenToUse` 虽合法但模型目录和加载包装会忽略它，触发条件必须写在 `description`**。
- `description` 是模型看到的**唯一**触发依据（超 500 字符截断），**触发词必须落在决策点之前**，不要写成「已决定做 X 后加载」。
- 发现优先级：项目级 `<项目>/.dsh/skills`（rank 100）、`<项目>/.agents/skills`（rank 200）高于用户级 `~/.dsh/skills`（rank 400）、`~/.agents/skills`（rank 500）。

完整字段清单、旧键名单、rank 100–600 全表、目录卫生与触发反例见 `references/contract.md`——写 frontmatter、选放置目录或排障「技能消失」时读。

## 工作流

1. **明确输入**：仅在**新建技能且用户未给触发示例**时，用 `ask_user_question` 问清一两个典型用户说法与期望产出；已有明确需求，或执行修改、拆分、审查、排障时直接进入下一步。
1. **定形态与拆分**：按「按需加载」判据划分常驻正文与下沉资源，再读对应细则（`references/flat-skill.md` 或 `references/nested-skill.md`）。
1. **落盘**：先核对是否存在旧备份或重复主题技能（全局 `~/.dsh/` 非 Git 仓库，改前备份统一放 `~/.dsh/backups/`，不留 `.bak` 在技能目录内）。
1. **按类型验收**：
   - 常规顶层技能：用 `skill` 工具按精确名加载，确认返回正文且出现在会话 `<available_skills>` 中。
   - `disable-model-invocation: true` 技能：它刻意不在模型目录中且 `skill` 工具不可调，核对 frontmatter 合法、目录名一致并确认仅通过用户 `/<name>` 触发。
   - 嵌套子技能：核对顶层路由表相对路径与磁盘目录一一对应。

## 交付前自检

- `description` 在 500 字符内、触发词落在决策点之前、无依赖 `whenToUse` 路由。
- `name` 为 kebab-case 且与目录名一致；无旧驼峰键与无效外部配置（如 `openai.yaml`）。
- 技能目录内无 `README.md`、`.bak`、`CHANGELOG.md` 等噪音文件；标题无序号、正文无数字章节引用（见 `doc-governance`）。
- 每个下沉文件均在 `SKILL.md` 写明相对路径与读取时机；同一事实只有一个出处，上下层不互相复制。

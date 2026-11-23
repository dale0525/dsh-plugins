# 注册契约

以下每条均由宿主代码决定；违反后通常表现为**技能静默消失**而不报错。

## 目录与命名

- 技能根目录下只认两种形状：目录包 `<name>/SKILL.md` 或扁平文件 `<name>.md`。**不递归发现**——`subskills/x/SKILL.md` 不会被注册为独立技能。
- `name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（kebab-case，无大写、无下划线、无连续连字符），且目录名与 `name` 一致；非法名会让整个技能被静默丢弃。

## frontmatter

- 必填：`name`、`description`；缺失或为空都会丢弃整份技能。
- 可选：`metadata`（对象）、`disable-model-invocation`（布尔）、`user-invocable`（布尔）、`whenToUse`（字符串）。
  - **关键警示**：`whenToUse` 仅作为 provider 元数据保留，DSH 的模型目录（`<available_skills>`）与加载包装层都会**完全忽略它**——绝不要把触发条件放进 `whenToUse`。
- **旧键致命**：`disableModelInvocation`、`modelInvocable`、`userInvocable` 一律导致整个技能被丢弃。
- 未知键（如 `license`、`allowed-tools`）无任何效果，不要写。
- `disable-model-invocation: true` 将技能排除出模型目录和 `skill` 工具，只能由用户 `/<name>` 触发；`user-invocable: false` 将其排除出用户 `/` 菜单。布尔键接受 YAML 布尔及不区分大小写的 `true`/`false`/`yes`/`no`/`on`/`off`/`1`/`0`，非法值会丢弃整份技能。

## description 决定触发

- `description` 是模型看到的**唯一**触发依据，目录中超过 **500 字符**会被截断为 `...`，关键触发词放前面。
- 写清「做什么」和「什么时候用（具体用户说法或决策前兆）」，避免「帮助处理各种任务」类空话。
- **触发词必须落在决策点之前**：若正文讲的是「该不该做 X」，`description` 必须锚定在还没做决策的时刻；否则形成循环依赖。同一技能若包含不同决策点的职责，拆为不同技能（例如交付核验归 `delivery-discipline`，派单与并发写法归 `collaboration-and-delegation`）。

## 发现位置与优先级全表

项目根按距离工作目录最近的 `.git` 祖先目录判定；同名技能取 rank 数值更小者胜出，新增或改名即时生效无需重启：

| rank | 来源目录 |
| --- | --- |
| 100 | `<项目>/.dsh/skills` |
| 200 | `<项目>/.agents/skills` |
| 300 | `customSkillDirs`（用户自定义配置目录） |
| 400 | `~/.dsh/skills` |
| 500 | `~/.agents/skills` |
| 600 | `bundledSkillDir`（内置／插件随附技能） |

`~/.dsh/skills/.system` 会被跳过。

## 目录卫生

技能目录内只放支撑该技能的必需文件。禁止放入 `README.md`、`CHANGELOG.md`、`.bak*` 备份文件或无关平台配置（如 `agents/openai.yaml`）。

/**
 * The Stitch design conventions, as the plugin announces them.
 *
 * These are **prose**, and deliberately so. "Did you use TailwindCSS?" and "is
 * this pixel-perfect?" have no computable predicate, so a validator for them
 * would be a lie — it would either pass everything or block correct work. They
 * are delivered the way this repository delivers every other non-computable
 * rule: as an announcement in the system prompt, registered by the plugin that
 * owns the subject, so the model reads it in every session without anyone
 * having to remember to ask.
 *
 * The one convention with a computable predicate — one code project owns one
 * Stitch project — is **not** here. It is enforced in `src/conventions.js`,
 * because a rule the model can silently break is not a rule. This file is only
 * the text.
 *
 * The rules fall in two groups, and the split is the point: rules 4-8 govern
 * how a screen is commissioned (what to ask Stitch for), rules 1-3 govern how
 * the result is implemented. A brief that over-specifies produces a screen that
 * is no better than hand-written code, and a screen containing what cannot be
 * built is a defect discovered only at implementation time — both are cheaper
 * to prevent when the model is told before it writes the prompt.
 *
 * @module @logictan/dsh-stitch-designer/guidance
 */

/** Section name in the system prompt; unique across plugins. */
export const SECTION_NAME = 'plugin:dsh-stitch-designer';

/** Order within the tool-guidance band. */
export const SECTION_ORDER = 150;

/**
 * What the model is told about Stitch, and about implementing its designs.
 *
 * Written for a reader who has just been handed a design and is about to write
 * code from it — the moment these rules matter and the only moment they can be
 * acted on.
 */
export const STITCH_GUIDANCE = [
  '本机已安装 dsh-stitch-designer 插件（Google Stitch AI 界面设计）：提供 15 个 `mcp__stitch__*` 工具（建/删/列项目、列/取界面、生成界面、改界面、生成变体、设计系统与设计稿上传）。',
  '',
  '用 Stitch 设计稿实现界面时，遵守以下规范：',
  '1. 一个代码项目只对应一个 Stitch 项目，对应关系记录在该代码项目根目录的 `.stitch.json`。继续沿用已记录的那个项目，不要为同一个代码项目再调 `create_project`——插件会直接报错拒绝，并告知已绑定的项目 id。记录指向的 Stitch 项目已被删除时，插件会自动清掉记录，可重新创建。',
  '2. 实现时使用 TailwindCSS，与 Stitch 生成设计稿的方式保持一致；除非该项目已有架构无法兼容 TailwindCSS，此时先说明是哪一处不兼容、为什么不兼容，再动手。',
  '3. 先导出 Stitch 的设计稿 HTML，照着它实现，尽可能做到像素级还原。设计稿 HTML 落在 `<项目>/docs/design/<screenId>.html`，应提交到版本库。凡实现需要与设计稿不一致的地方，先问用户并给出理由，不要自行偏离。',
  '',
  '下单给 Stitch 时，遵守以下规范：',
  '4. 提示词只说明需要显示什么内容、用哪些已有组件，以及不需要显示什么（不要出现的模块、数据、交互）。布局、间距、配色、字体、动效等样式一律不写，让它自由发挥。把样式写死成一份详细规格，等于让它照着抄，产出的稿子不会比你自己写的更好。',
  '5. 唯一例外：当实现必须与某个既有设计语言保持一致时（例如要求按 `@logictan/dsh-macos-theme` 出稿），才需要交代样式——但只报名字没用，Stitch 不认识你的包名和主题名。要把那套语言实际长什么样告诉它：颜色取值、圆角、描边、字重与字号层级、间距密度、明暗关系。项目里已有设计系统说明（如主题包的设计系统文档或 Stitch 的 design system）就直接给原文，不要只给一个标识符。没有这种一致性要求时，不要指定任何设计语言。',
  '6. 设计稿最终要被像素级还原，所以稿子里不得出现无法实现的功能和元素。写提示词时就假定它会被逐像素实现：不要许愿一个做不到的交互、一个实现不了的效果，或一份拿不到的数据。',
  '7. 尽可能复用已有组件。出稿前先看项目里已经有什么（宿主组件、共享组件层），让稿子由这些组件拼出来，而不是重画一套长得像的。',
  '8. 每份设计稿都要同时给出暗色版本。暗色不是把亮色反相，而是同一套设计语言在暗色下的取值：颜色、描边、层级都要按暗色重新给。实现时两边共用同一套 token，暗色不另写一份。',
].join('\n');

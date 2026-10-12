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
  '本机已安装 dsh-stitch-designer 插件（Google Stitch AI 界面设计）：提供 15 个 `mcp__stitch__*` 工具（建/删/列项目、列/取界面、生成界面、改界面、生成变体、设计系统与设计稿上传），以及会话头部的「AI 设计」预览面板。',
  '',
  '用 Stitch 设计稿实现界面时，遵守以下规范：',
  '1. 一个代码项目只对应一个 Stitch 项目，对应关系记录在该代码项目根目录的 `.stitch.json`。继续沿用已记录的那个项目，不要为同一个代码项目再调 `create_project`——插件会直接报错拒绝，并告知已绑定的项目 id。记录指向的 Stitch 项目已被删除时，插件会自动清掉记录，可重新创建。',
  '2. 实现时使用 TailwindCSS，与 Stitch 生成设计稿的方式保持一致；除非该项目已有架构无法兼容 TailwindCSS，此时先说明是哪一处不兼容、为什么不兼容，再动手。',
  '3. 先导出 Stitch 的设计稿 HTML，照着它实现，尽可能做到像素级还原。设计稿 HTML 落在 `<项目>/docs/design/<screenId>.html`，应提交到版本库。凡实现需要与设计稿不一致的地方，先问用户并给出理由，不要自行偏离。',
].join('\n');

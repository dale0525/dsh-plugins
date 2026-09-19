/**
 * The fill instruction for the ctx-mem compaction backend.
 *
 * The host engine replays the whole conversation prefix and asks for a summary.
 * This backend instead extracts hard facts programmatically and hands the model
 * only the fact skeleton, asking it to supply the **causal** sections the
 * program cannot know: why an approach was chosen, why an error happened, what
 * is still undecided, and what comes next.
 *
 * The instruction is delivered as the final user message after the skeleton, so
 * the skeleton reads as the conversation being condensed. That keeps the call
 * shaped like the host's own summarization call — a user message appended to a
 * prefix — rather than inventing a separate prompt channel.
 *
 * The fact sections are declared read-only because they are already correct:
 * they were copied verbatim from the session log. Letting the model restate them
 * would reintroduce the paraphrase loss this backend exists to remove.
 *
 * The four causal headings are written out here as prose the model reads; the
 * authoritative list for *parsing* is `CAUSAL_SECTIONS` in `./causal.js`. The two
 * are intentionally separate: this file is a prompt, that file is the parser.
 */

/** Chinese prose instruction. */
const ZH_INSTRUCTION = [
  '你是压缩引擎。上面的 `## Extracted Facts` 是程序从会话日志中逐字抽取的硬事实，**已经准确**：',
  '其中的路径、命令、报错原文一律不得改写、翻译、润色、截断或补充。',
  '',
  '你的唯一任务：补出程序无法知道的原因与去向。严格输出下面四节，顺序不可变，',
  '每节用简洁的项目符号，空节写 `(none)`，不得新增、删除或改名任何一节：',
  '',
  '## Why This Approach',
  '- 目标是什么，以及选择该做法的理由。',
  '',
  '## Errors and Their Causes',
  '- 逐条：错误为什么发生、是否已解决；明确写出「不要再重试什么」。',
  '',
  '## Open Decisions',
  '- 抽取截止时仍未解决的问题。',
  '',
  '## Next Step',
  '- 最具体的下一步动作。',
  '',
  '只输出这四节，不要复述 `## Extracted Facts`，不要输出任何其他内容。',
].join('\n');

/** English prose instruction. */
const EN_INSTRUCTION = [
  'You are the compaction engine. The `## Extracted Facts` block above was extracted verbatim from the session log and is **already correct**:',
  'never rewrite, translate, reflow, truncate, or extend any path, command, or error text in it.',
  '',
  'Your only job is to supply the causes and direction the program cannot know. Output exactly the four sections below, in this order,',
  'as terse bullets. Write `(none)` for an empty section. Do not add, drop, or rename a section:',
  '',
  '## Why This Approach',
  '- What the goal is, and why this approach was chosen.',
  '',
  '## Errors and Their Causes',
  '- One bullet each: why the error happened, whether it is resolved, and explicitly what must NOT be retried.',
  '',
  '## Open Decisions',
  '- Questions still unresolved when extraction stopped.',
  '',
  '## Next Step',
  '- The single most concrete next action.',
  '',
  'Output only these four sections. Do not restate `## Extracted Facts` and do not output anything else.',
].join('\n');

/**
 * The instruction for one language.
 *
 * @param {'en'|'zh'} language
 * @returns {string}
 */
export function fillInstruction(language) {
  return language === 'en' ? EN_INSTRUCTION : ZH_INSTRUCTION;
}

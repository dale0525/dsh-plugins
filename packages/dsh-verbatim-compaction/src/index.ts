/**
 * Deterministic, verbatim-history compaction backend.
 *
 * `@deepseek-ai/dsh-compaction-basic` condenses a shadowed span through one
 * `ctx.llm.stream()` call whose instruction asks for a nine-section template
 * ("Primary Request / Key Technical Concepts / Errors and Fixes ..."). Measured
 * over eight real sessions (403 MiB, 145 compactions, 24.5M discarded tokens)
 * that template retains 2.38% of what it discards, and of everything discarded
 * only 0.67% is prose a human wrote -- the rest is reasoning (63.8%), tool
 * results (25.2%) and tool-call arguments (10.4%). The prose that does survive
 * is then summarized again on the next compaction, because
 * `selectCompactableRange` always starts at `surfaceNodes[firstIdx]` and the
 * previous checkpoint sits at index 1.
 *
 * This backend keeps the base class's replay, range selection, durable
 * transaction and shrink guard untouched and overrides only `summarize()`, the
 * one hook the base class documents for exactly this purpose. The replacement
 * summary is built from the log, with one model call per batch of turns:
 *
 *   - user and assistant prose verbatim, per turn;
 *   - tool results reduced to one line (tool names, call counts, bytes);
 *   - reasoning never read;
 *   - repeated injections recorded once.
 *
 * The digest source is the session log, not the shadowed span: the previous
 * checkpoint is itself shadowed on every compaction, so a span-only digest
 * would drop everything the previous digest carried. Reading the log's
 * append-origin surface events minus the retained tail reconstructs the whole
 * history without any accumulated state.
 *
 * @module @logictan/dsh-verbatim-compaction
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type ContentBlock, type Message, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
// Type-only: brings the `ctx.tokenMeter` augmentation into scope.
import type {} from '@deepseek-ai/dsh-token-meter'

/** Cordis companion plugin name. Must equal this plugin's `cordis.patch.yml` row id. */
export const name = 'verbatim-compaction'

/**
 * Absolute ceiling for one digest, in the meter's fixed 4-chars-per-token
 * heuristic.
 *
 * A share of the shadowed span is the wrong shape: it makes the digest grow
 * with history. Measured on one real session, the share-based budget produced
 * 2642 chars on an early span, 51019 on a later one, and 348539 on the span that
 * triggered the compaction loop — because a bigger span licensed a bigger
 * digest, and a digest near the threshold re-triggers immediately.
 *
 * A fixed ceiling makes the digest size independent of how long the session has
 * run, which is what the host's own summarizer does (its summaries measured
 * 14009-22208 chars across spans of 108829-173514 tokens).
 *
 * 20000 tokens holds roughly 100 turns of user prose plus one extracted block
 * per turn, and leaves the checkpoint far below any measured threshold.
 */
export const DIGEST_TOKEN_CEILING = 20000

/**
 * Framing overhead `frameSummary` adds under `TokenMeter.estimateMessage`:
 * 3 text blocks (`BLOCK_OVERHEAD = 4` each) + `ROLE_OVERHEAD = 4` + preamble/tags = 102 tokens.
 */
const FRAME_TOKENS = 102

/** Safety margin below the shrink guard, in tokens. */
const SHRINK_MARGIN_TOKENS = 512

/**
 * Share of the budget user prose may occupy before oldest-first truncation.
 *
 * Measured on a 122-turn session, every human message in the span totalled 3219
 * characters — 4% of the 80000-character ceiling — because 99.5% of user-message
 * characters are injected context, which the digest excludes. So user prose
 * should never be truncated for room; the share exists only to stop one pasted
 * file from consuming the whole digest. Reserving most of the budget for it
 * costs almost nothing and is what keeps an early constraint like "请用pixi管理
 * 开发环境" from being evicted by 131 extracted blocks.
 */
const USER_BUDGET_SHARE = 0.9

/** Tool names whose call arguments name a written path. */
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'apply_patch'])

/** Max parallel batch extraction calls in flight per compaction. */
const EXTRACT_CONCURRENCY = 4

/** Default per-call timeout (ms) for extraction and condensation LLM streams. */
const DEFAULT_LLM_CALL_TIMEOUT_MS = 90_000

/** In-memory cache bounds (FIFO/LRU eviction). */
const EXTRACTION_CACHE_MAX = 2000
const CONDENSED_CACHE_MAX = 200

/** Max characters kept per turn when extraction fails and prose falls back verbatim. */
const FALLBACK_PROSE_MAX_CHARS = 3000

/** Old (non-latest) user messages longer than this are head+tail clipped to prevent paste bloat. */
const OLD_USER_PASTE_MAX_CHARS = 2400

/** Recent trailing section count whose `## Answers` keep full verbose question stems. */
const FULL_ANSWER_STEM_RECENT_SECTIONS = 3

/** Max characters for historical `## Answers` question stems (user answers always stay verbatim). */
const OLD_ANSWER_STEM_MAX_CHARS = 180

/** Max length of a following user turn that counts as a short reply depending on prior `## Asked`. */
const SHORT_REPLY_MAX_CHARS = 80

/** Thresholds for supplementing single-turn tool-heavy (subagent/research) extraction with sampled tool results. */
const SINGLE_TURN_TOOL_HEAVY_CALLS = 10
const SINGLE_TURN_TOOL_HEAVY_PROSE_MAX = 1500
const SAMPLED_TOOL_RESULT_TOTAL_CHARS = 6000
const SAMPLED_TOOL_RESULT_PER_CALL_CHARS = 600

/** Thresholds and budgets for long/multi-step turns that need expanded extraction capacity. */
const LONG_TURN_TOOL_CALLS = 25
const LONG_TURN_ASSISTANT_MSGS = 8
const LONG_TURN_PROSE_CHARS = 10000
const LONG_TURN_PROSE_BUDGET = 16000
const LONG_TURN_PROSE_HEAD_CHARS = 3000
const LONG_TURN_PROSE_TAIL_CHARS = 6000
const LONG_TURN_MIN_MILESTONE_CHARS = 160

/** Short human continuation replies that keep the penultimate section's open tasks active. */
const SHORT_CONTINUATION_REPLY = /^(?:(?:继续|接着|往下|按计划|按这个|按上面|好|好的|可以|行|同意|确认|收到|开始|continue|proceed|go\s+on|keep\s+going|resume|yes|ok|okay|sure|y|\d+)(?:[，,、。！!\s]|$))/i
const SHORT_CONTINUATION_MAX_CHARS = 32

/** Budgets for subagent reports (`agent-message` / `subagent-settled`) fed to extraction. */
const SUBAGENT_REPORT_TOTAL_CHARS = 12000
const SUBAGENT_REPORT_PER_MSG_CHARS = 7000
const SUBAGENT_REPORT_MAX_COUNT = 12

/** Bounds for the active open-tasks block preserved at the tail of the digest. */
const MAX_ACTIVE_OPEN_TASKS = 16
const MAX_ACTIVE_TASK_LINE_CHARS = 240

/** Keep head and tail of overlong text so both opening context and final conclusions survive. */
function clipHeadTail(text: string, maxChars: number, headChars: number, tailChars: number): string {
  if (text.length <= maxChars) return text
  const omitted = text.length - headChars - tailChars
  if (omitted <= 0) return text
  return `${text.slice(0, headChars).trimEnd()}\n…(+${omitted} chars omitted)\n${text.slice(text.length - tailChars).trimStart()}`
}

/** The replayed prefix the base class hands to `summarize`. */
export interface SummarizationInput {
  /** Tool schemas reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly unknown[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the envelope the base class records with it. */
export interface SummaryResult {
  summary: ContentBlock[]
  provider: string
  model: string
  usage?: TokenUsage
}

/** The message an event derives to, or null when it derives to none. */
function messageOf(event: SessionEvent): Message | null {
  switch (event.type) {
    case 'user/message':
      return event.data as unknown as Message
    case 'assistant/message':
    case 'tool/result':
    case 'system/message':
    case 'developer/message':
      return (event.data as { message?: Message }).message ?? null
    default:
      return null
  }
}

/** Source kind of a user message, or undefined when it carries none. */
function sourceKind(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = (event.data as { source?: { kind?: string } }).source
  return source?.kind
}

/**
 * Whether this user message was injected by the host rather than typed.
 *
 * The rule is `kind !== 'user'` rather than a list of known producers: the
 * source union is merge-extensible, so a new plugin's kind must not silently
 * become "user prose the human wrote". Measured on one real session, injected
 * context is 97% of all user-message characters (161993 of 375 for
 * `agent-instructions` against the human's own 375), so a leaked kind would
 * swamp the digest.
 */
function isInjection(event: SessionEvent): boolean {
  const kind = sourceKind(event)
  if (kind === undefined) return false
  if (kind === 'goal') return false
  return kind !== 'user'
}

/**
 * The objective carried by a goal round, or undefined for any other message.
 *
 * A goal-triggered turn has no user message at all: the host injects a
 * `<goal_round>` carrying the objective it is working toward. Treating that as
 * ordinary injection dropped the only statement of why the turn existed — a real
 * 909-character, 7-item objective appeared nowhere in the digest, leaving an
 * assistant block with no task above it.
 *
 * Only the objective is kept. `Round: 3/256` is a counter, and the objective
 * repeats unchanged on every round, so the caller records it once.
 *
 * @param event - any event; non-goal events yield undefined.
 * @returns the objective text, or undefined.
 */
/** Whether a user/message event is a subagent relay or settled closing notice. */
function isSubagentReport(event: SessionEvent): boolean {
  const kind = sourceKind(event)
  return kind === 'agent-message' || kind === 'subagent-settled'
}

/** Sender session id recorded on a subagent relay/settled event, if present. */
function senderSessionIdOf(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = (event.data as { source?: { senderSessionId?: unknown } }).source
  return typeof source?.senderSessionId === 'string' && source.senderSessionId.length > 0
    ? source.senderSessionId
    : undefined
}

/** Auto-generated host continuation goals that restate the todo list rather than a user goal. */
const AUTO_CONTINUATION_GOAL = /^(?:Continue the \d+ open tasks? this session recorded:|Continue working on the current goal\b)/i

/** Extract the raw unescaped `Objective: "..."` string from a `goal` event, if present. */
function extractGoalRawObjective(event: SessionEvent): string | undefined {
  if (sourceKind(event) !== 'goal') return undefined
  const text = textOf(event)
  const match = /Objective:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  if (match === null) return undefined
  const raw = match[1] ?? ''
  let objective: string
  try {
    objective = String(JSON.parse(`"${raw}"`)).trim()
  } catch {
    objective = raw.replace(/\\([n"\\])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch)).trim()
  }
  return objective.length > 0 ? objective : undefined
}

function goalObjective(event: SessionEvent): string | undefined {
  const objective = extractGoalRawObjective(event)
  if (objective === undefined) return undefined
  if (AUTO_CONTINUATION_GOAL.test(objective)) return undefined
  return objective
}

/** One active unfinished task recovered from the latest `todo_write` or auto-continuation goal. */
export interface ActiveTask {
  status?: 'in_progress' | 'pending'
  content: string
}

/** Parse numbered/bulleted open task items carried inside an `AUTO_CONTINUATION_GOAL` event. */
function autoContinuationGoalTasks(event: SessionEvent): ActiveTask[] {
  const objective = extractGoalRawObjective(event)
  if (objective === undefined || !AUTO_CONTINUATION_GOAL.test(objective)) return []
  const lines = objective.split(/\r?\n/).slice(1)
  const tasks: ActiveTask[] = []
  for (const line of lines) {
    const cleaned = line
      .trim()
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^[-*•]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned.length > 0) tasks.push({ content: cleaned })
  }
  return tasks
}

/** Parse a `todo_write` tool call's arguments into its remaining unfinished tasks. */
function parseTodoWriteArgs(argumentsJson: string): { open: ActiveTask[]; valid: boolean } {
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (typeof parsed !== 'object' || parsed === null) return { open: [], valid: false }
    const todos = (parsed as { todos?: unknown }).todos
    if (!Array.isArray(todos)) return { open: [], valid: false }
    const open: ActiveTask[] = []
    for (const item of todos) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const status = typeof rec['status'] === 'string' ? rec['status'].trim().toLowerCase() : ''
      const content = typeof rec['content'] === 'string' ? rec['content'].replace(/\s+/g, ' ').trim() : ''
      if (content.length === 0) continue
      if (status === 'completed' || status === 'done' || status === 'cancelled') continue
      open.push({
        ...(status === 'in_progress'
          ? { status: 'in_progress' as const }
          : status === 'pending'
            ? { status: 'pending' as const }
            : {}),
        content,
      })
    }
    return { open, valid: true }
  } catch {
    return { open: [], valid: false }
  }
}

/** Whether this user message is a compaction checkpoint written by a backend. */
function isCheckpoint(event: SessionEvent): boolean {
  return sourceKind(event) === 'compact-checkpoint'
}

/** The visible text of a message, with reasoning excluded. */
function textOf(event: SessionEvent): string {
  const message = messageOf(event)
  if (message === null) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Every tool-call block of one message, in order. */
function toolCallsOf(event: SessionEvent): { id: string; name: string; arguments: string }[] {
  const message = messageOf(event)
  if (message === null) return []
  const calls: { id: string; name: string; arguments: string }[] = []
  for (const block of message.content) {
    if (block.type === 'tool-call') calls.push({ id: block.id, name: block.name, arguments: block.arguments })
  }
  return calls
}

/** One question the user answered through the question tool, with its answer. */
interface AnsweredQuestion {
  question: string
  /** Option labels offered by `ask_user_question`, used to dedupe paraphrased `## Asked`. */
  options: string[]
  /** The labels the user picked, in the order they were offered. */
  selected: string[]
  /** What the user typed instead of picking, when they did. */
  typed: string
}

interface QuestionSpec {
  question: string
  options: string[]
}

function optionLabelsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const labels: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (trimmed.length > 0) labels.push(trimmed)
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const label = (entry as Record<string, unknown>)['label']
    if (typeof label === 'string' && label.trim().length > 0) labels.push(label.trim())
  }
  return labels
}

/** The `questions[]` payload of an `ask_user_question` call, as `{id → {question, options}}`. */
function questionSpecsOf(argumentsJson: string): Map<string, QuestionSpec> {
  const out = new Map<string, QuestionSpec>()
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return out
  }
  if (typeof parsed !== 'object' || parsed === null) return out
  const questions = (parsed as Record<string, unknown>)['questions']
  if (!Array.isArray(questions)) return out
  for (const question of questions) {
    if (typeof question !== 'object' || question === null) continue
    const record = question as Record<string, unknown>
    const id = record['id']
    const text = typeof record['question'] === 'string' ? record['question'] : undefined
    if (typeof id === 'string' && text !== undefined) {
      out.set(id, { question: text, options: optionLabelsOf(record['options']) })
    }
  }
  return out
}

/**
 * Read one answer batch into per-question answers.
 *
 * The batch is `{answers:[{id, selected:[…], custom?}]}`, and it arrives two
 * ways: as the result of an answered `ask_user_question` call, and inside the
 * `user/message` the host writes when the user answers after the call already
 * returned its pending notice. Both carry the same shape, so both are read here.
 *
 * A typed answer arrives with `selected: []` and the text in `custom`. Ten of 31
 * real questions in one session were answered that way, and those carried the
 * user's actual observations rather than a menu label.
 *
 * @param text - the JSON body.
 * @param specs - question id to question text and option labels, from the call's arguments.
 * @returns one entry per answered question; empty when the body is not a batch.
 */
function answersOf(text: string, specs: ReadonlyMap<string, QuestionSpec>): AnsweredQuestion[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  // A late reply carries its own `questions` array beside the answers, so it does
  // not depend on the call still being in the same turn's events.
  const body = parsed as Record<string, unknown>
  const own = Array.isArray(body['questions']) ? body['questions'] : []
  const merged = new Map(specs)
  for (const question of own) {
    if (typeof question !== 'object' || question === null) continue
    const record = question as Record<string, unknown>
    const id = record['id']
    const text = record['question']
    if (typeof id === 'string' && typeof text === 'string') {
      const existing = merged.get(id)
      const options = optionLabelsOf(record['options'])
      merged.set(id, { question: text, options: options.length > 0 ? options : (existing?.options ?? []) })
    }
  }
  const answers = body['answers']
  if (!Array.isArray(answers)) return []
  const out: AnsweredQuestion[] = []
  for (const answer of answers) {
    if (typeof answer !== 'object' || answer === null) continue
    const record = answer as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'] : ''
    const spec = merged.get(id)
    if (spec === undefined) continue
    const selected = Array.isArray(record['selected'])
      ? record['selected'].map((value) => String(value)).filter((value) => value.length > 0)
      : []
    const typed = typeof record['custom'] === 'string' ? record['custom'].trim() : ''
    if (selected.length === 0 && typed.length === 0) continue
    out.push({ question: spec.question, options: spec.options, selected, typed })
  }
  return out
}

/**
 * Render one answered question as a digest line pair.
 *
 * @param answered - one question and the answer it got.
 * @returns the question line and, indented under it, the answer line.
 */
function renderAnswered(answered: AnsweredQuestion): string[] {
  const picked = [...answered.selected]
  if (answered.typed.length > 0) picked.push(answered.typed)
  return [
    `- ${answered.question.replace(/\s+/g, ' ').trim()}`,
    `  → ${picked.join(' / ').replace(/\s+/g, ' ').trim()}`,
  ]
}

/** Directive appended as the final user message of the extraction call. */
const EXTRACT_INSTRUCTION = [
  'Reply with ONE JSON object and nothing else. No prose, no code fence, no markdown.',
  'Shape: {"slots":[{"key":"<the slot key>","did":["…"],"concluded":["…"],"overturned":["…"],"asked":[{"question":"…","options":["…"]}]}]}',
  'Rules:',
  '- `key` must be copied exactly from the `=== SLOT <key> ===` line. One entry per slot, in the order given. Never skip a slot.',
  '- `did`: what was done (at most 2 short strings for a normal slot; up to 6–8 covering major phases for a LONG slot). `concluded`: findings, subagent audit conclusions, verification outcomes, and unresolved blockers a later turn needs (at most 2 for a normal slot; up to 6–8 for a LONG slot). `overturned`: earlier conclusions this turn disproved.',
  '- Each field is an array of short strings. Use [] for a field with nothing to say.',
  '- Never write a heading, a bullet, or a field name inside a string.',
  '- Never invent. If the material does not support a claim, leave the field empty.',
  // A question is not reliably the last paragraph: measured over 231 real turns
  // that drew a short reply, 34% had prose after it (p90 = 7 paragraphs, max 24).
  '- `asked`: one entry per question this turn put to the user and was still waiting on when it ended. A question is anywhere in the prose, not only the last paragraph.',
  // And the options are usually further up: in 26 of 231 turns was the list in the
  // question's own paragraph or the one before it.
  '- `options`: what the user could pick from, in order, one short line each, with their own numbering stripped. The list is often a paragraph or two above the question. Use [] when the question offered none.',
  // The reply is the next turn's `## user` line, already verbatim in the digest.
  // Asking for it here printed the same sentence twice.
  "- Use [] for `asked` when the turn asked nothing, when questions were already answered via `ask_user_question`, or when questions raised earlier were already resolved later in the same turn's prose. Do not report the user's reply.",
  '',
  'Write strings in the same language as the material. A session whose requests are Chinese gets Chinese text; do not switch to English.',
].join('\n')

/** Whether a parsed JSON value looks like an extraction slot payload (object with `slots[]` or array of keyed slots). */
function isSlotPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === 'object' && item !== null && 'key' in item)
  }
  return typeof value === 'object' && value !== null && Array.isArray((value as { slots?: unknown }).slots)
}

/** Extract the first balanced JSON object or array payload from a model reply that may carry prose or stray braces. */
function extractJsonPayload(raw: string): unknown {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    return JSON.parse(body)
  } catch {
    // Fall through to balanced scan.
  }
  const candidates: unknown[] = []
  for (let start = 0; start < body.length; start += 1) {
    const opener = body[start]
    if (opener !== '{' && opener !== '[') continue
    const closer = opener === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let end = start; end < body.length; end += 1) {
      const ch = body[end]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === opener) depth += 1
      else if (ch === closer) {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(body.slice(start, end + 1))
            if (isSlotPayload(parsed)) return parsed
            candidates.push(parsed)
            start = end
          } catch {
            // Do not skip past `end`: valid JSON may be nested inside invalid outer braces.
          }
          break
        }
      }
    }
  }
  return candidates[0]
}

/** Normalize model-drifted slot keys like `SLOT 0:0 (turn 1)` back to `0:0`. */
function normalizeSlotKey(raw: unknown): string {
  const str = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : ''
  return str
    .trim()
    .replace(/^SLOT\s+/i, '')
    .replace(/\s*\(turn\s+[^)]*\)\s*$/i, '')
    .trim()
}

/** One slot's extraction, as the model returns it. */
export interface Extraction {
  did: string[]
  concluded: string[]
  overturned: string[]
  /**
   * What this turn asked the user and what came back, when it asked anything.
   *
   * Written by the model rather than read off the log. The two cases the log
   * cannot cover are the reason:
   *
   *   - A question is often not in the last line. Over 231 real turns that drew a
   *     short reply, 34% had prose after the question (p90 = 7 paragraphs, max
   *     24) — a `## 需要你决定` block followed by `## 还没验证的`. The log records
   *     text, not which paragraph was the question.
   *   - A bare `1` is meaningless without the list it selects from, and that list
   *     is usually a paragraph or more above the question, under its own heading.
   *     Reading it out needs judgement about which list the question refers to.
   *
   * The model already reads the same prose to fill `did`/`concluded`, so this
   * costs one more field rather than another pass.
   */
  asked: AskedPair[]
}

/**
 * One question the assistant put to the user, with the options it offered.
 *
 * No `answer` field: the reply is the next section's `## user` line, already in the
 * digest verbatim. Carrying it here as well printed the same sentence twice.
 */
export interface AskedPair {
  /** The question, one line. */
  question: string
  /** The options as offered, each one line; empty when the question offered none. */
  options: string[]
}

/**
 * Parse the model's JSON reply into per-slot extractions.
 *
 * The reply used to be free-form markdown, which let a heading share a line with
 * its body — a real block read `… 重出 4 屏 Concluded Stitch 会回填真实车牌`, and no
 * post-hoc regex can decide where that sentence ends and the next heading begins.
 * Fields remove the ambiguity: the renderer owns every heading and bullet.
 *
 * @param answer - the model's raw reply.
 * @returns extractions by slot key; empty when the reply is not usable JSON.
 */
export function parseExtraction(answer: string): Map<string, Extraction> {
  const out = new Map<string, Extraction>()
  const parsed = extractJsonPayload(answer)
  if (typeof parsed !== 'object' || parsed === null) return out
  const slots = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown>)['slots']
  if (!Array.isArray(slots)) return out
  const strings = (value: unknown): string[] => {
    const rawList = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? [value]
        : []
    return rawList
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .filter((item) => item.length > 0)
      // A field is a list, so "nothing here" is an empty list. Models still write a
      // placeholder often enough that dropping it is worth one test.
      .filter((item) => !/^(?:\(?none\)?|n\/a|na|-{1,2}|无|沒有|没有|暂无|无变更|无推翻|未发现)[。.！!]*$/i.test(item))
      .filter((item) => !/^(?:未提问|无提问|没有提问|no questions? (?:were |was )?asked|none asked)[。.！!]*$/i.test(item))
  }
  // Asked is a list of objects, not of strings: a question without its options
  // turns the user's `1` into a number that selects nothing.
  const pairs = (value: unknown): AskedPair[] => (Array.isArray(value)
    ? value
      .flatMap((item): AskedPair[] => {
        if (typeof item !== 'object' || item === null) return []
        const record = item as Record<string, unknown>
        const question = typeof record['question'] === 'string'
          ? record['question'].replace(/\s+/g, ' ').trim()
          : ''
        if (question.length === 0) return []
        const options = Array.isArray(record['options'])
          ? record['options']
            .filter((option): option is string => typeof option === 'string')
            // The renderer supplies the numbering, so a model that echoes the source
            // list's own `1.` / `(1)` / `A.` would print double prefixes.
            .map((option) => option
              .replace(/\s+/g, ' ')
              .replace(/^\s*(?:(?:\d{1,2}|[A-Za-z])\s*[.、:：)]\s*|[（(]\s*(?:\d{1,2}|[A-Za-z])\s*[)）]\s*)/, '')
              .trim())
            .filter((option) => option.length > 0)
          : []
        return [{ question, options }]
      })
    : [])
  for (const slot of slots) {
    if (typeof slot !== 'object' || slot === null) continue
    const record = slot as Record<string, unknown>
    const key = normalizeSlotKey(record['key'])
    if (key.length === 0) continue
    out.set(key, {
      did: strings(record['did']),
      concluded: strings(record['concluded']),
      overturned: strings(record['overturned']),
      asked: pairs(record['asked']),
    })
  }
  return out
}

/**
 * Render one extraction as the digest block, headings included.
 *
 * @param extraction - the fields for one slot.
 * @param level - graded retention level (3..0).
 * @param includeAsked - whether to render the `## Asked` section (false for stale historical turns).
 * @returns markdown with a heading per non-empty field; empty string when every
 * field is empty.
 */
export function renderExtractionBlock(
  extraction: Extraction | undefined,
  level: number = 3,
  includeAsked: boolean = true,
): string {
  if (extraction === undefined) return ''
  const lines: string[] = []
  const section = (heading: string, items: readonly string[] | undefined): void => {
    if (items === undefined || items.length === 0) return
    lines.push(`## ${heading}`, ...items.map((item) => `- ${item}`))
  }
  if (level >= 1) section('Did', extraction.did)
  if (level >= 2) section('Concluded', extraction.concluded)
  if (level >= 3) section('Overturned', extraction.overturned)
  // Asked goes last and its options are listed under it, so the user's reply — the
  // next `## user` line — lands directly under the list it chose from.
  if (includeAsked && extraction.asked.length > 0) {
    lines.push('## Asked')
    for (const pair of extraction.asked) {
      lines.push(`- ${pair.question}`)
      for (const [index, option] of pair.options.entries()) {
        lines.push(`  ${index + 1}. ${option}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * The group starts a fold walk visits, oldest first, one entry per group.
 *
 * Extracted so the walk's bounds are testable without a session, a logger and a
 * model: the walk itself was where two defects lived — a bound that skipped the
 * last group, and a start advanced from the success count, which retried a failed
 * group on every pass.
 *
 * @param sectionCount - how many sections the digest has.
 * @returns the start index of each group, in order.
 */
export function foldGroupStarts(sectionCount: number): number[] {
  const starts: number[] = []
  for (let start = 0; start < sectionCount; start += CONDENSE_GROUP) starts.push(start)
  return starts
}

/**
 * A folded-up summary of a run of consecutive sections, keyed by the `turnKey` of
 * the first section it covers. The key's second component is always 0: a fold
 * starts at a section boundary, never mid-section.
 *
 * Produced when the plain digest overflows: the oldest turns are handed to the
 * model together and replaced by one paragraph. Deleting those turns instead —
 * what the budget walk used to do — loses what they established, while folding
 * keeps a statement of it in a fraction of the room.
 */
export interface Condensed {
  /** The folded text, already in the digest's own wording. */
  text: string
  /**
   * How many sections this block stands in for, counting from the key's own
   * section.
   *
   * Sections, not turns: `buildSections` opens one section per user request, so a
   * run of consecutive requests is a run of consecutive sections. Counting turns
   * would cover only the first section and leave the rest rendering their own
   * blocks — the fold bought nothing.
   */
  covers: number
}

/** Turns handed to one extraction call. */
const TURNS_PER_CALL = 8

/**
 * Sections folded into one condensed block when the digest overflows.
 *
 * Lowered from 100 to 30 so real long sessions (30–80 turns) fold oldest runs
 * instead of falling straight into destructive body eviction.
 */
export const CONDENSE_GROUP = 30

/**
 * Output tokens allowed for one condensation call.
 *
 * A condensed block stands in for `CONDENSE_GROUP` sections, so it has to be far
 * smaller than what it replaces to buy any room at all. Measured on 12000
 * characters of real digest: the answer ran 565 tokens and produced 987
 * characters, 8.2% of the input.
 *
 * The cap is far above that answer because thinking is charged to the same
 * budget and is not small: the same call spent 1873 tokens thinking. At a 1200
 * cap it returned an empty string in one run out of one — the thinking block
 * took the whole allowance, the same failure the extraction call had.
 */
const CONDENSE_TOKENS = 6000

const CONDENSE_INSTRUCTION = [
  'The text above is the digest of a run of already-finished turns from a coding session.',
  'Fold it into one short paragraph that a later turn can read to know what that stretch established.',
  'Keep: decisions still in force, constraints that still apply, conclusions a later turn would otherwise redo, and anything later turns disproved.',
  'Drop: per-turn narration, restatements, and detail already superseded by later turns in the same run.',
  'Reply with the paragraph and nothing else. No heading, no bullets, no code fence, no preamble.',
  'Write in the same language as the material.',
].join('\n')

/**
 * Output tokens allowed per turn in an extraction call.
 *
 * Raised from 220 when `asked` was added. The model thinks before it answers and
 * thinking is charged to the same `maxTokens`, so the answer's own budget has to
 * cover both. Measured on real 8-slot batches: thinking alone ran 1057–4086
 * tokens, and a cap of `220 x 8 + 1000` cut one run off mid-JSON, which parsed to
 * zero slots and lost the whole batch. `900` per slot plus the reserve below
 * parsed 8 of 8 on every attempt.
 */
const EXTRACT_TOKENS_PER_TURN = 900

/** Output tokens allowed for one expanded/long multi-step slot. */
const EXTRACT_TOKENS_PER_LONG_TURN = 2200

/**
 * Fixed thinking reserve added to every extraction call's `maxTokens`.
 *
 * `maxTokens` covers thinking and the answer together, and thinking is a
 * per-call cost that does not shrink with the batch. Measured on the live route
 * with real-length material: one slot at `220 x 1` with no reserve returned zero
 * parseable slots in 4 of 4 runs, while `220 x 1 + 1000` parsed in 4 of 4. See
 * `extractOnce` for the effort half of the same problem, and for why the reserve
 * is the fix rather than an `off` effort.
 */
const EXTRACT_THINKING_RESERVE_TOKENS = 1000

/** Most tool calls one turn may contribute to the hint block. */
const MAX_HINTS_PER_TURN = 120

/** Characters kept from one call's description or command head. */
const HINT_CHARS = 100

/**
 * The best short description of what one call was for.
 *
 * The description argument wins when present because the agent writes it for
 * humans; the command body is the fallback and is truncated hard, since a single
 * `python3 -c` can be hundreds of lines.
 */
function hintOf(argumentsJson: string): string {
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(argumentsJson)
    if (typeof value !== 'object' || value === null) return ''
    parsed = value as Record<string, unknown>
  } catch {
    return ''
  }
  for (const key of ['description', 'command', 'query', 'file_path', 'path', 'pattern']) {
    const candidate = parsed[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim().replace(/\s+/g, ' ').slice(0, HINT_CHARS)
    }
  }
  return ''
}

/**
 * Build the compact per-turn trace fed to the summarizer.
 *
 * This is what lets a turn whose assistant prose is empty still leave a record:
 * in the measured session one turn ran 342 tool calls and emitted zero prose, so
 * the verbatim digest reduced it to a single `tools:` count line. The trace names
 * what was attempted, which is enough for a model to state the outcome.
 *
 * Tool results are not read. Their only contribution used to be a first-line
 * error string, and that string was never the part of a failure that mattered.
 *
 * Bounded on purpose — 500 calls would otherwise produce a prompt larger than the
 * material it summarizes.
 *
 * @param events - one turn's events, in log order.
 * @returns newline-joined hints, or an empty string when the turn has none.
 */
export function collectHints(events: readonly SessionEvent[]): string {
  const all: string[] = []
  for (const event of events) {
    // Tool calls are blocks inside `assistant/message`, not standalone events:
    // `digestSource` emits no `tool/call` type at all, so selecting on that type
    // matched nothing and a 342-call turn produced a single hint line.
    if (event.type !== 'assistant/message') continue
    for (const call of toolCallsOf(event)) {
      // A question is not a hint. It and its answer are rendered from the log by
      // `renderAnswers`, so listing it here as well only invited the model to
      // restate it in `asked` — the same exchange printed twice, once of them
      // paraphrased.
      if (call.name === 'ask_user_question') continue
      const hint = hintOf(call.arguments)
      all.push(hint.length > 0 ? `TOOL ${call.name}: ${hint}` : `TOOL ${call.name}`)
    }
  }
  if (all.length <= MAX_HINTS_PER_TURN) return all.join('\n')
  const headCount = 45
  const tailCount = MAX_HINTS_PER_TURN - headCount - 1
  const omitted = all.length - headCount - tailCount
  return [
    ...all.slice(0, headCount),
    `…(+${omitted} tool calls omitted)`,
    ...all.slice(all.length - tailCount),
  ].join('\n')
}

/** Extract target file paths from write/edit/multiedit/apply_patch tool calls. */
function writePathsOf(toolName: string, argumentsJson: string): string[] {
  const paths: string[] = []
  const add = (candidate: unknown): void => {
    if (typeof candidate !== 'string') return
    const trimmed = candidate.trim()
    if (trimmed.length > 0 && !paths.includes(trimmed)) paths.push(trimmed)
  }
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (typeof parsed !== 'object' || parsed === null) return paths
    const record = parsed as Record<string, unknown>
    add(record['file_path'])
    add(record['path'])
    if (toolName === 'apply_patch') {
      const patchText = typeof record['input'] === 'string'
        ? record['input']
        : typeof record['patch'] === 'string'
          ? record['patch']
          : ''
      for (const match of patchText.matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$|^\*\*\*\s+Move to:\s*(.+)$/gm)) {
        add(match[1] ?? match[2])
      }
    }
  } catch {
    return paths
  }
  return paths
}

/** One turn's accumulated digest material. */
interface Turn {
  turn: number | undefined
  /**
   * True when a human request opened this turn, false when a `goal` objective did.
   *
   * Both fill the `user` slot, so `user.length > 0` cannot tell them apart — and
   * the difference decides which turn is kept when the budget is too small to
   * hold the digest: dropping the newest human request loses what the next turn
   * is answering, while dropping a goal round only loses a restated objective.
   */
  fromRequest: boolean
  user: string[]
  assistant: string[]
  writes: string[]
  /**
   * Questions this turn put to the user through `ask_user_question`, with the
   * answers they got.
   *
   * Read from the log rather than asked of the model, and rendered as its own
   * `## Answers` section. The model's `asked` field covers questions written in
   * prose; a question asked through the tool is answered in the tool's own picker,
   * and that answer is the tool result. Measured on one real session: three such
   * questions were answered inside the picker and no `user/message` was written at
   * all, so both the question and the choice were absent from two consecutive
   * checkpoints.
   */
  answered: AnsweredQuestion[]
  /**
   * The extracted summary for this turn, when extraction succeeded.
   *
   * Set here rather than appended to a separate block so the extraction takes
   * the assistant prose's place in the digest: keeping both duplicated the same
   * content and pushed the prose out through the budget.
   */
  extracted?: Extraction
}

/** One digest section: everything from one non-injected user message to the next. */
interface Section {
  turns: Turn[]
}

/** The turn number an event belongs to, when the log records one. */
function turnOf(event: SessionEvent): number | undefined {
  const turn = (event.data as { turn?: unknown }).turn
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : undefined
}

/** A fresh, empty turn accumulator. */
function emptyTurn(turn: number | undefined, fromRequest: boolean = false): Turn {
  return { turn, fromRequest, user: [], assistant: [], writes: [], answered: [] }
}

/**
 * Single source of truth for partitioning log events into sections alongside each
 * section's exact slice of raw events, so rendering and extraction can never drift
 * off by one section.
 */
function buildSectionsWithEvents(events: readonly SessionEvent[]): {
  sections: Section[]
  sectionEvents: SessionEvent[][]
} {
  const sections: Section[] = []
  const sectionEvents: SessionEvent[][] = []
  let current: Section | undefined
  let currentEvents: SessionEvent[] | undefined
  let currentTurn: Turn | undefined
  let lastTurn: number | undefined

  const startSection = (): void => {
    current = { turns: [] }
    currentEvents = []
    sections.push(current)
    sectionEvents.push(currentEvents)
  }

  const openTurn = (turn: number | undefined, fromRequest: boolean = false): Turn => {
    if (current === undefined) startSection()
    const next = emptyTurn(turn, fromRequest)
    current!.turns.push(next)
    if (turn !== undefined) lastTurn = turn
    return next
  }

  const recordedObjectives = new Set<string>()
  const questionSpecs = new Map<string, QuestionSpec>()
  const questionCallIds = new Set<string>()

  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = turnOf(event)
      if (turn !== undefined) lastTurn = turn
      currentEvents?.push(event)
      continue
    }
    if (sourceKind(event) === 'goal') {
      const objective = goalObjective(event)
      if (objective === undefined || recordedObjectives.has(objective)) {
        // Auto todo-continuation goals never penetrate into human `## user`
        // sections, but are still kept in `currentEvents` so the trailing
        // active open-tasks state can be recovered when mid-turn compaction
        // shadows the live todo list.
        if (autoContinuationGoalTasks(event).length > 0) {
          currentEvents?.push(event)
        }
        continue
      }
      recordedObjectives.add(objective)
      startSection()
      currentTurn = openTurn(turnOf(event) ?? lastTurn, false)
      currentTurn.user.push(objective)
      currentEvents!.push(event)
      continue
    }
    if (event.type === 'tool/result') {
      currentEvents?.push(event)
      const callId = (messageOf(event) as { toolCallId?: string } | null)?.toolCallId
      if (callId === undefined || !questionCallIds.has(callId) || currentTurn === undefined) continue
      currentTurn.answered.push(...answersOf(textOf(event), questionSpecs))
      continue
    }
    if (sourceKind(event) === 'user-question-reply') {
      currentEvents?.push(event)
      if (currentTurn !== undefined) currentTurn.answered.push(...answersOf(textOf(event), questionSpecs))
      continue
    }
    if (isSubagentReport(event)) {
      currentEvents?.push(event)
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (isInjection(event) || isCheckpoint(event)) continue

    const eventTurn = turnOf(event) ?? lastTurn
    if (event.type === 'user/message') {
      startSection()
      currentTurn = openTurn(eventTurn, true)
      const text = textOf(event)
      if (text.length > 0) currentTurn.user.push(text)
      currentEvents!.push(event)
      continue
    }
    if (currentTurn === undefined) currentTurn = openTurn(eventTurn ?? lastTurn)
    currentEvents?.push(event)
    const text = textOf(event)
    if (text.length > 0) currentTurn.assistant.push(text)
    for (const call of toolCallsOf(event)) {
      if (call.name === 'ask_user_question') {
        for (const [id, spec] of questionSpecsOf(call.arguments)) questionSpecs.set(id, spec)
        questionCallIds.add(call.id)
        continue
      }
      if (!WRITE_TOOLS.has(call.name)) continue
      for (const path of writePathsOf(call.name, call.arguments)) {
        if (!currentTurn.writes.includes(path)) currentTurn.writes.push(path)
      }
    }
  }
  return { sections, sectionEvents }
}

/**
 * Group append-origin surface events into per-turn digest material.
 *
 * @param events - the digest source in log order.
 * @returns one section per non-injected user message.
 */
export function buildSections(events: readonly SessionEvent[]): Section[] {
  return buildSectionsWithEvents(events).sections
}

/**
 * Attach extracted blocks to the turns they belong to.
 *
 * Keyed by turn number, with `undefined` covering a log that carries no
 * `turn/start` markers. A turn with no entry keeps its prose, which is the
 * fallback path when extraction is unavailable.
 *
 * @param sections - sections built from the digest source.
 * @param extracted - turn number to extracted block.
 * @returns the same sections with `extracted` set where available.
 */
function withExtractions(
  sections: readonly Section[],
  extracted: ReadonlyMap<string, Extraction>,
): Section[] {
  return sections.map((section, sectionIndex) => ({
    turns: section.turns.map((turn, turnIndex) => {
      const block = extracted.get(turnKey(sectionIndex, turnIndex))
      return block === undefined ? turn : { ...turn, extracted: block }
    }),
  }))
}

/**
 * Position-based key for one turn: `<section index>:<turn index>`.
 *
 * Not the turn number. `turn/start` is emitted per step in some sessions and only
 * once in others, so the number in the log is neither unique nor one-per-request.
 * A real session carried 2 user requests under a single `turn/start` (turn 1), so
 * both sections were keyed `1`; the second extraction overwrote the first, and
 * the digest printed the same block twice — once under a request about source
 * refresh, once under 「模拟器使用硬件加速！」.
 */
function turnKey(sectionIndex: number, turnIndex: number): string {
  return `${sectionIndex}:${turnIndex}`
}

/**
 * A stable hex digest of one string, used as a cache key.
 *
 * FNV-1a, 32-bit, two seeds. Not cryptographic: the risk here is an accidental
 * collision between two inputs, and 64 bits over a few hundred entries makes that
 * vanishingly unlikely.
 *
 * @param input - the text to hash.
 * @returns a stable hex key.
 */
function hashText(input: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${a.toString(16)}${b.toString(16)}`
}

/**
 * Cache key for one slot's extraction material: a hash of everything the model
 * would be shown.
 *
 * The material, not the slot's position or turn number: positions shift as
 * history grows and numbers repeat, but identical material must produce an
 * identical extraction. Hashing the exact string `buildExtractionMaterial` returns
 * means a change anywhere in the user request, the prose, or the tool trace
 * invalidates the entry — nothing can silently go stale.
 *
 * @param events - one slot's events, in log order.
 * @returns a stable hex key.
 */
function materialKey(
  events: readonly SessionEvent[],
  options?: { includeToolResults?: boolean; expanded?: boolean },
): string {
  const prose = events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => textOf(event))
    .filter((text) => text.length > 0)
    .join('\n')
  return hashText(buildExtractionMaterial(events, prose, options))
}

/**
 * Render one section to digest text, truncating assistant prose to `capChars`.
 *
 * When the turn carries an extraction, that extraction *replaces* the assistant
 * prose. Keeping both was the duplication this design removes: 58.2% of
 * assistant characters are substantive conclusions that the extraction restates,
 * and the doubled copy pushed real history out through the budget.
 *
 * The tool pointer line stays either way: it is one line, and it is the only
 * record of what was actually run when the prose and extraction both say little.
 */
/** Generic Chinese/English question boilerplate excluded from token-overlap dedupe. */
const QUESTION_STOP_TOKENS = new Set([
  '是否', '要不要', '怎么', '如何', '哪个', '哪种', '哪一', '哪些', '什么', '还是', '或者', '以及',
  '一下', '一起', '一并', '继续', '现在', '需要', '可以', '应该', '确认', '决定', '选择', '处理',
  '修改', '改动', '保留', '不动', '直接', '如果', '那么', '这个', '那个', '这两', '两项', '两处',
  '三处', '四处', '用户', '拍板', '我们', '你们', '他们', '已经', '不要', '不行',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'should', 'would', 'which', 'what', 'how',
  'are', 'you', 'can', 'not', 'use', 'into', 'about', 'want', 'keep', 'change', 'yes', 'no',
])

function stripRecommendationTag(text: string): string {
  return text.replace(/[（(]\s*(?:推荐|recommended)\s*[）)]/gi, '')
}

/** Normalize a question or option string for fuzzy duplicate comparison between Answers and Asked. */
function normalizeQuestionText(text: string): string {
  return stripRecommendationTag(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** Extract substantive ASCII words and CJK bigrams for cross-question paraphrase matching. */
function extractQuestionTokens(text: string): Set<string> {
  const lower = stripRecommendationTag(text).toLowerCase()
  const tokens = new Set<string>()
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) {
    const token = match[0]
    if (!QUESTION_STOP_TOKENS.has(token)) tokens.add(token)
  }
  for (const match of lower.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0]
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!QUESTION_STOP_TOKENS.has(bigram)) tokens.add(bigram)
    }
  }
  return tokens
}

function tokenOverlapCount(source: ReadonlySet<string>, target: ReadonlySet<string>): number {
  let hits = 0
  for (const token of source) {
    if (target.has(token)) hits += 1
  }
  return hits
}

interface OptionMatchTarget {
  norm: string
  tokens: Set<string>
}

function toOptionMatchTarget(text: string): OptionMatchTarget {
  return {
    norm: normalizeQuestionText(text),
    tokens: extractQuestionTokens(text),
  }
}

function optionMatchesTarget(candidate: OptionMatchTarget, target: OptionMatchTarget): boolean {
  if (
    candidate.norm.length >= 5
    && target.norm.length >= 5
    && (target.norm.includes(candidate.norm) || candidate.norm.includes(target.norm))
  ) {
    return true
  }
  if (candidate.tokens.size >= 3 && target.tokens.size >= 3) {
    const hits = tokenOverlapCount(candidate.tokens, target.tokens)
    if (hits >= 3 && hits / candidate.tokens.size >= 0.6) return true
  }
  return false
}

/** Drop `asked` entries that duplicate or paraphrase questions already answered via `ask_user_question` in the same turn. */
function dedupeAskedAgainstAnswers(extraction: Extraction, answered: readonly AnsweredQuestion[]): Extraction {
  if (answered.length === 0 || extraction.asked.length === 0) return extraction
  const answeredNorms = answered.map((item) => normalizeQuestionText(item.question)).filter((q) => q.length > 0)
  if (answeredNorms.length === 0) return extraction

  // Combined question + answer token corpus catches merged paraphrases across multiple
  // answered questions; unselected options stay out of this corpus so a later follow-up
  // prose question sharing a domain noun does not cross-bleed.
  const corpusTokens = new Set<string>()
  const answerTargets: OptionMatchTarget[] = []
  const offeredTargets: OptionMatchTarget[] = []
  for (const item of answered) {
    for (const token of extractQuestionTokens(item.question)) corpusTokens.add(token)
    for (const selected of item.selected) {
      for (const token of extractQuestionTokens(selected)) corpusTokens.add(token)
      const target = toOptionMatchTarget(selected)
      if (target.norm.length >= 5 || target.tokens.size >= 3) answerTargets.push(target)
    }
    if (item.typed.length > 0) {
      for (const token of extractQuestionTokens(item.typed)) corpusTokens.add(token)
      const target = toOptionMatchTarget(item.typed)
      if (target.norm.length >= 5 || target.tokens.size >= 3) answerTargets.push(target)
    }
    for (const opt of item.options) {
      const target = toOptionMatchTarget(opt)
      if (target.norm.length >= 5 || target.tokens.size >= 3) offeredTargets.push(target)
    }
  }

  const filtered = extraction.asked.filter((pair) => {
    const q = normalizeQuestionText(pair.question)
    if (q.length === 0) return true
    if (answeredNorms.some((ans) => (
      ans === q
      || (q.length >= 4 && ans.length >= 4 && (ans.includes(q) || q.includes(ans)))
    ))) {
      return false
    }
    const qTokens = extractQuestionTokens(pair.question)
    if (qTokens.size > 0 && corpusTokens.size > 0) {
      const hits = tokenOverlapCount(qTokens, corpusTokens)
      const ratio = hits / qTokens.size
      if ((hits >= 3 && ratio >= 0.4) || (hits >= 5 && ratio >= 0.35)) return false
    }
    if (pair.options.length > 0 && (answerTargets.length > 0 || offeredTargets.length > 0)) {
      const matchedOfferedIndices = new Set<number>()
      for (const opt of pair.options) {
        const candidate = toOptionMatchTarget(opt)
        if (answerTargets.some((target) => optionMatchesTarget(candidate, target))) return false
        for (let i = 0; i < offeredTargets.length; i += 1) {
          if (optionMatchesTarget(candidate, offeredTargets[i]!)) {
            matchedOfferedIndices.add(i)
            break
          }
        }
      }
      if (matchedOfferedIndices.size >= 2) return false
    }
    return true
  })
  return filtered.length === extraction.asked.length ? extraction : { ...extraction, asked: filtered }
}

/** Whether a section's `## Asked` should survive into the digest. */
function shouldKeepAsked(sections: readonly Section[], sectionIndex: number): boolean {
  const isLast = sectionIndex === sections.length - 1
  if (isLast) return true
  const nextUser = sections[sectionIndex + 1]?.turns[0]?.user.join('\n').trim() ?? ''
  return nextUser.length > 0 && nextUser.length <= SHORT_REPLY_MAX_CHARS
}

/** Index of the latest section carrying a real user request, falling back to the final section. */
function lastRealUserSectionIndex(sections: readonly Section[]): number {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i]?.turns.some((turn) => turn.fromRequest && turn.user.length > 0)) return i
  }
  return sections.length - 1
}

/** Keep the latest section and the latest real user request unclipped; clip oversized pastes in older sections. */
function shouldKeepFullUser(sections: readonly Section[] | undefined, sectionIndex: number): boolean {
  if (sections === undefined) return true
  if (sectionIndex === sections.length - 1) return true
  return sectionIndex === lastRealUserSectionIndex(sections)
}

/** Format a turn's user prose, clipping oversized pastes in older (non-latest) sections. */
function formatUserText(texts: readonly string[], keepFullUser: boolean): string {
  if (keepFullUser) return texts.join('\n')
  return texts
    .map((text) => clipHeadTail(text, OLD_USER_PASTE_MAX_CHARS, 1400, 800))
    .join('\n')
}

/** Extract active unfinished tasks from the trailing section's latest `todo_write` or auto-continuation goal. */
export function extractActiveOpenTasks(
  sections: readonly Section[],
  sectionEvents: readonly (readonly SessionEvent[])[],
): ActiveTask[] {
  if (sections.length === 0) return []

  const extractFromEvents = (events: readonly SessionEvent[]): { found: boolean; tasks: ActiveTask[] } => {
    const failedCallIds = new Set<string>()
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      const msg = messageOf(event) as { toolCallId?: string; isError?: boolean } | null
      if (msg?.isError === true && typeof msg.toolCallId === 'string') {
        failedCallIds.add(msg.toolCallId)
      }
    }
    let foundTodo = false
    let latestTodo: ActiveTask[] = []
    let latestGoalTasks: ActiveTask[] = []
    for (const event of events) {
      if (event.type === 'assistant/message') {
        for (const call of toolCallsOf(event)) {
          if (call.name !== 'todo_write' || failedCallIds.has(call.id)) continue
          const parsed = parseTodoWriteArgs(call.arguments)
          if (parsed.valid) {
            foundTodo = true
            latestTodo = parsed.open
          }
        }
        continue
      }
      if (sourceKind(event) === 'goal') {
        const goalTasks = autoContinuationGoalTasks(event)
        if (goalTasks.length > 0) {
          latestGoalTasks = goalTasks
        }
      }
    }
    // `todo_write` is the authoritative ground truth (carries `completed` status
    // updates), whereas `<goal_round>` auto-continuation text can repeat a stale
    // snapshot across rounds. Fall back to auto-goal tasks only when no valid
    // `todo_write` occurred in the section.
    if (foundTodo) return { found: true, tasks: latestTodo }
    if (latestGoalTasks.length > 0) return { found: true, tasks: latestGoalTasks }
    return { found: false, tasks: [] }
  }

  const lastIdx = sections.length - 1
  let result = extractFromEvents(sectionEvents[lastIdx] ?? [])

  // If the trailing section is a short human continuation ("继续", "好的", "continue")
  // with no todo update of its own, inherit the penultimate section's latest open tasks.
  if (!result.found && lastIdx >= 1) {
    const lastTurn = sections[lastIdx]?.turns[0]
    const lastUserText = lastTurn?.user.join('\n').trim() ?? ''
    if (
      lastTurn?.fromRequest === true
      && lastUserText.length > 0
      && lastUserText.length <= SHORT_CONTINUATION_MAX_CHARS
      && SHORT_CONTINUATION_REPLY.test(lastUserText)
    ) {
      result = extractFromEvents(sectionEvents[lastIdx - 1] ?? [])
    }
  }

  if (!result.found || result.tasks.length === 0) return []

  const deduped: ActiveTask[] = []
  const seen = new Set<string>()
  for (const task of result.tasks) {
    const norm = task.content.toLowerCase()
    if (seen.has(norm)) continue
    seen.add(norm)
    deduped.push(task)
    if (deduped.length >= MAX_ACTIVE_OPEN_TASKS) break
  }
  return deduped
}

function renderOpenTasks(tasks: readonly ActiveTask[]): string {
  if (tasks.length === 0) return ''
  const lines = ['## Open Tasks']
  for (const task of tasks) {
    const prefix = task.status !== undefined ? `[${task.status}] ` : ''
    const content = task.content.length > MAX_ACTIVE_TASK_LINE_CHARS
      ? `${task.content.slice(0, MAX_ACTIVE_TASK_LINE_CHARS).trimEnd()}…`
      : task.content
    lines.push(`- ${prefix}${content}`)
  }
  return lines.join('\n')
}

function renderSection(
  section: Section,
  level: number,
  condensed: ReadonlyMap<string, Condensed> | undefined,
  sectionIndex: number,
  allSections?: readonly Section[],
  openTasksBlock?: string,
): string {
  const lines: string[] = []
  const index = sectionIndex ?? 0
  const totalSections = allSections?.length ?? (index + 1)
  const isFinalSection = index === totalSections - 1
  const activeOpenTasks = isFinalSection && level >= 1 && openTasksBlock !== undefined && openTasksBlock.length > 0
    ? openTasksBlock
    : ''
  const keepFullUser = shouldKeepFullUser(allSections, index)
  const compactAnswerStem = index < totalSections - FULL_ANSWER_STEM_RECENT_SECTIONS
  const keepAsked = allSections === undefined ? true : shouldKeepAsked(allSections, index)

  let covering: { key: string, block: Condensed } | undefined
  if (condensed !== undefined) {
    for (const [key, block] of condensed) {
      const start = Number(key.split(':')[0])
      if (index >= start && index < start + block.covers) {
        covering = { key, block }
        break
      }
    }
  }
  if (covering !== undefined) {
    const start = Number(covering.key.split(':')[0])
    for (const turn of section.turns) {
      if (turn.user.length > 0) lines.push(`\n## user\n${formatUserText(turn.user, keepFullUser)}`)
    }
    if (index === start) {
      const range = covering.block.covers <= 1
        ? `section ${start + 1}`
        : `sections ${start + 1}-${start + covering.block.covers}`
      lines.push(`\n### assistant\n## Condensed (condensed from ${range})\n- ${covering.block.text}`)
    }
    if (activeOpenTasks.length > 0) lines.push(activeOpenTasks)
    return lines.join('\n')
  }
  for (const [turnIndex, turn] of section.turns.entries()) {
    const turnOpenTasks = turnIndex === section.turns.length - 1 ? activeOpenTasks : ''
    if (turn.user.length > 0) lines.push(`\n## user\n${formatUserText(turn.user, keepFullUser)}`)
    const effectiveExtraction = turn.extracted === undefined
      ? undefined
      : dedupeAskedAgainstAnswers(turn.extracted, turn.answered)
    const renderedBlock = renderExtractionBlock(effectiveExtraction, level, keepAsked)
    if (effectiveExtraction !== undefined && renderedBlock.length > 0) {
      const trailer: string[] = []
      if (turn.writes.length > 0) trailer.push(`  wrote: ${turn.writes.join(', ')}`)
      const withAnswers = insertAnswers(renderedBlock, renderAnswers(turn, compactAnswerStem))
      const withTasks = insertAnswers(withAnswers, turnOpenTasks)
      const body = trailer.length > 0 ? `${trailer.join('\n')}\n${withTasks}` : withTasks
      lines.push(`### assistant\n${body}`)
    } else if (
      turn.extracted !== undefined
      && (turn.extracted.did.length > 0
        || turn.extracted.concluded.length > 0
        || turn.extracted.overturned.length > 0
        || turn.extracted.asked.length > 0)
    ) {
      // Extraction succeeded with non-empty fields, and everything was filtered at this
      // level or dropped as stale Asked. Emit answers/writes if present without falling
      // back to raw prose.
      const trailer: string[] = []
      if (turn.writes.length > 0) trailer.push(`  wrote: ${turn.writes.join(', ')}`)
      const answers = renderAnswers(turn, compactAnswerStem)
      const parts = [...trailer, answers, turnOpenTasks].filter((part) => part.length > 0)
      if (parts.length > 0) lines.push(`### assistant\n${parts.join('\n')}`)
    } else {
      const rawBody = turn.assistant.join('\n')
      const body = clipHeadTail(rawBody, FALLBACK_PROSE_MAX_CHARS, 1000, 1800)
      const answers = renderAnswers(turn, compactAnswerStem)
      const parts = [body, answers, turnOpenTasks].filter((part) => part.length > 0)
      if (parts.length > 0) lines.push(`### assistant\n${parts.join('\n')}`)
      if (turn.writes.length > 0) lines.push(`  wrote: ${turn.writes.join(', ')}`)
    }
  }
  return lines.join('\n')
}

function renderAnswers(turn: Turn, compactStem: boolean = false): string {
  if (turn.answered.length === 0) return ''
  const items = compactStem
    ? turn.answered.map((item) => {
        const collapsed = item.question.replace(/\s+/g, ' ').trim()
        return collapsed.length > OLD_ANSWER_STEM_MAX_CHARS
          ? { ...item, question: `${collapsed.slice(0, OLD_ANSWER_STEM_MAX_CHARS).trimEnd()}…` }
          : { ...item, question: collapsed }
      })
    : turn.answered
  return `## Answers\n${items.flatMap(renderAnswered).join('\n')}`
}

/**
 * Place the `## Answers` section just above `## Asked`, or at the end when the
 * block has none.
 *
 * Not at the end unconditionally: `## Asked` is the block's last section because
 * the user's reply — a bare `1` — is the very next line and needs the options
 * directly above it. A second question-and-answer block wedged in between would
 * separate them.
 *
 * @param block - the rendered extraction block.
 * @param answers - the rendered `## Answers` section, or an empty string.
 * @returns the block with the answers placed.
 */
function insertAnswers(block: string, answers: string): string {
  if (answers.length === 0) return block
  // The heading as a whole line, not the bare text: a `did`/`concluded` item is a
  // free string, and one that happens to contain `## Asked` would otherwise be
  // split in the middle of a bullet.
  const at = block.startsWith('## Asked\n') ? 0 : block.indexOf('\n## Asked\n') + 1
  if (at <= 0 && !block.startsWith('## Asked\n')) return `${block}\n${answers}`
  const head = block.slice(0, at)
  return head.length === 0 ? `${answers}\n${block}` : `${head}${answers}\n${block.slice(at)}`
}


/**
 * Render the digest under a hard character budget.
 *
 * Three tiers, in order:
 *
 * - **T1** user prose is verbatim unless it alone exceeds `USER_BUDGET_SHARE` of
 *   the budget, then the oldest turns are cut first. The share is 0.9 rather than
 *   0.5 because real user prose is a few percent of the digest: at 0.5 the
 *   extracted blocks crowded out the oldest human messages, which are exactly the
 *   standing constraints (「请用pixi管理开发环境」) that must survive.
 * - **T1'** the graded ladder: each block drops Overturned, then Concluded, then
 *   Did, while Asked survives every level.
 * - **T2** whole turn bodies go, oldest first, when even the surviving sections
 *   overflow. The user lines stay; only what the assistant produced is dropped.
 *
 * T1' runs *after* T1 because a user's own words are the least reconstructible
 * thing in the log: an assistant's reply can be inferred from its tool calls and
 * the surrounding turns, a user's request cannot.
 *
 * All three tiers run on a long session, and that is by design: the ceiling is
 * absolute (`DIGEST_TOKEN_CEILING`), so a 122-turn history with 316k characters
 * of assistant prose cannot fit verbatim. In the extractive design most turns
 * carry an extraction instead of prose, which keeps the digest far below the
 * ceiling; the tiers exist for the turns where extraction was unavailable and
 * the prose is all that remains.
 *
 * When `condensed` is supplied the tiers are skipped and the digest is returned
 * whole. That path is entered only by `condenseOldest`, which owns the overflow:
 * degrading here would report "fits" at a level that has already dropped the
 * sections the fold was meant to preserve, and the fold loop would stop early
 * having bought nothing. Measured at 1200 turns: the ladder dropped 475 turn
 * bodies, leaving only `## Asked`, before condensation ever got a chance.
 */
export function renderDigest(
  events: readonly SessionEvent[],
  budgetTokens: number,
  extracted?: ReadonlyMap<string, Extraction>,
  condensed?: ReadonlyMap<string, Condensed>,
): string {
  const { sections: builtSections, sectionEvents } = buildSectionsWithEvents(events)
  const rawSections = extracted === undefined ? builtSections : withExtractions(builtSections, extracted)
  const openTasksBlock = renderOpenTasks(extractActiveOpenTasks(rawSections, sectionEvents))
  // Normalize oversized pastes in older sections before budgeting and T1 so a
  // single 50k historical paste is billed at its ~2.2k clipped size instead of
  // starving earlier standing constraints or being truncated twice.
  const sections = rawSections.map((section, sectionIndex) => (
    shouldKeepFullUser(rawSections, sectionIndex)
      ? section
      : {
          turns: section.turns.map((turn) => ({
            ...turn,
            user: turn.user.map((text) => clipHeadTail(text, OLD_USER_PASTE_MAX_CHARS, 1400, 800)),
          })),
        }
  ))
  const budgetChars = Math.max(0, budgetTokens * 4)

  const render = (trimmed?: Section[], level: number = 3): string => {
    const list = trimmed ?? sections
    return list
      .map((section, index) => renderSection(section, level, condensed, index, list, openTasksBlock))
      .join('\n')
  }

  // User prose is reserved before anything else is placed.
  //
  // Measured on a 122-turn session: every human message in the span totalled 469
  // characters (117 tokens), while one extracted block per turn totalled 55020
  // characters. The extraction is 117x the size of the prose it sat next to, so
  // any layout that lets them compete evicts the prose — and the prose is the
  // standing constraints (「请用pixi管理开发环境」) that never expire, while the
  // extraction describes work that is already finished.
  const userReserve = Math.min(
    Math.floor(budgetChars * USER_BUDGET_SHARE),
    sections.reduce(
      (total, section) => total + section.turns.reduce((sum, turn) => sum + turn.user.join('\n').length, 0),
      0,
    ),
  )

  const verbatim = render()
  if (verbatim.length <= budgetChars) return verbatim

  // T1: user prose over its share, oldest first. Only the user side changes, so
  // assistant prose stays verbatim for now. The walk is backwards because the
  // newest request is the one the next turn depends on: cutting forwards would
  // keep the opening question and drop what the user just asked for.
  const userCap = userReserve
  let seen = 0
  const t1 = sections.map((section) => ({ turns: section.turns.map((turn) => ({ ...turn, user: [...turn.user] })) }))
  for (let section = t1.length - 1; section >= 0; section -= 1) {
    const turns = t1[section]?.turns ?? []
    for (let turn = turns.length - 1; turn >= 0; turn -= 1) {
      const texts = turns[turn]?.user ?? []
      for (let index = texts.length - 1; index >= 0; index -= 1) {
        const text = texts[index] ?? ''
        const room = userCap - seen
        if (text.length <= room) {
          seen += text.length
          continue
        }
        texts[index] = room <= 0
          ? `…(+${text.length} chars, older user prose truncated)`
          : `${text.slice(0, room)}\n…(+${text.length - room} chars)`
        seen = userCap
      }
    }
  }
  const afterT1 = render(t1)
  if (afterT1.length <= budgetChars) return afterT1
  // The user side fits inside its reserve; what overflows is the turn bodies
  // (extraction or prose plus pointers). Thin those, and only drop whole turns
  // once every body is already at zero — dropping a turn also drops the user
  // prose in it, which is what the reserve exists to prevent.

  // T1': the graded ladder. Each level drops one section from every block —
  // Overturned first, then Concluded, then Did — and Asked survives all of them.
  //
  // This replaces a character cap applied to each block. That cap sliced every
  // extraction at the same offset, and because Asked is the block's last section
  // it was the first thing eaten: at 490 turns each question rendered as `  1.`
  // with its options gone, and by 520 both Asked and Overturned were absent from
  // every block. A half-line reads as data, so slicing loses more than dropping:
  // the reader cannot tell a truncated fact from a short one.
  //
  // Asked outranks everything because it is the only section nothing later can
  // rebuild. Did and Concluded describe work whose results are still in the
  // working tree; the question and the options the user chose between exist only
  // in this line.
  //
  // No character cap at any level: a block either renders whole or loses a whole
  // section. Slicing was the original mechanism and it cut Asked's options off
  // mid-list, which reads as data rather than as truncation.
  //
  // The ladder only runs when no condensation was supplied. A condensed digest
  // that still overflows is the caller's problem to fix by folding more turns:
  // degrading it here would report "fits" at a level that has already dropped the
  // sections the fold was meant to preserve, and the fold loop would stop early
  // having bought nothing. Measured at 1200 turns: the ladder dropped 475 turn
  // bodies, leaving only `## Asked`, before condensation ever got a chance.
  if (condensed !== undefined && condensed.size > 0) {
    // Returned whole even when it still overflows. The caller folds more turns and
    // asks again; slicing here would cut the last block mid-line, which is the
    // failure this whole path exists to remove.
    return render(t1, 3)
  }
  for (let level = 3; level >= 0; level -= 1) {
    const whole = render(t1, level)
    if (whole.length <= budgetChars) return whole
  }

  // Every level overflowed with prose already at zero, so the user lines plus the
  // surviving Asked sections alone exceed the budget. Drop the oldest turn
  // *bodies* rather than the oldest sections: a dropped section takes the user's
  // request with it, and those requests are standing constraints ("请用pixi管理
  // 开发环境") that never expire, while a body describes work already superseded.
  // The newest turns are the ones the next request depends on, so the cut runs
  // from the oldest end.
  const positions: Array<{ section: number, turn: number }> = []
  for (const [section, { turns }] of t1.entries()) {
    for (let turn = 0; turn < turns.length; turn += 1) positions.push({ section, turn })
  }
  const withoutBodies = (count: number): Section[] => {
    const trimmed = t1.map((section) => ({ turns: section.turns.map((turn) => ({ ...turn })) }))
    for (const { section, turn } of positions.slice(0, count)) {
      const target = trimmed[section]?.turns[turn]
      if (target === undefined) continue
      // The user line stays; only what the assistant produced goes. `delete`
      // rather than assigning undefined: `exactOptionalPropertyTypes` treats the
      // key's absence and its undefined value as different types.
      delete target.extracted
      target.assistant = []
      target.writes = []
      // The answers belong to the body: they were produced by this turn's own
      // tool call, so a dropped body that kept them would still print a full
      // `## Answers` at every tier, and the truncation would never fit.
      target.answered = []
    }
    return trimmed
  }
  // Lower bound on the drop count: the smallest number that fits. `Math.floor`
  // rather than `ceil` is load-bearing — with `ceil`, `mid` equals `high` once the
  // range narrows to two entries, so a fitting `mid` left `high` unchanged and the
  // loop never terminated. A 2200-turn digest hung here; 2100 happened to converge.
  let low = 0
  let high = positions.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const marker = mid === 0 ? '' : `…(${mid} oldest turn bodies dropped: over budget)\n`
    if (marker.length + render(withoutBodies(mid), 0).length <= budgetChars) high = mid
    else low = mid + 1
  }
  const marker = low === 0 ? '' : `…(${low} oldest turn bodies dropped: over budget)\n`
  const stripped = render(withoutBodies(low), 0)
  if (marker.length + stripped.length <= budgetChars) return `${marker}${stripped}`

  // Even with every body gone the user lines alone overflow — a budget smaller
  // than the requests it must hold. Only here do whole sections go, oldest first:
  // slicing the tail instead would cut the newest turns, which are exactly the
  // ones the next request depends on.
  // Still over budget with every body gone. Drop whole turns from the oldest end
  // — a dropped turn takes its user line with it, which is the price of a budget
  // too small to hold the requests themselves. The newest turn is never dropped,
  // and the walk keeps every turn after the cut point rather than only the last
  // one: a `goal` round records its objective as a user message and can sit after
  // the newest request, so keeping just `slice(-1)` kept the goal and lost the
  // request.
  // The cut never passes the last turn carrying a user request. Without this the
  // walk reached the very end — the fixture's `goal` round is the last position,
  // so dropping up to it kept the goal and lost `USER-13`, the newest request.
  const turnAt = (position: { section: number, turn: number } | undefined): Turn | undefined =>
    position === undefined ? undefined : t1[position.section]?.turns[position.turn]
  let lastRequest = positions.length - 1
  while (lastRequest > 0 && turnAt(positions[lastRequest])?.fromRequest !== true) lastRequest -= 1
  let first = 0
  while (first < lastRequest) {
    first += 1
    const cut = positions[first]
    if (cut === undefined) break
    const kept = t1
      .map((section, sectionIndex) => ({
        turns: section.turns.filter((_, turnIndex) => sectionIndex > cut.section || (sectionIndex === cut.section && turnIndex >= cut.turn)),
      }))
      .filter((section) => section.turns.length > 0)
    const rest = render(kept, 0)
    const text = `…(${first} earlier turn(s) dropped: over budget)\n${rest}`
    if (text.length <= budgetChars) return text
  }
  // Nothing fit, so keep the one turn the next request depends on: the newest one
  // carrying a user request, not the last position in the log.
  // Only the user line: the budget cannot even hold one full turn, and the request
  // is the part the next turn is answering.
  const keeperTurn = turnAt(positions[lastRequest])
  if (keeperTurn === undefined) return ''
  const bare: Turn = { ...keeperTurn, assistant: [], writes: [], answered: [] }
  delete bare.extracted
  return render([{ turns: [bare] }], 0)
}

/**
 * The surface seqs this compaction shadows, recovered from the summarization
 * input's message count.
 *
 * `SummarizationInput` carries no seqs, but the base class always builds it as
 * `[system head?] + shadowed region in surface order`, so the count recovers the
 * span exactly. Verified against 120 real compactions: the recovered span
 * matched the shadowed span seq-for-seq every time.
 *
 * @param session - session whose surface the input was built from.
 * @param input - the replayed prefix handed to `summarize`.
 * @returns the shadowed surface seqs in order.
 */
export function shadowedSeqs(session: Session, input: SummarizationInput): SessionSeq[] {
  const nodes = session.surface.nodes
  const firstEvent = nodes[0] !== undefined ? session.eventAt(nodes[0]) : undefined
  const head = firstEvent?.type === 'system/message' ? 1 : 0
  const messageCount = Math.max(0, input.messages.length - head)
  if (messageCount === 0) return []
  // Match surface nodes that actually derive to a message: the host's
  // `buildSummarizationInput` skips nodes whose `deriveEventMessage` is null,
  // while the replaced span still covers every surface node through the last
  // shadowed message.
  let seenMessages = 0
  let endIndex = head
  for (let i = head; i < nodes.length && seenMessages < messageCount; i += 1) {
    const seq = nodes[i]
    const ev = seq === undefined ? undefined : session.eventAt(seq)
    if (ev !== undefined && messageOf(ev) !== null) seenMessages += 1
    endIndex = i + 1
  }
  return nodes.slice(head, endIndex)
}

/**
 * Pick the log events the digest is built from: every append-origin surface
 * event, minus the retained tail.
 *
 * The retained tail is what stays on the surface after this compaction, so
 * excluding it keeps the digest and the surviving surface disjoint. Everything
 * else has either already been shadowed by an earlier checkpoint or is being
 * shadowed now, and must appear in the digest or it is lost.
 *
 * Events a `{op: 'replace'}` copy superseded still qualify, because their own
 * marker is `'append'`. That is deliberate: tool results become a one-line
 * pointer either way, so including the pre-replacement original changes the
 * digest by 19-109 tokens across the measured sessions, and never dropping
 * content is worth more than that.
 *
 * @param session - session whose log supplies the events.
 * @param retainedSeqs - seqs that remain on the surface after this compaction.
 * @returns the events the digest is built from, in log order.
 */
export function digestSource(session: Session, retainedSeqs: ReadonlySet<SessionSeq>): readonly SessionEvent[] {
  return session.snapshotEvents().filter((event) => {
    // `turn/start` is not a surface event, but it is the only record of which
    // turn a user message belongs to: user messages carry no turn of their own.
    // Keeping the markers costs a few tokens and makes every heading say
    // "turn 37" instead of "turn ?".
    if (event.type === 'turn/start') return true
    if (event.surfaceOp !== 'append') return false
    if (isCheckpoint(event)) return false
    return !retainedSeqs.has(event.seq)
  })
}

/**
 * Assemble the three-part material one extraction call is given.
 *
 * Split out from the call itself so it can be asserted: the first hand-built
 * version of this silently dropped the user request, because it selected user
 * messages by `data.turn` and user messages carry no turn of their own. The model
 * then summarized tool names with no idea what had been asked.
 *
 * @param turn - one turn's events, in log order.
 * @param prose - that turn's assistant prose, already extracted by the caller.
 * @returns the joined material, or an empty string when the turn has nothing.
 */
/** Sample non-error, non-question tool results for single-turn tool-heavy (subagent) runs. */
function sampleToolResults(turn: readonly SessionEvent[]): string {
  const questionCallIds = new Set<string>()
  const callNames = new Map<string, string>()
  for (const event of turn) {
    if (event.type !== 'assistant/message') continue
    for (const call of toolCallsOf(event)) {
      callNames.set(call.id, call.name)
      if (call.name === 'ask_user_question') questionCallIds.add(call.id)
    }
  }
  const collected: string[] = []
  let budget = SAMPLED_TOOL_RESULT_TOTAL_CHARS
  for (let i = turn.length - 1; i >= 0 && budget > 0; i -= 1) {
    const event = turn[i]
    if (event === undefined || event.type !== 'tool/result') continue
    const msg = messageOf(event) as { toolCallId?: string; isError?: boolean } | null
    if (msg === null || msg.isError === true) continue
    const callId = msg.toolCallId
    if (callId !== undefined && questionCallIds.has(callId)) continue
    const raw = textOf(event).replace(/\s+/g, ' ').trim()
    if (raw.length === 0) continue
    const snippet = raw.slice(0, Math.min(SAMPLED_TOOL_RESULT_PER_CALL_CHARS, budget))
    const toolLabel = callId !== undefined ? (callNames.get(callId) ?? 'tool') : 'tool'
    const entry = `[${toolLabel}] ${snippet}`
    collected.push(entry)
    budget -= entry.length + 1
  }
  return collected.reverse().join('\n')
}

/** Collect bounded subagent reports (`agent-message`, plus `subagent-settled` closing notes when no relay arrived). */
function collectSubagentReports(turn: readonly SessionEvent[]): string {
  const relaySenders = new Set<string>()
  for (const event of turn) {
    if (sourceKind(event) !== 'agent-message') continue
    const sender = senderSessionIdOf(event)
    if (sender !== undefined) relaySenders.add(sender)
    const textSender = /^Agent\s+([^\s]+)\s+sent a message:/i.exec(textOf(event).trim())?.[1]
    if (textSender !== undefined && textSender.length > 0) relaySenders.add(textSender)
  }

  const entries: { label: string; body: string }[] = []
  for (const event of turn) {
    const kind = sourceKind(event)
    if (kind === 'agent-message') {
      const raw = textOf(event).trim()
      if (raw.length === 0) continue
      const match = /^Agent\s+([^\s]+)\s+sent a message:\s*/i.exec(raw)
      const sender = match?.[1] ?? senderSessionIdOf(event)
      const body = (match !== null ? raw.slice(match[0].length) : raw).trim()
      if (body.length === 0) continue
      entries.push({ label: sender ? sender.slice(0, 8) : 'subagent', body })
      continue
    }
    if (kind === 'subagent-settled') {
      const sender = senderSessionIdOf(event)
      if (sender !== undefined && relaySenders.has(sender)) continue
      const raw = textOf(event).trim()
      const closing = /Its closing message:\s*([\s\S]+)$/i.exec(raw)?.[1]?.trim() ?? ''
      if (closing.length === 0) continue
      entries.push({ label: sender ? `${sender.slice(0, 8)} (settled)` : 'subagent (settled)', body: closing })
    }
  }

  if (entries.length === 0) return ''
  const selected = entries.length > SUBAGENT_REPORT_MAX_COUNT
    ? entries.slice(entries.length - SUBAGENT_REPORT_MAX_COUNT)
    : entries

  // Water-fill budget allocation: short reports stay verbatim while long reports
  // share the remaining budget up to `SUBAGENT_REPORT_PER_MSG_CHARS` each.
  const caps = new Array<number>(selected.length).fill(0)
  const order = selected
    .map((entry, idx) => ({ idx, len: entry.body.length }))
    .sort((a, b) => a.len - b.len)
  let remainingBudget = SUBAGENT_REPORT_TOTAL_CHARS
  for (let i = 0; i < order.length; i += 1) {
    const item = order[i]!
    const left = order.length - i
    const share = Math.min(SUBAGENT_REPORT_PER_MSG_CHARS, Math.max(400, Math.floor(remainingBudget / left)))
    const alloc = Math.min(item.len, share)
    caps[item.idx] = alloc
    remainingBudget = Math.max(0, remainingBudget - alloc)
  }

  const rendered: string[] = []
  for (let i = 0; i < selected.length; i += 1) {
    const entry = selected[i]!
    const cap = caps[i] ?? SUBAGENT_REPORT_PER_MSG_CHARS
    const body = entry.body.length > cap
      ? clipHeadTail(entry.body, cap, Math.floor(cap * 0.55), Math.floor(cap * 0.4))
      : entry.body
    rendered.push(`[subagent ${entry.label}]\n${body}`)
  }
  return rendered.join('\n\n')
}

/** Whether a turn is long/multi-step enough to warrant expanded extraction capacity. */
export function isExpandedTurn(turn: readonly SessionEvent[], prose: string): boolean {
  if (prose.length >= LONG_TURN_PROSE_CHARS) return true
  let toolCallCount = 0
  let assistantMsgCount = 0
  for (const event of turn) {
    if (event.type === 'assistant/message') {
      toolCallCount += toolCallsOf(event).length
      if (textOf(event).trim().length > 0) assistantMsgCount += 1
    } else if (isSubagentReport(event)) {
      return true
    }
  }
  return toolCallCount >= LONG_TURN_TOOL_CALLS || assistantMsgCount >= LONG_TURN_ASSISTANT_MSGS
}

/** Sample assistant prose: head+tail for normal turns; stage-sampled head/middle/tail for long turns. */
function sampleAssistantProse(turn: readonly SessionEvent[], prose: string, expanded: boolean): string {
  if (!expanded) return clipHeadTail(prose, 6000, 2000, 3900)
  if (prose.length <= LONG_TURN_PROSE_BUDGET) return prose

  const segments = turn
    .filter((event) => event.type === 'assistant/message')
    .map((event) => textOf(event).trim())
    .filter((text) => text.length > 0)

  const segmentsTotal = segments.reduce((sum, seg) => sum + seg.length, 0)
  if (segments.length >= 4 && segmentsTotal >= prose.length * 0.8) {
    const headParts: string[] = []
    let headChars = 0
    let headEnd = 0
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!
      if (headParts.length === 0) {
        const clipped = seg.length > LONG_TURN_PROSE_HEAD_CHARS
          ? clipHeadTail(seg, LONG_TURN_PROSE_HEAD_CHARS, 1800, 1100)
          : seg
        headParts.push(clipped)
        headChars += clipped.length
        headEnd = i + 1
        if (headChars >= LONG_TURN_PROSE_HEAD_CHARS) break
      } else if (headChars + seg.length + 1 <= LONG_TURN_PROSE_HEAD_CHARS) {
        headParts.push(seg)
        headChars += seg.length + 1
        headEnd = i + 1
      } else {
        break
      }
    }

    const tailParts: string[] = []
    let tailChars = 0
    let tailStart = segments.length
    for (let i = segments.length - 1; i >= headEnd; i -= 1) {
      const seg = segments[i]!
      if (tailParts.length === 0) {
        const clipped = seg.length > LONG_TURN_PROSE_TAIL_CHARS
          ? clipHeadTail(seg, LONG_TURN_PROSE_TAIL_CHARS, 2000, 3800)
          : seg
        tailParts.push(clipped)
        tailChars += clipped.length
        tailStart = i
        if (tailChars >= LONG_TURN_PROSE_TAIL_CHARS) break
      } else if (tailChars + seg.length + 1 <= LONG_TURN_PROSE_TAIL_CHARS) {
        tailParts.push(seg)
        tailChars += seg.length + 1
        tailStart = i
      } else {
        break
      }
    }
    tailParts.reverse()

    const midCount = Math.max(0, tailStart - headEnd)
    const midBudget = LONG_TURN_PROSE_BUDGET - headChars - tailChars
    if (midCount > 0 && midBudget >= 400) {
      const maxSlots = Math.max(1, Math.floor(midBudget / LONG_TURN_MIN_MILESTONE_CHARS))
      const chosenIndices: number[] = []
      if (midCount <= maxSlots) {
        for (let idx = headEnd; idx < tailStart; idx += 1) chosenIndices.push(idx)
      } else {
        for (let s = 0; s < maxSlots; s += 1) {
          const idx = headEnd + Math.floor(((s + 0.5) * midCount) / maxSlots)
          if (chosenIndices.at(-1) !== idx) chosenIndices.push(idx)
        }
      }
      const perSample = Math.max(120, Math.floor(midBudget / chosenIndices.length) - 28)
      const midParts = chosenIndices.map((idx) => {
        const seg = segments[idx]!
        const clipped = seg.length > perSample
          ? clipHeadTail(seg, perSample, Math.floor(perSample * 0.65), Math.floor(perSample * 0.3))
          : seg
        return `[milestone ${idx + 1}/${segments.length}] ${clipped}`
      })
      return [
        headParts.join('\n'),
        `…(sampled ${chosenIndices.length} of ${midCount} intermediate assistant messages)`,
        midParts.join('\n'),
        '…',
        tailParts.join('\n'),
      ].join('\n')
    }
    return `${headParts.join('\n')}\n…(${midCount} intermediate messages omitted)\n${tailParts.join('\n')}`
  }

  // Fallback for a single oversized prose string without segment boundaries: head + 2 middle windows + tail.
  const head = prose.slice(0, LONG_TURN_PROSE_HEAD_CHARS).trimEnd()
  const tail = prose.slice(prose.length - LONG_TURN_PROSE_TAIL_CHARS).trimStart()
  const midSpanStart = LONG_TURN_PROSE_HEAD_CHARS
  const midSpanEnd = prose.length - LONG_TURN_PROSE_TAIL_CHARS
  const midSpan = midSpanEnd - midSpanStart
  if (midSpan <= 4000) return clipHeadTail(prose, LONG_TURN_PROSE_BUDGET, LONG_TURN_PROSE_HEAD_CHARS, LONG_TURN_PROSE_TAIL_CHARS)
  const win = 3000
  const m1Start = midSpanStart + Math.floor(midSpan / 3) - Math.floor(win / 2)
  const m2Start = midSpanStart + Math.floor((2 * midSpan) / 3) - Math.floor(win / 2)
  const m1 = prose.slice(Math.max(midSpanStart, m1Start), Math.min(midSpanEnd, m1Start + win)).trim()
  const m2 = prose.slice(Math.max(midSpanStart, m2Start), Math.min(midSpanEnd, m2Start + win)).trim()
  return `${head}\n…(middle stage 1/2)\n${m1}\n…(middle stage 2/2)\n${m2}\n…\n${tail}`
}

export function buildExtractionMaterial(
  turn: readonly SessionEvent[],
  prose: string,
  options?: { includeToolResults?: boolean; expanded?: boolean },
): string {
  const userRequest = turn
    .filter((event) => {
      if (event.type !== 'user/message' || isCheckpoint(event)) return false
      if (sourceKind(event) === 'goal') return goalObjective(event) !== undefined
      return !isInjection(event)
    })
    .map((event) => (sourceKind(event) === 'goal' ? (goalObjective(event) ?? '') : textOf(event)))
    .filter((text) => text.length > 0)
    .join('\n')
  const hints = collectHints(turn)
  const subagentReports = collectSubagentReports(turn)
  const toolResults = options?.includeToolResults === true ? sampleToolResults(turn) : ''
  if (
    userRequest.length === 0
    && prose.length === 0
    && hints.length === 0
    && subagentReports.length === 0
    && toolResults.length === 0
  ) {
    return ''
  }
  const expanded = options?.expanded ?? isExpandedTurn(turn, prose)
  const clippedUser = clipHeadTail(userRequest, 4000, 2500, 1400)
  const clippedProse = sampleAssistantProse(turn, prose, expanded)
  const sections = [
    `USER INSTRUCTION (already in the digest verbatim; never copy it into Asked):\n${clippedUser || '(none)'}`,
    `ASSISTANT PROSE:\n${clippedProse || '(none)'}`,
    `TOOL TRACE:\n${hints || '(none)'}`,
  ]
  if (subagentReports.length > 0) {
    sections.push(
      `SUBAGENT REPORTS (subagent audits/findings delivered during this turn; extract key conclusions, decisions, and blockers):\n${subagentReports}`,
    )
  }
  if (toolResults.length > 0) {
    sections.push(`KEY TOOL RESULTS (sampled from tool-heavy single-turn run):\n${toolResults}`)
  }
  return sections.join('\n\n')
}

/**
 * Per-turn extraction through the host's own LLM service.
 *
 * This is the part the verbatim digest cannot do on its own. Measured on a real
 * 13878-event session: 1973 assistant messages, of which only 317 carried any
 * prose, and one turn ran 342 tool calls while emitting zero characters of text.
 * A digest that only copies prose therefore reduced that whole turn to a `tools:`
 * count line — the work happened, the record did not.
 *
 * The call reuses the session's routed model exactly as the host's own
 * compaction does (`ctx.llm.stream` with the session's provider/model), so no
 * separate credential or configuration is involved.
 *
 * Every failure path yields no blocks and the caller falls back to the plain
 * digest: a compaction that cannot reach the model must still compact, or the
 * session dies of context overflow instead of losing detail. The degradation is
 * per turn, but it is never silent — a batch that comes back unusable is
 * reported, because the whole point of that fallback is invisible otherwise.
 *
 * @param ctx - plugin context carrying the `llm` service and a logger.
 * @param agent - owner of the session being compacted; supplies the routed model.
 * @param batch - slots to extract, in one call unless the answer is truncated.
 * @param signal - cancellation forwarded to the adapter.
 * @returns the extracted blocks by slot key; empty when extraction is unavailable.
 */
/**
 * One condensation request: fold a run of already-finished turns into a paragraph.
 *
 * Module-level and shaped like `extractOnce` rather than a method, so both calls
 * derive their route and reasoning effort the same way.
 *
 * @param ctx - plugin context carrying the `llm` service and a logger.
 * @param agent - owner of the session being compacted.
 * @param material - the rendered blocks being folded.
 * @param signal - cancellation forwarded to the adapter.
 * @returns the folded paragraph, or undefined when the call produced nothing.
 */
/** Mutable accumulator for summing provider-reported token usage across all LLM calls in one compaction. */
interface UsageAccumulator {
  seen: boolean
  inputTokens: number
  outputTokens: number
  totalTokens: number
  hasTotalTokens: boolean
  cacheReadTokens: number
  hasCacheRead: boolean
  cacheWriteTokens: number
  hasCacheWrite: boolean
  reasoningTokens: number
  hasReasoning: boolean
}

function createUsageAccumulator(): UsageAccumulator {
  return {
    seen: false,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    hasTotalTokens: false,
    cacheReadTokens: 0,
    hasCacheRead: false,
    cacheWriteTokens: 0,
    hasCacheWrite: false,
    reasoningTokens: 0,
    hasReasoning: false,
  }
}

function addUsage(acc: UsageAccumulator | undefined, usage: unknown): void {
  if (acc === undefined || typeof usage !== 'object' || usage === null) return
  const u = usage as Record<string, unknown>
  const input = typeof u['inputTokens'] === 'number' ? u['inputTokens'] : 0
  const output = typeof u['outputTokens'] === 'number' ? u['outputTokens'] : 0
  if (input === 0 && output === 0 && typeof u['totalTokens'] !== 'number') return
  acc.seen = true
  acc.inputTokens += input
  acc.outputTokens += output
  if (typeof u['totalTokens'] === 'number') {
    acc.hasTotalTokens = true
    acc.totalTokens += u['totalTokens']
  }
  if (typeof u['cacheReadTokens'] === 'number') {
    acc.hasCacheRead = true
    acc.cacheReadTokens += u['cacheReadTokens']
  }
  if (typeof u['cacheWriteTokens'] === 'number') {
    acc.hasCacheWrite = true
    acc.cacheWriteTokens += u['cacheWriteTokens']
  }
  if (typeof u['reasoningTokens'] === 'number') {
    acc.hasReasoning = true
    acc.reasoningTokens += u['reasoningTokens']
  }
}

function toTokenUsage(acc: UsageAccumulator): TokenUsage | undefined {
  if (!acc.seen) return undefined
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    ...(acc.hasTotalTokens ? { totalTokens: acc.totalTokens } : {}),
    ...(acc.hasCacheRead ? { cacheReadTokens: acc.cacheReadTokens } : {}),
    ...(acc.hasCacheWrite ? { cacheWriteTokens: acc.cacheWriteTokens } : {}),
    ...(acc.hasReasoning ? { reasoningTokens: acc.reasoningTokens } : {}),
  }
}

/** The route this compaction's model calls go to: the session's own. */
function resolveEffectiveRoute(
  agent: Agent,
): { provider: string; model: string } | undefined {
  const sessionRoute = agent.session.requestHeader()?.config
  const provider = sessionRoute?.provider ?? agent.options.provider
  const model = sessionRoute?.model ?? agent.options.model
  if (provider === undefined || model === undefined) return undefined
  return { provider, model }
}

/** Read the per-call LLM timeout in ms, honoring an optional environment override. */
function resolveCallTimeoutMs(): number {
  const raw = process.env['DSH_VERBATIM_CALL_TIMEOUT_MS']
  if (raw !== undefined) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_LLM_CALL_TIMEOUT_MS
}

/** Combine an optional outer AbortSignal with a per-call timeout. */
function withCallTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onAbort = (): void => {
    controller.abort(signal?.reason)
  }
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return { signal: controller.signal, dispose: () => {} }
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`verbatim-compaction call timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** Flatten folded model output into one clean bullet-safe paragraph (no code fences, headings, or multiline breaks). */
function sanitizeCondensedText(raw: string): string {
  const unfenced = raw.trim().replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/\s*```$/, '').trim()
  const cleanedLines = unfenced
    .split(/\r?\n/)
    .map((line) => line
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*•]\s+/, '')
      .trim())
    .filter((line) => line.length > 0 && !/^```/.test(line))
  return cleanedLines.join(' ').replace(/\s+/g, ' ').trim()
}

/** Bounded LRU-like Map read/write helpers. */
function boundedCacheGet<V>(map: Map<string, V>, key: string): V | undefined {
  const value = map.get(key)
  if (value !== undefined) {
    map.delete(key)
    map.set(key, value)
  }
  return value
}

function boundedCacheSet<V>(map: Map<string, V>, key: string, value: V, maxSize: number): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > maxSize) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Directory for persistent per-session caches, or undefined when disabled (e.g. under node --test). */
function resolveCacheDir(): string | undefined {
  const explicit = process.env['DSH_VERBATIM_CACHE_DIR']
  if (explicit !== undefined) {
    const trimmed = explicit.trim()
    if (trimmed === '' || /^(?:off|none|false|0)$/i.test(trimmed)) return undefined
    return trimmed
  }
  if (process.env['NODE_TEST_CONTEXT'] !== undefined) return undefined
  const base = process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  return join(base, 'cache', 'verbatim-compaction')
}

interface DiskCachePayload {
  v: 1
  extraction?: Record<string, Extraction>
  condensed?: Record<string, string>
}

function cacheFilePath(dir: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'
  return join(dir, `${safeId}.json`)
}

async function condenseOnce(
  ctx: ExtractionContext,
  agent: Agent,
  material: string,
  signal: AbortSignal | undefined,
  usageAcc?: UsageAccumulator,
): Promise<string | undefined> {
  const llm = ctx.llm
  if (llm === undefined) {
    ctx.logger?.warn('verbatim-compaction: no llm service, condensation skipped')
    return undefined
  }
  const effective = resolveEffectiveRoute(agent)
  if (effective === undefined) {
    ctx.logger?.warn('verbatim-compaction: no route for condensation, skipped')
    return undefined
  }

  const call = withCallTimeout(signal, resolveCallTimeoutMs())
  const chunks: string[] = []
  try {
    const info = await Promise.resolve()
      .then(() => llm.resolveModelInfo?.(effective.provider, effective.model, call.signal))
      .catch(() => undefined)
    const cheapest = cheapestEffort(info?.reasoning?.efforts)

    const stream = llm.stream({
      provider: effective.provider,
      model: effective.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: `${material}\n\n${CONDENSE_INSTRUCTION}` }] }],
      maxTokens: CONDENSE_TOKENS,
      sessionId: agent.session.id,
      purpose: 'compaction',
      signal: call.signal,
      ...(cheapest === undefined ? {} : { reasoningEffort: ReasoningEffortId(cheapest) }),
    })
    for await (const chunk of stream) {
      const delta = chunk as { type?: string; text?: string; usage?: unknown }
      if (delta.type === 'text-delta' && typeof delta.text === 'string') chunks.push(delta.text)
      else if (delta.type === 'finish') addUsage(usageAcc, delta.usage)
    }
  } catch (error) {
    ctx.logger?.warn(`verbatim-compaction: condensation call failed: ${String(error)}`)
    return undefined
  } finally {
    call.dispose()
  }
  const text = sanitizeCondensedText(chunks.join(''))
  if (text.length === 0) {
    ctx.logger?.warn(`verbatim-compaction: condensation returned no text for ${material.length} chars of material`)
    return undefined
  }
  return text
}

async function extractBatch(
  ctx: ExtractionContext,
  agent: Agent,
  batch: readonly ExtractionSlot[],
  signal: AbortSignal | undefined,
  usageAcc?: UsageAccumulator,
): Promise<Map<string, Extraction>> {
  const out = new Map<string, Extraction>()
  const isAborted = (): boolean => signal?.aborted === true
  if (batch.length === 0 || isAborted()) return out

  const attempt = await extractOnce(ctx, agent, batch, signal, usageAcc)
  if (attempt.transportError) return attempt.blocks

  const needsSplit = attempt.truncated || (attempt.blocks.size === 0 && batch.length > 1 && !isAborted())
  if (!needsSplit) {
    if (attempt.blocks.size === 0) {
      ctx.logger?.warn(
        `verbatim-compaction: extraction returned no usable JSON for ${batch.length} slot(s) `
        + `(${batch.map((slot) => slot.key).join(', ')}); those turns keep their verbatim prose`,
      )
    }
    return attempt.blocks
  }

  if (batch.length === 1) {
    if (attempt.blocks.size === 0) {
      ctx.logger?.warn(
        `verbatim-compaction: extraction truncated at the token cap for slot ${batch[0]?.key ?? '?'}; `
        + 'that turn keeps its verbatim prose',
      )
    }
    return attempt.blocks
  }
  for (const [key, block] of attempt.blocks) out.set(key, block)
  const remaining = batch.filter((slot) => !out.has(slot.key))
  if (remaining.length === 0) return out
  if (remaining.length === 1) {
    if (!isAborted()) {
      for (const [key, block] of await extractBatch(ctx, agent, remaining, signal, usageAcc)) out.set(key, block)
    }
    return out
  }
  const middle = Math.ceil(remaining.length / 2)
  for (const half of [remaining.slice(0, middle), remaining.slice(middle)]) {
    if (half.length === 0 || isAborted()) continue
    for (const [key, block] of await extractBatch(ctx, agent, half, signal, usageAcc)) out.set(key, block)
  }
  return out
}

/** One slot handed to an extraction call. */
interface ExtractionSlot {
  key: string
  turn: number | undefined
  events: readonly SessionEvent[]
  includeToolResults?: boolean
  expanded?: boolean
}

/** What one extraction call produced, and whether the answer was cut short or failed in transport. */
interface ExtractionAttempt {
  blocks: Map<string, Extraction>
  truncated: boolean
  transportError?: boolean
}

/** The slice of the plugin context an extraction call needs. */
interface ExtractionContext {
  llm?: {
    stream: (options: any) => AsyncIterable<any>
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<any>
  }
  logger?: { warn: (message: string) => void }
}

function cheapestEffort(efforts: readonly (string | { id: string })[] | undefined): string | undefined {
  if (efforts === undefined) return undefined
  for (const entry of efforts) {
    const id = typeof entry === 'string' ? entry : entry.id
    if (id !== 'off') return id
  }
  return undefined
}

async function extractOnce(
  ctx: ExtractionContext,
  agent: Agent,
  batch: readonly ExtractionSlot[],
  signal: AbortSignal | undefined,
  usageAcc?: UsageAccumulator,
): Promise<ExtractionAttempt> {
  const out = new Map<string, Extraction>()
  const llm = ctx.llm
  if (llm === undefined) return { blocks: out, truncated: false }
  const effective = resolveEffectiveRoute(agent)
  if (effective === undefined) return { blocks: out, truncated: false }

  const parts: string[] = []
  const usedSlots: ExtractionSlot[] = []
  for (const slot of batch) {
    const prose = slot.events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => textOf(event))
      .filter((text) => text.length > 0)
      .join('\n')
    const material = buildExtractionMaterial(
      slot.events,
      prose,
      slot.includeToolResults === true || slot.expanded === true
        ? {
            ...(slot.includeToolResults === true ? { includeToolResults: true } : {}),
            ...(slot.expanded === true ? { expanded: true } : {}),
          }
        : undefined,
    )
    if (material.length === 0) continue
    const headerMeta = slot.expanded === true ? `turn ${slot.turn ?? '?'}, LONG` : `turn ${slot.turn ?? '?'}`
    parts.push(`=== SLOT ${slot.key} (${headerMeta}) ===\n${material}`)
    usedSlots.push(slot)
  }
  if (parts.length === 0) return { blocks: out, truncated: false }

  const call = withCallTimeout(signal, resolveCallTimeoutMs())
  const chunks: string[] = []
  let truncated = false
  try {
    const info = await Promise.resolve()
      .then(() => llm.resolveModelInfo?.(effective.provider, effective.model, call.signal))
      .catch(() => undefined)
    const cheapest = cheapestEffort(info?.reasoning?.efforts)
    const slotOutputBudget = usedSlots.reduce(
      (sum, slot) => sum + (slot.expanded === true ? EXTRACT_TOKENS_PER_LONG_TURN : EXTRACT_TOKENS_PER_TURN),
      0,
    )

    const stream = llm.stream({
      provider: effective.provider,
      model: effective.model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `${parts.join('\n\n')}\n\n${EXTRACT_INSTRUCTION}` }] },
      ],
      maxTokens: slotOutputBudget + EXTRACT_THINKING_RESERVE_TOKENS,
      sessionId: agent.session.id,
      purpose: 'compaction',
      signal: call.signal,
      ...(cheapest === undefined ? {} : { reasoningEffort: ReasoningEffortId(cheapest) }),
    })
    for await (const chunk of stream) {
      const delta = chunk as { type?: string; text?: string; reason?: { kind?: string }; usage?: unknown }
      if (delta.type === 'text-delta' && typeof delta.text === 'string') chunks.push(delta.text)
      else if (delta.type === 'finish') {
        if (delta.reason?.kind === 'max-tokens') truncated = true
        addUsage(usageAcc, delta.usage)
      }
    }
  } catch (error) {
    ctx.logger?.warn(`verbatim-compaction: extraction call failed for ${parts.length} slot(s): ${String(error)}`)
    const abortedOrTimedOut = call.signal.aborted || signal?.aborted === true
    return { blocks: out, truncated: false, transportError: abortedOrTimedOut }
  } finally {
    call.dispose()
  }

  const answer = chunks.join('').trim()
  if (answer.length === 0) return { blocks: out, truncated }
  return { blocks: parseExtraction(answer), truncated }
}

/** Validate a deserialized extraction object before hydrating from disk cache. */
function isValidExtraction(value: unknown): value is Extraction {
  if (value === null || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((item) => typeof item === 'string')
  if (!isStringArray(rec['did']) || !isStringArray(rec['concluded']) || !isStringArray(rec['overturned'])) {
    return false
  }
  const asked = rec['asked']
  if (!Array.isArray(asked)) return false
  return asked.every((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    const pair = entry as Record<string, unknown>
    return typeof pair['question'] === 'string' && isStringArray(pair['options'])
  })
}

/** Trim a plain record to its newest `max` entries in insertion order. */
function trimRecord<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record)
  if (entries.length <= max) return record
  return Object.fromEntries(entries.slice(-max))
}


/**
 * Extractive compaction backend: verbatim user prose, one model call per batch,
 * call.
 *
 * Everything except `summarize()` is inherited. The base class prices pressure,
 * selects the span, writes the durable `compaction/start` ... `compaction/end`
 * pair, applies the shrink guard and records `compaction/summary`, so this
 * subclass cannot diverge from the host's transaction semantics.
 */
export default class VerbatimCompactionEngine extends BasicCompactionEngine {


  /**
   * Extraction results, keyed by a hash of the material they were derived from.
   *
   * `digestSource` rebuilds from the raw log on every compaction, and raw events
   * never leave the log, so the same turn is re-read on every later compaction.
   * Measured on the session that compacted 33 times: 142 turns extracted, 129 of
   * them (91%) already extracted earlier. Across all 370 local sessions, 81% of
   * compaction work is that repeat.
   *
   * Keyed by content, not by slot position: a position holds different content
   * once history grows, so a positional key would serve a stale block. A turn
   * whose prose changed hashes differently and is extracted again.
   *
   * Process-local and bounded. A restart loses it, costing one re-extraction —
   * the same behaviour as before this cache existed.
   */
  private readonly extractionCache = new Map<string, Extraction>()
  /**
   * Folded text, keyed by effective provider, model and a hash of the material folded.
   */
  private readonly condensedCache = new Map<string, string>()
  /** Session ids whose on-disk cache has already been hydrated into memory. */
  private readonly hydratedSessions = new Set<string>()

  private hydrateDiskCache(sessionId: string): void {
    if (this.hydratedSessions.has(sessionId)) return
    this.hydratedSessions.add(sessionId)
    const dir = resolveCacheDir()
    if (dir === undefined) return
    try {
      const raw = readFileSync(cacheFilePath(dir, sessionId), 'utf8')
      const parsed = JSON.parse(raw) as Partial<DiskCachePayload>
      if (parsed.v !== 1) return
      if (parsed.extraction !== undefined && typeof parsed.extraction === 'object' && parsed.extraction !== null) {
        for (const [key, value] of Object.entries(parsed.extraction)) {
          if (isValidExtraction(value)) {
            boundedCacheSet(this.extractionCache, key, value, EXTRACTION_CACHE_MAX)
          }
        }
      }
      if (parsed.condensed !== undefined && typeof parsed.condensed === 'object' && parsed.condensed !== null) {
        for (const [key, value] of Object.entries(parsed.condensed)) {
          if (typeof value === 'string' && value.length > 0) {
            boundedCacheSet(this.condensedCache, key, value, CONDENSED_CACHE_MAX)
          }
        }
      }
    } catch {
      // Cache miss or corrupt file — start cold without failing compaction.
    }
  }

  private persistDiskCache(
    sessionId: string,
    newExtractions: ReadonlyMap<string, Extraction>,
    newCondensed: ReadonlyMap<string, string>,
  ): void {
    if (newExtractions.size === 0 && newCondensed.size === 0) return
    const dir = resolveCacheDir()
    if (dir === undefined) return
    try {
      mkdirSync(dir, { recursive: true })
      const target = cacheFilePath(dir, sessionId)
      let payload: DiskCachePayload = { v: 1, extraction: {}, condensed: {} }
      try {
        const existing = JSON.parse(readFileSync(target, 'utf8')) as Partial<DiskCachePayload>
        if (existing.v === 1) {
          const validExtraction: Record<string, Extraction> = {}
          if (existing.extraction !== undefined && typeof existing.extraction === 'object' && existing.extraction !== null) {
            for (const [key, value] of Object.entries(existing.extraction)) {
              if (isValidExtraction(value)) validExtraction[key] = value
            }
          }
          const validCondensed: Record<string, string> = {}
          if (existing.condensed !== undefined && typeof existing.condensed === 'object' && existing.condensed !== null) {
            for (const [key, value] of Object.entries(existing.condensed)) {
              if (typeof value === 'string' && value.length > 0) validCondensed[key] = value
            }
          }
          payload = { v: 1, extraction: validExtraction, condensed: validCondensed }
        }
      } catch {
        // Fresh cache file.
      }
      payload.extraction ??= {}
      payload.condensed ??= {}
      for (const [key, value] of newExtractions) {
        delete payload.extraction[key]
        payload.extraction[key] = value
      }
      for (const [key, value] of newCondensed) {
        delete payload.condensed[key]
        payload.condensed[key] = value
      }
      payload.extraction = trimRecord(payload.extraction, EXTRACTION_CACHE_MAX)
      payload.condensed = trimRecord(payload.condensed, CONDENSED_CACHE_MAX)
      const tmp = `${target}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, target)
    } catch (error) {
      this.ctx.logger?.warn(`verbatim-compaction: failed to persist cache for ${sessionId}: ${String(error)}`)
    }
  }

  /**
   * Build the replacement checkpoint content from the session log.
   *
   * The budget is the shrink guard's own bound rather than only the fixed
   * ceiling: the guard compares the framed digest against the route price of
   * the span being replaced, so a digest accumulated over a long history
   * against a small span is the one case that can fail. Deriving the budget
   * from that same number makes the failure impossible by construction instead
   * of relying on measurement.
   *
   * @param input - replayed conversation prefix the base class is shadowing.
   * @param agent - owner of the session being compacted.
   * @param signal - cancellation forwarded to the extraction and fold calls.
   * @returns text summary blocks, route metadata, and aggregated LLM usage.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const session = agent.session
    this.hydrateDiskCache(session.id)
    const shadowed = shadowedSeqs(session, input)
    const shadowedSet = new Set(shadowed)
    const retained = new Set(session.surface.nodes.filter((seq) => !shadowedSet.has(seq)))
    const source = digestSource(session, retained)

    let shadowedPrice = 0
    for (const node of this.ctx.tokenMeter.measure(session).nodes) {
      if (shadowedSet.has(node.seq)) shadowedPrice += node.tokens
    }
    // Absolute ceiling, floored by the shrink guard. The ceiling keeps the digest
    // size independent of history length; the guard bound only exists for the
    // degenerate case of a span smaller than the ceiling.
    const budget = Math.max(
      0,
      Math.min(DIGEST_TOKEN_CEILING, shadowedPrice - FRAME_TOKENS - SHRINK_MARGIN_TOKENS),
    )

    const usageAcc = createUsageAccumulator()
    const extracted = await this.extractAll(source, agent, signal, usageAcc)

    // Check overflow against the *unclipped* digest. Measuring `renderDigest(source, budget, extracted)`
    // was always <= `budget * 4` because `renderDigest` clips to budget, making `condenseOldest` dead code.
    let condensed: ReadonlyMap<string, Condensed> | undefined
    const unclippedLength = renderDigest(source, Math.floor(Number.MAX_SAFE_INTEGER / 4), extracted).length
    if (unclippedLength > budget * 4) {
      condensed = await this.condenseOldest(source, extracted, agent, budget, signal, usageAcc)
    }
    // The fold path returns its digest whole, so it can still overflow when every
    // group has been folded and the user lines alone are too long. The budget is a
    // contract the host's shrink guard depends on, so that case falls back to the
    // ladder: a degraded digest beats an over-budget one. The fold is the better
    // outcome, not the only permitted one.
    let text = renderDigest(source, budget, extracted, condensed)
    if (text.length > budget * 4) {
      this.ctx.logger?.warn(
        `verbatim-compaction: digest still over budget after folding ${condensed?.size ?? 0} group(s) `
        + `(${text.length} > ${budget * 4} chars), falling back to the graded ladder`,
      )
      text = renderDigest(source, budget, extracted)
    }

    const effective = resolveEffectiveRoute(agent)
    const route = session.requestHeader()?.config
    const usage = toTokenUsage(usageAcc)
    return {
      summary: [{ type: 'text', text }],
      provider: effective?.provider ?? route?.provider ?? agent.options.provider ?? 'verbatim',
      model: effective?.model ?? route?.model ?? agent.options.model ?? 'digest',
      ...(usage === undefined ? {} : { usage }),
    }
  }

  /**
   * Fold the oldest turns into condensed blocks until the digest fits.
   *
   * Only reached when the unclipped plain digest overflows `budget`. The oldest
   * turns are the right ones to fold: they describe work already superseded, while
   * the newest are what the next request depends on.
   */
  private async condenseOldest(
    source: readonly SessionEvent[],
    extracted: ReadonlyMap<string, Extraction>,
    agent: Agent,
    budget: number,
    signal: AbortSignal | undefined,
    usageAcc?: UsageAccumulator,
  ): Promise<ReadonlyMap<string, Condensed>> {
    const sections = withExtractions(buildSections(source), extracted)
    const budgetChars = budget * 4
    const out = new Map<string, Condensed>()

    for (const start of foldGroupStarts(sections.length)) {
      if (signal?.aborted === true) break
      const group = sections.slice(start, start + CONDENSE_GROUP)
      if (group.length === 0) continue
      const text = await this.condenseGroup(group, agent, signal, usageAcc)
      if (text === undefined) continue
      out.set(turnKey(start, 0), { text, covers: group.length })
      if (renderDigest(source, budget, extracted, out).length <= budgetChars) return out
    }
    return out
  }

  /**
   * Hand one group of turns to the model and return its folded text.
   */
  private async condenseGroup(
    group: readonly Section[],
    agent: Agent,
    signal: AbortSignal | undefined,
    usageAcc?: UsageAccumulator,
  ): Promise<string | undefined> {
    const material = group
      .map((section) => section.turns
        .map((turn) => {
          const block = renderExtractionBlock(turn.extracted)
          return block.length > 0 ? block : turn.assistant.join('\n')
        })
        .filter((block) => block.length > 0)
        .join('\n'))
      .filter((block) => block.length > 0)
      .join('\n\n')
    if (material.length === 0) return undefined

    const llm = this.ctx.llm
    if (llm === undefined) return undefined
    const effective = resolveEffectiveRoute(agent)
    if (effective === undefined) return undefined

    const key = `${effective.provider}:${effective.model}:${hashText(material)}`
    const cached = boundedCacheGet(this.condensedCache, key)
    if (cached !== undefined) return cached

    const text = await condenseOnce(this.ctx, agent, material, signal, usageAcc)
    if (text === undefined) return undefined
    boundedCacheSet(this.condensedCache, key, text, CONDENSED_CACHE_MAX)
    this.persistDiskCache(agent.session.id, new Map(), new Map([[key, text]]))
    return text
  }

  /**
   * Run the extraction for every section in the digest source.
   *
   * Uses `buildSectionsWithEvents` as the single source of truth so slot keys can
   * never drift out of alignment with rendered sections. Uncached batches execute
   * with bounded concurrency (`EXTRACT_CONCURRENCY`), and newly extracted entries
   * are persisted to the per-session disk cache.
   */
  private async extractAll(
    source: readonly SessionEvent[],
    agent: Agent,
    signal: AbortSignal | undefined,
    usageAcc?: UsageAccumulator,
  ): Promise<Map<string, Extraction>> {
    const { sections, sectionEvents } = buildSectionsWithEvents(source)
    const singleSection = sections.length === 1
    const slots: ExtractionSlot[] = []
    for (const [sectionIndex, section] of sections.entries()) {
      const first = section.turns[0]
      if (first === undefined) continue
      const events = sectionEvents[sectionIndex] ?? []
      let toolCallCount = 0
      const proseParts: string[] = []
      for (const ev of events) {
        if (ev.type !== 'assistant/message') continue
        toolCallCount += toolCallsOf(ev).length
        const t = textOf(ev)
        if (t.length > 0) proseParts.push(t)
      }
      const prose = proseParts.join('\n')
      const includeToolResults = singleSection
        && toolCallCount >= SINGLE_TURN_TOOL_HEAVY_CALLS
        && prose.length <= SINGLE_TURN_TOOL_HEAVY_PROSE_MAX
      const expanded = isExpandedTurn(events, prose)
      slots.push({
        key: turnKey(sectionIndex, 0),
        turn: first.turn,
        events,
        ...(includeToolResults ? { includeToolResults: true } : {}),
        ...(expanded ? { expanded: true } : {}),
      })
    }

    const effective = resolveEffectiveRoute(agent)
    const routePrefix = effective === undefined ? '' : `${effective.provider}:${effective.model}:`
    const cacheKeyFor = (slot: ExtractionSlot): string => {
      const opts = slot.includeToolResults === true || slot.expanded === true
        ? {
            ...(slot.includeToolResults === true ? { includeToolResults: true } : {}),
            ...(slot.expanded === true ? { expanded: true } : {}),
          }
        : undefined
      return `${routePrefix}${slot.includeToolResults === true ? 'tr:' : ''}${slot.expanded === true ? 'long:' : ''}${materialKey(slot.events, opts)}`
    }

    const extracted = new Map<string, Extraction>()
    const missing: ExtractionSlot[] = []
    for (const slot of slots) {
      const cached = boundedCacheGet(this.extractionCache, cacheKeyFor(slot))
      if (cached === undefined) missing.push(slot)
      else extracted.set(slot.key, cached)
    }

    const batches: ExtractionSlot[][] = []
    let currentBatch: ExtractionSlot[] = []
    for (const slot of missing) {
      if (slot.expanded === true) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch)
          currentBatch = []
        }
        batches.push([slot])
        continue
      }
      currentBatch.push(slot)
      if (currentBatch.length >= TURNS_PER_CALL) {
        batches.push(currentBatch)
        currentBatch = []
      }
    }
    if (currentBatch.length > 0) batches.push(currentBatch)

    const newlyExtracted = new Map<string, Extraction>()
    let nextBatch = 0
    const workerCount = Math.min(EXTRACT_CONCURRENCY, batches.length)
    const worker = async (): Promise<void> => {
      while (nextBatch < batches.length) {
        if (signal?.aborted === true) break
        const batch = batches[nextBatch]
        nextBatch += 1
        if (batch === undefined) break
        const blocks = await extractBatch(this.ctx, agent, batch, signal, usageAcc)
        for (const slot of batch) {
          const block = blocks.get(slot.key)
          if (block === undefined) continue
          extracted.set(slot.key, block)
          const ckey = cacheKeyFor(slot)
          boundedCacheSet(this.extractionCache, ckey, block, EXTRACTION_CACHE_MAX)
          newlyExtracted.set(ckey, block)
        }
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    this.persistDiskCache(agent.session.id, newlyExtracted, new Map())
    return extracted
  }
}

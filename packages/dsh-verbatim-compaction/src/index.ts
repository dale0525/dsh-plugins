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
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
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

/** Framing overhead `frameSummary` adds: preamble plus both tags, 341 chars = 86 tokens. */
const FRAME_TOKENS = 86

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
function goalObjective(event: SessionEvent): string | undefined {
  if (sourceKind(event) !== 'goal') return undefined
  const text = textOf(event)
  const match = /Objective:\s*"([\s\S]*?)"/.exec(text)
  // The objective arrives with its newlines already escaped inside the JSON
  // string, so a seven-item list reaches the digest as one unreadable line.
  const objective = (match?.[1] ?? '').replace(/\\n/g, '\n').trim()
  return objective.length > 0 ? objective : undefined
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

/**
 * The answer the user gave to one `ask_user_question` call, or undefined.
 *
 * The answer is the tool's own result — `{"answers":[{"id":"…","selected":[…]}]}`
 * — not an error, so without this the result was skipped and the only record of
 * what the user chose never reached the extractor. The user's next message is
 * often just "1" or "继续", which is unreadable without the question beside it.
 *
 * @param event - any event; non-results and unrelated results yield undefined.
 * @param askedIds - tool-call ids of this turn's questions.
 * @returns the chosen labels, or undefined when this result answers no question.
 */
function answerOf(event: SessionEvent, askedIds: ReadonlySet<string>): string | undefined {
  if (askedIds.size === 0) return undefined
  const message = messageOf(event)
  if (message === null) return undefined
  const callId = (message as { toolCallId?: string }).toolCallId
  if (callId === undefined || !askedIds.has(callId)) return undefined
  const text = textOf(event)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const answers = (parsed as Record<string, unknown>)['answers']
  if (!Array.isArray(answers)) return undefined
  const chosen = answers
    .flatMap((answer) => {
      if (typeof answer !== 'object' || answer === null) return []
      const record = answer as Record<string, unknown>
      const selected = record['selected']
      const picked = Array.isArray(selected) ? selected.map((value) => String(value)) : []
      // A typed answer arrives with `selected: []` and the text in `custom`. Ten
      // of 31 real questions were answered this way, and those carried the user's
      // actual observations rather than a menu label.
      const typed = typeof record['custom'] === 'string' ? [record['custom']] : []
      return [...picked, ...typed]
    })
    .filter((value) => value.length > 0)
  if (chosen.length === 0) return undefined
  return chosen.join(' / ').replace(/\s+/g, ' ').slice(0, HINT_CHARS * 2)
}

/**
 * Whether one tool result is a failure.
 *
 * Reads `data.message.isError` and nothing else. Matching the serialized text
 * for /error/i was tried and is wrong: tool output routinely contains that word
 * (grep misses, compiler logs, dumps of source files), so it labelled every
 * result in a 347-result turn as failed and the summarizer reported the whole
 * turn as a failure.
 *
 * @param event - a `tool/result` event.
 * @returns true only when the log itself marks the result as an error.
 */
export function isErrorResult(event: SessionEvent): boolean {
  const message = messageOf(event)
  return (message as { isError?: unknown } | null)?.isError === true
}

/** Directive appended as the final user message of the extraction call. */
const EXTRACT_INSTRUCTION = [
  'Reply with ONE JSON object and nothing else. No prose, no code fence, no markdown.',
  'Shape: {"slots":[{"key":"<the slot key>","did":["…"],"concluded":["…"],"overturned":["…"],"asked":[{"question":"…","options":["…"]}]}]}',
  'Rules:',
  '- `key` must be copied exactly from the `=== SLOT <key> ===` line. One entry per slot, in the order given. Never skip a slot.',
  '- `did`: what was done, at most two short strings. `concluded`: findings a later turn needs, at most two. `overturned`: earlier conclusions this turn disproved.',
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
  "- Use [] for `asked` when the turn asked nothing. Do not report the user's reply.",
  '',
  'Write strings in the same language as the material. A session whose requests are Chinese gets Chinese text; do not switch to English.',
].join('\n')

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
  // Models wrap JSON in a fence often enough that stripping it is not defensive
  // programming but the common case.
  const body = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return out
  }
  if (typeof parsed !== 'object' || parsed === null) return out
  const slots = (parsed as Record<string, unknown>)['slots']
  if (!Array.isArray(slots)) return out
  const strings = (value: unknown): string[] => (Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .filter((item) => item.length > 0)
      // A field is a list, so "nothing here" is an empty list. Models still write a
      // placeholder often enough that dropping it is worth one test.
      .filter((item) => !/^(?:\(?none\)?|n\/a|na|-{1,2}|无|沒有|没有)$/i.test(item))
      .filter((item) => !/^(?:未提问|无提问|没有提问|no questions? (?:were |was )?asked|none asked)[。.！!]*$/i.test(item))
    : [])
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
            // list's own `1.` would print `1. 1. …`. Stripped here rather than asked
            // for in the prompt alone: three of five real runs kept it.
            .map((option) => option.replace(/\s+/g, ' ').replace(/^\s*\d{1,2}\s*[.、)]\s*/, '').trim())
            .filter((option) => option.length > 0)
          : []
        return [{ question, options }]
      })
    : [])
  for (const slot of slots) {
    if (typeof slot !== 'object' || slot === null) continue
    const record = slot as Record<string, unknown>
    const key = record['key']
    if (typeof key !== 'string' || key.length === 0) continue
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
 * @returns markdown with a heading per non-empty field; empty string when every
 * field is empty.
 */
export function renderExtractionBlock(extraction: Extraction | undefined, level: number = 3): string {
  if (extraction === undefined) return ''
  const lines: string[] = []
  const section = (heading: string, items: readonly string[] | undefined): void => {
    if (items === undefined || items.length === 0) return
    lines.push(`## ${heading}`, ...items.map((item) => `- ${item}`))
  }
  // `level` is how many of the graded sections survive: 3 keeps all, 2 drops
  // Overturned, 1 keeps only Did, 0 keeps only Asked. Asked is never dropped by
  // the level because it is the one section nothing later can rebuild — the
  // reply arrives in the next turn, but the question and its options exist only
  // here. See `renderDigest` for why the ladder exists at all.
  if (level >= 1) section('Did', extraction.did)
  if (level >= 2) section('Concluded', extraction.concluded)
  if (level >= 3) section('Overturned', extraction.overturned)
  // Asked goes last and its options are listed under it, so the user's reply — the
  // next `## user` line — lands directly under the list it chose from.
  if (extraction.asked.length > 0) {
    lines.push('## Asked')
    for (const pair of extraction.asked) {
      lines.push(`- ${pair.question}`)
      // Indented under the question so a reader cannot mistake an option for a
      // separate question, and numbered so the reply's digit has something to
      // point at.
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
 * Each fold is a model call, so the group size trades calls against compression.
 * Simulated on a 700- and a 1200-turn digest at the measured 8.2% fold ratio:
 *
 *   group  20 → 19 and 52 calls
 *   group  50 →  8 and 21 calls
 *   group 100 →  4 and 11 calls
 *
 * Larger groups fold more text per call, which is also where the ratio holds
 * best: a 20-section group is small enough that the model's own paragraph is a
 * larger share of it. 100 keeps a long session to a handful of calls.
 */
const CONDENSE_GROUP = 100

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

/** Characters kept from one failing result's first line. */
const ERROR_CHARS = 140

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
  // `ask_user_question` carries `questions[]`, not a `description`. Without this
  // branch the hint was the bare tool name, so the extractor never saw what was
  // asked and `## Asked` came out empty or wrong on every turn that used it.
  const questions = parsed['questions']
  if (Array.isArray(questions)) {
    const asked = questions
      .map((question) => {
        if (typeof question !== 'object' || question === null) return ''
        const record = question as Record<string, unknown>
        const text = typeof record['question'] === 'string'
          ? record['question']
          : typeof record['header'] === 'string' ? record['header'] : ''
        const options = Array.isArray(record['options'])
          ? record['options']
            .map((option) => (typeof option === 'object' && option !== null
              ? String((option as Record<string, unknown>)['label'] ?? '')
              : ''))
            .filter((label) => label.length > 0)
          : []
        if (text.length === 0) return ''
        return options.length === 0 ? text : `${text} [options: ${options.join(' / ')}]`
      })
      .filter((text) => text.length > 0)
      .join(' | ')
    if (asked.length > 0) return asked.replace(/\s+/g, ' ').slice(0, HINT_CHARS * 2)
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
 * what was attempted and which attempts failed, which is enough for a model to
 * state the outcome.
 *
 * Bounded on purpose — 500 calls would otherwise produce a prompt larger than the
 * material it summarizes.
 *
 * @param events - one turn's events, in log order.
 * @returns newline-joined hints, or an empty string when the turn has none.
 */
export function collectHints(events: readonly SessionEvent[]): string {
  const lines: string[] = []
  let calls = 0
  // Tool-call ids of this turn's questions, so the matching result can be read as
  // an answer rather than being skipped as a non-error result.
  const askedIds = new Set<string>()
  for (const event of events) {
    // Tool calls are blocks inside `assistant/message`, not standalone events:
    // `digestSource` emits no `tool/call` type at all, so selecting on that type
    // matched nothing and a 342-call turn produced a single hint line.
    if (event.type === 'assistant/message') {
      for (const call of toolCallsOf(event)) {
        // A question is never dropped by the cap. It is the only record of what was
        // asked, and its answer is matched by call id rather than by the cap, so
        // dropping the question left an orphan ANSWER line with nothing beside it —
        // a real turn made 292 calls, the question came late, and the user's choice
        // never reached the digest.
        const isQuestion = call.name === 'ask_user_question'
        if (!isQuestion) {
          if (calls >= MAX_HINTS_PER_TURN) break
          calls += 1
        }
        const hint = hintOf(call.arguments)
        lines.push(hint.length > 0 ? `TOOL ${call.name}: ${hint}` : `TOOL ${call.name}`)
        if (isQuestion) askedIds.add(call.id)
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    // The answer to a question is the tool's own result, not an error. It is the
    // only record of what the user chose, and the next user message is often just
    // "1" — so it has to travel with the question.
    const answered = answerOf(event, askedIds)
    if (answered !== undefined) {
      lines.push(`ANSWER: ${answered}`)
      continue
    }
    if (!isErrorResult(event)) continue
    const firstLine = textOf(event).split('\n')[0] ?? ''
    if (firstLine.trim().length === 0) continue
    lines.push(`ERR ${firstLine.trim().slice(0, ERROR_CHARS)}`)
  }
  return lines.join('\n')
}

/** The `path` argument of one tool call, when the call carries one. */
function pathArgumentOf(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const path = (parsed as { path?: unknown }).path
    return typeof path === 'string' ? path : undefined
  } catch {
    return undefined
  }
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
  tools: Map<string, number>
  resultBytes: number
  errors: string[]
  writes: string[]
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
  return { turn, fromRequest, user: [], assistant: [], tools: new Map(), resultBytes: 0, errors: [], writes: [] }
}

/**
 * Group append-origin surface events into per-turn digest material.
 *
 * A section starts at each non-injected user message; assistant-only runs
 * before the first user message join the first section. Turn numbers come from
 * the log: `turn/start` carries `{turn}` and `assistant/message` carries
 * `data.turn`. A user message carries no turn of its own, so it inherits the
 * last one seen.
 *
 * @param events - the digest source in log order.
 * @returns one section per non-injected user message.
 */
export function buildSections(events: readonly SessionEvent[]): Section[] {
  const sections: Section[] = []
  let current: Section | undefined
  let currentTurn: Turn | undefined
  let lastTurn: number | undefined

  const openTurn = (turn: number | undefined, fromRequest: boolean = false): Turn => {
    if (current === undefined) {
      current = { turns: [] }
      sections.push(current)
    }
    const next = emptyTurn(turn, fromRequest)
    current.turns.push(next)
    if (turn !== undefined) lastTurn = turn
    return next
  }

  // One objective per section, and never twice: the host re-injects the same
  // objective on every round, so recording each copy would repeat it dozens of
  // times across a long autonomous run.
  const recordedObjectives = new Set<string>()


  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = turnOf(event)
      if (turn !== undefined) lastTurn = turn
      continue
    }
    const objective = goalObjective(event)
    if (objective !== undefined) {
      if (current === undefined) {
        current = { turns: [] }
        sections.push(current)
      }
      if (recordedObjectives.has(objective)) continue
      recordedObjectives.add(objective)
      // A goal round opens a section like a user request does, and its objective
      // takes the user slot: it is the request this turn serves.
      current = { turns: [] }
      sections.push(current)
      currentTurn = openTurn(turnOf(event) ?? lastTurn, false)
      currentTurn.user.push(objective)
      continue
    }
    if (event.type === 'tool/result') {
      if (currentTurn === undefined) continue
      const text = textOf(event)
      currentTurn.resultBytes += text.length
      const message = messageOf(event)
      if ((message as { isError?: boolean } | null)?.isError === true) {
        const firstLine = text.split('\n')[0] ?? ''
        currentTurn.errors.push(firstLine.slice(0, 100))
      }
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (isInjection(event) || isCheckpoint(event)) continue

    const eventTurn = turnOf(event) ?? lastTurn
    if (event.type === 'user/message') {
      // A user message opens a new section, not merely a new turn: sections are
      // what the digest headings delimit, and one section per user request is
      // what makes the digest readable after a hundred turns.
      current = { turns: [] }
      sections.push(current)
      currentTurn = openTurn(eventTurn, true)
      const text = textOf(event)
      if (text.length > 0) currentTurn.user.push(text)
      continue
    }
    // A user message carries no `turn` field while the reply carries one, so a
    // plain turn-number comparison opened a second turn for the same request: every
    // real section ended up with an empty request turn plus a reply turn holding no
    // user text, and the digest printed `## user` and `### assistant` twice.
    //
    // The turn number only separates work when the current turn already holds some,
    // i.e. when the log really moved on to a later turn.
    // A section is one request, so it is one turn. The log keeps advancing the turn
    // number inside a single request (7 assistant messages as turn 2, then 9 more as
    // turn 3), and splitting on the number gave every section a second turn whose
    // block was the tail of the same request's prose.
    if (currentTurn === undefined) currentTurn = openTurn(eventTurn ?? lastTurn)
    const text = textOf(event)
    if (text.length > 0) currentTurn.assistant.push(text)
    for (const call of toolCallsOf(event)) {
      currentTurn.tools.set(call.name, (currentTurn.tools.get(call.name) ?? 0) + 1)
      if (!WRITE_TOOLS.has(call.name)) continue
      const path = pathArgumentOf(call.arguments)
      if (path !== undefined && !currentTurn.writes.includes(path)) currentTurn.writes.push(path)
    }
  }
  return sections
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
function materialKey(events: readonly SessionEvent[]): string {
  const prose = events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => textOf(event))
    .filter((text) => text.length > 0)
    .join('\n')
  return hashText(buildExtractionMaterial(events, prose))
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
function renderSection(
  section: Section,
  level: number,
  condensed: ReadonlyMap<string, Condensed> | undefined,
  sectionIndex: number,
): string {
  const lines: string[] = []
  // The block that covers this section, if any. Looked up by scanning the keys
  // rather than by probing one key per turn: a fold spans whole sections, so the
  // covering key belongs to an earlier section, not to this turn's own key.
  const index = sectionIndex ?? 0
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
    // The user line stays: a request is a standing constraint. Only the first
    // covered section prints the folded text — the rest contribute their user
    // lines alone, which is the room the condensation buys.
    const start = Number(covering.key.split(':')[0])
    for (const turn of section.turns) {
      if (turn.user.length > 0) lines.push(`\n## user\n${turn.user.join('\n')}`)
    }
    if (index === start) {
      const range = covering.block.covers <= 1
        ? `section ${start + 1}`
        : `sections ${start + 1}-${start + covering.block.covers}`
      lines.push(`\n### assistant\n## Condensed (condensed from ${range})\n- ${covering.block.text}`)
    }
    return lines.join('\n')
  }
  for (const [turnIndex, turn] of section.turns.entries()) {
    if (turn.user.length > 0) lines.push(`\n## user\n${turn.user.join('\n')}`)
    // An extraction whose every field is empty renders nothing: a heading followed by
    // no body reads as a turn that did something but says nothing.
    if (turn.extracted !== undefined && renderExtractionBlock(turn.extracted, level).length > 0) {
      const block = renderExtractionBlock(turn.extracted, level)
      // The trailer goes *above* the block, not below it. `## Asked` is the block's
      // last section and the user's reply is the very next line, so an errors line
      // in between would separate the reply from the question it answers.
      const trailer: string[] = []
      if (turn.errors.length > 0) {
        trailer.push(`  errors: ${turn.errors.length}: ${turn.errors.slice(0, 3).join(' | ')}`)
      }
      if (turn.writes.length > 0) trailer.push(`  wrote: ${turn.writes.join(', ')}`)
      const body = trailer.length > 0 ? `${trailer.join('\n')}\n${block}` : block
      lines.push(`### assistant\n${body}`)
    } else {
      const body = turn.assistant.join('\n')
      if (body.length > 0) lines.push(`### assistant\n${body}`)
      if (turn.errors.length > 0) {
        lines.push(`  errors: ${turn.errors.length}: ${turn.errors.slice(0, 3).join(' | ')}`)
      }
      if (turn.writes.length > 0) lines.push(`  wrote: ${turn.writes.join(', ')}`)
    }
  }
  return lines.join('\n')
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
  const sections = extracted === undefined ? buildSections(events) : withExtractions(buildSections(events), extracted)
  const budgetChars = Math.max(0, budgetTokens * 4)

  const render = (trimmed?: Section[], level: number = 3): string =>
    (trimmed ?? sections)
      .map((section, index) => renderSection(section, level, condensed, index))
      .join('\n')

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
      target.errors = []
      target.writes = []
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
  const bare: Turn = { ...keeperTurn, assistant: [], errors: [], writes: [] }
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
  const head = nodes[0] !== undefined && session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  const take = Math.max(0, input.messages.length - head)
  return nodes.slice(head, head + take)
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
export function buildExtractionMaterial(turn: readonly SessionEvent[], prose: string): string {
  const userRequest = turn
    .filter((event) => event.type === 'user/message' && !isInjection(event) && !isCheckpoint(event))
    .map((event) => textOf(event))
    .filter((text) => text.length > 0)
    .join('\n')
  const hints = collectHints(turn)
  if (userRequest.length === 0 && prose.length === 0 && hints.length === 0) return ''
  return [
    `USER INSTRUCTION (already in the digest verbatim; never copy it into Asked):\n${userRequest.slice(0, 4000) || '(none)'}`,
    `ASSISTANT PROSE:\n${prose.slice(0, 6000) || '(none)'}`,
    `TOOL TRACE:\n${hints || '(none)'}`,
  ].join('\n\n')
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
async function condenseOnce(
  ctx: ExtractionContext,
  agent: Agent,
  material: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const llm = ctx.llm
  if (llm === undefined) {
    ctx.logger?.warn('verbatim-compaction: no llm service, condensation skipped')
    return undefined
  }
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  if (provider === undefined || model === undefined) {
    ctx.logger?.warn('verbatim-compaction: no route for condensation, skipped')
    return undefined
  }

  const info = await Promise.resolve()
    .then(() => llm.resolveModelInfo?.(provider, model, signal))
    .catch(() => undefined)
  const cheapest = cheapestEffort(info?.reasoning?.efforts)

  const chunks: string[] = []
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: `${material}\n\n${CONDENSE_INSTRUCTION}` }] }],
      maxTokens: CONDENSE_TOKENS,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(cheapest === undefined ? {} : { reasoningEffort: cheapest }),
      ...(signal === undefined ? {} : { signal }),
    })
    for await (const chunk of stream) {
      const delta = chunk as { type?: string; text?: string }
      if (delta.type === 'text-delta' && typeof delta.text === 'string') chunks.push(delta.text)
    }
  } catch (error) {
    ctx.logger?.warn(`verbatim-compaction: condensation call failed: ${String(error)}`)
    return undefined
  }
  const text = chunks.join('').trim()
  if (text.length === 0) {
    // Silence here is what makes "the digest stopped folding" invisible at runtime:
    // the summary still renders, just without the room the fold would have bought.
    ctx.logger?.warn(`verbatim-compaction: condensation returned no text for ${material.length} chars of material`)
    return undefined
  }
  return text
}

async function extractBatch(
  ctx: ExtractionContext,
  agent: Agent,
  batch: readonly ExtractionSlot[],
  signal?: AbortSignal,
): Promise<Map<string, Extraction>> {
  const out = new Map<string, Extraction>()
  if (batch.length === 0) return out

  const attempt = await extractOnce(ctx, agent, batch, signal)
  if (!attempt.truncated) {
    if (attempt.blocks.size === 0) {
      ctx.logger?.warn(
        `verbatim-compaction: extraction returned no usable JSON for ${batch.length} slot(s) `
        + `(${batch.map((slot) => slot.key).join(', ')}); those turns keep their verbatim prose`,
      )
    }
    return attempt.blocks
  }

  // A truncated answer parses to nothing, so one over-budget turn would cost
  // every turn in its batch. Measured on 191 real compactions, failures arrived
  // in runs of exactly `TURNS_PER_CALL`, which is this batching, not the model
  // failing per turn. Halving bounds the loss to the half that still does not
  // fit, and a single slot cannot be split further.
  if (batch.length === 1) {
    ctx.logger?.warn(
      `verbatim-compaction: extraction truncated at the token cap for slot ${batch[0]?.key ?? '?'}; `
      + 'that turn keeps its verbatim prose',
    )
    return attempt.blocks
  }
  for (const [key, block] of attempt.blocks) out.set(key, block)
  const middle = Math.ceil(batch.length / 2)
  for (const half of [batch.slice(0, middle), batch.slice(middle)]) {
    for (const [key, block] of await extractBatch(ctx, agent, half, signal)) out.set(key, block)
  }
  return out
}

/** One slot handed to an extraction call. */
interface ExtractionSlot {
  key: string
  turn: number | undefined
  events: readonly SessionEvent[]
}

/** What one extraction call produced, and whether the answer was cut short. */
interface ExtractionAttempt {
  blocks: Map<string, Extraction>
  truncated: boolean
}

/** The slice of the plugin context an extraction call needs. */
interface ExtractionContext {
  llm?: {
    stream: (options: any) => AsyncIterable<any>
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<any>
  }
  logger?: { warn: (message: string) => void }
}

/**
 * The cheapest effort a route advertises, or undefined when it advertises none.
 *
 * The route's own default is not used: it is typically the highest level, and
 * thinking is paid out of the answer's token budget. The list is ordered from
 * least to greatest effort by the host's own contract, so the first entry is the
 * cheapest. `off` is skipped even when present — pi-ai maps it to a wire value
 * the route may reject, and a level that cannot be sent is worse than a cheap
 * one that can.
 *
 * @param efforts - the route's advertised efforts, in escalation order.
 * @returns the cheapest usable effort id, or undefined to leave the choice alone.
 */
function cheapestEffort(efforts: readonly { id: string }[] | undefined): string | undefined {
  return efforts?.find((entry) => entry.id !== 'off')?.id
}

/**
 * One extraction request, no retry.
 *
 * The cap must carry a fixed thinking reserve on top of the per-slot output
 * budget. `maxTokens` covers thinking and the answer together, and thinking is
 * a per-call cost that does not shrink when the batch does. Measured against the
 * live route (deepseek-flash, `reasoning_effort` unset, real-length material):
 * a single slot at the old `220 x 1` cap returned zero parseable slots in 4 of 4
 * runs, the thinking block having consumed the entire cap; the same single slot
 * at `220 x 1 + 1000` parsed in 4 of 4. The reserve is what makes the cap work
 * for a batch of any size, including the batches the caller splits down to.
 *
 * The effort is pinned to the route's cheapest advertised level rather than left
 * to the route default. Thinking is paid out of the same `maxTokens` as the
 * answer, so a default that thinks hard shrinks the answer budget even with the
 * reserve in place. Measured on the live route at a 2-slot cap with the reserve:
 * `low` spent 375 thinking tokens and parsed 3 of 3; `high` spent 931 and parsed
 * 2 of 3.
 *
 * Two things that look like fixes and are not:
 *
 *   - `off` cannot be reached through pi-ai. Its `deepseek` thinking format maps
 *     the `off` level to `reasoning_effort: "minimal"`, which the route rejects
 *     outright (`valid levels: low, medium, high`), and its `thinking` field is
 *     pinned to `{type: "enabled"}` for every level. Captured from pi-ai 1.3.0
 *     against a local echo server, not inferred.
 *   - Only the provider's own `thinking: {type: "disabled"}` actually stops
 *     thinking (0 thinking tokens, measured), but `GenerateOptions` has no field
 *     that carries it, so no plugin on this seam can send it.
 *
 * An effort is requested only when the route advertises it, because the host
 * rejects one it does not.
 *
 * @param ctx - plugin context carrying the `llm` service and a logger.
 * @param agent - owner of the session being compacted.
 * @param batch - slots to ask about in this one call.
 * @param signal - cancellation forwarded to the adapter.
 * @returns the parsed blocks and whether the model stopped at the token cap.
 */
async function extractOnce(
  ctx: ExtractionContext,
  agent: Agent,
  batch: readonly ExtractionSlot[],
  signal?: AbortSignal,
): Promise<ExtractionAttempt> {
  const out = new Map<string, Extraction>()
  const llm = ctx.llm
  if (llm === undefined) return { blocks: out, truncated: false }
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  if (provider === undefined || model === undefined) return { blocks: out, truncated: false }

  // The label the model echoes back is the slot key, not the turn number: two
  // requests can share a number, and a duplicate label would collapse two blocks
  // into one entry.
  const parts: string[] = []
  for (const slot of batch) {
    const prose = slot.events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => textOf(event))
      .filter((text) => text.length > 0)
      .join('\n')
    const material = buildExtractionMaterial(slot.events, prose)
    if (material.length === 0) continue
    parts.push(`=== SLOT ${slot.key} (turn ${slot.turn ?? '?'}) ===\n${material}`)
  }
  if (parts.length === 0) return { blocks: out, truncated: false }

  const info = await Promise.resolve()
    .then(() => llm.resolveModelInfo?.(provider, model, signal))
    .catch(() => undefined)
  const cheapest = cheapestEffort(info?.reasoning?.efforts)

  const chunks: string[] = []
  let truncated = false
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `${parts.join('\n\n')}\n\n${EXTRACT_INSTRUCTION}` }] },
      ],
      maxTokens: EXTRACT_TOKENS_PER_TURN * parts.length + EXTRACT_THINKING_RESERVE_TOKENS,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(cheapest === undefined ? {} : { reasoningEffort: cheapest }),
      ...(signal === undefined ? {} : { signal }),
    })
    for await (const chunk of stream) {
      const delta = chunk as { type?: string; text?: string; reason?: { kind?: string } }
      if (delta.type === 'text-delta' && typeof delta.text === 'string') chunks.push(delta.text)
      else if (delta.type === 'finish' && delta.reason?.kind === 'max-tokens') truncated = true
    }
  } catch (error) {
    ctx.logger?.warn(`verbatim-compaction: extraction call failed for ${parts.length} slot(s): ${String(error)}`)
    return { blocks: out, truncated: false }
  }

  const answer = chunks.join('').trim()
  if (answer.length === 0) return { blocks: out, truncated }
  return { blocks: parseExtraction(answer), truncated }
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
   * Folded text, keyed by provider, model and a hash of the material folded.
   *
   * Same reasoning as `extractionCache`: the fold is a model call over material
   * rebuilt from the raw log on every compaction, so the same run of old turns is
   * re-folded on every later compaction unless it is remembered.
   */
  private readonly condensedCache = new Map<string, string>()
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
   * @returns text summary blocks, unmarked by any LLM call.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const session = agent.session
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

    const extracted = await this.extractAll(source, agent, signal)

    // Fold the oldest turns up only when the plain digest overflows. The fold is an
    // LLM call, so a digest that already fits must not pay for one.
    let condensed: ReadonlyMap<string, Condensed> | undefined
    if (renderDigest(source, budget, extracted).length > budget * 4) {
      condensed = await this.condenseOldest(source, extracted, agent, budget, signal)
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

    const route = session.requestHeader()?.config
    return {
      summary: [{ type: 'text', text }],
      provider: route?.provider ?? agent.options.provider ?? 'verbatim',
      model: route?.model ?? agent.options.model ?? 'digest',
    }
  }

  /**
   * Fold the oldest turns into condensed blocks until the digest fits.
   *
   * Only reached when the plain digest overflows `budget`. The oldest turns are
   * the right ones to fold: they describe work already superseded, while the
   * newest are what the next request depends on.
   *
   * Linear in groups, not bisected: a fold is not monotone in how much is folded —
   * a paragraph's length depends on what the model chose to keep — so there is no
   * boundary to bisect. The walk stops at the first size that fits, which is the
   * fewest calls that buy enough room. Each block covers `CONDENSE_GROUP`
   * consecutive sections, so the number of calls is proportional to the digest,
   * not to the number of turns.
   *
   * Cached by content, like the extraction: the same prefix of turns folds to the
   * same text, and a later compaction re-reads the same history.
   *
   * @param source - digest source events, in log order.
   * @param extracted - per-turn extractions already computed.
   * @param agent - owner of the session being compacted.
   * @param budget - token budget the digest must fit.
   * @param signal - cancellation forwarded to every call.
   * @returns condensed blocks keyed by the `turnKey` of the first covered section.
   */
  private async condenseOldest(
    source: readonly SessionEvent[],
    extracted: ReadonlyMap<string, Extraction>,
    agent: Agent,
    budget: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, Condensed>> {
    const sections = withExtractions(buildSections(source), extracted)
    const budgetChars = budget * 4
    const out = new Map<string, Condensed>()

    // One group per iteration, oldest first, checking after each whether the digest
    // fits. Single loop, `start` monotone: the earlier two-level form advanced its
    // inner start from `out.size`, so a group whose call failed was retried on every
    // outer pass (45 calls instead of 4 with the model down), and the outer bound
    // `covered < sections.length` stopped one group short of the end — at 700
    // sections the last 100 were never folded, and at 100 or fewer the loop body
    // never ran at all.
    for (const start of foldGroupStarts(sections.length)) {
      if (signal?.aborted === true) break
      const group = sections.slice(start, start + CONDENSE_GROUP)
      if (group.length === 0) continue
      const text = await this.condenseGroup(group, agent, signal)
      // A failed group is skipped rather than retried: the next group still buys
      // room, and retrying the same material against a failing model only spends
      // calls. The remaining turns keep their own blocks either way.
      if (text === undefined) continue
      out.set(turnKey(start, 0), { text, covers: group.length })
      if (renderDigest(source, budget, extracted, out).length <= budgetChars) return out
    }
    return out
  }

  /**
   * Hand one group of turns to the model and return its folded text.
   *
   * @param group - consecutive sections to fold into one paragraph.
   * @param agent - owner of the session being compacted.
   * @param signal - cancellation forwarded to the call.
   * @returns the folded paragraph, or undefined when the call produced nothing.
   */
  private async condenseGroup(
    group: readonly Section[],
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    // Both sources, because a turn has one or the other: extraction succeeds and
    // the block replaces the prose, or it fails and the verbatim prose is what the
    // digest shows. Reading only `extracted` meant a run of turns whose extraction
    // failed contributed nothing — and because the fold then still replaced them,
    // their content vanished from the digest entirely rather than merely being
    // summarised badly.
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
    const route = agent.session.requestHeader()?.config
    const provider = route?.provider ?? agent.options.provider
    const model = route?.model ?? agent.options.model
    if (provider === undefined || model === undefined) return undefined

    const key = `${provider}:${model}:${hashText(material)}`
    const cached = this.condensedCache.get(key)
    if (cached !== undefined) return cached

    const text = await condenseOnce(this.ctx, agent, material, signal)
    if (text === undefined) return undefined
    this.condensedCache.set(key, text)
    return text
  }

  /**
   * Run the extraction for every turn in the digest source.
   *
   * Sequential rather than parallel: these calls share the session's routed
   * model and the provider's KV cache, and firing a dozen at once would both
   * multiply the cost and defeat the cache the host's own summarizer relies on.
   *
   * A turn that fails is simply absent from the output; one bad turn must not
   * drop the extraction for the rest.
   *
   * Batched rather than one call per turn. One call per turn meant 131 calls on a
   * 122-turn session, each with its own round trip: a measured extraction budget
   * of 131 x 400 tokens could on its own exceed the whole digest ceiling. A
   * batch of `TURNS_PER_CALL` turns costs one round trip and shares the prompt
   * prefix, so the provider's KV cache is reused rather than rebuilt.
   *
   * @param source - digest source events, in log order.
   * @param agent - owner of the session being compacted.
   * @param signal - cancellation forwarded to every call.
   * @returns turn number to extracted block, omitting turns that yielded none.
   */
  private async extractAll(
    source: readonly SessionEvent[],
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<Map<string, Extraction>> {
    // Walk the same sections the renderer will use, so a key addresses the exact
    // slot the block will be written into. Grouping by turn number instead lost
    // blocks whenever the log reused a number.
    // Partition the source into the same sections `buildSections` produced, then
    // hand each section to its slot. A slot is a section, not a single message:
    // the earlier version stopped at the first message, so a turn with 69
    // assistant messages and 112 tool calls contributed 2 events out of 164 and
    // the extractor reported "no work observed" for a turn that did plenty.
    const sections = buildSections(source)
    // Attribute events to sections by replaying the same walk `buildSections`
    // does, so the two can never disagree about where a section starts. An
    // independent scan drifted by one section on the fixture: `buildSections`
    // opens a new section for an unclosed turn without consuming a user message.
    const grouped: SessionEvent[][] = []
    let sectionIndex = -1
    const openedObjectives = new Set<string>()
    for (const event of source) {
      const objective = goalObjective(event)
      let startsSection = false
      if (objective !== undefined) {
        if (!openedObjectives.has(objective)) {
          openedObjectives.add(objective)
          startsSection = true
        }
      } else if (event.type === 'user/message' && !isInjection(event) && !isCheckpoint(event)) {
        startsSection = true
      }
      if (startsSection) {
        sectionIndex += 1
        grouped[sectionIndex] = []
      }
      if (sectionIndex >= 0) grouped[sectionIndex]?.push(event)
    }

    // One slot per section, addressed to the section's first turn.
    //
    // The material is about what the section did as a whole, so handing it to
    // every turn in the section made the model answer twice with the same block:
    // a real section holding two turns produced two identical `## Concluded`
    // bodies plus `(duplicate of SLOT 4:0)` placeholders in the digest. The extra
    // turns keep their prose and their own headings; only the first carries the
    // section's extraction.
    const slots: ExtractionSlot[] = []
    for (const [sectionIndex, section] of sections.entries()) {
      const first = section.turns[0]
      if (first === undefined) continue
      slots.push({ key: turnKey(sectionIndex, 0), turn: first.turn, events: grouped[sectionIndex] ?? [] })
    }

    const extracted = new Map<string, Extraction>()
    const missing: typeof slots = []
    for (const slot of slots) {
      const cached = this.extractionCache.get(materialKey(slot.events))
      if (cached === undefined) missing.push(slot)
      else extracted.set(slot.key, cached)
    }

    for (let index = 0; index < missing.length; index += TURNS_PER_CALL) {
      if (signal?.aborted === true) break
      const batch = missing.slice(index, index + TURNS_PER_CALL)
      const blocks = await extractBatch(this.ctx, agent, batch, signal)
      for (const slot of batch) {
        const block = blocks.get(slot.key)
        if (block === undefined) continue
        extracted.set(slot.key, block)
        this.extractionCache.set(materialKey(slot.events), block)
      }
    }
    return extracted
  }
}

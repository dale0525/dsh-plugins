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
 * summary is built deterministically, with no model call:
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

/** Per-turn floor when assistant prose has to be truncated, in characters. */
const MIN_TURN_CHARS = 800

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
  return kind !== undefined && kind !== 'user'
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
function toolCallsOf(event: SessionEvent): { name: string; arguments: string }[] {
  const message = messageOf(event)
  if (message === null) return []
  const calls: { name: string; arguments: string }[] = []
  for (const block of message.content) {
    if (block.type === 'tool-call') calls.push({ name: block.name, arguments: block.arguments })
  }
  return calls
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
  'You are summarizing a batch of turns from a coding session for a compaction checkpoint.',
  'Each turn is introduced by a line `=== TURN <n> ===` and contains the user request, the assistant prose (may be empty), and a trace of the tool calls it made (descriptions only) plus any results the log marked as errors.',
  '',
  'For EVERY turn, emit exactly one block, introduced by the same `=== TURN <n> ===` line, containing these three Markdown headings in order. Under each, at most two terse lines. If a section has no real information, write "(none)" — never invent.',
  '',
  '## Did',
  '- what was actually done, concretely',
  '',
  '## Concluded',
  '- findings, decisions, or measurements that a later turn would need',
  '',
  '## Overturned',
  '- earlier conclusions this turn disproved or replaced',
  '',
  'Do not describe the tool calls themselves ("ran bash", "explored the repo"). State what came out of them. Do not repeat a conclusion the previous turn already stated. If the trace is too thin to support a claim, write "(none)".',
].join('\n')

/** Turns handed to one extraction call. */
const TURNS_PER_CALL = 8

/** Output tokens allowed per turn in an extraction call. */
const EXTRACT_TOKENS_PER_TURN = 220

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
  for (const event of events) {
    // Tool calls are blocks inside `assistant/message`, not standalone events:
    // `digestSource` emits no `tool/call` type at all, so selecting on that type
    // matched nothing and a 342-call turn produced a single hint line.
    if (event.type === 'assistant/message') {
      for (const call of toolCallsOf(event)) {
        if (calls >= MAX_HINTS_PER_TURN) break
        calls += 1
        const hint = hintOf(call.arguments)
        lines.push(hint.length > 0 ? `TOOL ${call.name}: ${hint}` : `TOOL ${call.name}`)
      }
      continue
    }
    if (event.type !== 'tool/result') continue
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
  extracted?: string
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
function emptyTurn(turn: number | undefined): Turn {
  return { turn, user: [], assistant: [], tools: new Map(), resultBytes: 0, errors: [], writes: [] }
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

  const openTurn = (turn: number | undefined): Turn => {
    if (current === undefined) {
      current = { turns: [] }
      sections.push(current)
    }
    const next = emptyTurn(turn)
    current.turns.push(next)
    if (turn !== undefined) lastTurn = turn
    return next
  }

  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = turnOf(event)
      if (turn !== undefined) lastTurn = turn
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
      currentTurn = openTurn(eventTurn)
      const text = textOf(event)
      if (text.length > 0) currentTurn.user.push(text)
      continue
    }
    if (currentTurn === undefined || (eventTurn !== undefined && currentTurn.turn !== eventTurn)) {
      currentTurn = openTurn(eventTurn)
    }
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
  extracted: ReadonlyMap<number | undefined, string>,
): Section[] {
  return sections.map((section) => ({
    turns: section.turns.map((turn) => {
      const block = extracted.get(turn.turn)
      return block === undefined ? turn : { ...turn, extracted: block }
    }),
  }))
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
function renderSection(section: Section, capChars: number | undefined): string {
  const lines: string[] = []
  for (const turn of section.turns) {
    const label = turn.turn === undefined ? '?' : String(turn.turn)
    if (turn.user.length > 0) lines.push(`\n## user (turn ${label})\n${turn.user.join('\n')}`)
    if (turn.extracted !== undefined) {
      let block = turn.extracted
      if (capChars !== undefined && block.length > capChars) {
        block = `${block.slice(0, capChars)}\n…(+${block.length - capChars} chars)`
      }
      lines.push(`### assistant (turn ${label})\n${block}`)
    } else {
      let body = turn.assistant.join('\n')
      if (capChars !== undefined && body.length > capChars) {
        body = `${body.slice(0, capChars)}\n…(+${body.length - capChars} chars)`
      }
      if (body.length > 0) lines.push(`### assistant (turn ${label})\n${body}`)
    }
    if (turn.tools.size > 0) {
      const names = [...turn.tools.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([tool, count]) => `${tool}×${count}`)
        .join(' ')
      lines.push(`  tools: ${names} (${turn.resultBytes} bytes)`)
    }
    if (turn.errors.length > 0) {
      lines.push(`  errors: ${turn.errors.length}: ${turn.errors.slice(0, 3).join(' | ')}`)
    }
    if (turn.writes.length > 0) lines.push(`  wrote: ${turn.writes.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Total characters of turn bodies across every section: the extraction where a
 * turn has one, its prose otherwise.
 *
 * Both must count, because the cap applies to whichever body is rendered. When
 * only prose counted, a digest made almost entirely of extractions reported a
 * bound of zero, the bisection had nothing to shrink, and the renderer fell
 * through to dropping the oldest turns outright — which deleted the earliest
 * human messages, the standing constraints the digest exists to keep.
 */
function assistantChars(sections: readonly Section[]): number {
  let total = 0
  for (const section of sections) {
    for (const turn of section.turns) {
      total += turn.extracted !== undefined ? turn.extracted.length : turn.assistant.join('\n').length
    }
  }
  return total
}

/**
 * Render the digest under a hard character budget.
 *
 * The two truncation tiers are the plan's T1 and T1', in that order:
 *
 * - **T1** user prose is verbatim unless it alone exceeds `USER_BUDGET_SHARE` of
 *   the budget, then the oldest turns are cut first. The share is 0.9 rather than
 *   0.5 because real user prose is a few percent of the digest: at 0.5 the
 *   extracted blocks crowded out the oldest human messages, which are exactly the
 *   standing constraints (「请用pixi管理开发环境」) that must survive.
 * - **T1'** assistant prose is verbatim unless the whole digest overflows, then
 *   it is cut evenly per turn down to `MIN_TURN_CHARS`.
 *
 * T1' runs *after* T1 because a user's own words are the least reconstructible
 * thing in the log: an assistant's reply can be inferred from its tool calls
 * and the surrounding turns, a user's request cannot. The 800-character floor
 * exists so a tight budget thins every turn instead of erasing the last few.
 *
 * Both tiers run on a long session, and that is by design: the ceiling is
 * absolute (`DIGEST_TOKEN_CEILING`), so a 122-turn history with 316k characters
 * of assistant prose cannot fit verbatim. In the extractive design most turns
 * carry an extraction instead of prose, which keeps the digest far below the
 * ceiling; the tiers exist for the turns where extraction was unavailable and
 * the prose is all that remains.
 */
export function renderDigest(
  events: readonly SessionEvent[],
  budgetTokens: number,
  extracted?: ReadonlyMap<number | undefined, string>,
): string {
  const sections = extracted === undefined ? buildSections(events) : withExtractions(buildSections(events), extracted)
  const budgetChars = Math.max(0, budgetTokens * 4)

  const render = (capChars: number | undefined, trimmed?: Section[]): string =>
    (trimmed ?? sections).map((section) => renderSection(section, capChars)).join('\n')

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

  const verbatim = render(undefined)
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
  const afterT1 = render(undefined, t1)
  if (afterT1.length <= budgetChars) return afterT1
  // The user side fits inside its reserve; what overflows is the turn bodies
  // (extraction or prose plus pointers). Thin those, and only drop whole turns
  // once every body is already at zero — dropping a turn also drops the user
  // prose in it, which is what the reserve exists to prevent.

  // T1': assistant prose, evenly per turn. Length is monotone non-decreasing in
  // the cap, so bisection finds the largest cap that fits exactly, in about
  // eight renders. The floor is honoured only while it fits; below that the cap
  // follows the budget down and the final slice guarantees the ceiling.
  let low = 0
  let high = assistantChars(t1)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (render(mid, t1).length <= budgetChars) low = mid
    else high = mid - 1
  }
  const capped = render(low, t1)
  if (capped.length <= budgetChars) return capped

  // Even cap 0 overflows, so the headings and pointers alone exceed the budget.
  // Drop the oldest sections instead of slicing the head: a truncated tail would
  // cut the newest turns, which are exactly the ones the next request needs.
  let first = 0
  let dropped = 0
  while (first < t1.length - 1) {
    dropped += 1
    first += 1
    const rest = render(0, t1.slice(first))
    const text = `…(${dropped} earlier turn(s) dropped: over budget)\n${rest}`
    if (text.length <= budgetChars) return text
  }
  return render(0, t1.slice(-1)).slice(0, budgetChars)
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
    `USER REQUEST:\n${userRequest.slice(0, 4000) || '(none)'}`,
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
 * Every failure path returns null and the caller falls back to the plain digest:
 * a compaction that cannot reach the model must still compact, or the session
 * dies of context overflow instead of losing detail.
 *
 * @param ctx - plugin context carrying the `llm` service.
 * @param agent - owner of the session being compacted; supplies the routed model.
 * @param turn - one turn's events.
 * @param prose - that turn's assistant prose, already extracted.
 * @param signal - cancellation forwarded to the adapter.
 * @returns the extracted block, or null when extraction is unavailable.
 */
async function extractBatch(
  ctx: { llm?: { stream: (options: any) => AsyncIterable<any> } },
  agent: Agent,
  batch: readonly (readonly [number, readonly SessionEvent[]])[],
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const llm = ctx.llm
  if (llm === undefined) return out
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  if (provider === undefined || model === undefined) return out

  const parts: string[] = []
  for (const [turn, events] of batch) {
    const prose = events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => textOf(event))
      .filter((text) => text.length > 0)
      .join('\n')
    const material = buildExtractionMaterial(events, prose)
    if (material.length === 0) continue
    parts.push(`=== TURN ${turn} ===\n${material}`)
  }
  if (parts.length === 0) return out

  const chunks: string[] = []
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `${parts.join('\n\n')}\n\n${EXTRACT_INSTRUCTION}` }] },
      ],
      // One block per turn, so the cap scales with the batch rather than being
      // a per-turn 400 that a dozen turns would multiply past the digest ceiling.
      maxTokens: EXTRACT_TOKENS_PER_TURN * parts.length,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    })
    for await (const chunk of stream) {
      // Chunk kinds come from `@deepseek-ai/dsh-llm`'s BlockAssembler: text
      // arrives as `text-delta`, and `reasoning-delta` is deliberately ignored —
      // reasoning is 98.8% of a long session's output and is not the record.
      const delta = chunk as { type?: string; text?: string }
      if (delta.type === 'text-delta' && typeof delta.text === 'string') chunks.push(delta.text)
    }
  } catch {
    return out
  }

  // Split the answer back per turn. A turn the model skipped simply keeps its
  // prose, so a partial answer degrades per turn instead of losing the batch.
  const answer = chunks.join('').trim()
  if (answer.length === 0) return out
  const sections = answer.split(/^=== TURN (\d+) ===$/m)
  for (let index = 1; index < sections.length; index += 2) {
    const turn = Number(sections[index])
    const body = (sections[index + 1] ?? '').trim()
    if (Number.isFinite(turn) && body.length > 0) out.set(turn, body)
  }
  return out
}

/**
 * Deterministic compaction backend: verbatim prose, pointerized tools, no model
 * call.
 *
 * Everything except `summarize()` is inherited. The base class prices pressure,
 * selects the span, writes the durable `compaction/start` ... `compaction/end`
 * pair, applies the shrink guard and records `compaction/summary`, so this
 * subclass cannot diverge from the host's transaction semantics.
 */
export default class VerbatimCompactionEngine extends BasicCompactionEngine {
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
   * @param _signal - unused: the digest is synchronous and cannot be cancelled midway.
   * @returns text summary blocks, unmarked by any LLM call.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    _signal?: AbortSignal,
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

    const extracted = await this.extractAll(source, agent, _signal)
    const text = renderDigest(source, budget, extracted)

    const route = session.requestHeader()?.config
    return {
      summary: [{ type: 'text', text }],
      provider: route?.provider ?? agent.options.provider ?? 'verbatim',
      model: route?.model ?? agent.options.model ?? 'digest',
    }
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
  ): Promise<Map<number | undefined, string>> {
    const turns = new Map<number, SessionEvent[]>()
    let lastTurn: number | undefined
    for (const event of source) {
      if (event.type === 'turn/start') {
        const turn = turnOf(event)
        if (turn !== undefined) lastTurn = turn
        continue
      }
      const turn = turnOf(event) ?? lastTurn
      if (turn === undefined) continue
      const bucket = turns.get(turn)
      if (bucket === undefined) turns.set(turn, [event])
      else bucket.push(event)
    }

    const ordered = [...turns.entries()].sort((left, right) => left[0] - right[0])
    const extracted = new Map<number | undefined, string>()
    for (let index = 0; index < ordered.length; index += TURNS_PER_CALL) {
      if (signal?.aborted === true) break
      const batch = ordered.slice(index, index + TURNS_PER_CALL)
      const blocks = await extractBatch(this.ctx, agent, batch, signal)
      for (const [turn, block] of blocks) extracted.set(turn, block)
    }
    return extracted
  }
}

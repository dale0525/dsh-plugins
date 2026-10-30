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
 * Ceiling for one digest, in the meter's fixed 4-chars-per-token heuristic.
 *
 * The base class's own summary budget is `thresholdTokens - retainTokens -
 * 8192`, which is 196752 for the route this was measured on. The digest is also
 * bounded by the shrink guard itself, which is tighter in practice; see
 * `summarize`.
 */
const DIGEST_BUDGET_TOKENS = 196752

/** Framing overhead `frameSummary` adds: preamble plus both tags, 341 chars = 86 tokens. */
const FRAME_TOKENS = 86

/** Safety margin below the shrink guard, in tokens. */
const SHRINK_MARGIN_TOKENS = 512

/** Per-turn floor when assistant prose has to be truncated, in characters. */
const MIN_TURN_CHARS = 800

/** Share of the budget user prose may occupy before oldest-first truncation. */
const USER_BUDGET_SHARE = 0.5

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

/** Render one section to digest text, truncating assistant prose to `capChars`. */
function renderSection(section: Section, capChars: number | undefined): string {
  const lines: string[] = []
  for (const turn of section.turns) {
    const label = turn.turn === undefined ? '?' : String(turn.turn)
    if (turn.user.length > 0) lines.push(`\n## user (turn ${label})\n${turn.user.join('\n')}`)
    let body = turn.assistant.join('\n')
    if (capChars !== undefined && body.length > capChars) {
      body = `${body.slice(0, capChars)}\n…(+${body.length - capChars} chars)`
    }
    if (body.length > 0) lines.push(`### assistant (turn ${label})\n${body}`)
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

/** Total characters of assistant prose across every section. */
function assistantChars(sections: readonly Section[]): number {
  let total = 0
  for (const section of sections) for (const turn of section.turns) total += turn.assistant.join('\n').length
  return total
}

/**
 * Render the digest under a hard character budget.
 *
 * The two truncation tiers are the plan's T1 and T1', in that order:
 *
 * - **T1** user prose is verbatim unless it alone exceeds `USER_BUDGET_SHARE` of
 *   the budget, then the oldest turns are cut first.
 * - **T1'** assistant prose is verbatim unless the whole digest overflows, then
 *   it is cut evenly per turn down to `MIN_TURN_CHARS`.
 *
 * T1' runs *after* T1 because a user's own words are the least reconstructible
 * thing in the log: an assistant's reply can be inferred from its tool calls
 * and the surrounding turns, a user's request cannot. The 800-character floor
 * exists so a tight budget thins every turn instead of erasing the last few.
 *
 * Neither tier runs in practice: over the eight measured sessions the largest
 * digest was 44542 tokens against a 196752 budget, and user prose totalled 2591
 * tokens against a 98376 cap. They are a guard against a pasted file, not the
 * normal path.
 *
 * @param events - the digest source in log order.
 * @param budgetTokens - hard ceiling in the meter's fixed 4-chars-per-token heuristic.
 * @returns the digest text, never longer than `budgetTokens * 4` characters.
 */
export function renderDigest(events: readonly SessionEvent[], budgetTokens: number): string {
  const sections = buildSections(events)
  const budgetChars = Math.max(0, budgetTokens * 4)

  const render = (capChars: number | undefined, trimmed?: Section[]): string =>
    (trimmed ?? sections).map((section) => renderSection(section, capChars)).join('\n')

  const verbatim = render(undefined)
  if (verbatim.length <= budgetChars) return verbatim

  // T1: user prose over its share, oldest first. Only the user side changes, so
  // assistant prose stays verbatim for now. The walk is backwards because the
  // newest request is the one the next turn depends on: cutting forwards would
  // keep the opening question and drop what the user just asked for.
  const userCap = Math.floor(budgetChars * USER_BUDGET_SHARE)
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
    const budget = Math.max(
      0,
      Math.min(DIGEST_BUDGET_TOKENS, shadowedPrice - FRAME_TOKENS - SHRINK_MARGIN_TOKENS),
    )

    const text = renderDigest(source, budget)
    const route = session.requestHeader()?.config
    return {
      summary: [{ type: 'text', text }],
      provider: route?.provider ?? agent.options.provider ?? 'verbatim',
      model: route?.model ?? agent.options.model ?? 'digest',
    }
  }
}

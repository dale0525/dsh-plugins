/**
 * Thinking-loop guard for the dsh harness.
 *
 * Closes a guard-layer gap the in-tree `guard/` family does not cover.
 * `guard/timeout-policy` is a per-tool `tools/execute` deadline and
 * `guard/repeat-tool-reminder` is a same-tool-call chain detector — only a tool
 * *call* arms either. When a model degrades into a pure-thinking loop
 * (`deepseek-v4.1-flash-expires-on-0910` under `max`/`high` reasoning effort and
 * a long context), it emits only `reasoning-delta` chunks — zero `text-delta`,
 * zero `tool-call-delta` — so neither fires, `turn()` never sets `turnEnds`, and
 * the agent-loop `while (true)` never breaks until the user manually aborts.
 *
 * This plugin observes the public `llm/stream` waterfall (present on dsh
 * **0.1.2-rc.1 and 0.1.5-alpha.1**), tallies the `StreamChunk` composition of
 * each loop-built model call, and escalates through a configured reaction.
 *
 * Why `llm/stream` and not `agent/assistant-stream`: the latter (scoped emit
 * with `start`/`chunk`/`end` frames) only exists from dsh 0.1.5-alpha.1; the
 * widely-installed 0.1.2-rc.1 has neither it nor `AssistantStreamFrame`, so a
 * plugin pinned to that seam silently no-ops on the common release. `llm/stream`
 * is a Cordis waterfall around every streaming model call in both versions and
 * carries the same `StreamChunk` delta types, and its `GenerateOptions` carries
 * `sessionId`, from which the live Agent is reachable via `ctx.agents.get(...)`.
 *
 * ## Detection (two per-call shapes, plus two in-call breakers)
 *
 * Issue #1's re-test on dsh 0.1.2-rc.1 showed the v0.1.2 detector did not fire on
 * the reproduction: the loop recurred with the plugin loaded and working. The
 * v0.1.2 detector had two blind spots that together miss the reported shape:
 *
 *  1. It required **consecutive** reasoning-only calls and reset the counter on
 *     *any* text output. A loop whose steps each emit some (boilerplate) text
 *     after their reasoning never accumulates, because every step looks like
 *     progress.
 *  2. Its only content signal was `repeatRatio` — verbatim n-gram repetition
 *     *within one call*. A model that re-derives the same stalled conclusion with
 *     different wording every step scores near zero on that measure, so it also
 *     slipped through.
 *
 * The fix for (2) is a **cross-call** measure: the **containment** of the
 * previous call's distinct n-grams in this call's. A step is "stalled" when it
 * either produced no output at all (shape 1) *or* it repeats most of the previous
 * step's distinct reasoning material (shape 2 — the same conclusion reworded,
 * which is what a stuck model actually does). Anything else is genuine progress
 * and resets the run.
 *
 * The intra-call ratio itself turned out not to be salvageable as a signal and is
 * no longer wired in; {@link LoopDetector.observe} carries the measurement.
 *
 * ## Mid-stream repetition (issue #2848, v0.1.6)
 *
 * The three shapes above are judged **after** a model call ends, which is
 * structurally too late for the failure in issue #2848: a ~10-minute, 420,000
 * character bleed where the model repeated one sentence across ~2825 text chunks
 * — all inside a **single** call. No per-call detector can help, because there is
 * no call boundary to react at; the harness must intervene mid-stream.
 *
 * `maxRepeatedText` therefore adds an intra-call breaker: count consecutive
 * identical normalized `text-delta` payloads and, on the Nth, **end the stream
 * from inside the `llm/stream` wrapper** by yielding a terminal `finish` chunk
 * and returning. Two facts make that expressible and safe, both verified on
 * 0.1.5-alpha.1 and re-checked against the 0.1.2-rc.1 typings:
 *
 *  - The agent loop consumes the waterfall's iterable (`for await (const chunk
 *    of stream) live.push(chunk)`), so a listener's own chunk reaches the same
 *    assembler as an adapter's.
 *  - `packages/llm/llm/src/invariant.ts` requires a terminal finish chunk and
 *    explicitly permits an `error`/`aborted` finish with blocks still open — so
 *    a mid-call cut is a sanctioned protocol outcome, not a violation. A stream
 *    that simply ends is an invariant failure, which is why the breaker emits a
 *    finish rather than merely returning.
 *
 * The break is always an `error` finish carrying `REPETITIVE_OUTPUT`: it fails
 * the step through the loop's normal error path (and the `agent/request-error`
 * waterfall, where a retry policy may act on the code). A quiet `stop` is not
 * offered, because the breaker fires with the call's text block still open and
 * the invariant admits only `error`/`aborted` finishes in that state — measured,
 * not assumed. `breakCorrection` steers the agent so the resumed turn is told
 * what happened. Deliberately **no model fallback and no automatic retry of the
 * break**: a degenerate model must not be silently re-billed.
 *
 * That stance is scoped to the break, and it is not in tension with
 * {@link Config.retryRequestFailures}. A break re-sends the request to a model
 * that has just demonstrated it cannot act on it — the input is the problem. A
 * corrupted response body is the opposite case: the request was well-formed and
 * the provider returned something the JSON parser rejected, so the same request
 * normally succeeds on a second attempt. Different cause, different remedy.
 *
 * ## Cycled repetition (discussion #7043, v0.1.8)
 *
 * `maxRepeatedText` compares *deltas*, so it only covers the period-1 case: the
 * same payload emitted over and over. The #7043 report is a **cycle** — a few
 * short lines rotating ("好。 / 发。 / 好。 / 好。", and a mixed-language variant
 * with "Emitting." in front) for tens of lines, and the same signature in a long
 * session where the model bleeds instead of calling the tool it obviously means
 * to call. Measured against the shipped v0.1.7 detector, that shape **never
 * fires under any of four chunkings** (one delta per line, per cycle, per four
 * characters, per character) within 40 repeats: the longest run of identical
 * consecutive deltas is 3, against a threshold of 60.
 *
 * `maxRepeatedCycleChars` / `minRepeatedCycleChars` add the missing rule at the
 * character level: when the tail of the call's visible output is an exact
 * repetition of one period no longer than `maxRepeatedCycleChars` and spanning
 * at least `minRepeatedCycleChars`, the stream is cut by the same terminal
 * `error` finish. Character-level because the shape does not depend on line
 * breaks — a provider that streams the same bleed with no newline at all is
 * caught identically — and because the reported period is short (12 and 26
 * characters for the two reported shapes).
 *
 * Why exactness and not a low-entropy ratio, when `repeatRatio` was already in
 * the file: measured on the same texts, a *coverage* measure reads 0.92-0.99 for
 * the two reported shapes at a 512-character tail but 0.72 for a 40-row
 * markdown table, 0.76 for a log listing, 0.82 for generated CSS rows and 0.84
 * for a JSON dump. Separating "degenerate" from "legitimately repetitive" by
 * 0.06 is not a margin worth truncating a user's call over; verbatim
 * periodicity is 0 for every one of those samples.
 *
 * ## Reaction
 *
 * On a threshold crossing it applies `escalate`. Unlike v0.1.2 it does **not**
 * latch after one reaction: a single steer often does not break a strong loop
 * (which is exactly what issue #1's re-test observed), so the run counter resets
 * and re-fires after another `maxThinkingSteps`, up to `maxFires` times.
 *
 * Mechanism notes (verified against packages/core/agent-loop/src/agent.ts,
 * packages/llm/llm/src/index.ts, and packages/core/agent/src/runtime-types.ts on
 * dsh 0.1.5-alpha.1; the `llm/stream` / `StreamChunk` / `ctx.agents.get` trio is
 * present unchanged on 0.1.2-rc.1):
 *  - `llm/stream` is a waterfall; a listener wraps `next()` and sees each chunk.
 *  - `chunk: StreamChunk` distinguishes `reasoning-delta` / `text-delta` /
 *    `tool-call-delta` (packages/llm/llm/src/types.ts).
 *  - Loop-built requests carry `markAgentLoopRequest`; `isAgentLoopRequest`
 *    filters out arbitrary non-agent streaming (tool streams, etc.).
 *  - `options.sessionId` → `ctx.agents.get(sessionId)` yields the live `Agent`.
 *  - `agent.steer(message)`, `agent.inject(message)`, and `agent.cancel(cause)`
 *    are public methods; a listener can react but not veto an in-flight step.
 *
 * ## Reasoning bleed (issue #5976, v0.1.9)
 *
 * The three per-call shapes above all assume the call eventually **ends**. #5976
 * is the case where it does not: the model degrades into a pure reasoning bleed
 * — no `text-delta`, no `tool-call-delta` — and keeps generating indefinitely.
 * The harness derives `StepEndReason` from the finished message
 * (`packages/core/agent-loop`, `step()` returns `completed` only once a message
 * exists), so a stream that never finishes never settles the step, `turnEnds`
 * stays null, and the `while (true)` turn loop never breaks. The reporter's
 * experience — "只能手动中止" — is that loop.
 *
 * Every detector above is therefore blind to it by construction:
 *
 *  - {@link LoopDetector} judges a call after it ends, and this one does not end;
 *  - {@link TextRepetitionDetector} watches visible output, and this failure
 *    emits none — deliberately, since reasoning is where the bleed lives and
 *    reasoning legitimately revisits itself far more often.
 *
 * {@link ReasoningLoopBreaker} closes it with the only mechanism that can: it
 * watches `reasoning-delta`, and on a verbatim cycle it ends the stream from
 * inside the `llm/stream` wrapper with a terminal `error` finish. That failure
 * is what makes the turn end at all — `agent-loop`'s `step()` turns a non-retried
 * `error` finish into a thrown `LlmError`, `turn()` catches it into
 * `turnEnds = { kind: 'error' }`, and the `finally` appends `turn/end`.
 *
 * The rule is exact periodicity, not a ratio, and the thresholds are measured
 * rather than guessed — see {@link ReasoningLoopBreaker} for the calibration
 * against a real reproduction.
 *
 * @module dsh-loop-guard
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentCancelCause, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'

type UserMessage = ReturnType<typeof createUserMessage>

/**
 * The agent's public methods the guard reacts with.
 *
 * `whenIdle` is optional because it is only needed for
 * {@link Config.resumeAfterBreak}, and a guard that required it would fail to
 * mount on any Agent-shaped stand-in that omits it.
 */
type GuardableAgent = Pick<Agent, 'inject' | 'steer' | 'cancel'>
  & Partial<Pick<Agent, 'whenIdle' | 'status'>>

/** Plugin configuration. */
export interface Config {
  /**
   * Consecutive stalled model calls before a reaction. A call is stalled when it
   * produced no text/tool output, or when it repeated most of the previous
   * call's distinct reasoning material. Default `3`.
   */
  maxThinkingSteps?: number
  /**
   * Minimum reasoning text within one call before that call is judged at all; a
   * short burst is normal. Default `2048` chars.
   */
  minReasoningChars?: number
  /**
   * Cross-call similarity: how much of the previous call's distinct reasoning
   * material must reappear in this call before the call counts as a repetition
   * of stalled thinking rather than progress. `1.0` requires an exact rerun of
   * the same material; `0` disables this signal. Default `0.8`.
   */
  similarityThreshold?: number
  /**
   * Reaction to fire on a threshold crossing. `warn` injects a notice, `steer`
   * sends a steering message, `cancel` hard-aborts the turn. Default `steer`.
   */
  escalate?: 'warn' | 'steer' | 'cancel'
  /**
   * How many times one agent may be reacted to before the guard stops
   * re-firing. A single intervention often does not break a strong loop, so the
   * default allows several. Default `4`.
   */
  maxFires?: number
  /** Cancel cause used when `escalate` is `cancel`. Default `'thinking-loop'`. */
  cancelCause?: string
  /**
   * Consecutive identical normalized visible-output chunks that end the stream
   * mid-call. `0` disables the breaker. This is the only guard here that fires
   * *inside* a model call, so it is the only one that can stop a single-call
   * repetition bleed (issue #2848). Default `60`.
   *
   * Covers the period-1 case only (a byte-identical delta repeated); a model
   * bleeding a *cycle* of a few short lines resets this counter on every phase
   * change. See `maxRepeatedCycleChars`.
   */
  maxRepeatedText?: number
  /**
   * Longest repeating period, in visible-output characters, that
   * {@link trailingCycle} will recognize at the tail of a call's output.
   * `0` disables the cycle rule. Default `512`.
   *
   * Discussion #7043 reported a model that bleeds a cycle of a few short lines
   * ("好。 / 发。 / 好。 / 好。", and a mixed-language variant) for tens of
   * lines; measured on v0.1.7, that shape never fires `maxRepeatedText` under any
   * chunking, because no two consecutive deltas are identical.
   *
   * ## Why the default is 512 and not 64
   *
   * The same silent-failure rule that set the reasoning cap applies here, and
   * this side was left behind. Measured on a real 44 387-character visible-output
   * bleed: its exact minimal period is **172** characters (stable across every
   * tail window from 512 to 16 384), and the loop starts at character **139 —
   * 0.3 %** of the final text. At the old `64` default `trailingCycle` returned
   * **0** for it, so the guard never fired, the call was never cut, and the text
   * ran to 44 387 characters until the user stopped the turn by hand.
   *
   * A streaming replay of that text through {@link TextRepetitionDetector} — the
   * real detector, delta by delta, not the settled message — puts the candidate
   * caps side by side. The figures are for that ONE text:
   *
   * | cap | fires on it |
   * | --- | --- |
   * | 64 (shipped) | **0** |
   * | 128 | 0 |
   * | 256 | 1, cut at character 576 (1.3 %) |
   * | 512 | 1, cut at character 576 (1.3 %) |
   *
   * `512` is chosen over the bare-minimum `256` for the same reason the reasoning
   * side chose it: a cap below a real period fails *silently*, and the periods
   * seen on this side have already grown past a previous default once. It costs
   * nothing in precision — across every visible-output text in the session store
   * (2 973 texts of 1 500+ characters, all sessions) the cycle rule fires on
   * exactly one: the real bleed. The other 2 972 legitimate texts — reports,
   * code, tables — score `0` at every cap from 64 through 4096.
   */
  maxRepeatedCycleChars?: number
  /**
   * Shortest tail span that must be an exact repetition of a single period before
   * the cycle rule ends the stream. Default `256`.
   *
   * Exact repetition rather than a low-entropy ratio on purpose: measured against
   * legitimately repetitive long output — a 40-row markdown table (0.72 at a
   * 512-char tail), generated CSS rows (0.82), a JSON dump (0.84), a log listing
   * (0.76) — a coverage threshold only separates the loop (0.92-0.99) by ~0.06,
   * too thin for a rule that truncates a call. Verbatim periodicity is 0 for all
   * of those samples and non-zero only for the reported shapes.
   */
  minRepeatedCycleChars?: number
  /**
   * Longest repeating period, in **reasoning** characters, that ends the stream
   * mid-call. `0` disables the reasoning rule. Default `512`.
   *
   * This is the rule that closes issue #5976. That failure is a model bleeding
   * reasoning and never returning — no text, no tool call — so no post-call
   * detector can reach it and the harness turn loop never settles (`StepEndReason`
   * is derived from a finished message). Cutting the stream from inside the
   * `llm/stream` wrapper is the only mechanism that ends such a turn.
   *
   * Calibrated on real reproductions. Measured bleed periods: 89, 102, 105, 154,
   * 187, 235, and **409** characters. The 409 is why this default is `512` and
   * not the `256` an earlier calibration chose: with `256` that bleed was
   * invisible (`trailingCycle` returns 0), the guard never fired, and the turn
   * had to be aborted by hand — the exact failure the rule exists to prevent.
   * A too-low period cap fails silently, so it must sit above every observed
   * period rather than at the middle of the ones seen so far.
   */
  maxRepeatedReasoningCycleChars?: number
  /**
   * Shortest reasoning tail that must be an exact repetition of one period
   * before the reasoning rule ends the stream. Default `384`.
   *
   * Higher than the visible-output default (`256`) on purpose: reasoning is
   * private scratch space that legitimately restates a heading or a plan step, so
   * the reasoning rule demands a longer verbatim run before truncating a call.
   *
   * Measured across 22 sessions (9195 calls), the calls this rule exists to catch
   * — reasoning-only, ending the turn with no text and no tool call — repeat a
   * phrase pool in their last 384-516 characters. `512` catches **0 of 56** of
   * them; `384` catches 40 (71%). The earlier `512` was calibrated on a single
   * reproduction where the bleeds happened to run long, and its "costs no recall"
   * claim does not survive the wider corpus.
   */
  minRepeatedReasoningCycleChars?: number
  /**
   * How many characters of *repeated lines* end a reasoning bleed. Default
   * `2048`, `0` disables the rule.
   *
   * The cycle rule above only sees a bleed that repeats in the same order every
   * time. A measured reproduction recombined a pool of about eleven sentences in
   * a different order each pass, so it had no period at any cap and the cycle
   * rule never fired: 330 188 characters until the user aborted. Counting the
   * mass sitting in lines already seen catches that shape, and the two rules are
   * complementary — a pool of very short phrases is the cycle rule's job.
   *
   * The threshold is deliberately far below the smallest aborted bleed that
   * matters: the worst measured case is cut at 4096 characters, 1.2 % of its
   * final length, with no false positive on any of the 119 calls in the same
   * session that produced text or a tool call.
   */
  maxRepeatedReasoningLineChars?: number
  /**
   * The share of counted reasoning characters that must sit in repeated lines
   * before the line rule fires. Default `0.6`.
   *
   * Coherent reasoning reuses phrases ("Let me check", "OK") but the bulk of its
   * text is new, so its repeated share stays low; a bleed drawn from a fixed
   * pool approaches 1.0. Lines shorter than two characters are excluded from
   * both the numerator and the denominator, so generated code full of `}` and
   * `);` cannot drive the ratio up.
   */
  minRepeatedReasoningLineCoverage?: number
  /**
   * Error code carried by the breaker's terminal failure. Default
   * `'REPETITIVE_OUTPUT'`.
   *
   * There is deliberately no way to choose a quiet `stop` finish instead: the
   * breaker fires while the call's text block is still open, and the `llm/stream`
   * invariant rejects a `stop` finish with open blocks (only `error`/`aborted`
   * may leave them open). Verified by running the wrapper's own output through
   * `@deepseek-ai/dsh-llm/invariant` — see `test/text-breaker.spec.mjs`.
   */
  breakCode?: string
  /**
   * Steer the agent after a mid-stream break so the resumed turn is told what
   * happened instead of silently continuing. Default `true`.
   */
  breakCorrection?: boolean
  /**
   * Continue the turn automatically after a mid-stream break, instead of
   * leaving the session waiting for the user. Default `false`.
   *
   * Off by default because it re-enters the model without the user asking, and
   * because the failure it responds to is one where the model has already shown
   * it cannot act on its own. Turn it on when an unattended run must not stall.
   *
   * How it works, and why a naive attempt cannot work: the break is observed
   * inside the stream wrapper, which runs while the agent's phase is `running`.
   * In that phase `agent-loop` deliberately suppresses every wake —
   * `wakeDriver()` only latches behind maintenance or an aborted activity, so a
   * `steer()`/`followup()` issued here sets no `wakeRequested`, and `kick()`'s
   * `finally` (`if (wakeRequested && inbox.hasPending) wakeDriver()`) finds
   * neither and lets the session come to rest. The wake has to happen *after*
   * the driver returns to `idle`, which is what `whenIdle()` waits for.
   *
   * Only meaningful with `breakCorrection: false`. A steered correction already
   * keeps the turn alive on its own — `turn()` only ends while `nextStep` is
   * empty — so with the correction on there is nothing left for this option to
   * do, and scheduling it as well would deliver the same text twice.
   *
   * The continuation message is the same correction text `breakCorrection`
   * steers, delivered as a steering notice. It is never empty: a user message
   * with no text blocks carries no instruction, and `createUserMessage` is
   * happy to build one, so an "empty retry" would re-enter the model with the
   * degenerate history unchanged — the shape that produced the loop.
   */
  resumeAfterBreak?: boolean
  /**
   * Retry a model request whose response body could not be parsed. Default
   * `true`.
   *
   * This is the one failure where re-sending the SAME request is the fix rather
   * than a silent re-bill, and it is a different class from the thinking-loop
   * breaks above — those re-enter a model that has already shown it cannot act,
   * which is why they are never retried automatically. Here the request was
   * well-formed and the provider returned a corrupted body; the turn dies
   * through `agent/request-error` with the user seeing `本轮运行失败`, and a
   * second attempt normally succeeds.
   *
   * The predicate is deliberately narrow — the code AND a V8 `JSON.parse`
   * signature, both required. Measured across this machine's `~/.dsh/sessions`:
   * every JSON-parse failure (16 error turns) arrives as `PI_AI_ERROR`, but
   * `PI_AI_ERROR` alone is the adapter's catch-all — it also carries
   * `Too many pending requests, please retry later`, `Provider finish_reason:
   * error`, and pi-ai's `ended pending` / `deferred` bodies, none of which is a
   * parse failure. Conversely an upstream 400 whose error body merely QUOTES a
   * JSON error must not be re-sent. See {@link isMalformedResponseFailure}.
   */
  retryRequestFailures?: boolean
  /**
   * How many times ONE attempt may be re-sent before the failure is handed to
   * downstream recovery. Default `2`.
   *
   * Small on purpose, and deliberately below `dsh-llm`'s own
   * `DEFAULT_MAX_RETRIES` of 5: this budget sits in FRONT of that policy, so a
   * provider that corrupts every body must stop costing money quickly. The
   * budget is per agent and per `(turn, step)`, so a bad step cannot starve the
   * rest of the turn.
   */
  maxRequestRetries?: number
}

/** Resolved config: every field carries its validated default. */
type ResolvedConfig = Required<Config>

/**
 * A live reference to one volatile field, as the Loader hands it to `apply`.
 *
 * Declared structurally rather than imported: `Volatile` is a `cordis` 4.0.3
 * export and this package declares the whole `^4.0.2` range, so naming the
 * vendor type here would narrow the peer range for a cosmetic gain.
 */
export interface ConfigRef<T> {
  /** The field's value right now; re-read on every call. */
  get(): T
}

/**
 * The live references `apply` receives, one per {@link Config} field.
 *
 * Cordis's Loader replaces every `volatile()` field of a plugin's `Config` with
 * a reference of this shape, so a value the user edits on the Plugins page is
 * committed into the RUNNING plugin (`loader/volatile-update`) instead of
 * remounting it. Reading through `.get()` at the point of use is therefore what
 * makes an edit take effect without a restart.
 */
export type ConfigRefs = { [K in keyof ResolvedConfig]: ConfigRef<ResolvedConfig[K]> }

/**
 * Plugin configuration — and, as of the 0.1.7-alpha.1 settings redesign, the
 * ONE schema behind every configuration surface.
 *
 * The host's `dsh-settings` no longer has a namespace registry: it derives the
 * Plugins-page form for a loader entry from that entry's own `Config`, keyed by
 * the entry id (which is this package's {@link name}, `loop-guard`). Marking
 * every field `volatile()` is what puts it in that form — a field left plain
 * would still configure the guard through `cordis.patch.yml`, but the Plugins
 * page could neither show nor edit it.
 *
 * Two consequences follow, both deliberate:
 *
 *  - The row's `config` in `cordis.patch.yml` is no longer a "composition
 *    layer" that the guard merges a settings section over. It is simply the
 *    entry's config, and the Plugins page edits that same entry, so there is
 *    exactly one layer and no precedence rule left to get wrong.
 *  - The guard no longer registers a settings namespace at all. The former
 *    `settings.installSection(ctx, 'loop-guard', SettingsSection, …)` seam —
 *    present in `dsh-settings` 0.1.2-alpha.2 through 0.1.6-alpha.2 — was
 *    removed in 0.1.7-alpha.1, which is why this plugin failed to activate on
 *    that harness generation.
 */
export const Config: z<Config, ConfigRefs> = z.object({
  maxThinkingSteps: z.number().min(2).default(3).volatile(),
  minReasoningChars: z.number().min(256).default(2048).volatile(),
  similarityThreshold: z.number().min(0).max(1).default(0.8).volatile(),
  escalate: z.union(['warn', 'steer', 'cancel']).default('steer').volatile(),
  maxFires: z.number().min(1).default(4).volatile(),
  cancelCause: z.string().default('thinking-loop').volatile(),
  maxRepeatedText: z.number().step(1).min(0).default(60).volatile(),
  maxRepeatedCycleChars: z.number().step(1).min(0).default(512).volatile(),
  minRepeatedCycleChars: z.number().step(1).min(2).default(256).volatile(),
  maxRepeatedReasoningCycleChars: z.number().step(1).min(0).default(512).volatile(),
  minRepeatedReasoningCycleChars: z.number().step(1).min(2).default(384).volatile(),
  maxRepeatedReasoningLineChars: z.number().step(1).min(0).default(2048).volatile(),
  minRepeatedReasoningLineCoverage: z.number().min(0).max(1).default(0.6).volatile(),
  breakCode: z.string().default('REPETITIVE_OUTPUT').volatile(),
  breakCorrection: z.boolean().default(true).volatile(),
  resumeAfterBreak: z.boolean().default(false).volatile(),
  retryRequestFailures: z.boolean().default(true).volatile(),
  maxRequestRetries: z.number().step(1).min(0).default(2).volatile(),
})

export const name = 'loop-guard'

/**
 * Cordis services this plugin resolves off the Context.
 *
 * Declaring `agents` is REQUIRED, not documentation: Cordis's context proxy
 * throws `cannot get property "agents" without inject` for any service read
 * that the fiber did not declare (vendor/cordis/src/reflect.ts, the
 * `waterfall('internal/get', …)` guard). The plugin reaches the live Agent via
 * `ctx.agents.get(options.sessionId)`, so without this line `apply()` throws on
 * activation and every session in that deployment fails to run.
 *
 * TypeScript cannot catch this: `ctx.agents` type-checks as soon as
 * `@deepseek-ai/dsh-agent` is in the type graph, because the guard is purely
 * runtime. That is exactly how v0.1.1 shipped broken (issue #1).
 */
export const inject = ['agents']

/**
 * Producer-owned source kind stamped on every notice this guard injects.
 *
 * Session format v4 refuses the retired `{ kind: 'plugin', plugin }` wrapper at
 * native admission (`format v4 message requires a producer-owned source kind`),
 * so the identity that used to ride `plugin` now rides `kind` itself. The
 * `plugin:` prefix is the host's documented V4 mapping for a producer that is
 * not one of its same-name first-party plugins, and it is also what this
 * guard's v3-era notices become when a session is migrated — so one transcript
 * keeps a single attribution across the boundary.
 */
const PLUGIN_SOURCE = { kind: 'plugin:dsh-loop-guard' } as const

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * One guard notice. `summary` is what the collapsed transcript row shows;
     * `form` records that this is a notice rather than a prompt, which is what
     * keeps a synthetic nudge from rendering as a human turn in derived
     * history.
     */
    'plugin:dsh-loop-guard': {
      kind: 'plugin:dsh-loop-guard'
      form: 'notice'
      summary: string
    }
  }
}

/**
 * Build one model-facing notice from the guard.
 *
 * The source `kind` is the identity shown in the transcript's attribution row.
 * `summary` is a one-line account of *what happened* — the collapsed
 * transcript row renders it, and `boundContextSummary` caps it at
 * {@link CONTEXT_SUMMARY_MAX_CHARS} — so it states the event rather than
 * repeating the plugin name, the way `guard/repeat-tool-reminder` summarises as
 * `<tool> × <count>`.
 *
 * @param text - the full notice body.
 * @param form - the context form; always `notice` here.
 * @param summary - the one-line account for the collapsed row.
 */
function message(text: string, form: 'notice', summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form, summary },
  })
}

/* -------------------------------------------------------------------------- */
/* Detection primitives (exported for tests)                                  */
/* -------------------------------------------------------------------------- */

/** Fixed window used for both the intra-call and cross-call measures. */
export const GRAM_SIZE = 4

/**
 * How many newly emitted visible characters must accumulate before the cycle
 * rule re-scans the tail. The scan is bounded by `minRepeatedCycleChars`, so a
 * fixed stride keeps the whole rule linear in emitted characters.
 */
const CYCLE_CHECK_STRIDE = 32

/**
 * The shortest line the line-repeat rule counts, in characters.
 *
 * A line this short or shorter is not evidence of anything: generated code
 * repeats `}` and `);` by the hundred legitimately, and a brace is one
 * character. Two characters is the floor at which a line starts carrying
 * content (`OK`, `Go`), which is exactly the vocabulary a phrase-pool bleed
 * recombines.
 */
const LINE_MIN_CHARS = 2

/**
 * Which detector ended a call, for the log line, the notice noun and tests.
 *
 * `identical-chunks` and `repeating-cycle` watch visible output;
 * `reasoning-cycle` and `reasoning-lines` watch reasoning under the two
 * complementary rules described on {@link ReasoningLoopBreaker}.
 */
export type BreakRule = 'identical-chunks' | 'repeating-cycle' | 'reasoning-cycle' | 'reasoning-lines'

/**
 * The distinct fixed-length grams of one reasoning text.
 *
 * Fixed-length windows are the language-agnostic choice: CJK loops
 * ("好。执行。") have no whitespace, so a whitespace-token histogram collapses to
 * one token and can never distinguish repetition.
 *
 * @param text - the reasoning text of one call.
 * @param size - the window length in characters.
 * @returns the set of distinct windows (empty for text shorter than `size`).
 */
export function grams(text: string, size = GRAM_SIZE): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + size <= text.length; i++) out.add(text.slice(i, i + size))
  return out
}

/**
 * Low-entropy ratio: coverage of one text by repeated fixed-length grams.
 *
 * ## Not a loop detector — do not use it as one
 *
 * This is kept as a **diagnostic**, exported for `tools/analyze-session.mjs` and
 * the tests. It is deliberately no longer wired into {@link LoopDetector}; the
 * measurement behind that decision is on {@link LoopDetector.observe}.
 *
 * The short version: the ratio rises with **length**, because the number of
 * distinct 4-grams in natural language saturates. One continuous non-repeating
 * English document scores 0.290 at 2048 characters and 0.629 at 20 000; this
 * repo's own `README_EN.md` and `src/index.ts` score 0.54-0.65, above the `0.5`
 * that used to be the threshold, while a genuine periodic loop scores
 * 0.994-0.999. It separates "long" from "short", not "stuck" from "working".
 *
 * A tight repetition ("好。执行。" x N) still scores near 1.0, so it remains a
 * useful *descriptive* statistic on a text already known to be a loop.
 *
 * @param reasoning - the reasoning text of one call.
 * @returns the fraction of windows that had already appeared in the same text.
 */
export function repeatRatio(reasoning: string): number {
  if (reasoning.length < 16) return 0
  const k = Math.min(GRAM_SIZE, Math.max(2, Math.floor(reasoning.length / 16)))
  let repeated = 0
  let total = 0
  const seen = new Set<string>()
  for (let i = 0; i + k <= reasoning.length; i++) {
    const gram = reasoning.slice(i, i + k)
    total++
    if (seen.has(gram)) repeated++
    else seen.add(gram)
  }
  return total === 0 ? 0 : repeated / total
}

/**
 * Containment of one gram set in another: the fraction of the SMALLER set's
 * grams present in the larger.
 *
 * Containment rather than Jaccard on purpose. A stuck model typically restates
 * the previous step's material and appends another sentence, so the new set is a
 * near-superset of the old one; Jaccard would dilute that with the new material
 * and let the step look like progress, while containment reports the repetition
 * directly.
 *
 * @param a - one call's distinct grams.
 * @param b - another call's distinct grams.
 * @returns `0` when either set is empty, otherwise the containment in `[0, 1]`.
 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const gram of small) if (large.has(gram)) shared++
  return shared / small.size
}

/** What one completed model call looked like to the guard. */
export interface StepObservation {
  /** Whether the call emitted any `text-delta` or `tool-call-delta`. */
  readonly hasOutput: boolean
  /** The call's total reasoning text. */
  readonly reasoning: string
}

/**
 * Why one call was counted as stalled (`undefined` = it was progress).
 *
 * Both reasons are structural: no output at all, or the previous call's material
 * restated. There is deliberately no "low-entropy" member — see
 * {@link LoopDetector.observe} for the measurement that removed it.
 */
export type StallReason = 'reasoning-only' | 'repeated-material'

/**
 * The per-agent detector: accumulates stalled calls and decides when to react.
 *
 * Kept free of Cordis types so the decision rule is unit-testable without a
 * harness: the plugin only feeds it observations and applies the reaction.
 */
export class LoopDetector {
  private stalled = 0
  private fires = 0
  private previous: Set<string> | undefined
  private lastReason: StallReason | undefined

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** The stalled-run length that would trigger the next reaction. */
  get threshold(): number {
    return this.config.maxThinkingSteps
  }

  /** How many reactions have fired for this agent so far. */
  get fired(): number {
    return this.fires
  }

  /**
   * Observe one completed model call.
   *
   * ## Why there is no intra-call ratio rule here
   *
   * An earlier version added a third reason, `low-entropy`: `repeatRatio` at or
   * above `0.5` on a call that did produce output. It was removed after being
   * measured on a real 4380-record session, where it fired **12 times and not
   * once on a loop**:
   *
   *  - Of the 36 calls it judged across those 12 fires, **33 (92 %)** were calls
   *    that had just made a tool call — `edit`, `write`, `read`, `grep`, `pwsh`.
   *    **Zero** were calls that produced neither output nor a tool call.
   *  - Across the whole session, on the 152 calls that produced output, it fired
   *    on **91 (59.9 %)**.
   *  - No threshold rescues it: the highest ratio on a productive call is
   *    **0.797** and the lowest on a reasoning-only call is **0.308**, so the
   *    ranges overlap and no cut-off separates them. At `0.5` it flags 60 % of
   *    productive calls; at `0.8` it flags none but also misses half the real
   *    bleeds.
   *  - The reason is arithmetic, not tuning. `repeatRatio` counts 4-grams
   *    already seen; the distinct 4-gram count of natural language saturates, so
   *    the ratio is pushed up by **length**. Scoring one continuous
   *    non-repeating English document at growing prefixes gives 0.290 at 2048
   *    characters, 0.495 at 8000, 0.629 at 20 000 — and the repo's own
   *    `README_EN.md` and `src/index.ts` score 0.54-0.65, i.e. above the
   *    threshold, while a genuine periodic loop scores 0.994-0.999. Spearman
   *    rho(length, ratio) = 0.606.
   *
   * So the rule was not a loop detector but a "reasoning longer than roughly
   * 8000 characters" detector. Its cost was not only the wrong steers: `fires` is
   * a per-agent budget, so four false positives exhausted `maxFires` and left the
   * guard silent for the rest of the process — the failure recorded in
   * {@link ReasoningLoopBreaker}'s calibration notes, where the three real bleeds
   * of a reproduction drew no reaction at all.
   *
   * The two reasons that remain are both structural and were clean on the same
   * data: `reasoning-only` fired on 0 of 152 productive calls, and
   * `repeated-material` needs 80 % of the previous call's distinct material
   * restated.
   *
   * @param step - the call's output shape and reasoning text.
   * @returns the reason it counted as stalled, or `undefined` when it was progress.
   */
  observe(step: StepObservation): StallReason | undefined {
    // A short burst is normal and carries too little material to judge. It is
    // neither counted nor treated as progress — it must not clear a run built
    // from substantive steps.
    if (step.reasoning.length < this.config.minReasoningChars) return undefined

    const current = grams(step.reasoning)
    const repeated = this.previous !== undefined
      && this.config.similarityThreshold > 0
      && containment(this.previous, current) >= this.config.similarityThreshold
    this.previous = current

    const reason: StallReason | undefined = !step.hasOutput
      ? 'reasoning-only'
      : repeated
        ? 'repeated-material'
        : undefined

    if (reason === undefined) {
      // Real progress: the run is over.
      this.stalled = 0
      this.lastReason = undefined
      return undefined
    }

    this.stalled += 1
    this.lastReason = reason
    return reason
  }

  /**
   * Whether a reaction is due now, consuming one fire when it is.
   *
   * A single intervention often does not break a strong loop, so a fire resets
   * the run counter (another full run of stalled calls is needed) and is capped
   * by `maxFires` so the guard cannot intervene forever.
   *
   * @returns the reason to report in the reaction, or `undefined` when no reaction is due.
   */
  takeFire(): StallReason | undefined {
    if (this.stalled < this.config.maxThinkingSteps) return undefined
    if (this.fires >= this.config.maxFires) return undefined
    this.fires += 1
    this.stalled = 0
    const reason = this.lastReason ?? 'reasoning-only'
    this.lastReason = undefined
    return reason
  }

  /** Forget every observation (used when a loop is judged broken by real output). */
  reset(): void {
    this.stalled = 0
    this.previous = undefined
    this.lastReason = undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Mid-stream repetition breaker (issue #2848)                                */
/* -------------------------------------------------------------------------- */

/**
 * Count how many of a list of visible-output chunks are a trailing run of
 * identical payloads (compared after trimming).
 *
 * Anchored at the tail on purpose: the breaker wants the *current* run, so
 * interleaved reasoning deltas (which are not passed here) and any earlier
 * unrelated text cannot mask it. Whitespace-only chunks normalize to `''` and
 * therefore count as repetitions of each other, which is the intended reading —
 * a stream emitting nothing but blank lines for a minute is equally stuck.
 *
 * @param texts - the call's `text-delta` payloads, in stream order.
 * @returns the length of the trailing identical run (`0` for an empty list).
 */
export function countRepeatedText(texts: readonly string[]): number {
  const last = texts.at(-1)
  if (last === undefined) return 0
  const normalized = last.trim()
  let run = 0
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i]!.trim() !== normalized) break
    run++
  }
  return run
}

/**
 * The tail span that is an exact repetition of one short period, or `0` when the
 * tail is not periodic (discussion #7043).
 *
 * This generalizes {@link countRepeatedText} from "the same delta twice" to
 * "the same *cycled* output for hundreds of characters", and it is
 * newline-agnostic: the period is measured in characters, so a bleed that never
 * emits a line break is caught identically to a one-line-per-delta bleed.
 *
 * Two guards keep it off legitimate output:
 *
 *  - **Exactness.** The whole span must be a verbatim repetition; a near-repeat
 *    scores `0`. Measured: a 40-row markdown table, generated CSS rows, a JSON
 *    dump and a 60-line log listing are all period-free while scoring
 *    0.72-0.84 on a *coverage* measure of the same text — a ratio rule would
 *    have had to separate the loop from those by ~0.06.
 *  - **A period of at least two distinct characters.** A run of `=` or `-` is a
 *    legitimate divider, and a one-character period would flag every long rule
 *    line in a generated document.
 *
 * The scan stops as soon as the minimum is met, so the returned span is
 * `max(minSpan, 2 * period)` rather than the longest periodic tail that exists:
 * the caller only distinguishes zero from non-zero, and stopping early keeps the
 * rule bounded on a call that bleeds for hundreds of thousands of characters.
 *
 * @param text - the accumulated visible output of one call.
 * @param maxPeriod - the longest period to consider, in characters.
 * @param minSpan - the shortest qualifying tail span, in characters.
 * @returns the qualifying span in characters (`>= minSpan`), or `0`.
 */
export function trailingCycle(text: string, maxPeriod: number, minSpan: number): number {
  if (maxPeriod < 1) return 0
  for (let period = 1; period <= maxPeriod; period++) {
    // The last `period` characters are the template; walk backwards while the
    // output still matches itself one period earlier.
    const template = text.slice(text.length - period)
    if (new Set(template).size < 2) continue
    const need = Math.max(minSpan, 2 * period) - period
    const limit = Math.min(text.length - period, need)
    let matched = 0
    while (matched < limit && text[text.length - period - 1 - matched] === text[text.length - 1 - matched]) matched++
    if (matched >= need) return matched + period
  }
  return 0
}

/**
 * The reasoning breaker: the one rule that can end a thinking loop.
 *
 * ## Why this exists separately from every other detector here
 *
 * Issue #5976's failure is a model that degrades into a **pure reasoning bleed**
 * and never returns: no `text-delta`, no `tool-call-delta`, so the step never
 * settles. Measured on a real reproduction (a 174 MB session, 4628 calls, dsh
 * 0.1.5-rc.2), the final three calls emitted 74 193 / 357 112 / 134 244
 * characters of reasoning and nothing else.
 *
 * Every other detector in this file is structurally too late for that shape:
 *
 *  - {@link LoopDetector} judges a call **after** it ends. A bleed that does not
 *    end never reaches it. On the reproduction its `maxFires` budget was already
 *    spent by four false positives early in the session (the `low-entropy` rule,
 *    since removed — see {@link LoopDetector.observe}), so the three real bleeds
 *    produced no reaction at all.
 *  - {@link TextRepetitionDetector} watches `text-delta` only, by design, because
 *    visible output is what a repetition is normally visible in. Here the bleed
 *    is entirely in reasoning, so it never saw a chunk.
 *
 * The harness itself has no seam for this either: `packages/core/agent-loop`
 * derives `StepEndReason` from the finished message, so a stream that keeps
 * producing reasoning never settles and the `while (true)` turn loop never
 * breaks — which is exactly what the reporter observed as "只能手动中止".
 *
 * ## Why it is safe to watch reasoning, which legitimately revisits itself
 *
 * The rule is the same **exact verbatim periodicity** as the visible-output
 * cycle rule, not a low-entropy ratio. Calibrated against real reproductions —
 * every call with >= 2048 reasoning characters, of which the overwhelming
 * majority produced text or a tool call:
 *
 *  - Measured bleed periods: **89, 102, 105, 154, 187, 235 and 409** characters.
 *  - `maxPeriod: 64` (the shipped visible-output default) finds **none** of them.
 *  - The period cap must sit **above every observed period**, not in the middle
 *    of the ones seen so far: a cap below a real period fails *silently* —
 *    `trailingCycle` returns 0, the breaker never fires, and the turn runs until
 *    the user aborts it. A `256` default did exactly that to the 409-character
 *    bleed. Hence `512`.
 *  - Verbatim periodicity is what separates a bleed from legitimately repetitive
 *    reasoning: the highest-`repeatRatio` non-loop calls have *no* period at
 *    all, so a ratio rule would flag them while the exact rule does not.
 *
 * Free of Cordis types so the decision rule is unit-testable without a harness.
 */
export class ReasoningLoopBreaker {
  private broken = false
  private chars = 0
  private reasoning = ''
  private lastCycleCheck = 0
  private trippedRule: 'reasoning-cycle' | 'reasoning-lines' | undefined
  /** Trailing text not yet terminated by a newline. */
  private linePartial = ''
  /** How many times each counted line has been seen. */
  private lineCounts = new Map<string, number>()
  /** Characters sitting in counted lines. */
  private lineTotal = 0
  /** Characters sitting in lines that have been seen more than once. */
  private lineRepeat = 0

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** Whether the breaker has already fired for this call. */
  get tripped(): boolean {
    return this.broken
  }

  /** Which rule fired, for the log line and for tests. */
  get trippedBy(): 'reasoning-cycle' | 'reasoning-lines' | undefined {
    return this.trippedRule
  }

  /** Reasoning characters observed so far in this call (for the break report). */
  get emittedChars(): number {
    return this.chars
  }

  /**
   * Observe one `reasoning-delta` payload.
   *
   * @param text - the delta's text.
   * @returns `true` exactly once, on the delta that trips a rule.
   */
  push(text: string): boolean {
    if (this.broken) return false
    this.chars += text.length
    this.reasoning += text
    if (this.pushLines(text)) {
      this.broken = true
      this.trippedRule = 'reasoning-lines'
      return true
    }
    if (this.config.maxRepeatedReasoningCycleChars <= 0) return false
    // Same fixed-stride scan as the visible-output rule: the check is bounded by
    // `minRepeatedReasoningCycleChars`, so a bleed that runs for hundreds of
    // thousands of characters is still scanned a bounded number of times.
    if (this.reasoning.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false
    this.lastCycleCheck = this.reasoning.length
    const span = trailingCycle(
      this.reasoning,
      this.config.maxRepeatedReasoningCycleChars,
      this.config.minRepeatedReasoningCycleChars,
    )
    if (span === 0) return false
    this.broken = true
    this.trippedRule = 'reasoning-cycle'
    return true
  }

  /**
   * The line-repeat rule: a bleed that recombines a small pool of phrases.
   *
   * Verbatim periodicity ({@link trailingCycle}) only catches a bleed whose unit
   * repeats in the same order every time. A real reproduction broke that
   * assumption: 330 188 reasoning characters drawn from roughly eleven sentences
   * — `Let me read the section.` / `Executing.` / `Go.` / `Now.` / `Writing.` /
   * `OK.` / `Let me write.` — **reshuffled** each pass, so no period exists at
   * any cap (measured: 0 at every cap from 64 to 4096, and the minimum period of
   * the trailing 8192 characters was 6767, i.e. none). The cycle rule was blind
   * to it and the turn ran to 330 188 characters until the user aborted.
   *
   * What such a bleed *does* have is a tiny line vocabulary. Counting how much
   * of the text sits in lines already seen separates it cleanly, and the two
   * rules are complementary rather than redundant: short-phrase bleeds (`Go.`,
   * `OK.` — under {@link LINE_MIN_CHARS}) are the cycle rule's job, long-phrase
   * pools are this one's.
   *
   * Calibrated on 146 real reasoning calls (17 aborted bleeds, 119 calls that
   * produced text or a tool call): the shipped thresholds catch the bleed at
   * **4096 characters — 1.2 % of its 330 188** — with **zero false positives on
   * all 119 producing calls**, and zero across every parameter set in the sweep
   * that this one was chosen from.
   *
   * Incremental, so the rule stays linear in emitted characters: only complete
   * lines are counted, and each line is folded in exactly once.
   *
   * @param text - the delta's text.
   * @returns `true` when the repeated mass crosses both thresholds.
   */
  private pushLines(text: string): boolean {
    if (this.config.maxRepeatedReasoningLineChars <= 0) return false
    this.linePartial += text
    let idx: number
    while ((idx = this.linePartial.indexOf('\n')) >= 0) {
      this.addLine(this.linePartial.slice(0, idx).trim())
      this.linePartial = this.linePartial.slice(idx + 1)
    }
    if (this.lineRepeat < this.config.maxRepeatedReasoningLineChars) return false
    if (this.lineTotal === 0) return false
    return this.lineRepeat / this.lineTotal >= this.config.minRepeatedReasoningLineCoverage
  }

  /**
   * Fold one complete line into the running counts.
   *
   * The repeat mass is maintained rather than recomputed: on the *second*
   * sighting of a line both copies become repetition, hence `* 2`, and every
   * sighting after that adds one more copy. Lines below {@link LINE_MIN_CHARS}
   * are dropped entirely so they never enter the denominator either.
   *
   * @param line - the trimmed line.
   */
  private addLine(line: string): void {
    if (line.length < LINE_MIN_CHARS) return
    const prev = this.lineCounts.get(line) ?? 0
    this.lineCounts.set(line, prev + 1)
    this.lineTotal += line.length
    if (prev === 1) this.lineRepeat += line.length * 2
    else if (prev > 1) this.lineRepeat += line.length
  }
}

/**
 * The intra-call breaker: watches one call's visible output and reports when the
 * model has repeated itself enough to be considered degenerate.
 *
 * Kept separate from {@link LoopDetector} because the two answer different
 * questions on different clocks — this one must decide *while the stream is
 * still open* (a call that bleeds for ten minutes never reaches the other), and
 * it is deliberately blind to reasoning text, which legitimately revisits itself
 * far more often than visible output does. A bleed that happens *inside*
 * reasoning is {@link ReasoningLoopBreaker}'s job, under a stricter rule.
 * Free of Cordis types so the decision rule is unit-testable without a harness.
 */
export class TextRepetitionDetector {
  private texts: string[] = []
  private broken = false
  private visible = ''
  private lastCycleCheck = 0
  private reason: 'identical-chunks' | 'repeating-cycle' | undefined

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** Whether the breaker has already fired for this call. */
  get tripped(): boolean {
    return this.broken
  }

  /** Which rule fired, for the log line and for tests. */
  get trippedBy(): 'identical-chunks' | 'repeating-cycle' | undefined {
    return this.reason
  }

  /** How many characters the call had emitted when the breaker tripped. */
  private chars = 0

  /** Visible-output characters observed so far in this call. */
  get emittedChars(): number {
    return this.chars
  }

  /**
   * Observe one `text-delta` payload.
   *
   * @param text - the delta's text.
   * @returns `true` exactly once, on the delta that completes the run.
   */
  push(text: string): boolean {
    if (this.broken) return false
    this.chars += text.length
    if (this.config.maxRepeatedText <= 0 && this.config.maxRepeatedCycleChars <= 0) return false
    this.texts.push(text)
    if (this.config.maxRepeatedText > 0
      && this.texts.length >= this.config.maxRepeatedText
      && countRepeatedText(this.texts) >= this.config.maxRepeatedText) {
      this.broken = true
      this.reason = 'identical-chunks'
      return true
    }
    if (this.config.maxRepeatedCycleChars <= 0) return false
    this.visible += text
    // The scan grows with the qualifying span, so run it on a fixed stride
    // rather than per delta: a bleed is hundreds of characters long and 32
    // characters of latency cost nothing next to the cost of not firing.
    if (this.visible.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false
    this.lastCycleCheck = this.visible.length
    const span = trailingCycle(this.visible, this.config.maxRepeatedCycleChars, this.config.minRepeatedCycleChars)
    if (span === 0) return false
    this.broken = true
    this.reason = 'repeating-cycle'
    return true
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

/** The shape of one row of `settings.describe()`, narrowed to what is read here. */
interface SettingsDescriptorLike {
  /** Loader entry id; since the 0.1.7-alpha.1 redesign this IS the namespace. */
  ns?: unknown
  /** The entry's resolved live values. */
  value?: unknown
}

/**
 * The language the guard speaks to the model in. Default `zh`.
 *
 * Chinese is the default and the fallback in every direction: this guard's
 * primary audience reads Chinese, and a wrong guess costs more than a default
 * does. Only an explicit `en` preference selects English; an absent settings
 * service, a missing `locale` entry, a malformed section or a throwing reader
 * all resolve to `zh`.
 *
 * The service is read with `ctx.get('settings')` rather than `ctx.settings`:
 * Cordis's context proxy throws `cannot get property "settings" without inject`
 * for any service the fiber did not declare, and the guard only declares
 * `agents`. Reading through `get` is the non-throwing accessor, so the settings
 * service stays genuinely optional — a profile without it works, and one with it
 * gets the user's real choice.
 *
 * The preference is read from `describe()` rather than from a namespace lookup,
 * because `dsh-settings` 0.1.7-alpha.1 removed the per-namespace reader
 * (`settings.get(ns)`): an entry's live values are now reported only as one row
 * of the describe projection, keyed by entry id — and the locale entry's id is
 * `locale`, which is also its settings namespace.
 */
function readLanguage(ctx: Context): 'zh' | 'en' {
  try {
    const settings = (ctx as { get?: (name: string) => unknown }).get?.('settings') as
      | { describe?: () => unknown }
      | undefined
    if (settings === undefined || typeof settings.describe !== 'function') return 'zh'
    const rows = settings.describe()
    if (!Array.isArray(rows)) return 'zh'
    const row = (rows as SettingsDescriptorLike[]).find((candidate) => candidate.ns === 'locale')
    const section = row?.value
    if (section === null || typeof section !== 'object') return 'zh'
    const preference = (section as { preference?: unknown }).preference
    if (typeof preference !== 'string') return 'zh'
    return preference.toLowerCase().startsWith('en') ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** Localized strings for the messages the guard sends the model. */
interface Strings {
  /** `warn` escalation notice. */
  warn(detail: string): string
  /** `steer` escalation notice. */
  steer(detail: string): string
  /** `cancel` escalation notice. */
  cancel(detail: string): string
  /** What the stall looked like, for the `warn`/`steer`/`cancel` templates. */
  detail(reason: StallReason): string
  /** The correction queued after a mid-stream break. */
  correction(what: string, chars: number): string
  /** One-line account for the collapsed transcript row of a stall notice. */
  stallSummary(reason: StallReason): string
  /** One-line account for the collapsed transcript row of a break notice. */
  breakSummary(what: string, chars: number): string
}

const EN: Strings = {
  warn: (d) => `The agent has produced ${d}. If this continues it will be interrupted.`,
  steer: (d) => `You are repeating the same reasoning without acting (${d}). Stop deliberating and carry on `
    + 'with the task: take the next concrete step instead of restating it.',
  cancel: (d) => `Aborting: ${d}.`,
  detail: (reason) => reason === 'reasoning-only'
    ? 'several long reasoning-only calls with no output'
    : 'several calls that restate the same reasoning without adding anything',
  correction: (what, chars) => `Your ${what} had repeated itself for ${chars} characters without progressing, `
    + 'so the response was cut off mid-stream. Do not repeat it: carry on with the task you were working on.',
  stallSummary: (reason) => reason === 'reasoning-only'
    ? 'stalled: reasoning-only calls'
    : 'stalled: restated reasoning',
  breakSummary: (what, chars) => `cut a repeating ${what} at ${chars} chars`,
}

const ZH: Strings = {
  warn: (d) => `模型已出现${d}。若继续，将被中断。`,
  steer: (d) => `你正在重复相同的推理而没有行动（${d}）。停止空转，继续推进任务：直接执行下一步，不要再复述。`,
  cancel: (d) => `正在中止：${d}。`,
  detail: (reason) => reason === 'reasoning-only'
    ? '连续多次只输出思考、没有任何产出'
    : '连续多次复述同样的推理、没有新增内容',
  // The correction must send the model BACK to its task, not wrap it up. An
  // earlier wording ("state the conclusion once, briefly") read as "finish now"
  // and made the model abandon work in progress — the break ended the loop but
  // also derailed the turn. The instruction is therefore only "stop repeating,
  // carry on".
  correction: (what, chars) => `你的${what}已连续重复 ${chars} 个字符而没有进展，因此响应被中途截断。`
    + '不要重复这段内容，继续完成你原本的任务。',
  stallSummary: (reason) => reason === 'reasoning-only'
    ? '空转：仅思考无产出'
    : '空转：复述推理',
  breakSummary: (what, chars) => `已截断重复的${what}（${chars} 字符）`,
}

/** The strings for one language. */
function stringsFor(lang: 'zh' | 'en'): Strings {
  return lang === 'zh' ? ZH : EN
}

/** The noun naming what repeated, in the language the model is addressed in. */
function whatFor(lang: 'zh' | 'en', rule: BreakRule): string {
  if (lang === 'zh') return rule === 'identical-chunks' || rule === 'repeating-cycle' ? '可见输出' : '思考内容'
  return rule === 'identical-chunks' || rule === 'repeating-cycle' ? 'visible output' : 'reasoning'
}

/**
 * Whether a failed model request was a response body the JSON parser rejected.
 *
 * Both halves are required, and neither is sufficient alone:
 *
 *  - The **code** alone is too broad. `PI_AI_ERROR` is the pi-ai adapter's
 *    catch-all, so it also carries bodies that are not parse failures at all —
 *    `Too many pending requests, please retry later`, `Provider finish_reason:
 *    error`, and pi-ai's own `ended pending` / `deferred` terminals. Measured
 *    across this machine's session store, the same code covered 16 genuine
 *    JSON-parse failures AND those unrelated ones.
 *  - The **message** alone is too broad too. An upstream 4xx/5xx whose error
 *    BODY quotes a JSON error is not a parse failure, and re-sending it just
 *    repeats the upstream's answer; those arrive under the upstream's own code.
 *
 * `JSON at position <n>` is the anchor V8 gives every positional parse failure —
 * it is the shared substring of all three observed shapes
 * (`Unexpected non-whitespace character after JSON at position …`,
 * `Unterminated string in JSON at position …`,
 * `Expected ',' or '}' after property value in JSON at position …`). Matching
 * the whole phrasing of any single one would miss the others.
 */
function isMalformedResponseFailure(failure: LlmFailure): boolean {
  return failure.code === 'PI_AI_ERROR' && /JSON at position \d+/.test(failure.message)
}

/**
 * Install the listener. Per-`Agent` state is keyed in a `WeakMap` so a disposed
 * agent is collected; detectors are scoped to one agent lifecycle.
 *
 * `config` carries the entry's LIVE references, so the value a user saved on
 * the Plugins page — or wrote into the row's `cordis.patch.yml` config — is the
 * one in effect, and a later edit is picked up on the next model call: the
 * per-call breakers and the per-agent detector are both built from a fresh read.
 *
 * Every field is resolved INSIDE the thunk rather than captured once, because
 * the Loader commits a volatile edit into these very references (`updateVolatile`
 * → `loader/volatile-update`) instead of remounting the plugin. A snapshot taken
 * at activation would pin the values the profile started with, and the page's
 * save button would appear to do nothing.
 */
export function apply(ctx: Context, config: ConfigRefs): void {
  installListeners(ctx, () => ({
    maxThinkingSteps: config.maxThinkingSteps.get(),
    minReasoningChars: config.minReasoningChars.get(),
    similarityThreshold: config.similarityThreshold.get(),
    escalate: config.escalate.get(),
    maxFires: config.maxFires.get(),
    cancelCause: config.cancelCause.get(),
    maxRepeatedText: config.maxRepeatedText.get(),
    maxRepeatedCycleChars: config.maxRepeatedCycleChars.get(),
    minRepeatedCycleChars: config.minRepeatedCycleChars.get(),
    maxRepeatedReasoningCycleChars: config.maxRepeatedReasoningCycleChars.get(),
    minRepeatedReasoningCycleChars: config.minRepeatedReasoningCycleChars.get(),
    maxRepeatedReasoningLineChars: config.maxRepeatedReasoningLineChars.get(),
    minRepeatedReasoningLineCoverage: config.minRepeatedReasoningLineCoverage.get(),
    breakCode: config.breakCode.get(),
    breakCorrection: config.breakCorrection.get(),
    resumeAfterBreak: config.resumeAfterBreak.get(),
    retryRequestFailures: config.retryRequestFailures.get(),
    maxRequestRetries: config.maxRequestRetries.get(),
  }))
}

/** The listener body, resolving the effective configuration at each use. */
function installListeners(ctx: Context, currentConfig: () => ResolvedConfig): void {
  const detectors = new WeakMap<object, LoopDetector>()

  /**
   * The attempt each agent's retry budget currently belongs to, with how much of
   * that budget is spent.
   *
   * `(turn, step)` is the identity of ONE attempt: `agent-loop` re-runs the
   * failed step inside its own `while (true)` and advances `phase.step` only
   * between steps, so an unchanged key means the same attempt is being retried.
   * Scoping the budget to the attempt — rather than to the agent alone — is what
   * stops one corrupted step from exhausting the whole turn.
   *
   * A single slot per agent is enough because the loop only ever moves forward:
   * `step` resets to 1 only when `turn` increments, so a key that differs from
   * the stored one is always a LATER attempt. A map keyed by every attempt would
   * therefore grow for the life of the session to say the same thing; the outer
   * `WeakMap` also drops a disposed agent's entry with the agent.
   */
  const retryBudgets = new WeakMap<object, { attempt: string; spent: number }>()

  /**
   * Claim one retry from the current attempt's budget.
   *
   * Reads the configuration at the point of use, like every other reaction, so
   * turning `retryRequestFailures` off on the Plugins page takes effect on the
   * very next failure without a remount.
   *
   * @returns whether this failure may be re-sent.
   */
  function claimRequestRetry(agent: object, turn: number, step: number): boolean {
    const config = currentConfig()
    if (!config.retryRequestFailures) return false
    const attempt = `${turn}:${step}`
    const previous = retryBudgets.get(agent)
    const spent = previous !== undefined && previous.attempt === attempt ? previous.spent : 0
    if (spent >= config.maxRequestRetries) return false
    retryBudgets.set(agent, { attempt, spent: spent + 1 })
    return true
  }

  function detectorFor(agent: Agent): LoopDetector {
    let detector = detectors.get(agent)
    if (detector === undefined) {
      detector = new LoopDetector(currentConfig())
      detectors.set(agent, detector)
    }
    return detector
  }

  function react(agent: GuardableAgent, reason: StallReason): void {
    const config = currentConfig()
    const s = stringsFor(readLanguage(ctx))
    switch (config.escalate) {
      case 'warn':
        agent.inject(message(s.warn(s.detail(reason)), 'notice', s.stallSummary(reason)))
        return
      case 'steer':
        agent.steer(message(s.steer(s.detail(reason)), 'notice', s.stallSummary(reason)))
        return
      case 'cancel':
        agent.cancel(config.cancelCause as unknown as AgentCancelCause)
        return
    }
  }

  /**
   * End one in-flight model call from inside the stream wrapper.
   *
   * The synthesized `finish` is the part that must not be skipped: the agent
   * loop feeds every chunk this wrapper yields into the same assembler an
   * adapter feeds, and `packages/llm/llm/src/invariant.ts` requires a terminal
   * finish chunk while explicitly allowing `error`/`aborted` to leave blocks
   * open. Returning without one would violate that grammar.
   *
   * Order matters — steer first, then return the terminal chunk. The user
   * message must be durably enqueued *before* the `error` finish throws out of
   * the step, so the resumed turn that the loop's `turn/end` finally block
   * schedules (`if (!this.inbox.hasPending) return false`) claims it. The error
   * path reaches `turn/end` through `throwError` without passing a turn-stopping
   * idle check, so this ordering is what makes the correction survive.
   *
   * @param agent - the live agent that owns the call.
   * @param chars - visible-output characters emitted before the break.
   * @returns the terminal chunk to yield as the call's last.
   */
  /**
   * End one in-flight model call from inside the stream wrapper.
   *
   * ## Why the call is closed, not failed
   *
   * An earlier version ended the call with a terminal `error` finish. That is
   * legal at the stream level — `llm/invariant` permits `error`/`aborted` to
   * leave blocks open — but it produces a session shape the rest of the harness
   * cannot handle, in two independent ways:
   *
   *  1. **The client cannot render it.** `agent-loop` settles an `error` finish
   *     as an `assistant/attempt` and appends no `assistant/message`
   *     (`step()`, the `finish.kind === 'error' || 'aborted'` branch). The
   *     conversation renderer builds its `assistant-step` node from a settled
   *     message, so it returns `null` for that step — and
   *     `buildTargetUpserts` refuses to withdraw a target it already
   *     materialized, throwing `conversation Definition "assistant-step"
   *     withdrew materialized target "chat"`. A reasoning-only break has no
   *     visible content to fall back on, so every break crashed the UI.
   *  2. **The turn could never continue.** The same branch ends in
   *     `throwError(error)`, so `turn()` throws out of the loop *before* it
   *     reaches `if (!this.inbox.hasPending) return false` — the line that
   *     decides whether another turn opens. A queued steer was therefore never
   *     claimed, which is why a break looked like "it just stopped".
   *
   * Closing the open blocks and finishing with `stop` instead puts the call on
   * the ordinary path: `step()` assembles `live.blocks()` into a real
   * `assistant/message`, the client renders it, and `turn()` returns normally so
   * pending steering opens the next turn.
   *
   * The invariant requires `open.size === 0` for a `stop` finish, which is
   * exactly what closing the blocks establishes.
   *
   * @param agent - the live agent that owns the call.
   * @param chars - characters emitted before the break.
   * @param rule - which detector fired.
   * @param open - the blocks still open, in stream order, with their text.
   * @returns the terminal chunks to yield, or `null` when the break cannot be
   *   made safe and the stream should be left alone.
   */
  function breakStream(
    agent: GuardableAgent,
    chars: number,
    rule: BreakRule,
    open: readonly { index: number; blockType: string; text: string }[],
  ): StreamChunk[] | null {
    // A `stop` finish is only legal with no open block, so every open block must
    // be closed. That is safe for text/reasoning, whose payload this wrapper
    // accumulated. It is NOT safe for a tool-call: closing one would commit a
    // half-streamed call into `message.content`, and `step()` executes any
    // tool-call block it finds — running a call whose arguments are still
    // truncated JSON. Leaving it open fails the invariant instead. Neither is
    // acceptable, so the break is abandoned; the post-call detectors still
    // apply, and a few more repeated characters are cheaper than a bad call.
    if (open.some((block) => block.blockType !== 'text' && block.blockType !== 'reasoning')) {
      ctx.logger.warn(`loop-guard: repetition detected but a non-text block is open; not breaking (rule: ${rule})`)
      return null
    }
    const config = currentConfig()
    const lang = readLanguage(ctx)
    const s = stringsFor(lang)
    const what = whatFor(lang, rule)
    ctx.logger.warn(`dsh-loop-guard: breaking a repetitive stream (${chars} chars, one call, rule: ${rule}, code: ${config.breakCode})`)
    if (config.breakCorrection) {
      agent.steer(message(s.correction(what, chars), 'notice', s.breakSummary(what, chars)))
    } else if (config.resumeAfterBreak) {
      // Only reachable when nothing was steered above: a steered correction
      // keeps the turn alive on its own (`turn()` only breaks while `nextStep`
      // is empty), so scheduling a resume as well would deliver the same text
      // twice — and it is the resume copy that accumulates.
      //
      // Called synchronously here, before the terminal chunk is yielded, so the
      // `whenIdle()` promise observes this turn's completion. Awaiting it later,
      // from the break path, would race the very wind-down it needs to follow.
      scheduleResume(agent, s.correction(what, chars), s.breakSummary(what, chars))
    }
    const out: StreamChunk[] = []
    for (const block of open) {
      // `block-end` wins over the accumulated deltas (`BlockAssembler.assemble`
      // returns `partial.block` when set), so this payload is what the committed
      // message carries.
      out.push({
        type: 'block-end',
        index: block.index,
        block: { type: block.blockType, text: block.text } as never,
      })
    }
    out.push({ type: 'finish', reason: { kind: 'stop' } })
    return out
  }

  /**
   * Re-enter the model once the broken turn has actually finished unwinding.
   *
   * `wakeDriver()` only starts a driver when the agent is `idle`, so a wake
   * issued from inside the stream wrapper (phase `running`) is silently
   * dropped: `send()` classifies it as a non-abort wake, `wakeDriver` refuses
   * to latch it, and `kick()`'s `finally` sees no `wakeRequested`. Waiting on
   * `whenIdle()` is what puts the wake on the far side of that boundary.
   *
   * The continuation goes through `steer()`, never `followup()`. Both wake the
   * driver identically, but they land in different inboxes: `followup()` writes
   * `next-turn`, and `claim()` consumes exactly ONE queued message per turn, so
   * a burst of breaks accumulates a backlog that drains as one single-step turn
   * per message. `steer()` writes `next-step`, which is drained whole at the
   * next step boundary. Every notice this plugin emits is a steering notice.
   *
   * The continuation carries the correction text rather than an empty message:
   * an empty one would hand the model the same degenerate history with no new
   * instruction, which is the loop's own input.
   *
   * Failures here are logged, never thrown: this runs detached from the stream,
   * and a guard must not be the reason a session dies.
   */
  function scheduleResume(agent: GuardableAgent, text: string, summary: string): void {
    const whenIdle = agent.whenIdle
    if (typeof whenIdle !== 'function') return
    void whenIdle.call(agent).then(() => {
      agent.steer(message(text, 'notice', summary))
      ctx.logger.debug('dsh-loop-guard: resumed the turn after a break')
    }).catch((error: unknown) => {
      ctx.logger.warn(`dsh-loop-guard: could not resume after a break: ${String(error)}`)
    })
  }

  // Re-send a request whose response body was corrupted in transit. Unlike every
  // other reaction in this plugin, this one is an automatic retry — and it is
  // the only failure class where that is right, because the request itself was
  // well-formed: the provider returned something the JSON parser rejected, the
  // turn died through this very waterfall, and the same request normally
  // succeeds on a second attempt. The thinking-loop breaks above re-enter a model
  // that has already shown it cannot act, which is why those are never retried.
  //
  // Declining is `next()`, never `undefined`: this waterfall is shared, so the
  // shipped `llm-retry` policy (and any later listener) must still get its turn
  // and its answer must survive.
  ctx.on('agent/request-error', ({ agent, turn, step, failure }, next) => {
    if (!isMalformedResponseFailure(failure)) return next()
    if (!claimRequestRetry(agent, turn, step)) return next()
    ctx.logger.debug('dsh-loop-guard: retrying a malformed model response')
    return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
  })

  // Observe every streaming model call through the `llm/stream` waterfall. This
  // is present on both dsh 0.1.2-rc.1 and 0.1.5-alpha.1 and carries the SAME
  // StreamChunk delta types, so no version branching is needed.
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    // Only agent-loop-built calls carry the loop identity; skip arbitrary
    // non-agent streaming (tool streams, assistant replay, etc.).
    if (!isAgentLoopRequest(options)) return next()
    if (options.sessionId === undefined) return next()
    const agent = ctx.agents.get(options.sessionId)
    if (agent === undefined) return next()
    const detector = detectorFor(agent)

    return (async function* wrapped(): AsyncIterable<StreamChunk> {
      let reasoning = ''
      let hasOutput = false
      const config = currentConfig()
      const textBreaker = new TextRepetitionDetector(config)
      const reasoningBreaker = new ReasoningLoopBreaker(config)
      // Blocks still open, in stream order. A break has to close them itself:
      // `llm/invariant` rejects a `stop` finish while any block is open, and the
      // committed content of each block comes from the `block-end` payload.
      const open = new Map<number, { blockType: string; text: string }>()
      const openBlocks = () => [...open.entries()].map(([index, b]) => ({ index, ...b }))
      for await (const chunk of next()) {
        if (chunk.type === 'block-start') open.set(chunk.index, { blockType: chunk.blockType, text: '' })
        else if (chunk.type === 'block-end') open.delete(chunk.index)
        else if (chunk.type === 'reasoning-delta') {
          reasoning += chunk.text
          const block = open.get(chunk.index)
          if (block !== undefined) block.text += chunk.text
        } else if (chunk.type === 'text-delta') {
          hasOutput = true
          const block = open.get(chunk.index)
          if (block !== undefined) block.text += chunk.text
        } else if (chunk.type === 'tool-call-delta') hasOutput = true
        yield chunk
        // Visible-output repetition is the one failure the post-call judgement
        // above cannot reach (issue #2848: ~2825 repeats inside ONE call), so it
        // is checked per chunk and ends the stream while it is still open. The
        // returning branch skips the post-call observation: the call did not
        // finish, and its breaker already reacted.
        if (chunk.type === 'text-delta' && textBreaker.push(chunk.text)) {
          // `return` here ends the generator — this is not the C# `yield break`.
          const tail = breakStream(agent, textBreaker.emittedChars, textBreaker.trippedBy ?? 'identical-chunks', openBlocks())
          if (tail === null) continue
          for (const c of tail) yield c
          return
        }
        // Reasoning repetition is the failure in issue #5976: the model emits
        // reasoning forever and never returns, so the step never settles and the
        // harness turn loop never breaks. This is the only detector here that
        // can end such a turn, and it must run mid-stream to do it.
        if (chunk.type === 'reasoning-delta' && reasoningBreaker.push(chunk.text)) {
          const tail = breakStream(agent, reasoningBreaker.emittedChars, reasoningBreaker.trippedBy ?? 'reasoning-cycle', openBlocks())
          if (tail === null) continue
          for (const c of tail) yield c
          return
        }
      }
      // Judge the call only once its stream has ended: a call that turns out to
      // produce output after its reasoning is progress, not a thinking loop.
      const reason = detector.observe({ hasOutput, reasoning })
      if (reason !== undefined) ctx.logger.debug(`thinking-loop-guard: stalled call (${reason})`)
      const fire = detector.takeFire()
      if (fire !== undefined) react(agent, fire)
    })()
  })
}

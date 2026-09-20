/**
 * ctx-mem — a compaction backend that carries hard facts verbatim and asks a
 * model only for the causes.
 *
 * The host's `BasicCompactionEngine` condenses a whole conversation span by
 * replaying it into one summarization call. That call is priced by everything
 * it replays, and it lets the model paraphrase the very things that must not
 * drift: file paths, commands, error strings. In cascade, early facts are lost
 * because each checkpoint is written from the previous checkpoint's prose.
 *
 * This backend keeps every safety mechanism of the host engine — trigger
 * policy, retained tail, transaction locking, tool-pairing boundaries — and
 * replaces only `summarize()`, the one hook the host documents for that purpose:
 *
 * 1. Recover the compacted region from the session log by message identity and
 *    select its raw events by **seq range** (see `src/region.js`).
 * 2. Extract hard facts from those raw events programmatically
 *    (`src/extract.js`), so paths, commands and errors are copied byte-for-byte.
 * 3. Render them as a small fact skeleton (`src/skeleton.js`).
 * 4. Ask the model to fill in only the four causal sections
 *    (`src/prompt.js`), then re-establish their structure programmatically
 *    (`src/causal.js`) so a drifting model cannot reshape the checkpoint.
 *
 * Because the skeleton is rebuilt from raw events on every compaction, facts
 * from the first span survive into the second (no cascade decay).
 *
 * @module @logictan/dsh-ctx-mem
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { normalizeCausal } from './causal.js';
import { Config, resolveFillTarget, splitConfig } from './config.js';
import { extractFacts } from './extract.js';
import { framedPrice } from './frame.js';
import { fillInstruction } from './prompt.js';
import { regionOf } from './region.js';
import { renderCheckpoint } from './render.js';
import { skillProvider } from './skill.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'ctx-mem';

/**
 * Tokens held back from the denominator so the joint frame lands strictly under
 * it. The host's guard is `framedPrice < denominator` with no slack, so the
 * budget must leave room for rounding and for the join between the skeleton and
 * the causal section.
 *
 * Measured on the real 12-round degenerate chain: 64 loses at most 4 commands
 * in any single round (A15's ceiling is 5), while 128 already loses 6 and 256
 * loses 8. The reserve is deliberately the smallest value that keeps the
 * fidelity contract, because every extra token here is a fact dropped from
 * every checkpoint.
 */
const FRAME_RESERVE = 64;

/**
 * Tokens assumed for the causal section while rendering the skeleton that the
 * fill call reads.
 *
 * The causal price cannot be known before the model has written it, but the
 * fill call needs a skeleton as its input. This allowance sizes that
 * provisional skeleton. It must NOT be the fill route's `maxTokens`: an
 * 8192-token allowance consumes the whole budget on a degenerate fold and
 * collapses the command list within five rounds. The measured causal sections
 * top out at 1143 tokens, so 1200 covers every real fold observed.
 */
const CAUSAL_ALLOWANCE = 1200;

/**
 * Compaction backend carrying hard facts verbatim and filling causes with a model.
 *
 * `static inject` is intentionally **not** redeclared: the host engine already
 * declares `['llm', 'tokenMeter', 'sessions']`, and redeclaring it here would
 * silently drop any dependency the host adds later.
 *
 * Every method here is public and every helper it calls is a module-scope
 * function. Neither `#private` members nor `#private` methods are usable: the
 * host reaches this backend through the `compaction` service, and cordis calls
 * service methods with a shadow context as `this` — a `Proxy` that wraps the
 * instance without being one. V8's brand check then rejects the receiver
 * (`Receiver must be an instance of class CtxMemEngine`) on the first private
 * access, which is exactly how a real compaction fails. Public fields are fine
 * (`ctxMemConfig` below is read through the proxy), and so is `this.ctx`, which
 * cordis rewrites to the shadow's own context.
 */
export default class CtxMemEngine extends BasicCompactionEngine {
  static Config = Config;

  /**
   * This backend's own configuration, split out of the row config.
   * @type {{ fillEnabled: boolean, fillProvider: string, fillModel: string, language: string }}
   */
  ctxMemConfig;

  /**
   * Fiber of the child plugin that publishes the bundled guide.
   *
   * The guide registers asynchronously (a Cordis plugin body starts once its
   * `skills` dependency resolves), so this is the handle that says when it has.
   * It is also why the guide is registered from a child fiber instead of the
   * constructor body: `skills` is not in this engine's `static inject`, and it
   * must not be added there (see the class doc).
   *
   * @type {any}
   */
  skillFiber;

  /**
   * @param {any} ctx Plugin context.
   * @param {Record<string, unknown>} [config] Row configuration, validated by
   *   {@link Config}. Keys this backend adds are stripped before `super()`.
   */
  constructor(ctx, config = {}) {
    const { engineConfig, own } = splitConfig(config);
    super(ctx, engineConfig);
    this.ctxMemConfig = own;
    this.skillFiber = registerSkill(ctx);
  }

  /**
   * Build the checkpoint for one compacted region.
   *
   * With `fillEnabled: false` — or with no resolvable route — this performs no
   * model call at all and returns the fact skeleton alone.
   *
   * `usage` is present only when the adapter reported one, matching how the host
   * backend spreads the assembler's usage into its own result.
   *
   * @param {{ tools?: unknown, messages: readonly any[] }} input Replayed region.
   * @param {any} agent Compaction agent; supplies `session`.
   * @param {AbortSignal} [signal] Cancellation forwarded to the fill call.
   * @returns {Promise<{ summary: any[], rawOutput?: any[], llmStreamCall?: boolean, provider: string, model: string, maxTokens?: number, usage?: any }>}
   */
  async summarize(input, agent, signal) {
    const region = regionOf(agent.session, input);
    const facts = extractFacts(region);

    // The host guard requires the framed checkpoint to be strictly smaller than
    // the span it replaces, so the ceiling has to drive the rendering rather
    // than the other way round (see `src/render.js`).
    const denominator = shadowedPrice(this.ctx, input.messages);
    const budget = this.ctxMemConfig.maxCheckpointTokens;
    const framed = frameEstimator(this.ctx);

    if (!this.ctxMemConfig.fillEnabled) {
      const { text, tier, floorHit } = renderCheckpoint(
        facts,
        capped(denominator === undefined ? undefined : denominator - CAUSAL_ALLOWANCE - FRAME_RESERVE, budget),
        framed(undefined),
      );
      this.logFloor(denominator, tier, floorHit);
      return deterministicCheckpoint(text);
    }

    const target = resolveFillTarget(this.ctxMemConfig, agent);
    if (target === undefined) {
      // No route to fill with. Degrading to the deterministic checkpoint keeps
      // the facts and avoids failing a compaction the host already committed to.
      const { text, tier, floorHit } = renderCheckpoint(
        facts,
        capped(denominator === undefined ? undefined : denominator - CAUSAL_ALLOWANCE - FRAME_RESERVE, budget),
        framed(undefined),
      );
      this.logFloor(denominator, tier, floorHit);
      return deterministicCheckpoint(text);
    }

    // The per-route cap wins over the global one, exactly as the host's own
    // `resolveTargetPolicy` composes it. Reading `this.config.maxTokens` alone
    // would silently ignore a `modelPolicies[].maxTokens` the user pinned to
    // this route.
    const maxTokens = maxTokensFor(this.config, target);

    // First pass: a provisional skeleton, sized against an *allowance* for a
    // causal section that does not exist yet. It is only the fill call's input.
    const provisional = renderCheckpoint(
      facts,
      capped(denominator === undefined ? undefined : denominator - CAUSAL_ALLOWANCE - FRAME_RESERVE, budget),
      framed(undefined),
    );

    const { text: raw, usage } = await fillCheckpoint(
      this.ctx,
      provisional.text,
      target,
      agent,
      this.ctxMemConfig.language,
      maxTokens,
      signal,
    );

    // Second pass: the causal section now exists, so it can be priced for real
    // and the skeleton re-rendered to fit beside it. Re-rendering costs no
    // model call — the facts are already extracted.
    const causal = normalizeCausal(raw);
    const final = renderCheckpoint(
      facts,
      capped(denominator === undefined ? undefined : denominator - FRAME_RESERVE, budget),
      framed(causal),
    );
    this.logFloor(denominator, final.tier, final.floorHit);

    return {
      summary: textBlocks(`${final.text}\n\n${causal}`),
      rawOutput: textBlocks(raw),
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /**
   * Report a floor hit once, with the numbers needed to diagnose it.
   *
   * The host's guard is not recoverable, so a floor hit on a fold the host will
   * still reject cannot be fixed by retrying — it has to be visible instead.
   * @param {number | undefined} denominator Shadowed price, or undefined when
   *   the meter could not price the region.
   * @param {string} tier Tier the renderer settled on.
   * @param {boolean} floorHit Whether the floor tier was forced.
   */
  logFloor(denominator, tier, floorHit) {
    if (!floorHit) return;
    this.ctx.logger.warn(
      `ctx-mem checkpoint fell back to the floor tier: shadowed price ${denominator ?? 'unknown'} ` +
        `leaves no room for commands or errors (tier ${tier})`,
    );
  }
}

/**
 * Resolve the token cap for one fill route.
 *
 * Mirrors the host's `resolveTargetPolicy`: an exact provider/model entry in
 * `modelPolicies` overrides the global `maxTokens`. The host applies `?? 8192`
 * while validating, so `this.config.maxTokens` is always a number here.
 *
 * @param {{ maxTokens: number, modelPolicies?: Array<{ provider: string, model: string, maxTokens?: number }> }} config
 *   The engine's resolved configuration.
 * @param {{ provider: string, model: string }} target Resolved fill route.
 * @returns {number} The cap to pass to the fill call.
 */
function maxTokensFor(config, target) {
  const override = (config.modelPolicies ?? []).find(
    (policy) => policy.provider === target.provider && policy.model === target.model,
  );
  return override?.maxTokens ?? config.maxTokens;
}

/**
 * Price the region the checkpoint will replace, the way the host guard does.
 *
 * The host computes `shadowedRouteTokenCount` as the sum of each node's own
 * token count and compares the framed checkpoint against it. Summing
 * `estimateMessage` over the replayed messages reproduces that number exactly
 * (measured 11/11 against the host's own value), which is what makes the budget
 * a real ceiling rather than a guess.
 *
 * A leading `system/message` is skipped because the host's
 * `selectCompactableRange` starts at index 1 in that case — pricing it would
 * inflate the denominator and hand the renderer a budget it cannot actually
 * spend. The skip is **conditional**, exactly as the host's
 * `firstIdx = systemHead(...) === undefined ? 0 : 1`: a region with no system
 * head starts at index 0, so skipping blindly would under-count the
 * denominator. Under-counting is the safe direction (a smaller budget can only
 * make the checkpoint cheaper), but it would also make this function stop
 * mirroring the host, and A1's whole value is that the two agree.
 *
 * @param {any} ctx Service context; must carry a `tokenMeter`.
 * @param {readonly any[]} messages Replayed region messages.
 * @returns {number | undefined} The denominator, or undefined when no meter is
 *   available (the caller then falls back to the absolute cap alone).
 */
function shadowedPrice(ctx, messages) {
  const meter = ctx?.tokenMeter;
  if (typeof meter?.estimateMessage !== 'function' || !Array.isArray(messages)) return undefined;

  // `buildSummarizationInput` prepends the surface head's derived message only
  // when that head is a `system/message`; the host then starts the range at 1.
  const head = messages[0];
  const startsWithSystem = head !== null && head !== undefined && head.role === 'system';

  let total = 0;
  for (let index = startsWithSystem ? 1 : 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined || message === null) continue;
    total += meter.estimateMessage(message);
  }
  return total;
}

/**
 * Build the estimator the renderer prices a candidate skeleton with.
 *
 * It prices the **whole framed checkpoint** — preamble, tags, skeleton and
 * causal section — because that is the number the host guard actually compares.
 * Pricing the skeleton alone would let the frame and the causal section push the
 * final price back over the denominator, which is exactly the defect this
 * backend is being fixed for.
 *
 * @param {any} ctx Service context; must carry a `tokenMeter`.
 * @returns {(causal: string | undefined) => ((skeleton: string) => number) | undefined}
 *   A function taking the causal text (undefined before the fill call) and
 *   returning an estimator, or undefined when no meter is available.
 */
function frameEstimator(ctx) {
  const meter = ctx?.tokenMeter;
  if (typeof meter?.estimateMessage !== 'function') return () => undefined;

  return (causal) => (skeleton) =>
    framedPrice(meter, causal === undefined || causal === '' ? skeleton : `${skeleton}\n\n${causal}`);
}

/**
 * Clamp a denominator-derived budget by the absolute ceiling.
 *
 * @param {number | undefined} derived Budget from the shadowed price, or
 *   undefined when the region could not be priced.
 * @param {number} absolute Configured `maxCheckpointTokens`.
 * @returns {number} The smaller of the two; the absolute cap alone when the
 *   derived budget is unknown.
 */
function capped(derived, absolute) {
  if (derived === undefined || !Number.isFinite(derived)) return absolute;
  return Math.min(derived, absolute);
}

/**
 * The checkpoint used when no fill call runs: the fact skeleton alone.
 *
 * The provider/model are reported as the engine's own identity rather than a
 * fabricated route, because no routed request happened. The host requires both
 * to be non-empty strings on the recorded summary event.
 *
 * @param {string} text Rendered skeleton.
 * @returns {{ summary: any[], provider: string, model: string }}
 */
function deterministicCheckpoint(text) {
  return {
    summary: textBlocks(text),
    provider: name,
    model: name,
  };
}

/**
 * Run the fill call over the skeleton.
 *
 * The skeleton is sent as the conversation prefix and the instruction as the
 * final user message — the same shape the host's own summarization call uses,
 * so the request stays a single completion rather than a new prompt channel.
 *
 * @param {any} ctx Service context, passed in rather than read off `this` so the
 *   call does not depend on the receiver being the instance.
 * @param {string} skeleton Rendered fact skeleton.
 * @param {{ provider: string, model: string }} target Resolved fill route.
 * @param {any} agent Compaction agent; supplies the session id.
 * @param {string} language Configured language for the fill instruction.
 * @param {number} maxTokens Cap for the fill call, already resolved per route.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ text: string, usage: any }>} Raw model text and the
 *   adapter-reported usage, so the caller can record it on the summary event.
 */
async function fillCheckpoint(ctx, skeleton, target, agent, language, maxTokens, signal) {
  const assembler = new BlockAssembler();
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: skeleton }],
      source: { kind: 'plugin', plugin: name },
    }),
    createUserMessage({
      content: [{ type: 'text', text: fillInstruction(language) }],
      source: { kind: 'plugin', plugin: name },
    }),
  ];

  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens,
    sessionId: agent.session.id,
    // Marks the request as a compaction call, as the host's own summarization
    // call does. Adapters key provider-side behaviour off this.
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };

  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);

  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`ctx-mem fill call failed: ${finish.failure.message}`);
  }
  if (finish.kind === 'max-tokens') {
    throw new Error('ctx-mem fill call truncated at the token cap (incomplete checkpoint)');
  }

  const text = assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (text.trim() === '') throw new Error('ctx-mem fill call produced no text');
  return { text, usage: assembler.usage };
}

/**
 * Wrap plain text as one text content block.
 *
 * @param {string} text
 * @returns {Array<{ type: 'text', text: string }>}
 */
function textBlocks(text) {
  return [{ type: 'text', text }];
}

/**
 * Publish the bundled usage/config guide through the host skill registry.
 *
 * The guide is registered from a **child fiber that injects `skills`**, not
 * from `static inject` on the engine: redeclaring `inject` would drop whatever
 * the host engine adds to its own list later (see the class doc), and a host
 * without a skill registry must still boot — losing a documentation skill is
 * never worth failing a compaction engine over. The child fiber simply never
 * starts on such a host, and registering into it keeps the provider scoped to
 * this preset's layer rather than the process-global one.
 *
 * @param {any} ctx Plugin context.
 * @returns {any} The child fiber, so a caller can await registration. The
 *   constructor cannot await it and does not need to: a plugin body starts on
 *   its own once its dependencies resolve, which is how every Cordis row works.
 */
export function registerSkill(ctx) {
  try {
    return ctx?.inject?.(['skills'], (skillCtx) => {
      skillCtx.skills.registerProvider(() => skillProvider);
    });
  } catch {
    // Non-fatal: the engine's job is compaction, not documentation.
    return undefined;
  }
}

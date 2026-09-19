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
import { fillInstruction } from './prompt.js';
import { regionOf } from './region.js';
import { buildSkeleton } from './skeleton.js';
import { skillProvider } from './skill.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'ctx-mem';

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
    const { text } = buildSkeleton(facts);

    if (!this.ctxMemConfig.fillEnabled) {
      return deterministicCheckpoint(text);
    }

    const target = resolveFillTarget(this.ctxMemConfig, agent);
    if (target === undefined) {
      // No route to fill with. Degrading to the deterministic checkpoint keeps
      // the facts and avoids failing a compaction the host already committed to.
      return deterministicCheckpoint(text);
    }

    // The per-route cap wins over the global one, exactly as the host's own
    // `resolveTargetPolicy` composes it. Reading `this.config.maxTokens` alone
    // would silently ignore a `modelPolicies[].maxTokens` the user pinned to
    // this route.
    const maxTokens = maxTokensFor(this.config, target);

    const { text: raw, usage } = await fillCheckpoint(
      this.ctx,
      text,
      target,
      agent,
      this.ctxMemConfig.language,
      maxTokens,
      signal,
    );
    return {
      summary: textBlocks(`${text}\n\n${normalizeCausal(raw)}`),
      rawOutput: textBlocks(raw),
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens,
      ...(usage === undefined ? {} : { usage }),
    };
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

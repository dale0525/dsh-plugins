/**
 * Configuration surface of the desktop agent.
 *
 * As of the 0.1.7-alpha.1 settings redesign this schema is the ONE contract
 * every surface shares: the host half reads it when a run starts, and
 * `dsh-settings` derives the Plugins-page form from it — keyed by the loader
 * entry id, which is why {@link ENTRY_ID} must equal both the row id in
 * `cordis.patch.yml` and the host half's `export const name`. The card ships as
 * plain browser code and cannot import this module, so its field list is kept in
 * step by hand — changing a key here means changing `src/client.js` too.
 *
 * Two rules follow from the redesign, and both are load-bearing:
 *
 *  - The schema must be reachable as `entry.fiber.runtime.Config`, i.e. exported
 *    from the PACKAGE ENTRY (`lib/index.js`), not merely from this module. That
 *    is where `dsh-settings` looks; a schema exported only from a subpath is
 *    invisible and the entry simply has no form.
 *  - Every field must be `volatile()`. The marker is what makes the field
 *    editable without a remount — and it is also what makes the Loader hand
 *    `apply` a live `{ get() }` reference instead of a value, which is the only
 *    shape the host half reads.
 *
 * This plugin carries NO secret field of its own: every model call goes through
 * the host's own `ctx.llm`, so there is no second key to enter and nothing for
 * config sync to strip.
 *
 * @module @logictan/dsh-desktop-agent/config
 */
import z from '@deepseek-ai/schemastery';
import { DEFAULT_MAX_STEPS } from './loop.js';

/**
 * The loader entry id this plugin's configuration form is keyed by.
 *
 * `dsh-settings` keys a form by the profile entry id, which the repo convention
 * pins to the host half's `export const name`; the browser half passes the same
 * string to `configForms.get`. A mismatch does not throw — the card simply binds
 * a form that is never served, and every field renders as unset.
 */
export const ENTRY_ID = 'desktop-agent';

/** How an action reaches the target: the driver's own best-effort ladder. */
export const DELIVERY_MODES = ['background', 'foreground'];

/**
 * Schema of the `desktop-agent` configuration.
 *
 * The vision route is three separate fields rather than one. Empty means "use
 * the session's own current route", which is the only default that stays correct
 * after config sync moves the file to a machine with different providers; a
 * hard-coded model would point at a model the target may not have. It is also
 * what makes the AX fallback reachable without any configuration at all: an
 * unconfigured plugin asks the host whether the SESSION's route accepts images
 * and picks its channel from that answer.
 *
 * `deliveryMode` defaults to `background` — the official ladder is
 * background-first with `foreground` as the escalation, and the driver's
 * `background_unavailable` refusal is the only signal that authorises the
 * upgrade. Pre-selecting `foreground` is for canvas/game surfaces, which
 * explicitly filter per-pid-routed events.
 *
 * `maxImageDimension` caps the long edge of every screenshot this plugin asks
 * for. It is not cosmetic: the host refuses an oversized image at admission, and
 * an image that is merely offloaded arrives at the model as placeholder text —
 * the model would then be "looking" at nothing. The default matches the
 * driver's own 1568 ceiling, so the two never disagree.
 */
export const Config = z.object({
  visionProvider: z.string().default('').volatile(),
  visionModel: z.string().default('').volatile(),
  visionReasoningEffort: z.string().default('').volatile(),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS).volatile(),
  maxImageDimension: z.number().step(1).min(200).default(1568).volatile(),
  deliveryMode: z.union(DELIVERY_MODES).default('background').volatile(),
});

/**
 * The route one decision call uses.
 *
 * An explicitly configured pair wins. Otherwise the session's own route is used,
 * mirroring how the host resolves an auxiliary model call — the same three-step
 * fallback (configured pair, then the session's routed request, then its
 * options) that the browser agent uses for its own helper call.
 *
 * The second argument is the tool EXECUTION CONTEXT, not the agent: that is what
 * the tool body has in hand. The two are not interchangeable — reading agent
 * fields off the context short-circuits every optional chain and silently
 * reports "unconfigured" on a session that has a perfectly good route.
 *
 * @param config - the configuration in effect, as plain values (the host half
 *   unwraps the live references before calling).
 * @param exec - the tool execution context; its `agent` is the caller.
 * @returns the route to call; empty provider/model means "unconfigured".
 */
export function resolveVisionRoute(config, exec) {
  if (config.visionProvider !== '' && config.visionModel !== '') {
    return {
      provider: config.visionProvider,
      model: config.visionModel,
      reasoningEffort: config.visionReasoningEffort,
    };
  }

  const agent = exec?.agent;
  const routed = agent?.session?.requestHeader?.()?.config;
  if (routed?.provider && routed?.model) {
    return { provider: routed.provider, model: routed.model, reasoningEffort: '' };
  }

  const options = agent?.options;
  if (options?.provider && options?.model) {
    return { provider: options.provider, model: options.model, reasoningEffort: '' };
  }

  return { provider: '', model: '', reasoningEffort: '' };
}

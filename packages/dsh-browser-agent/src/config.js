/**
 * Configuration surface of the browser agent.
 *
 * The settings namespace is the one contract three surfaces share: the host
 * half reads it when a run starts, the Plugins-page card edits it, and the
 * client half's field list mirrors it. The card ships as plain browser code and
 * cannot import this module, so the two field lists are kept in step by hand —
 * changing a key here means changing `src/client.js` too.
 *
 * @module @logictan/dsh-browser-agent/config
 */
import z from '@deepseek-ai/schemastery';
import { DEFAULT_ENDPOINT as DEFAULT_CDP_ENDPOINT } from './cdp.js';
import { DEFAULT_MAX_STEPS } from './loop.js';
import { DEFAULT_ENDPOINT as DEFAULT_TYPESAFE_ENDPOINT, DEFAULT_MODEL } from './typesafe.js';

/** Settings namespace the host half registers and the card binds. */
export const SETTINGS_NAMESPACE = 'browser-agent';

/**
 * Schema of the `browser-agent` settings section.
 *
 * The TypeSafe key is `role('secret')`: it is stored in the local settings
 * document and stripped by every redacting surface, including config sync. That
 * is a deliberate consequence — a secret never leaves the machine that entered
 * it — so the key must be typed once per device.
 *
 * It deliberately carries NO default. The redaction sidecar reports
 * `set: value !== undefined` against the RESOLVED value, so `.default('')`
 * would make the key look permanently present: the card could never tell an
 * unset key from a set one, and its reset would clear a key it wrongly believed
 * was there. Leaving the field optional is what keeps that flag truthful.
 *
 * The TYPE_TEXT route is three separate fields rather than one. Empty means
 * "use the session's own current route", which is the only default that stays
 * correct after config sync moves the file to a machine with different
 * providers; a hard-coded model would point at a model the target may not have.
 */
export const Config = z.object({
  typesafeApiKey: z.string().role('secret'),
  typesafeEndpoint: z.string().default(DEFAULT_TYPESAFE_ENDPOINT),
  typesafeModel: z.string().default(DEFAULT_MODEL),
  cdpEndpoint: z.string().default(DEFAULT_CDP_ENDPOINT),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS),
  textProvider: z.string().default(''),
  textModel: z.string().default(''),
  textReasoningEffort: z.string().default(''),
});

/**
 * The route used for the TYPE_TEXT helper call.
 *
 * An explicitly configured pair wins. Otherwise the session's own route is
 * used, mirroring how the host resolves an auxiliary model call — the same
 * three-step fallback (configured pair, then the session's routed request, then
 * its options) that `ctx-mem` uses for its fill call.
 *
 * The second argument is the tool EXECUTION CONTEXT, not the agent: that is
 * what the tool body has in hand. The two are not interchangeable — reading
 * agent fields off the context short-circuits every optional chain and silently
 * reports "unconfigured" on a session that has a perfectly good route.
 *
 * @param config - the resolved settings section.
 * @param exec - the tool execution context; its `agent` is the caller.
 * @returns the route to call; empty provider/model means "unconfigured".
 */
export function resolveTextRoute(config, exec) {
  if (config.textProvider !== '' && config.textModel !== '') {
    return {
      provider: config.textProvider,
      model: config.textModel,
      reasoningEffort: config.textReasoningEffort,
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

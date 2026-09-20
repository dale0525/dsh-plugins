/**
 * Configuration surface of the ctx-mem compaction backend.
 *
 * The backend is a subclass of the host's `BasicCompactionEngine`, so its
 * configuration is the host's policy keys **plus** the keys this backend adds
 * for the fill step. Two consequences drive this module:
 *
 * 1. The host's own `resolveConfig` rejects any key it does not know
 *    (`BasicCompactionConfig: unknown key "..."`). Our extra keys must
 *    therefore be stripped before they reach `super()`, or every construction
 *    would throw. {@link splitConfig} is the single place that split happens.
 *
 * 2. The row's `Config` schema must accept both key sets, so it is the host's
 *    schema intersected with ours. That keeps the host's validation (and its
 *    `simplify`, used when the loader writes configuration back) intact instead
 *    of restating its keys here, which would drift.
 */
import z from '@deepseek-ai/schemastery';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

/** Languages this backend can produce checkpoint prose in. */
export const LANGUAGES = Object.freeze(['en', 'zh']);

/** Default output language. */
export const DEFAULT_LANGUAGE = 'zh';

/**
 * Default absolute ceiling on a rendered checkpoint, in estimated tokens.
 *
 * Set well above what a healthy fold needs (the largest real fold renders at
 * ~24,000 framed tokens before tiering) so it never binds in normal operation,
 * while still bounding the pathological case.
 */
export const DEFAULT_MAX_CHECKPOINT_TOKENS = 24000;

/**
 * Keys owned by this backend — everything the host engine does not know.
 *
 * Deliberately not exported: `Object.freeze` does not make a `Set` immutable
 * (`set.add()` still works on a frozen Set), so an exported "readonly" set would
 * be a lie — any importer could add a key and change which keys `splitConfig`
 * strips from the host half. Keeping it module-private makes the guarantee real.
 */
const OWN_CONFIG_KEYS = new Set([
  'fillEnabled',
  'fillProvider',
  'fillModel',
  'language',
  'maxCheckpointTokens',
]);

/**
 * Configuration added by this backend.
 *
 * - `fillEnabled` — run the model fill step. When false the backend degrades to
 *   a purely deterministic checkpoint and issues **no** model call.
 * - `fillProvider` / `fillModel` — route for the fill call. Both empty (the
 *   default) means "use the session's own current route", which keeps the
 *   checkpoint on the same model the conversation is already using.
 * - `language` — language of the generated prose.
 * - `maxCheckpointTokens` — absolute ceiling on the rendered checkpoint. The
 *   budget is normally driven by the region's own price, but that price is a
 *   heuristic over the replayed messages and can overstate what the guard will
 *   see on a session carrying images or attachments. This is the backstop that
 *   keeps a rendered checkpoint bounded regardless.
 */
export const Config = z.intersect([
  BasicCompactionEngine.Config,
  z.object({
    fillEnabled: z.boolean().default(true),
    fillProvider: z.string().default(''),
    fillModel: z.string().default(''),
    language: z.union(LANGUAGES.map((code) => z.const(code))).default(DEFAULT_LANGUAGE),
    maxCheckpointTokens: z.number().step(1).min(1).default(DEFAULT_MAX_CHECKPOINT_TOKENS),
  }),
]);

/**
 * Split a validated configuration into the host half and our half.
 *
 * @param {Record<string, unknown>} [config] Validated row configuration.
 * @returns {{ engineConfig: Record<string, unknown>, own: {
 *   fillEnabled: boolean,
 *   fillProvider: string,
 *   fillModel: string,
 *   language: string,
 *   maxCheckpointTokens: number,
 * } }} `engineConfig` holds only keys the host engine accepts; `own` holds only
 *   keys this backend adds.
 */
export function splitConfig(config = {}) {
  const engineConfig = {};
  const own = {
    fillEnabled: true,
    fillProvider: '',
    fillModel: '',
    language: DEFAULT_LANGUAGE,
    maxCheckpointTokens: DEFAULT_MAX_CHECKPOINT_TOKENS,
  };

  for (const [key, value] of Object.entries(config)) {
    if (OWN_CONFIG_KEYS.has(key)) continue;
    engineConfig[key] = value;
  }

  if (config.fillEnabled !== undefined) own.fillEnabled = config.fillEnabled;
  if (config.fillProvider !== undefined) own.fillProvider = config.fillProvider;
  if (config.fillModel !== undefined) own.fillModel = config.fillModel;
  if (config.language !== undefined) own.language = config.language;
  if (config.maxCheckpointTokens !== undefined) own.maxCheckpointTokens = config.maxCheckpointTokens;

  return { engineConfig, own };
}

/**
 * Resolve the route used for the fill call.
 *
 * An explicitly configured pair wins. Otherwise the session's own current route
 * is used — the latest durable routed request, falling back to the agent's
 * configured route. This mirrors how the host engine resolves its summarization
 * target, so the fill call lands on the same model the conversation is using.
 *
 * @param {{ fillProvider: string, fillModel: string }} own This backend's config.
 * @param {any} agent Compaction agent; supplies the session and options.
 * @returns {{ provider: string, model: string } | undefined} The route, or
 *   undefined when neither an override nor a routed request exists.
 */
export function resolveFillTarget(own, agent) {
  if (own.fillProvider.length > 0 && own.fillModel.length > 0) {
    return { provider: own.fillProvider, model: own.fillModel };
  }

  const routed = agent?.session?.requestHeader?.()?.config;
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model };
  }

  const options = agent?.options;
  if (
    options?.provider !== undefined &&
    options.provider.length > 0 &&
    options?.model !== undefined &&
    options.model.length > 0
  ) {
    return { provider: options.provider, model: options.model };
  }

  return undefined;
}

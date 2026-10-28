/**
 * dsh-browser-search — host half.
 *
 * Registers one thing: a `ctx.web` search provider that searches through the
 * user's own Chrome (Google) and falls back to plain-HTTP Bing. It replaces the
 * paid DeepSeek search API without changing the `web_search` tool the model sees:
 * the tool, its arguments, its output shape and its citation format all belong to
 * `@deepseek-ai/dsh-tool-web` and are untouched.
 *
 * `Config` is re-exported from the package entry because that is the exact object
 * `dsh-settings` looks for when deriving the Plugins-page form; a schema exported
 * only from `./config.js` would leave the entry with no form at all.
 *
 * @module @logictan/dsh-browser-search
 */
import { readConfig, Config } from './config.js';
import { searchBing, searchGoogle } from './engines.js';
import { BrowserSearchProvider } from './provider.js';

export { Config } from './config.js';
export { PROVIDER_ID } from './provider.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'browser-search';

/**
 * Services this plugin needs before it can mount.
 *
 * `web` is required: the whole plugin is a registration on that seam, and
 * mounting without it would leave a plugin that does nothing.
 */
export const inject = ['web'];

/**
 * Register the search provider with the web seam.
 *
 * @param ctx - the plugin context.
 * @param config - one live reference per {@link Config} field.
 */
export function apply(ctx, config) {
  const provider = new BrowserSearchProvider({
    config: () => readConfig(config),
    searchGoogle,
    searchBing,
  });

  ctx.effect(() => ctx.web.registerSearchProvider(provider), 'browser-search: search provider');
}

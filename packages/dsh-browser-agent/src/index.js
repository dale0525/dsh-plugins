/**
 * dsh-browser-agent — host half.
 *
 * Registers one thing: the `browser_agent` model tool that runs the decision
 * loop over CDP against the user's own Chrome.
 *
 * Configuration arrives as `apply`'s second argument. As of the 0.1.7-alpha.1
 * settings redesign the plugin's own `Config` schema is the only config surface
 * — `dsh-settings` derives the Plugins-page form from `entry.fiber.runtime.Config`,
 * keyed by the entry id — and every field of it is `volatile()`, so the Loader
 * hands `apply` one live `{ get() }` reference per field rather than a value.
 * The former `settings.register(ns, schema)` and `settings.get(ns)` seams were
 * removed in that generation, which is why this plugin failed to activate on it.
 *
 * `Config` is therefore re-exported from the package entry: that is the exact
 * object `dsh-settings` looks for, and a schema exported only from `./config.js`
 * would leave the entry with no form at all.
 *
 * The tool is registered through `ctx.get('tools')` rather than the `ctx.tools`
 * property. Cordis requires a declared `inject` before a service property may
 * be read, and `tools` is genuinely optional here — a headless deployment that
 * composes no tool registry still has a working configuration — so it must not
 * be injected. Reading it optionally is the same choice
 * `dsh-config-manager`'s `registerModelTools` makes, for the same reason.
 *
 * @module @logictan/dsh-browser-agent
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { attach, activePage } from './cdp.js';
import { resolveTextRoute } from './config.js';
import { run } from './loop.js';

export { Config } from './config.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'browser-agent';

/**
 * Services this plugin needs before it can mount.
 *
 * `llm` is required: the TYPE_TEXT step cannot work without it, and a silent
 * degradation there would be worse than a load failure. `settings` is NOT
 * injected — the plugin neither reads nor registers a settings namespace any
 * more, and waiting on a service a profile does not provide is precisely what
 * left this entry `pending` (and took the whole Web UI's boot audit down) on
 * 0.1.7-alpha.1.
 */
export const inject = ['llm'];

/**
 * Register the `browser_agent` tool.
 *
 * @param ctx - the plugin context.
 * @param config - one live reference per {@link Config} field.
 */
export function apply(ctx, config) {
  const llm = ctx.llm;
  const tools = ctx.get('tools');

  /**
   * The configuration in effect right now, as plain values.
   *
   * Resolved at each use rather than captured at activation: the Loader commits
   * a Plugins-page edit into these very references (`loader/volatile-update`)
   * instead of remounting the plugin, so a snapshot taken here would pin the
   * values the profile started with and the card's save button would appear to
   * do nothing.
   *
   * @returns the resolved configuration.
   */
  function currentConfig() {
    return {
      typesafeApiKey: config.typesafeApiKey.get(),
      typesafeEndpoint: config.typesafeEndpoint.get(),
      typesafeModel: config.typesafeModel.get(),
      cdpEndpoint: config.cdpEndpoint.get(),
      maxSteps: config.maxSteps.get(),
      textProvider: config.textProvider.get(),
      textModel: config.textModel.get(),
      textReasoningEffort: config.textReasoningEffort.get(),
    };
  }

  const definition = defineTool({
    name: 'browser_agent',
    description:
      "Drive the user's own Chrome to accomplish a goal. Navigates to `url` and runs an observation/decision loop " +
      'until the goal is met, then returns a structured trace. Requires Chrome to be running with a debugging port ' +
      '(the dedicated-profile command is in the plugin README) and a TypeSafe API key in the plugin settings.',
    parameters: {
      url: { type: 'string', description: 'Page to open before starting.', required: true },
      goal: { type: 'string', description: 'What must be true when the task is finished.', required: true },
    },
    output: {
      schema: { type: 'json', description: 'Structured trace: status, steps, decision count, final url.' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const current = currentConfig();
      // An unset optional field resolves to undefined; a cleared one to ''.
      if (current.typesafeApiKey === undefined || current.typesafeApiKey === '') {
        throw new Error(
          'browser_agent: no TypeSafe API key is configured. ' +
            'Open Settings → Plugins → browser-agent and paste a key from https://console.typesafe.ai/keys.',
        );
      }

      const browser = await attach(current.cdpEndpoint);
      try {
        const page = await activePage(browser);
        return await run({
          url: args.url,
          goal: args.goal,
          page,
          llm,
          config: {
            apiKey: current.typesafeApiKey,
            endpoint: current.typesafeEndpoint,
            model: current.typesafeModel,
            maxSteps: current.maxSteps,
            textRoute: resolveTextRoute(current, exec),
          },
          signal: exec.signal,
        });
      } finally {
        // Disconnect, never close: the browser is the user's, and closing it
        // would take their windows and tabs with it.
        await browser.close();
      }
    },
  });

  if (tools === null || tools === undefined || typeof tools !== 'object') {
    ctx.logger?.warn?.('browser_agent: the tools service is unavailable; the tool was not registered.');
    return;
  }
  ctx.effect(() => tools.register(definition), 'browser-agent: browser_agent tool');
}

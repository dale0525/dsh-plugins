/**
 * dsh-browser-agent — host half.
 *
 * Registers two things: the `browser-agent` settings namespace, and the
 * `browser_agent` model tool that runs the decision loop over CDP against the
 * user's own Chrome.
 *
 * The tool is registered through `ctx.get('tools')` rather than the `ctx.tools`
 * property. Cordis requires a declared `inject` before a service property may
 * be read, and `tools` is genuinely optional here — a headless deployment that
 * composes no tool registry still has a working settings namespace — so it must
 * not be injected. Reading it optionally is the same choice
 * `dsh-config-manager`'s `registerModelTools` makes, for the same reason.
 *
 * @module @logictan/dsh-browser-agent
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { attach, activePage } from './cdp.js';
import { Config, SETTINGS_NAMESPACE, resolveTextRoute } from './config.js';
import { run } from './loop.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'browser-agent';

/**
 * Services this plugin needs before it can mount.
 *
 * `llm` is required: the TYPE_TEXT step cannot work without it, and a silent
 * degradation there would be worse than a load failure. `settings` is required
 * for the same reason — every run reads its configuration from it.
 */
export const inject = ['settings', 'llm'];

/**
 * Register the `browser_agent` tool.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const settings = ctx.settings;
  const llm = ctx.llm;
  const tools = ctx.get('tools');

  // The namespace must be registered before anything reads or writes it: an
  // unregistered namespace makes `settings.get` return undefined and every
  // Plugins-page write fail with "settings namespace ... is not registered".
  settings.register(SETTINGS_NAMESPACE, Config);

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
      const current = Config(settings.get(SETTINGS_NAMESPACE) ?? {});
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

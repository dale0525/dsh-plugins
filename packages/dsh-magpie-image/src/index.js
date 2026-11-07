/**
 * dsh-magpie-image — host half.
 *
 * Registers the two `mcp__magpie__*` tools against magpie's image MCP endpoint
 * (`https://hub.logiconsole.com/mcp/magpie/image`) so image generation has a
 * second provider beside `@logictan/dsh-imagegen` rather than replacing it.
 *
 * Three decisions are load-bearing, each taken from a measured fact about this
 * endpoint (probed 2026-11-07):
 *
 *  - **The transport lives here, not in `@deepseek-ai/dsh-mcp-client`.** Two
 *    reasons, and either alone is sufficient. First, the key: an mcp-client row
 *    carries headers as literal config, has no env interpolation, and cannot read
 *    a credential — so mounting it would write the magpie key into
 *    `cordis.patch.yml`, which `dsh-config-manager` exports verbatim into every
 *    config-sync snapshot. Second, the reference image: magpie accepts a local
 *    path only from the machine it runs on and otherwise wants a `data:` URL,
 *    and a thin bridge cannot convert an attachment reference into one.
 *
 *  - **The key is a credential, not configuration.** It reuses `MAGPIE_API_KEY`,
 *    the same ref the magpie LLM provider already uses (`apiKeyEnv` in the
 *    profile), so there is one key to set rather than a second copy.
 *
 *  - **The tools wait for the services they need.** `ctx.get(name)` returns only
 *    a service whose providing fiber is ACTIVE, and providers come up
 *    asynchronously — a read taken once in `apply` can silently be `undefined`.
 *    Registration therefore nests under `ctx.inject`.
 *
 * @module @logictan/dsh-magpie-image
 */
import { createMagpieClient } from './magpie.js';
import { makeRoutes } from './routes.js';
import { createToolDefinitions } from './tools.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'magpie-image';

/**
 * Credential reference holding the magpie gateway key.
 *
 * Deliberately identical to the magpie LLM provider's `apiKeyEnv`, so the
 * existing key covers both the chat route and image generation.
 */
export const API_KEY_REF = 'MAGPIE_API_KEY';

/**
 * Register the magpie image tools.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /**
   * Resolve the magpie key at each call.
   *
   * Read per call rather than captured: the credential can be set, replaced or
   * removed from the Plugins page while the process runs, and a captured value
   * would keep signing with a revoked key until the next restart.
   *
   * @returns the key, or `''` when unset.
   */
  const resolveApiKey = async () => {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(API_KEY_REF);
      if (resolved?.value) return resolved.value;
    }
    // The credential store is absent in profiles that mount their own key
    // resolution instead — headless disables the `credentials` row outright and
    // hands the key through the process environment (the same fact the magpie
    // LLM provider relies on). Reading it here is what keeps the tools usable
    // in that profile rather than failing with "not configured" while the key
    // is in fact present.
    return process.env[API_KEY_REF] ?? '';
  };

  const magpie = createMagpieClient({ resolveApiKey });

  ctx.inject(['tools', 'attachments'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');
    const definitions = createToolDefinitions(toolsCtx, magpie);
    toolsCtx.effect(() => {
      const disposers = definitions.map((definition) => tools.register(definition));
      toolsCtx.logger.info(`magpie-image: registered ${disposers.length} mcp__magpie__* tools`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'magpie-image: tools');
  });

  // The browser half reads generated images over this route. It sits under its
  // own inject because `webServer` is absent on a host that composes no HTTP
  // surface (headless), and a missing web half must not drop the tools.
  ctx.inject(['webServer', 'attachments'], (routeCtx) => {
    const webServer = routeCtx.get('webServer');
    routeCtx.effect(
      () => {
        const routes = makeRoutes({
          attachments: routeCtx.attachments,
          connection: () => routeCtx.get('connection'),
        });
        const disposers = routes.map((route) => webServer.register(route));
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
      'magpie-image: image route',
    );
  });
}
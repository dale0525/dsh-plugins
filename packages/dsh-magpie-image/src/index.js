/**
 * dsh-magpie-image — host half.
 *
 * Registers the two `mcp__magpie__*` tools against magpie's image MCP endpoint
 * (`https://hub.logiconsole.com/mcp/magpie/image`). Since `dsh-imagegen` was
 * removed on 2026-11-11 this is the only image provider in this repository.
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
 * The toolset both image tools are handed over as.
 *
 * Model-facing twice: the model passes this name to `get_tools`, and the
 * description is the when-to-use line the catalog prints beside it. Kept under
 * the 200-char catalog limit so it is never ellipsized, and it names the jobs
 * rather than the parameters — the argument surface arrives with the schemas a
 * turn later.
 */
export const TOOLSET_NAME = 'magpie_image';

/** Model-facing when-to-use line for the {@link TOOLSET_NAME} toolset. */
export const TOOLSET_DESCRIPTION =
  'Generate an image from a text prompt, or edit or combine images passed as reference images; '
  + 'also collects a generation that was still running, by the task id it returned.';

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

  // `toolsets`, not `tools`, is the service that owns these definitions: the
  // group is loaded into the calling agent's own scope on demand, so no tool
  // schema is paid until the model asks for it. Both tools reach the registry
  // through one toolset, so they keep resolving to the same client instance.
  ctx.inject(['toolsets', 'attachments'], (toolsCtx) => {
    const toolsets = toolsCtx.get('toolsets');
    const definitions = createToolDefinitions(toolsCtx, magpie);
    toolsCtx.effect(
      () =>
        toolsets.register({
          name: TOOLSET_NAME,
          description: TOOLSET_DESCRIPTION,
          tools: definitions,
        }),
      'magpie-image: toolset',
    );
    toolsCtx.logger.info(`magpie-image: toolset ${TOOLSET_NAME} holds ${definitions.length} mcp__magpie__* tools`);
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
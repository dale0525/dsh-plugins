/**
 * dsh-stitch-designer — host half.
 *
 * Google Stitch (AI UI generation) as a first-class part of the harness. It
 * registers the same 15 `mcp__stitch__*` tools the retired `mcp-stitch` patch
 * row used to provide, and serves the preview panel's HTTP API.
 *
 * Three design choices are load-bearing, and each replaces something that was
 * tried and failed elsewhere in this repository:
 *
 *  - **The Stitch transport lives here, not in `@deepseek-ai/dsh-mcp-client`.**
 *    Stitch's tool schemas are outside the subset `dsh-tools` accepts — 11 of
 *    15 input schemas and 13 of 15 output schemas are rejected by
 *    `assertSupportedJsonSchema` — so the bridge has to decide per field what
 *    to keep. Owning the transport is also what keeps the API key out of a
 *    patch row (see below) and what lets the tools and the panel share one
 *    client.
 *
 *  - **The API key is a credential, not configuration.** It lives in
 *    `$DSH_HOME/.credentials.yaml` under the ref `STITCH_API_KEY`, resolved
 *    through `ctx.credentials` on every call. A `role('secret')` Config field
 *    would have been the obvious alternative, but it stores the value in the
 *    profile's `cordis.patch.yml` as plaintext — which is exactly how the
 *    previous generation leaked secrets into config-sync snapshots. As a
 *    credential it is still carried by config sync (the `credentialsStatus`
 *    section exports refs from the credentials file), and it never appears in a
 *    patch row.
 *
 *  - **Each half waits for the services it needs; `credentials` is read per
 *    call.** `ctx.get(name)` returns only a service whose providing fiber is
 *    already ACTIVE, and providers come up asynchronously — `webServer` waits on
 *    `webStartup`, so at `apply` time it is still `undefined` even though its
 *    row precedes this one in the patch list. Reading it once in `apply`
 *    silently dropped the entire panel API. The registrations therefore nest
 *    under `ctx.inject` so each waits for its own providers; the tools half
 *    additionally waits for `credentials`, because its first `tools/list` needs
 *    the key and nothing re-fires that fetch at boot (the initial attempt ran
 *    before the credential store was live and failed as "key not configured").
 *    The key itself is read at call time, so setting it later still works.
 *
 * @module @logictan/dsh-stitch-designer
 */
import { makeRoutes } from './routes.js';
import { createStitchClient } from './stitch.js';
import { createToolDefinition, publicToolName } from './tools.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'stitch-designer';

/**
 * Credential reference holding the Stitch API key.
 *
 * The reference grammar is `/^[A-Za-z_][A-Za-z0-9_]*$/`, so a POSIX-shell-style
 * name is required; `STITCH_API_KEY` also matches the convention the other
 * providers in this repository use for their keys.
 */
export const API_KEY_REF = 'STITCH_API_KEY';

/** Server namespace embedded in every public tool name (`mcp__stitch__*`). */
export const SERVER_NAME = 'stitch';

/**
 * Register the Stitch tools and the panel API.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /**
   * Resolve the Stitch API key at each call.
   *
   * Read per call rather than captured: the credential can be set, replaced or
   * removed from the Plugins page while the process runs, and a captured value
   * would keep signing with a revoked key until the next restart.
   *
   * @returns the key, or `''` when unset.
   */
  const resolveApiKey = async () => {
    const credentials = ctx.get('credentials');
    if (credentials === undefined) return '';
    const resolved = await credentials.resolve(API_KEY_REF);
    return resolved?.value ?? '';
  };

  const stitch = createStitchClient({ resolveApiKey });

  // ---------------------------------------------------------------- tools
  // The upstream descriptors ARE the tool contract — names, descriptions and
  // input schemas all come from Stitch — so registration follows a successful
  // `tools/list` rather than a copy of the list kept in this repository.
  //
  // That fetch needs the API key, which means a freshly installed plugin has
  // no tools until a key exists. The credential-change event is what closes
  // that gap: setting the key in the Plugins page registers the tools in the
  // running process, with no restart. Without it the tools would appear only
  // after the user happened to restart, which reads as "the plugin is broken".
  ctx.inject(['tools', 'credentials'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');

    toolsCtx.effect(() => {
      let disposed = false;
      let disposers = [];

      const sync = async () => {
        const listed = await stitch.listTools();
        if (disposed) return;
        const next = listed.map((tool) =>
          createToolDefinition({
            name: publicToolName(SERVER_NAME, tool.name),
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            call: (args, exec) => stitch.callTool(tool.name, args, exec),
          }),
        );
        for (const dispose of disposers) dispose();
        disposers = next.map((definition) => tools.register(definition));
        toolsCtx.logger.info(`stitch-designer: registered ${disposers.length} mcp__${SERVER_NAME}__* tools`);
      };

      const report = (error) => {
        if (disposed) return;
        toolsCtx.logger.warn(
          `stitch-designer: the mcp__${SERVER_NAME}__* tools are not registered yet (${error?.message ?? error})`,
        );
      };

      sync().catch(report);
      const offCredential = toolsCtx.on('credentials/reference-updated', (ref) => {
        if (ref !== API_KEY_REF || disposers.length > 0) return;
        sync().catch(report);
      });

      return () => {
        disposed = true;
        offCredential();
        for (const dispose of disposers) dispose();
        disposers = [];
      };
    }, 'stitch-designer: Stitch tools');
  });

  // --------------------------------------------------------------- routes
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');

    webCtx.effect(() => {
      const disposers = makeRoutes({ stitch }).map((route) => webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'stitch-designer: panel routes');
  });
}

/**
 * dsh-stitch-designer — host half.
 *
 * Google Stitch (AI UI generation) as a first-class part of the harness. It
 * registers the same 15 `mcp__stitch__*` tools the retired `mcp-stitch` patch
 * row used to provide.
 *
 * Three design choices are load-bearing, and each replaces something that was
 * tried and failed elsewhere in this repository:
 *
 *  - **The Stitch transport lives here, not in `@deepseek-ai/dsh-mcp-client`.**
 *    Stitch's tool schemas are outside the subset `dsh-tools` accepts — 11 of
 *    15 input schemas and 13 of 15 output schemas are rejected by
 *    `assertSupportedJsonSchema` — so the bridge has to decide per field what
 *    to keep. Owning the transport is also what keeps the API key out of a
 *    patch row (see below).
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
 *  - **The tools half waits for the services it needs.** `ctx.get(name)`
 *    returns only a service whose providing fiber is already ACTIVE, and
 *    providers come up asynchronously — so a service read once in `apply` can
 *    silently be `undefined`. The registration therefore nests under
 *    `ctx.inject` so it waits for its own providers; it waits for `credentials`
 *    in particular, because its first `tools/list` needs the key and nothing
 *    re-fires that fetch at boot (the initial attempt ran before the credential
 *    store was live and failed as "key not configured"). The key itself is read
 *    at call time, so setting it later still works.
 *
 * @module @logictan/dsh-stitch-designer
 */
import { createCanvasClient } from './canvas.js';
import { createStitchClient } from './stitch.js';
import { createInvoker } from './conventions.js';
import { SECTION_NAME, SECTION_ORDER, STITCH_GUIDANCE } from './guidance.js';
import { createOutput, createToolDefinition, publicToolName } from './tools.js';

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
 * Register the Stitch tools and announce the design conventions.
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
  const canvas = createCanvasClient({ resolveApiKey });

  // One code project ↔ one Stitch project is enforced here rather than merely
  // announced: this wrapper is the only seam that sees which code project a
  // call belongs to, and therefore the only one that can refuse a second
  // `create_project`. The other two conventions are prose and live in the
  // system-prompt section below. See `src/conventions.js`.
  const invoke = createInvoker({ stitch });

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
            call: (args, exec) => invoke(tool.name, args, exec),
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

      // `remove_screens_from_canvas` is local, not upstream: Stitch has no
      // screen-delete route (`stitch delete screen` answers
      // `UNSUPPORTED_RESOURCE`, `DELETE .../screens/<id>` answers 404), so the
      // bridge performs the removal itself through one project-level PATCH. The
      // tool takes a list because the canvas is one field: N removals are one
      // write, and a single removal is just the one-element list. It is
      // registered here unconditionally because it needs no `tools/list` to
      // describe it — its contract is this file's.
      const removeScreenDispose = tools.register({
        name: publicToolName(SERVER_NAME, 'remove_screens_from_canvas'),
        description:
          'Remove one or more screens from a Stitch project canvas. Stitch has no screen-delete API, so '
            + 'this rewrites the project\'s canvas without those screens — always in a single write, '
            + 'however many ids you pass. The screen objects themselves are not destroyed; they disappear '
            + 'from the project, which is what clears abandoned screens out. Use '
            + 'mcp__stitch__list_screens to find screen ids first. Ids that are not on the canvas are '
            + 'reported back rather than failing the whole call.',
        parameters: {
          type: 'object',
          properties: {
            projectId: {
              type: 'string',
              description: 'Stitch project id (bare id, not "projects/<id>").',
            },
            screenIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ids of the screens to remove from the canvas. One id is the normal single-removal case.',
            },
          },
          required: ['projectId', 'screenIds'],
        },
        output: createOutput(undefined),
        async execute(args, exec) {
          const result = await canvas.removeScreens(args.projectId, args.screenIds, exec);
          const remaining = Array.isArray(result?.screenInstances) ? result.screenInstances.length : 0;
          const lines = [
            `Removed ${result.removed.length} screen(s) from project ${args.projectId}: ${result.removed.join(', ')}.`,
            `The canvas now holds ${remaining} screen(s).`,
          ];
          if (result.missing.length > 0) {
            lines.push(`Not on the canvas (left alone): ${result.missing.join(', ')}.`);
          }
          return { content: [{ type: 'text', text: lines.join(' ') }] };
        },
      });

      return () => {
        disposed = true;
        offCredential();
        removeScreenDispose();
        for (const dispose of disposers) dispose();
        disposers = [];
      };
    }, 'stitch-designer: Stitch tools');
  });

  // ------------------------------------------------------------- guidance
  // The design conventions that cannot be enforced are announced instead, the
  // way this repository delivers every other non-computable rule. Read through
  // `ctx.get` rather than `inject`: `inject` treats a service as REQUIRED and
  // silently skips the whole plugin when it is missing, which would turn "no
  // system prompt" into "no Stitch tools at all".
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined || systemPrompt === null) {
    ctx.logger?.warn?.('stitch-designer: the systemPrompt service is unavailable; the design conventions were not announced.');
    return;
  }
  ctx.effect(
    () =>
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: STITCH_GUIDANCE,
      }),
    'stitch-designer: design conventions',
  );
}

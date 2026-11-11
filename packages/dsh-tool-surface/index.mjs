/**
 * dsh-tool-surface — press the announced tool surface down to a whitelist.
 *
 * The host assembles one tool list per step from every provider's schemas; the
 * `tools` registry that executes a call is a different object, layered, and
 * `tools.view(scope)` never consults the assembly. So removing a definition
 * changes what the model is TOLD, not what it can DO — measured on this machine
 * (2026-11-11, 659 local sessions): 63 calls to tools that were no longer
 * announced, 57 succeeded, the six failures were the upstream tool's own
 * errors.
 *
 * What that buys: the definitions were 81,473 characters of a one-request
 * context, about 15.6% of it. The prefix they live in is cached across steps,
 * so withdrawing a definition is a one-time saving per session, and the saving
 * grows with every definition withdrawn.
 *
 * The withdrawn arguments move into a system-prompt section, because a tool
 * knowable only by name is not usable. That section is rendered from the live
 * whitelist, so a deployment that keeps a group announced never reads prose
 * about a schema the prompt already carries.
 *
 * @module @logictan/dsh-tool-surface
 */

import {
  DEFAULT_GUIDANCE,
  GUIDANCE_GROUPS,
  GUIDANCE_LEAD,
  SECTION_NAME,
  SECTION_ORDER,
} from './guidance.mjs';
import { DEFAULT_KEEP, filterAnnounced, renderWithdrawnGuidance } from './surface.mjs';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'tool-surface';

/**
 * Install the announcement filter and the guidance section.
 *
 * @param ctx - the plugin context.
 * @param config - the row's `config:` object, when the profile sets one.
 */
export function apply(ctx, config = {}) {
  const keep = Array.isArray(config?.keep) ? config.keep : DEFAULT_KEEP;

  // A configured `guidance` is used verbatim: a deployment that rewrites the
  // prose owns its wording. An explicit empty string means "say nothing", which
  // is the only way to opt out without also announcing every tool.
  const guidance =
    typeof config?.guidance === 'string'
      ? config.guidance
      : renderWithdrawnGuidance(GUIDANCE_GROUPS, keep, GUIDANCE_LEAD);

  // Registered before `next()`, so this listener sees the FINAL list whatever
  // order the rows were inserted in: every other provider's filter has already
  // run by the time `next()` resolves.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    const tools = filterAnnounced(assembly.tools, keep);
    return tools === assembly.tools ? assembly : { ...assembly, tools };
  });

  // Read through `ctx.get`, not `inject`: `inject` treats a service as REQUIRED
  // and a missing one would skip the whole plugin — turning "no system prompt"
  // into "no filtering at all", which is the opposite of what the filter's
  // absence means.
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined || systemPrompt === null) {
    ctx.logger?.warn?.(
      'tool-surface: the systemPrompt service is unavailable; the withdrawn tools were filtered but not described.',
    );
    return;
  }
  if (guidance === '') {
    ctx.logger?.info?.(
      'tool-surface: guidance is empty; the withdrawn tools are filtered without a prompt section.',
    );
    return;
  }
  ctx.effect(
    () =>
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        // The prose quotes tool names and may quote literal braces. The host
        // reads every `{{…}}` in a section as a prompt-variable reference and
        // throws `malformed prompt variable reference` on one it cannot parse,
        // which took a whole plugin down at assembly on 2026-11-11. Nothing here
        // is a variable, so the section opts out of interpolation.
        interpolate: false,
        text: guidance,
      }),
    'tool-surface: withdrawn tool guidance',
  );
}

export { DEFAULT_GUIDANCE, DEFAULT_KEEP, filterAnnounced, renderWithdrawnGuidance };
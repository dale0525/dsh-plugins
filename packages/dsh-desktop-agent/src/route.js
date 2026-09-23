/**
 * Channel routing: does the route that will answer accept an image?
 *
 * This question is asked on the HOST side, against the live model directory, and
 * the answer decides whether a run sends screenshots or an element table. It
 * cannot be asked anywhere else:
 *
 *  - The browser's model catalog (`session.modelCatalog`) does not carry
 *    `inputModalities` at all. Its `ModelCatalogModel` is `{ id, name,
 *    description?, reasoning? }` and its host builder maps exactly those fields
 *    off the resolved model info, so the field is dropped before it ever reaches
 *    the wire. A client-side check would have nothing to read.
 *  - `ctx.llm.listModels` / `resolveModelInfo` do carry it, and the field's own
 *    contract is three-valued: present-and-contains-image is a yes, present-
 *    without-image is a no, and ABSENT MEANS UNKNOWN. Unknown is treated as "no"
 *    here on purpose: sending an image to a route that cannot take one is not a
 *    degraded run, it is a request the host rewrites into placeholder text, after
 *    which the model is looking at nothing and answers confidently about it.
 *
 * @module @logictan/dsh-desktop-agent/route
 */

/** The one message both route checks raise when no vision route is configured. */
export const NO_ROUTE_MESSAGE =
  'desktop_agent: no model route is available. Open Settings → Plugins → desktop-agent and choose a provider ' +
  'and model, or run this from a session that has one.';

/**
 * Whether the route accepts image input.
 *
 * @param llm - the host's `ctx.llm` service.
 * @param route - the resolved provider/model route.
 * @returns whether a screenshot may be sent.
 * @throws {Error} when the route is unconfigured, since no channel can run
 *   without a model and silently choosing one would misreport the failure.
 */
export async function supportsImages(llm, route) {
  if (route.provider === '' || route.model === '') {
    throw new Error(NO_ROUTE_MESSAGE);
  }

  const info = await llm.resolveModelInfo(route.provider, route.model);
  const modalities = info?.inputModalities;
  return Array.isArray(modalities) && modalities.includes('image');
}

/**
 * The vision-capable routes in the live directory.
 *
 * Exported for the settings bridge: the Plugins-page card may only offer models
 * that can actually see, and the honest answer comes from the same call this
 * module uses to route a run. A provider whose model list fails to load is
 * reported as a failure rather than dropped, so the card can say the list is
 * incomplete instead of implying those models do not exist.
 *
 * @param llm - the host's `ctx.llm` service.
 * @returns provider groups of vision-capable models, plus the providers that
 *   could not be read.
 */
export async function visionCatalog(llm) {
  const groups = [];
  const failures = [];

  for (const provider of llm.listProviders()) {
    let models;
    try {
      models = await llm.listModels(provider.id);
    } catch (cause) {
      failures.push({ id: provider.id, name: provider.name, message: cause instanceof Error ? cause.message : String(cause) });
      continue;
    }

    const capable = [];
    for (const model of models) {
      let info;
      try {
        info = await llm.resolveModelInfo(provider.id, model.id);
      } catch {
        continue;
      }
      if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) {
        capable.push({ id: model.id, name: model.name ?? model.id });
      }
    }
    groups.push({ id: provider.id, name: provider.name, models: capable });
  }

  return { groups, failures };
}

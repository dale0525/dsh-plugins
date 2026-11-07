/**
 * Transport to Stitch's Canvas REST surface, for the one operation its MCP
 * endpoint does not expose: taking a screen off a project's canvas.
 *
 * Stitch has no screen-delete route — `DELETE /projects/<p>/screens/<s>` answers
 * 404 for every spelling including `:delete`, and the `@google/stitch` CLI
 * rejects the command with `UNSUPPORTED_RESOURCE / "Stitch screens do not
 * support delete."` (measured 2026-11-08). The MCP tool list has no
 * `delete_screen` either, so this is not a field the bridge dropped.
 *
 * What the service DOES accept is a project-level PATCH of `screenInstances`:
 * a project's canvas is a list of instances, each pointing at a `sourceScreen`,
 * and writing that list back without one instance removes that screen from the
 * canvas. Measured against project 4697019860827468919: the PATCH returned 200
 * and the project went from five screens to three.
 *
 * Two properties of that endpoint shape this module:
 *
 *  - **The list is replaced whole** (`updateMask=screenInstances`), so every
 *    surviving instance is sent back verbatim. A field dropped here is a lost
 *    canvas position, and the API will not complain.
 *  - **The instance id is not the screen id.** A generated screen reuses its id
 *    as the instance id, but an uploaded image gets a fresh UUID instance whose
 *    `sourceScreen` ends in the screen id. Matching goes through `sourceScreen`,
 *    which is correct for both shapes.
 *
 * The screen object itself survives the removal: `GET .../screens/<id>` still
 * answers afterwards. That is the service's model, not a shortfall here — the
 * complaint this addresses is a project canvas full of abandoned screens.
 *
 * @module @logictan/dsh-stitch-designer/canvas
 */

/** Stitch's Canvas REST base. Distinct from the MCP endpoint in `stitch.js`. */
export const CANVAS_API_URL = 'https://stitch.googleapis.com/v1';

/** Budget for one Canvas round trip; both calls here are small. */
export const DEFAULT_CANVAS_TIMEOUT_MS = 60_000;

/**
 * One Canvas REST round trip.
 *
 * @param options - method, url, per-call key, body, timeout and abort signal.
 * @returns the parsed JSON response.
 * @throws when the request fails or the response is not JSON.
 */
async function request(options) {
  const { method, url, apiKey, body, timeoutMs, signal } = options;
  const response = await fetch(url, {
    method,
    headers: {
      'X-Goog-Api-Key': apiKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Stitch ${method} ${url} failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
  }
  return response.json();
}

/**
 * Build a Canvas client bound to one key-resolution callback.
 *
 * The key is resolved per call for the same reason as in `stitch.js`: it can be
 * replaced from the Plugins page while the process runs.
 *
 * @param options - key resolver, base URL override and per-call timeout.
 * @returns `removeScreen`.
 */
export function createCanvasClient(options = {}) {
  const { resolveApiKey, url = CANVAS_API_URL, timeoutMs = DEFAULT_CANVAS_TIMEOUT_MS } = options;

  const requireKey = async () => {
    const apiKey = await resolveApiKey();
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new Error(
        'Stitch API key is not configured. Open Settings → Plugins → stitch-designer and paste a key from https://stitch.withgoogle.com (avatar → Stitch Settings → API key).',
      );
    }
    return apiKey;
  };

  return {
    /**
     * Take one or more screens off a project's canvas.
     *
     * Batch is the primitive: the canvas is a single field, so every removal is
     * absorbed into ONE read-modify-write cycle and therefore one PATCH, however
     * many ids are given. Removing one screen is simply the one-element case.
     *
     * @param projectId - the project id (bare, without the `projects/` prefix).
     * @param screenIds - screen ids to remove; the bare ids from `list_screens`.
     * @param exec - the tool execution context, whose signal is honoured.
     * @returns the project after the write, plus which ids were removed and
     *   which were not on the canvas.
     * @throws when no id is given, or when none of them is on the canvas.
     */
    async removeScreens(projectId, screenIds, exec) {
      const requested = Array.isArray(screenIds) ? screenIds.filter((id) => typeof id === 'string' && id !== '') : [];
      if (requested.length === 0) {
        throw new Error(
          'No screen id was given: pass at least one screen id in screenIds. ' +
            'Run list_screens to see the screens this project currently holds.',
        );
      }

      const apiKey = await requireKey();
      const projectUrl = `${url}/projects/${projectId}`;

      const project = await request({ method: 'GET', url: projectUrl, apiKey, timeoutMs, signal: exec?.signal });
      const instances = Array.isArray(project?.screenInstances) ? project.screenInstances : [];
      const screenIdOf = (instance) => String(instance?.sourceScreen ?? '').split('/screens/').pop() ?? '';

      const kept = instances.filter((instance) => !requested.includes(screenIdOf(instance)));
      const present = instances.map(screenIdOf);
      const removed = requested.filter((id) => present.includes(id));
      const missing = requested.filter((id) => !present.includes(id));

      if (removed.length === 0) {
        throw new Error(
          `None of the given screen ids is on the canvas of project ${projectId}, so there is nothing to remove. ` +
            'Run list_screens to see the screens this project currently holds.',
        );
      }

      const updated = await request({
        method: 'PATCH',
        url: `${projectUrl}?updateMask=screenInstances`,
        apiKey,
        body: { screenInstances: kept },
        timeoutMs,
        signal: exec?.signal,
      });

      return { ...updated, removed, missing };
    },
  };
}
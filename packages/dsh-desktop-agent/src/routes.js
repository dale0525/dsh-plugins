/**
 * The /api/dsh-desktop-agent route family: a bridge that answers
 * one question the browser half cannot answer for itself.
 *
 * The settings card must list only models that can actually see, and the fact it
 * needs — `inputModalities` — is not on the wire the card can reach. The host's
 * model catalog builder maps a fixed set of fields off the resolved model info and
 * drops this one, so the card's own catalog call has nothing to read.
 *
 * The alternative would be a second, plugin-owned catalog endpoint carrying
 * modality flags. This route instead answers from the SAME call the decision loop
 * routes a run with (`ctx.llm.resolveModelInfo`), so the list the card shows and
 * the channel a run picks can never disagree.
 *
 * It is read-only and carries no secret: the answer is a list of model ids the
 * caller's own browser session could already enumerate.
 *
 * @module @logictan/dsh-desktop-agent/routes
 */
import { visionCatalog } from './route.js';

/** Absolute pathname of the vision-catalog route. */
export const VISION_MODELS_API = '/api/dsh-desktop-agent/vision-models';

/**
 * Ask the composition whether one request may be served.
 *
 * `connection.requestRejection` is the deployment's single trust fence: it
 * applies the Host/Origin checks (loopback plus the LAN authorities the
 * deployment declares) and the browser authentication that rides with them.
 * This plugin answers with the verdict instead of re-deriving it, because the
 * declared LAN authorities live in `connection`'s config and a local check
 * cannot see them.
 *
 * A missing `connection` refuses rather than serves: these routes sit in front
 * of Connection's `/api` prefix route, so serving them without its fence would
 * serve them unfenced.
 *
 * @param connection - the composition's Connection service, when it is up.
 * @param request - the incoming request.
 * @param response - the response, written to when the request is refused.
 * @returns whether the request was refused.
 */
function refuseUntrusted(connection, request, response) {
  if (connection === undefined) {
    writeJson(response, 403, { error: 'forbidden' });
    return true;
  }
  const rejection = connection.requestRejection(request);
  if (rejection === undefined) return false;
  writeJson(response, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
  return true;
}

/** Write one JSON response. */
function writeJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  response.end(payload);
}

/**
 * Build the route family.
 *
 * @param deps - the host dependencies.
 * @param deps.llm - the host's `ctx.llm` service.
 * @param deps.connection - resolves the composition's trust fence per request.
 *   Resolved per call rather than captured: a composed row order does not imply
 *   an activation order, so the service can still be absent when routes are built.
 * @returns the routes to register.
 */
export function makeRoutes(deps) {
  return [
    {
      kind: 'exact',
      path: VISION_MODELS_API,
      async handler(request, response) {
        if (refuseUntrusted(deps.connection(), request, response)) return;
        if (request.method !== 'GET' && request.method !== 'POST') {
          writeJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        try {
          const catalog = await visionCatalog(deps.llm);
          writeJson(response, 200, catalog);
        } catch (cause) {
          writeJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
        }
      },
    },
  ];
}

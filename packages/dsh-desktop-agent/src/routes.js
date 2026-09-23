/**
 * The /api/dsh-desktop-agent route family: a loopback-only bridge that answers
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
 * Loopback literal check plus browser same-origin markers (mirrors the imagegen
 * bridge and dsh-ssh).
 *
 * @param request - the incoming request.
 * @returns whether the request may be served.
 */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
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
 * @param deps - the host's `ctx.llm` service.
 * @returns the routes to register.
 */
export function makeRoutes(deps) {
  return [
    {
      kind: 'exact',
      path: VISION_MODELS_API,
      async handler(request, response) {
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { error: 'loopback-only' });
          return;
        }
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

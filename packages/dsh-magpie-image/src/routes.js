/**
 * The one route the browser half needs: read a generated image attachment by
 * its reference.
 *
 * Why a route at all: a tool-result image is deliberately not part of the
 * model-visible session content, so the client's session reader (`readAttachment`)
 * refuses it. The browser half therefore asks the host to read the same durable
 * attachment. The read is fenced by the composition's connection trust check
 * (`requestRejection`), so only a browser the deployment admits can pull bytes.
 *
 * The reference arrives as query parameters and is validated here rather than
 * trusted: an arbitrary id would otherwise turn this into an attachment-store
 * reader for any caller that can reach the port.
 *
 * @module @logictan/dsh-magpie-image/routes
 */
import { MAGPIE_IMAGE_API } from './protocol.js';

/** Image media types the attachment store can mint and the browser can render. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Narrow the query string back to a reference the attachment store accepts.
 *
 * Mirrors the store's shape: an opaque string id plus the exact media type and
 * three positive integers. Anything else is rejected so a malformed request
 * cannot reach `readImage`.
 *
 * @param url - the request URL.
 * @returns the reference, or `undefined` when any field is invalid.
 */
function refFromQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const attachmentId = params.get('attachment_id') ?? '';
  const mediaType = params.get('media_type') ?? '';
  const bytes = Number(params.get('bytes'));
  const width = Number(params.get('width'));
  const height = Number(params.get('height'));
  if (attachmentId === '' || !IMAGE_MEDIA_TYPES.has(mediaType)
    || !Number.isSafeInteger(bytes) || bytes < 1
    || !Number.isSafeInteger(width) || width < 1
    || !Number.isSafeInteger(height) || height < 1) return undefined;
  return { attachmentId, mediaType, bytes, width, height };
}

/**
 * Build the plugin's route list.
 *
 * @param options - seam accessors resolved per request.
 * @param options.attachments - the attachment store.
 * @param options.connection - resolves the trust fence, or `undefined` before it
 *   is active (a composed row order does not imply an activation order).
 * @returns the routes to hand to `webServer.register`.
 */
export function makeRoutes({ attachments, connection }) {
  return [{
    kind: 'prefix',
    path: MAGPIE_IMAGE_API,
    handler: async (req, res) => {
      const fence = connection();
      if (fence === undefined) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      const rejection = fence.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }));
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `method not allowed: ${req.method}` }));
        return;
      }
      const ref = refFromQuery(req.url ?? '');
      if (ref === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid image reference' }));
        return;
      }
      try {
        const stored = await attachments.readImage(ref);
        res.writeHead(200, {
          'content-type': stored.ref.mediaType,
          'content-length': stored.data.byteLength,
          'cache-control': 'private, max-age=3600',
        });
        res.end(Buffer.from(stored.data));
      } catch {
        // Never leak attachment-store internals to the browser.
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'image attachment not found' }));
      }
    },
  }];
}

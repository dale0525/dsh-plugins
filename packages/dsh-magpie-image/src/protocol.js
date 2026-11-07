/**
 * Wire constants shared by both halves of the plugin.
 *
 * The browser half cannot read an attachment from the session (tool-result
 * images are deliberately absent from model-visible content, so the session
 * reader rejects them), so it fetches the bytes over the host half's own
 * route. Both halves key that route off the same constant; keeping it in one
 * module means the client bundle and the route cannot drift.
 */

/** Route family prefix. Owned by this plugin; nothing else serves it. */
export const MAGPIE_IMAGE_API = '/api/dsh-magpie-image/image';

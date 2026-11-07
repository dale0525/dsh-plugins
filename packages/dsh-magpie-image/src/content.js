/**
 * Projection of magpie's MCP content blocks.
 *
 * magpie answers an image request with two blocks: a `text` block carrying the
 * provider line and a one-hour download URL, and an `image` block carrying the
 * same PNG as base64. Measured 2026-11-07 against the live endpoint.
 *
 * The text half is what the MODEL sees; the image half is what the user sees,
 * and it must become a durable attachment before it can be shown. That split is
 * why this module keeps them apart rather than flattening everything to text.
 *
 * @module @logictan/dsh-magpie-image/content
 */

/** Media types the attachment store accepts, and the only ones magpie sends. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Canonical base64: standard alphabet, padded, no line breaks. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Project ordered MCP content blocks into one plain-text string.
 *
 * A non-text block is reported positionally rather than silently dropped: an
 * image that fails to decode should still be visible to the model as "an image
 * came back", not as an empty answer.
 *
 * @param content - the MCP `content` array.
 * @returns the joined text.
 */
export function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      const type = block !== null && typeof block === 'object' && typeof block.type === 'string' ? block.type : 'unknown';
      return `[${type} content is not projected to text]`;
    })
    .join('\n');
}

/**
 * Decode every image block into attachment-ready bytes.
 *
 * Both checks are load-bearing rather than defensive: the attachment store
 * accepts four media types and requires that base64 round-trip exactly, so an
 * unchecked block would fail there with a less actionable message.
 *
 * @param content - the MCP `content` array.
 * @returns decoded images in block order.
 * @throws when a declared media type or encoding is outside that vocabulary.
 */
export function extractImages(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block === null || typeof block !== 'object' || block.type !== 'image') return [];
    if (!IMAGE_MEDIA_TYPES.has(block.mimeType)) {
      throw new Error(`magpie returned ${String(block.mimeType)}, which is not an image type the attachment store accepts`);
    }
    if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) {
      throw new Error('magpie returned image data that is not canonical base64');
    }
    const data = Buffer.from(block.data, 'base64');
    if (data.toString('base64') !== block.data) {
      throw new Error('magpie returned image data that is not canonical base64');
    }
    return [{ data: new Uint8Array(data), mediaType: block.mimeType }];
  });
}
/**
 * Conversion of DSH attachment bytes into a magpie reference image.
 *
 * magpie accepts a reference only as `data:<mime>;base64,<bytes>` or an http(s)
 * URL — an absolute local path works only on the machine magpie itself runs on
 * (measured 2026-11-07; the refusal reads "generate_image reads a file only for
 * an agent on the computer magpie runs on"). DSH attachments hold decoded bytes,
 * so this encoding is the whole adaptation, and it is the reason this plugin is
 * not a thin `@deepseek-ai/dsh-mcp-client` row.
 *
 * @module @logictan/dsh-magpie-image/reference-image
 */

/**
 * Encode attachment bytes as the data URL magpie expects.
 *
 * @param data - decoded image bytes.
 * @param mediaType - the attachment's own media type.
 * @returns a `data:` URL.
 */
export function toReferenceImage(data, mediaType) {
  if (data === undefined || data === null || data.byteLength === 0) {
    throw new Error('the reference image is empty, so magpie has nothing to draw from');
  }
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
}
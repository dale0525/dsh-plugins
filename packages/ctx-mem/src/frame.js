/**
 * The checkpoint frame: the fixed text the host wraps around every summary, and
 * the pricing of it.
 *
 * The host's guard compares the price of the **framed** checkpoint against the
 * span being replaced — not the price of the summary body alone. So a budget is
 * only a real ceiling if it is spent against the framed number. This module is
 * the single place that knows the frame's shape, so `src/index.js` and the
 * tests cannot drift apart on it.
 *
 * The host does not export these constants, so they are mirrored here verbatim.
 * `tests/frame-price.test.js` pins this module's arithmetic against the host's
 * own estimator, which is what keeps the mirror honest.
 *
 * @module @logictan/dsh-ctx-mem/frame
 */

/**
 * The paragraph the host prefixes to every checkpoint, copied verbatim from
 * `CHECKPOINT_PREAMBLE` in `dsh-compaction-basic`.
 */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

/** Opening tag the host wraps the summary body in. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>';

/** Closing tag the host wraps the summary body in. */
export const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/**
 * Build the message the host will price and send, from a summary body.
 *
 * Mirrors the host's `frameSummary`: a preamble-plus-open-tag block, the body,
 * then the close tag as separate blocks.
 *
 * @param {string} body Rendered summary body.
 * @returns {{ role: 'user', content: Array<{ type: 'text', text: string }> }}
 */
export function frameCheckpointMessage(body) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      { type: 'text', text: body },
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ],
  };
}

/**
 * Price a summary body as the host will price it once framed.
 *
 * @param {any} meter A `tokenMeter` exposing `estimateMessage`.
 * @param {string} body Rendered summary body.
 * @returns {number} Estimated tokens of the framed checkpoint.
 */
export function framedPrice(meter, body) {
  return meter.estimateMessage(frameCheckpointMessage(body));
}

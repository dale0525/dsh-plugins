/**
 * Test-side mirror of the host's token estimator.
 *
 * `@deepseek-ai/dsh-token-meter` exposes `TokenMeter` from its package root but
 * NOT the pure `estimateMessage` helper — the host reaches it through a deep
 * path that a published dependency may not expose. So the arithmetic is
 * mirrored here, and `frame-price.test.js` pins the mirror against that deep
 * module whenever it is resolvable, so a host-side density change cannot
 * silently invalidate every budget assertion in this suite.
 *
 * The frame *shape* is not mirrored: it comes from `src/frame.js`, the same
 * module production uses, so the tests and the backend cannot disagree about
 * what the host wraps around a checkpoint.
 *
 * @module tests/frame-price
 */
import { frameCheckpointMessage } from '../src/frame.js';

/** Fixed text-density estimate, identical to the host's `estimate.js`. */
const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4;
/** Role-field framing overhead added to every priced message. */
const ROLE_OVERHEAD = 4;

/** Price content blocks recursively under the fixed density heuristic. */
function estimateContent(blocks) {
  let tokens = 0;
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case 'tool-call':
        tokens +=
          Math.ceil(block.name.length / CHARS_PER_TOKEN) +
          Math.ceil(block.arguments.length / CHARS_PER_TOKEN) +
          BLOCK_OVERHEAD;
        break;
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD;
        break;
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
    }
  }
  return tokens;
}

/** Price one model-visible message under the fixed density heuristic. */
export function estimateMessage(message) {
  if (message.role === 'system') {
    if (message.content.length === 0) return 0;
    let characters = 0;
    for (const block of message.content) {
      characters += block.type === 'text' ? block.text.length : JSON.stringify(block).length;
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
  }
  return estimateContent(message.content) + ROLE_OVERHEAD;
}

/**
 * Price a rendered skeleton exactly as the host prices the framed checkpoint.
 * @param {string} skeleton
 * @returns {number}
 */
export function framePrice(skeleton) {
  return estimateMessage(frameCheckpointMessage(skeleton));
}

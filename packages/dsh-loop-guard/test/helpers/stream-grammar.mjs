/**
 * The stream-grammar rules a mid-call break could violate.
 *
 * dsh 0.1.6 shipped this grammar as `@deepseek-ai/dsh-llm/invariant`; 0.2.1
 * removed that module and ships no replacement, so the property is pinned here
 * instead of imported. Only the rules this plugin can break are checked — it
 * emits `block-end` and `finish` chunks and nothing else, so index and delta
 * bookkeeping would be dead weight:
 *
 *  - a `block-end` must close a block that is actually open, with its type;
 *  - a `stop` finish must leave nothing open (an `error`/`aborted` finish may);
 *  - nothing may follow the terminal finish, and one must exist.
 *
 * The second rule is the regression that mattered: an earlier bare `stop` with
 * the text block still open passed every other assertion in the suite and
 * crashed the renderer at runtime.
 *
 * @param chunks - the collected chunk list, in stream order.
 * @returns one message per violation; empty when the stream is legal.
 */
export function grammarViolations(chunks) {
  const violations = []
  const open = new Map()
  let finished = false
  for (const chunk of chunks) {
    if (finished) violations.push(`stream emitted ${chunk.type} after the terminal finish`)
    switch (chunk.type) {
      case 'block-start':
        if (open.has(chunk.index)) violations.push(`repeated block-start at index ${chunk.index}`)
        open.set(chunk.index, chunk.blockType)
        break
      case 'block-end': {
        const blockType = open.get(chunk.index)
        if (blockType === undefined) violations.push(`block-end at index ${chunk.index} has no open block`)
        else if (chunk.block.type !== blockType) {
          violations.push(`block-end at index ${chunk.index} closes ${chunk.block.type}, expected ${blockType}`)
        }
        open.delete(chunk.index)
        break
      }
      case 'finish':
        if (open.size > 0 && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
          violations.push(`finished with ${open.size} open block(s)`)
        }
        finished = true
        break
      default:
        break
    }
  }
  if (!finished) violations.push('stream ended without a terminal finish chunk')
  return violations
}

/**
 * Normalization of the model's fill output into the four fixed causal sections.
 *
 * The fill model is asked for four sections in a fixed order. Models drift: they
 * merge two sections, drop one, emit a fifth, restate the fact skeleton, or wrap
 * the whole thing in a code fence. A checkpoint whose structure depends on the
 * model's mood is not a checkpoint, so the four sections are re-established
 * programmatically from whatever the model returned:
 *
 * - the four headings are emitted in the fixed order, always, all of them;
 * - a section the model omitted, or left empty, becomes `(none)`;
 * - anything before the first heading (including a restated fact skeleton) is
 *   dropped, so the program-owned facts are never duplicated;
 * - a stray `##` heading the model invented ends the current section rather
 *   than leaking its text into it.
 *
 * Only the *section scaffolding* is normalized. The prose inside a section is
 * kept verbatim — this module must not rewrite what the model said.
 */

/** The four causal sections, in their fixed order. */
export const CAUSAL_SECTIONS = Object.freeze([
  '## Why This Approach',
  '## Errors and Their Causes',
  '## Open Decisions',
  '## Next Step',
]);

/** Marker an empty section renders as. */
const NONE = '(none)';

/**
 * Remove one enclosing Markdown code fence, when the model wrapped its output.
 *
 * @param {string} text
 * @returns {string}
 */
function stripFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;
  const lines = trimmed.split('\n');
  lines.shift();
  if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop();
  return lines.join('\n');
}

/**
 * Match a line against the section headings, tolerating a trailing colon and
 * trailing whitespace (`## Next Step:` counts as `## Next Step`).
 *
 * @param {string} line
 * @returns {string | undefined} The canonical heading.
 */
function matchSection(line) {
  const key = line.trim().replace(/[:\s]+$/, '');
  return CAUSAL_SECTIONS.find((heading) => heading === key);
}

/**
 * Re-establish the four causal sections from raw model output.
 *
 * @param {unknown} raw Model output text.
 * @returns {string} The four sections in fixed order, each non-empty, closed by
 *   exactly one newline.
 */
export function normalizeCausal(raw) {
  const text = stripFence(typeof raw === 'string' ? raw : '');

  /** @type {Map<string, string[]>} */
  const bodies = new Map();
  /** @type {string | null} */
  let current = null;

  for (const line of text.split('\n')) {
    const heading = matchSection(line);
    if (heading !== undefined) {
      current = heading;
      bodies.set(heading, []);
      continue;
    }
    // A different top-level heading ends the current section: its text does not
    // belong to the section it followed.
    if (current !== null && /^##\s/.test(line.trim())) {
      current = null;
      continue;
    }
    if (current !== null) bodies.get(current).push(line);
  }

  const sections = CAUSAL_SECTIONS.map((heading) => {
    const body = (bodies.get(heading) ?? []).join('\n').trim();
    return `${heading}\n${body === '' ? NONE : body}`;
  });

  return `${sections.join('\n\n')}\n`;
}

export default normalizeCausal;

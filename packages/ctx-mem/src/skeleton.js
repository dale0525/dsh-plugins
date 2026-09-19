/**
 * Skeleton renderer for the ctx-mem compaction backend.
 *
 * Why this module exists: the compaction backend feeds this skeleton to a model
 * and asks it to fill in four causal sections. The model input therefore shrinks
 * from the whole conversation to this skeleton, while the hard facts (paths,
 * commands, errors) are carried through verbatim rather than paraphrased.
 *
 * The skeleton is rebuilt from raw session events on EVERY compaction — it is
 * never forwarded from a previous checkpoint — because forwarding loses early
 * facts across successive compactions. That is why this module is a pure
 * renderer: no I/O, no session access, no model call, no token estimation.
 */

/**
 * @typedef {object} Facts
 * @property {string[]} [intents]  User intents, verbatim.
 * @property {string[]} [files]    Touched paths, verbatim.
 * @property {string[]} [commands] Executed commands, verbatim.
 * @property {string[]} [errors]   Observed errors, verbatim.
 */

/**
 * @typedef {object} SkeletonResult
 * @property {string} text     The rendered skeleton.
 * @property {Facts} facts      Defensive copy of the facts actually rendered.
 */

/** Top-level header; always the first line of the output. */
const TOP_HEADER = '## Extracted Facts';

/**
 * The four subsections in their fixed order. Never reordered, never omitted —
 * a missing section would silently hide a whole class of hard facts from the
 * fill step, so every one is always rendered even when empty.
 * @type {ReadonlyArray<{ key: keyof Facts, header: string }>}
 */
const SECTIONS = Object.freeze([
  { key: 'intents', header: '### User Intents' },
  { key: 'files', header: '### Files Touched' },
  { key: 'commands', header: '### Commands Run' },
  { key: 'errors', header: '### Errors Seen' },
]);

/** Marker used by a subsection that has no items. Never prefixed with `- `. */
const NONE = '(none)';

/**
 * Copy one fact list without mutating the caller's object.
 *
 * Tolerates partial input: a missing or non-array value becomes an empty list,
 * and `null` / `undefined` entries are skipped. Everything else is kept as-is
 * (coerced to a string only when it is not already one) so item text can be
 * emitted verbatim.
 * @param {unknown} value
 * @returns {string[]}
 */
function copyList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (item === null || item === undefined) continue;
    out.push(typeof item === 'string' ? item : String(item));
  }
  return out;
}

/**
 * Defensively copy the whole facts shape, defaulting every list to `[]`.
 * @param {Facts | undefined | null} facts
 * @returns {Facts}
 */
function copyFacts(facts) {
  const source = facts && typeof facts === 'object' ? facts : {};
  return {
    intents: copyList(source.intents),
    files: copyList(source.files),
    commands: copyList(source.commands),
    errors: copyList(source.errors),
  };
}

/**
 * Render one subsection body.
 *
 * Items are inserted verbatim: not trimmed, not escaped, not wrapped, not
 * indented, and embedded newlines are left intact. That verbatim preservation
 * is the whole point — hard facts must survive compaction unchanged.
 * @param {string[]} items
 * @returns {string}
 */
function renderBody(items) {
  if (items.length === 0) return NONE;
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * Build the fact skeleton that the compaction fill step consumes.
 *
 * Output shape (no leading blank line, exactly one trailing `\n`):
 *
 * ```
 * ## Extracted Facts
 * ### User Intents
 * - <intent 1>
 *
 * ### Files Touched
 * (none)
 * ```
 *
 * @param {Facts | undefined | null} facts Facts as returned by `src/extract.js`.
 *   Read-only: the caller's object is never mutated.
 * @returns {SkeletonResult} The rendered text plus the facts actually used, so
 *   the caller can log or re-render.
 */
export function buildSkeleton(facts) {
  const used = copyFacts(facts);

  const sections = SECTIONS.map(
    ({ key, header }) => `${header}\n${renderBody(used[key])}`,
  );

  // One blank line between adjacent subsections; `## Extracted Facts` sits
  // directly above the first one, and exactly one newline closes the output.
  const text = `${TOP_HEADER}\n${sections.join('\n\n')}\n`;

  return { text, facts: used };
}

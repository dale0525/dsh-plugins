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
 * @property {string[]} [contexts] Assistant statement preceding each intent, by
 *   index; `''` (or absent) when there is none.
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
 * The four subsections in their fixed order. Never omitted — a missing section
 * would silently hide a whole class of hard facts from the fill step, so every
 * one is always rendered even when empty.
 *
 * The order is not the historical one: errors come before commands. An error
 * string cannot be re-derived from anything else in the checkpoint, while a
 * command is a record of an action the reader can also see reflected in the
 * file list — which is why the budget's greedy pass gives commands away first.
 * Rendering them in price order puts the least replaceable section within the
 * first few percent of the message instead of past the 80% mark.
 *
 * @type {ReadonlyArray<{ key: keyof Facts, header: string }>}
 */
const SECTIONS = Object.freeze([
  { key: 'intents', header: '### User Intents' },
  { key: 'files', header: '### Files Touched' },
  { key: 'errors', header: '### Errors Seen' },
  { key: 'commands', header: '### Commands Run' },
]);

/** Marker used by a subsection that has no items. Never prefixed with `- `. */
const NONE = '(none)';

/**
 * Prefix of the paired-context line under an intent.
 *
 * The arrow is a deliberate non-content marker: it must be unmistakable that the
 * line was added by this renderer rather than said by the user. Nothing in the
 * verbatim fact set is altered — the intent line above it stays byte-for-byte.
 */
const CONTEXT_MARKER = '\u2191';

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
 *
 * Exported because `src/render.js` must normalize its input before pricing or
 * capping it, and a second copy of this rule would be a drift hazard: the two
 * sit on the same data path (the renderer's parts are handed straight back to
 * {@link buildSkeleton}), so a change to one copy's coercion semantics that
 * missed the other would silently render a differently-shaped fact set than the
 * one that was priced.
 *
 * @param {Facts | undefined | null} facts
 * @returns {Facts}
 */
export function copyFacts(facts) {
  const source = facts && typeof facts === 'object' ? facts : {};
  return {
    intents: copyList(source.intents),
    contexts: copyList(source.contexts),
    files: copyList(source.files),
    commands: copyList(source.commands),
    errors: copyList(source.errors),
  };
}

/**
 * Render one subsection body.
 *
 * Every item's text is inserted verbatim: not trimmed, not escaped, not
 * wrapped, and embedded newlines are left intact. That verbatim preservation
 * is the whole point — hard facts must survive compaction unchanged.
 *
 * The one thing added is a two-space indent on each continuation line. Without
 * it an item that itself contains newlines (a heredoc, a multi-line script) is
 * indistinguishable from several list items: counting lines that start with
 * `- ` over-counts the entries, and a continuation that happens to look like a
 * Markdown heading truncates the whole section for a Markdown reader. Two
 * spaces is the CommonMark minimum for staying inside the `- ` item.
 *
 * @param {string[]} items
 * @returns {string}
 */
function renderBody(items) {
  if (items.length === 0) return NONE;
  return items.map((item) => `- ${item.replace(/\n/g, '\n  ')}`).join('\n');
}

/**
 * Compose the `### User Intents` items: each intent verbatim, optionally
 * followed by the assistant statement it answers.
 *
 * An isolated `继续` is unreadable — the reader cannot tell what is being
 * continued, which question is being answered, or what the approval was for.
 * Pairing each intent with the statement immediately before it restores that
 * referent without summarising anything: both halves are already verbatim text.
 *
 * The intent itself is never truncated or reordered; the context is appended on
 * its own line and is subject to its own cap upstream (see `src/render.js`).
 * A missing or empty context contributes no line at all, so an intent with no
 * preceding statement renders exactly as it did before.
 *
 * @param {string[]} intents
 * @param {string[]} contexts Index-aligned with `intents`; may be shorter.
 * @returns {string[]} One item per intent, ready for {@link renderBody}.
 */
function intentItems(intents, contexts) {
  return intents.map((intent, index) => {
    const context = contexts[index];
    return typeof context === 'string' && context !== ''
      ? `${intent}\n${CONTEXT_MARKER} ${context}`
      : intent;
  });
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

  const sections = SECTIONS.map(({ key, header }) => {
    const items = key === 'intents' ? intentItems(used.intents, used.contexts) : used[key];
    return `${header}\n${renderBody(items)}`;
  });

  // One blank line between adjacent subsections; `## Extracted Facts` sits
  // directly above the first one, and exactly one newline closes the output.
  const text = `${TOP_HEADER}\n${sections.join('\n\n')}\n`;

  return { text, facts: used };
}

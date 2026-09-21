/**
 * Budget-driven checkpoint renderer for the ctx-mem compaction backend.
 *
 * Why this module exists: the host's guard rejects a checkpoint whose framed
 * price is not strictly smaller than the span it replaces. A fixed-rule
 * renderer cannot satisfy that in cascade, because a degenerate fold's
 * denominator IS the previous checkpoint's own price while the fact set grows
 * monotonically with the region — a growing sequence against a frozen ceiling
 * must eventually cross it. So the ceiling has to drive the rendering.
 *
 * This module is a pure function: no I/O, no session access, no model call, no
 * direct tokenizer. The caller injects `estimate`, which prices a rendered
 * skeleton exactly the way the host will price the final checkpoint frame.
 *
 * Ordering contract: `intents` and `files` are rendered verbatim and are never
 * trimmed, truncated or dropped — they are ~0.7% of the cost and 100% of the
 * intent fidelity. `errors` and `commands` are retained newest-first, so the
 * oldest (least relevant) entries are the ones that fall off.
 *
 * Fact contract: `commands` renders state-changing commands only. A probe's
 * fact is its output, which the error and file lists already carry, so the
 * probe text itself is dropped (see {@link commandAt}).
 *
 * @module @logictan/dsh-ctx-mem/render
 */
import { buildSkeleton, copyFacts } from './skeleton.js';

/**
 * Per-item character caps, richest first.
 *
 * Only state-changing commands are rendered at all (see {@link isWriteLike}), so
 * every tier differs solely in how much of each one it keeps. `writeVerbatim`
 * is that cap; when it is `0` those commands degrade to their first line plus
 * their marker line (see {@link capWriteFirstLine}). `errorCap` caps one error
 * entry, and `contextCap` one paired assistant statement.
 *
 * `contextCap` is the one cap that bounds *added* text rather than a fact: the
 * paired context is derived from the same region, so capping it loses nothing
 * that is not already in the region. The intent above it is never capped.
 *
 * @type {Readonly<Record<string, { writeVerbatim: number, firstLine: number, errorCap: number, contextCap: number }>>}
 */
export const TIERS = Object.freeze({
  T1: Object.freeze({ writeVerbatim: 4000, firstLine: 200, errorCap: 300, contextCap: 300 }),
  T2: Object.freeze({ writeVerbatim: 2000, firstLine: 120, errorCap: 200, contextCap: 200 }),
  T3: Object.freeze({ writeVerbatim: 0, firstLine: 120, errorCap: 120, contextCap: 120 }),
});

/** The floor tier: intents and files only. Never a member of {@link TIERS}. */
export const FLOOR_TIER = 'T4';

/** Fidelity order, richest first. Used to break a {@link prefer} tie. */
const TIER_RANK = Object.freeze({ T1: 0, T2: 1, T3: 2 });

/**
 * Commands that change state — files, history, the published artifact or the
 * running service. Their text is the fact, so it is rendered; a probe is
 * dropped instead (see {@link commandAt}).
 *
 * Two rules keep this precise, both measured against a real 355-command
 * archive where the naive form scored 88 and 22 of them were probes:
 *
 * 1. **A subcommand is matched only where it starts.** A bare
 *    `(^|[;&|(\s])` prefix also matches inside a quoted argument, so
 *    `pkill -f 'npm publish'` and `grep -i 'npm publish'` — both read-only —
 *    scored as writes. {@link isWriteLike} therefore strips quoted spans before
 *    testing: inside quotes a command name is data, not an invocation.
 * 2. **`git tag` is a write only when it creates, moves or deletes one.** The
 *    bare form, `-l`/`--list`, `-n` and `--sort` all list. The lookahead
 *    excludes exactly those and keeps `git tag v1.2.3`, `-a`, `-d`, `-f`.
 * 3. **A redirect writes only when it targets a tracked path.** Redirecting to
 *    `/dev/null`, `/tmp/` or `/private/tmp/` is how a probe captures its own
 *    output, so `… | sort > /tmp/all-specs.txt` is a read. On the measured
 *    archive all five redirect-only matches were exactly that.
 */
const WRITE_LIKE =
  /(^|[;&|(\s])(git\s+(commit|push|add|rm|mv|checkout|restore|reset|init|subtree|merge|rebase|stash|cherry-pick|apply|clean)|git\s+tag\s+(?!(?:-l|--list|--sort|-n\d*)\b)\S|npm\s+(publish|install|i|ci|version|unpublish)|pnpm\s+(install|add|remove|publish|build)|node\s+build\.mjs|dsh-web\s+(restart|start|stop)|mkdir|rm\s|mv\s|cp\s|chmod|tee\s|patch\s+-|sed\s+-i|touch\s|>\s*(?!\/dev\/null\b|\/private\/tmp\/|\/tmp\/)\S)/m;

/** Drop quoted spans so a command name inside an argument is not read as one. */
const QUOTED = /'[^']*'|"[^"]*"/g;

/**
 * True for a command whose own text (not just its first line) is the fact.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function isWriteLike(command) {
  return typeof command === 'string' && WRITE_LIKE.test(command.replace(QUOTED, "''"));
}

/**
 * Truncate to `limit` characters, marking exactly how many were dropped.
 *
 * The marker is explicit on purpose: a downstream model that cannot tell a
 * truncated fact from a complete one will reason about a half-command as if it
 * were whole.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function capText(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)} …[+${text.length - limit} chars]`;
}

/**
 * Keep the first line, truncated to `limit`, marking every dropped character —
 * both the ones cut off the line and the ones on the lines that were dropped.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function capFirstLine(text, limit) {
  const newline = text.indexOf('\n');
  const head = newline === -1 ? text : text.slice(0, newline);
  const kept = head.length <= limit ? head : head.slice(0, limit);
  const dropped = text.length - kept.length;
  return dropped > 0 ? `${kept} …[+${dropped} chars]` : kept;
}

/**
 * Render one command under one tier, or `undefined` for a probe.
 *
 * A probe is dropped outright rather than capped. Its fact is its *output*,
 * which the error list and the file list already carry; the probe text itself
 * is a question whose answer the reader already has. Keeping it spends budget
 * restating that question, and measured on the real archive it is the single
 * largest source of noise in a rendered checkpoint (267 of 355 commands, and
 * 87% of the command section's characters). Only a state-changing command's
 * own text is a fact in its own right.
 *
 * @param {string} command
 * @param {{ writeVerbatim: number, firstLine: number }} tier
 * @returns {string | undefined}
 */
function commandAt(command, tier) {
  if (!isWriteLike(command)) return undefined;
  if (tier.writeVerbatim > 0) return capText(command, tier.writeVerbatim);
  // A write-like command whose marker is not on its first line (`cd X` then
  // `cat > f <<EOF`) would otherwise be reduced to the leading `cd` and lose
  // the fact entirely. Keep its first line AND the line that carries the
  // marker, so the state change survives the degradation.
  return capWriteFirstLine(command, tier.firstLine);
}

/**
 * Keep a write-like command's first line plus its marker line.
 *
 * Used when the command must be degraded below its verbatim cap: dropping the
 * marker line would leave a bare `cd`/`echo`, which reads like a probe and
 * silently discards the state change. Measured on the real archive: 74 of 429
 * commands are write-like with the marker off line 1.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function capWriteFirstLine(text, limit) {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const markerIndex = lines.findIndex((line, index) => index > 0 && isWriteLike(line));
  if (markerIndex === -1) return capFirstLine(text, limit);

  const head = capFirstLine(first, limit);
  const marker = capFirstLine(lines[markerIndex], limit);
  const kept = `${head} … ${marker}`;
  const dropped = Math.max(0, text.length - head.length - marker.length);
  return dropped > 0 ? `${kept} …[+${dropped} chars]` : kept;
}

/** Price one rendered part-set through the caller's estimator. */
function priceOf(parts, estimate) {
  return estimate(buildSkeleton(parts).text);
}

/**
 * Transform every fact under one tier's caps — no budget, no dropping.
 * @param {{ intents: string[], files: string[], commands: string[], errors: string[] }} facts
 * @param {{ writeVerbatim: number, firstLine: number, errorCap: number }} tier
 */
function transformAll(facts, tier) {
  const commands = [];
  for (const command of facts.commands) {
    const rendered = commandAt(command, tier);
    if (rendered !== undefined) commands.push(rendered);
  }
  return {
    intents: facts.intents,
    contexts: cappedContexts(facts.contexts, tier),
    files: facts.files,
    commands,
    errors: facts.errors.map((error) => capText(error, tier.errorCap)),
  };
}

function firstNonEmptyLine(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') return line;
  }
  return '';
}

/**
 * Cap every paired assistant statement, preserving index alignment.
 *
 * Unlike intents and files — which are rendered verbatim and never trimmed —
 * the context is bounded: it is a convenience referent, and an unbounded one
 * would let a single verbose turn crowd out the commands. Its own cap keeps the
 * cost of S6 to a fixed ceiling per intent.
 *
 * Line truncation belongs here rather than in the skeleton renderer because
 * token estimation during tier evaluation and budget filling prices the output
 * of capped parts; stripping subsequent lines downstream would cause phantom
 * tokens to distort pricing and premature tier degradation.
 *
 * @param {string[]} contexts
 * @param {{ contextCap: number }} tier
 * @returns {string[]}
 */
function cappedContexts(contexts, tier) {
  return contexts.map((context) => capText(firstNonEmptyLine(context), tier.contextCap));
}

/**
 * Fill a budget greedily from the newest entry backwards.
 *
 * Errors are placed before commands because an error string is a fact that
 * cannot be re-derived, while a command is a record of an action the reader can
 * also see reflected in the file list. `floor` reports that even the
 * intents+files base does not fit.
 *
 * @param {{ intents: string[], files: string[], commands: string[], errors: string[] }} facts
 * @param {{ writeVerbatim: number, firstLine: number, errorCap: number }} tier
 * @param {number} budget
 * @param {(text: string) => number} estimate
 */
function greedyFill(facts, tier, budget, estimate) {
  const base = {
    intents: facts.intents,
    contexts: cappedContexts(facts.contexts, tier),
    files: facts.files,
    commands: [],
    errors: [],
  };
  if (priceOf(base, estimate) >= budget) return { floor: true, parts: base, originals: [] };

  const errors = [];
  for (const error of [...facts.errors].reverse()) {
    const rendered = capText(error, tier.errorCap);
    const next = { ...base, errors: [rendered, ...errors] };
    if (priceOf(next, estimate) >= budget) break;
    errors.unshift(rendered);
  }

  const commands = [];
  const originals = [];
  for (const command of [...facts.commands].reverse()) {
    const rendered = commandAt(command, tier);
    if (rendered === undefined) continue;
    const next = { ...base, commands: [rendered, ...commands], errors };
    if (priceOf(next, estimate) >= budget) break;
    commands.unshift(rendered);
    originals.unshift(command);
  }

  return { floor: false, parts: { ...base, commands, errors }, originals };
}

/** Assemble the public result shape. */
function result(parts, tier, floorHit, originals = []) {
  return {
    text: buildSkeleton(parts).text,
    tier,
    commands: parts.commands,
    errors: parts.errors,
    originals,
    floorHit,
  };
}

/**
 * How many state-changing commands a candidate retained.
 *
 * The count is taken over the **original** facts, not the rendered text: T3
 * degrades a command to its first line plus its marker line, and a marker that
 * lived on a later line (``echo setup`` then ``git commit -m ...``) is
 * truncated out of the rendering. A predicate over the rendered text would then
 * score that command as a probe and rank the tier that kept it below the tier
 * that dropped it.
 *
 * @param {string[]} originals The original commands.
 * @returns {number}
 */
function writeLikeCount(originals) {
  let count = 0;
  for (const command of originals) if (isWriteLike(command)) count += 1;
  return count;
}

/**
 * Pick the better of two budget-fitted candidates.
 *
 * Retention is newest-first, so under a tight budget the oldest entries are the
 * ones that fall off. A tier with a smaller per-item cap reaches further back
 * and so retains more of them, at the cost of keeping less of each. The
 * candidate that preserves more state-changing commands wins, because each one
 * is a separate fact while the detail inside one is a matter of degree.
 *
 * On a tie the **richer** tier wins. That is the case where two tiers retained
 * the same commands, and the one that kept more of each is strictly better. See
 * {@link TIER_RANK}.
 *
 * @param {{ commands: string[], originals: string[], tier: string }} candidate
 * @param {{ commands: string[], originals: string[], tier: string }} incumbent
 * @returns {boolean}
 */
function prefer(candidate, incumbent) {
  const candidateWrites = writeLikeCount(candidate.originals);
  const incumbentWrites = writeLikeCount(incumbent.originals);
  if (candidateWrites !== incumbentWrites) return candidateWrites > incumbentWrites;
  return TIER_RANK[candidate.tier] < TIER_RANK[incumbent.tier];
}

/**
 * Render a fact set that fits `budget`.
 *
 * Two rules, in order:
 *
 * 1. **Fidelity ladder (T1 → T2 → T3).** Every tier keeps the same fact set and
 *    differs only in per-item detail, so the first one that holds the whole set
 *    loses nothing but detail. This is the preferred outcome and covers every
 *    healthy fold. Because no tier drops a fact, a poorer tier that holds
 *    everything is strictly better than a richer tier that has to drop an
 *    entry — so the ladder runs to its end before rule 2 applies.
 * 2. **Budget-driven truncation (T1 → T2 → T3).** No tier holds everything, so
 *    render at that tier's caps and drop the oldest entries until it fits, then
 *    keep the candidate that best preserves state-changing commands (see
 *    {@link prefer}). Commands give way before errors, which give way last.
 *
 * The floor tier (intents + files only) is returned with `floorHit: true` when
 * even that base does not fit. This function never throws — the host's own
 * guard is not recoverable, so the backend must always hand it something.
 *
 * @param {import('./skeleton.js').Facts | undefined | null} facts
 * @param {number} budget Token budget for the rendered skeleton, already net of
 *   the causal section and the frame reserve.
 * @param {(text: string) => number} estimate Prices a rendered skeleton.
 * @returns {{ text: string, tier: string, commands: string[], errors: string[], floorHit: boolean }}
 */
export function renderCheckpoint(facts, budget, estimate) {
  const all = copyFacts(facts);
  // No estimator means no ceiling to enforce: render the richest tier whole
  // rather than silently degrading the checkpoint.
  if (typeof estimate !== 'function') return result(transformAll(all, TIERS.T1), 'T1', false);

  for (const name of ['T1', 'T2', 'T3']) {
    const parts = transformAll(all, TIERS[name]);
    if (priceOf(parts, estimate) < budget) return result(parts, name, false);
  }

  let best;
  for (const name of ['T1', 'T2', 'T3']) {
    const filled = greedyFill(all, TIERS[name], budget, estimate);
    // The floor price is tier-independent, so the first floor result is final.
    if (filled.floor) return result(filled.parts, FLOOR_TIER, true);
    const candidate = result(filled.parts, name, false, filled.originals);
    if (best === undefined || prefer(candidate, best)) best = candidate;
  }
  return best;
}

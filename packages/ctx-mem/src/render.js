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
 * @module @logictan/dsh-ctx-mem/render
 */
import { buildSkeleton } from './skeleton.js';

/**
 * Per-item character caps, richest first.
 *
 * `writeVerbatim` is the cap for state-changing commands (see
 * {@link isWriteLike}); when it is `0` those commands degrade to their first
 * line as well. `firstLine` caps every other command, and `errorCap` caps one
 * error entry. `writeOnly` drops probe commands entirely.
 *
 * @type {Readonly<Record<string, { writeVerbatim: number, firstLine: number, errorCap: number, writeOnly: boolean }>>}
 */
export const TIERS = Object.freeze({
  T1: Object.freeze({ writeVerbatim: 4000, firstLine: 200, errorCap: 300, writeOnly: false }),
  T2: Object.freeze({ writeVerbatim: 2000, firstLine: 120, errorCap: 200, writeOnly: false }),
  T3: Object.freeze({ writeVerbatim: 0, firstLine: 120, errorCap: 120, writeOnly: true }),
});

/** The floor tier: intents and files only. Never a member of {@link TIERS}. */
export const FLOOR_TIER = 'T4';

/**
 * Commands that change state — files, history, the published artifact or the
 * running service. Their full text is worth its price; everything else is a
 * probe whose first line already carries the fact.
 */
const WRITE_LIKE =
  /(^|[;&|(\s])(git\s+(commit|push|add|rm|mv|checkout|restore|reset|tag|init|subtree|merge|rebase|stash|cherry-pick|apply|clean)|npm\s+(publish|install|i|ci|version|unpublish)|pnpm\s+(install|add|remove|publish|build)|node\s+build\.mjs|dsh-web\s+(restart|start|stop)|mkdir|rm\s|mv\s|cp\s|chmod|tee\s|patch\s|sed\s+-i|touch\s|>\s*\S)/m;

/**
 * True for a command whose own text (not just its first line) is the fact.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function isWriteLike(command) {
  return typeof command === 'string' && WRITE_LIKE.test(command);
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
 * Render one command under one tier, or `undefined` when the tier drops it.
 *
 * @param {string} command
 * @param {{ writeVerbatim: number, firstLine: number, writeOnly: boolean }} tier
 * @returns {string | undefined}
 */
function commandAt(command, tier) {
  const write = isWriteLike(command);
  if (tier.writeOnly && !write) return undefined;
  if (write && tier.writeVerbatim > 0) return capText(command, tier.writeVerbatim);
  return capFirstLine(command, tier.firstLine);
}

/**
 * Coerce the caller's facts into the four lists this module renders.
 *
 * @param {import('./skeleton.js').Facts | undefined | null} facts
 * @returns {{ intents: string[], files: string[], commands: string[], errors: string[] }}
 */
function normalize(facts) {
  const source = facts && typeof facts === 'object' ? facts : {};
  return {
    intents: Array.isArray(source.intents) ? source.intents : [],
    files: Array.isArray(source.files) ? source.files : [],
    commands: Array.isArray(source.commands) ? source.commands : [],
    errors: Array.isArray(source.errors) ? source.errors : [],
  };
}

/** Price one rendered part-set through the caller's estimator. */
function priceOf(parts, estimate) {
  return estimate(buildSkeleton(parts).text);
}

/**
 * Transform every fact under one tier's caps — no budget, no dropping.
 * @param {{ intents: string[], files: string[], commands: string[], errors: string[] }} facts
 * @param {{ writeVerbatim: number, firstLine: number, errorCap: number, writeOnly: boolean }} tier
 */
function transformAll(facts, tier) {
  const commands = [];
  for (const command of facts.commands) {
    const rendered = commandAt(command, tier);
    if (rendered !== undefined) commands.push(rendered);
  }
  return {
    intents: facts.intents,
    files: facts.files,
    commands,
    errors: facts.errors.map((error) => capText(error, tier.errorCap)),
  };
}

/**
 * Fill a budget greedily from the newest entry backwards.
 *
 * Errors are placed before commands because an error string is the fact that
 * cannot be re-derived, while most commands are probes whose first line already
 * survives. `floor` reports that even the intents+files base does not fit.
 *
 * @param {{ intents: string[], files: string[], commands: string[], errors: string[] }} facts
 * @param {{ writeVerbatim: number, firstLine: number, errorCap: number, writeOnly: boolean }} tier
 * @param {number} budget
 * @param {(text: string) => number} estimate
 */
function greedyFill(facts, tier, budget, estimate) {
  const base = { intents: facts.intents, files: facts.files, commands: [], errors: [] };
  if (priceOf(base, estimate) >= budget) return { floor: true, parts: base };

  const errors = [];
  for (const error of [...facts.errors].reverse()) {
    const rendered = capText(error, tier.errorCap);
    const next = { ...base, errors: [rendered, ...errors] };
    if (priceOf(next, estimate) >= budget) break;
    errors.unshift(rendered);
  }

  const commands = [];
  for (const command of [...facts.commands].reverse()) {
    const rendered = commandAt(command, tier);
    if (rendered === undefined) continue;
    const next = { ...base, commands: [rendered, ...commands], errors };
    if (priceOf(next, estimate) >= budget) break;
    commands.unshift(rendered);
  }

  return { floor: false, parts: { ...base, commands, errors } };
}

/** Assemble the public result shape. */
function result(parts, tier, floorHit) {
  return {
    text: buildSkeleton(parts).text,
    tier,
    commands: parts.commands,
    errors: parts.errors,
    floorHit,
  };
}

/** How many of a rendered command list still read as state-changing. */
function writeLikeCount(commands) {
  let count = 0;
  for (const command of commands) if (isWriteLike(command)) count += 1;
  return count;
}

/**
 * Pick the better of two budget-fitted candidates.
 *
 * Retention is newest-first, so a flood of recent probes evicts the older
 * state-changing commands that actually carry facts. T3 exists to reverse that
 * trade: it keeps only write-like commands, so it can reach deeper into the
 * history for them. So the candidate that preserves more state-changing
 * commands wins, and only on a tie does the larger total win — which, given the
 * iteration order, leaves the richer tier in place.
 *
 * @param {{ commands: string[] }} candidate
 * @param {{ commands: string[] }} incumbent
 * @returns {boolean}
 */
function prefer(candidate, incumbent) {
  const candidateWrites = writeLikeCount(candidate.commands);
  const incumbentWrites = writeLikeCount(incumbent.commands);
  if (candidateWrites !== incumbentWrites) return candidateWrites > incumbentWrites;
  return candidate.commands.length > incumbent.commands.length;
}

/**
 * Render a fact set that fits `budget`.
 *
 * Two rules, in order:
 *
 * 1. **Fidelity ladder (T1 → T2).** Both tiers keep every fact and differ only
 *    in per-item detail, so the first one that holds the whole set loses
 *    nothing. This is the preferred outcome and covers every healthy fold. T3
 *    is deliberately NOT on this ladder: it discards probe commands, which is a
 *    fact loss, and a tier that drops facts always "fits" — putting it here
 *    would silently return an empty command list instead of degrading.
 * 2. **Budget-driven truncation (T1 → T2 → T3).** No tier holds everything, so
 *    render at that tier's caps and drop the oldest entries until it fits, then
 *    keep the candidate that best preserves state-changing commands (see
 *    {@link prefer}). Probes give way before state-changing commands, and
 *    errors give way last of all.
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
  const all = normalize(facts);
  // No estimator means no ceiling to enforce: render the richest tier whole
  // rather than silently degrading the checkpoint.
  if (typeof estimate !== 'function') return result(transformAll(all, TIERS.T1), 'T1', false);

  for (const name of ['T1', 'T2']) {
    const parts = transformAll(all, TIERS[name]);
    if (priceOf(parts, estimate) < budget) return result(parts, name, false);
  }

  let best;
  for (const name of ['T1', 'T2', 'T3']) {
    const filled = greedyFill(all, TIERS[name], budget, estimate);
    // The floor price is tier-independent, so the first floor result is final.
    if (filled.floor) return result(filled.parts, FLOOR_TIER, true);
    const candidate = result(filled.parts, name, false);
    if (best === undefined || prefer(candidate, best)) best = candidate;
  }
  return best;
}

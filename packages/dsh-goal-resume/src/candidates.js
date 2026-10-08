/**
 * Selection rules for the startup resume pass.
 *
 * Every function here is pure: the host calls live in `index.js`, so the
 * decisions "which session" and "which goal" can be pinned without a host.
 *
 * Two shapes reach this module and they are NOT the same:
 *
 * - a cached goal is the projection's wire view, which nests the durable goal
 *   (`{ goal: {...}, roundsStarted, ... }`);
 * - a live goal from `ctx.goals.get` is flat (`{ id, revision, phase, ... }`)
 *   and additionally carries the process-local `activation`.
 *
 * Both are normalized to one `facts` record so the resume predicate is written
 * once.
 *
 * @module @logictan/dsh-goal-resume/candidates
 */

/**
 * Whether a header describes a session the resume pass may target.
 *
 * `origin` is the host's own subagent marker (`hasApiSessionSubagentOwner`
 * tests exactly this field), and `cwd` is a hard precondition of the reopen
 * path: the session controller rejects an observation without one as
 * not-found, so such a session can never be resumed.
 *
 * @param header - one listed session header.
 * @param archivedIds - the registry-global archive set.
 * @returns whether the session is eligible to be considered.
 */
export function isEligible(header, archivedIds) {
  if (header.origin === 'subagent') return false;
  if (header.cwd === undefined) return false;
  return !archivedIds.has(header.id);
}

/**
 * Normalize the cached wire view into resume facts.
 *
 * @param snapshot - a `cachedSnapshot(header, ['goal'])` block, or `undefined`.
 * @returns facts, or `undefined` when the cache holds no current goal.
 */
export function cachedGoalFacts(snapshot) {
  if (snapshot === undefined) return undefined;
  const view = snapshot.values.goal;
  if (view === undefined || view === null) return undefined;
  return factsOf(view.goal, view.roundsStarted, undefined);
}

/**
 * Normalize a live goal view into resume facts.
 *
 * @param goal - a `ctx.goals.get(agent)` view, or `undefined`.
 * @returns facts, or `undefined` when no goal is current.
 */
export function liveGoalFacts(goal) {
  if (goal === undefined) return undefined;
  return factsOf(goal, goal.roundsStarted, goal.activation);
}

/**
 * Whether these facts describe a goal the pass should arm.
 *
 * The accepted phase is `active` alone — a paused, blocked, or complete goal
 * is never started automatically. `roundsStarted < maxGoalRounds` is checked
 * here because an exhausted goal cannot be resumed at all.
 *
 * @param facts - normalized goal facts, or `undefined`.
 * @returns whether the goal should be resumed.
 */
export function isResumable(facts) {
  if (facts === undefined) return false;
  return facts.phase === 'active' && facts.roundsStarted < facts.maxGoalRounds;
}

/**
 * Collapse entries that name the same goal, keeping one.
 *
 * A seeded fork and its parent carry the same goal id and revision, so
 * resuming both would run two round loops over one goal. The listed order is
 * newest-first, so the first entry wins a tie; a non-seeded entry always wins
 * over a seeded one.
 *
 * @param entries - eligible entries carrying normalized facts.
 * @returns one entry per distinct goal id.
 */
export function dedupeByGoalId(entries) {
  const byGoal = new Map();
  for (const entry of entries) {
    const seen = byGoal.get(entry.goal.id);
    if (seen === undefined || (seen.header.isSeeded === true && entry.header.isSeeded !== true)) {
      byGoal.set(entry.goal.id, entry);
    }
  }
  return [...byGoal.values()];
}

/** Build the one facts record both readers normalize into. */
function factsOf(goal, roundsStarted, activation) {
  return {
    id: goal.id,
    revision: goal.revision,
    phase: goal.phase,
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted,
    activation,
  };
}

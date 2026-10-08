/**
 * dsh-goal-resume — restart the goals a restart stopped.
 *
 * A goal's durable phase survives a restart, but its continuation authority
 * does not: `activation` is process-local and the host resets every session to
 * `disarmed` on `agent/created`. The only two writers of `armed` are `create`
 * and `resume`, and `resume` is reachable only from a direct human action
 * (`create_goal`/`update_goal`, the Goal page's button, or `/goal resume`). So
 * after a restart an `active` goal sits there inert: the round loop is not
 * running and nothing will start it again. This plugin closes that gap.
 *
 * One pass, once, a fixed delay after boot. The delay is what makes the pass
 * safe to be automatic: the session corpus, the projection cache, and the
 * workspace registry have all finished their own startup by then, and any
 * session a human opened in the meantime is already live and gets skipped.
 *
 * The read route is the projection cache, and it is a PREFILTER only. The
 * cache is a zero-I/O view of stored rows — identity-checked, so it is never
 * wrong, only possibly stale. Every candidate is therefore re-read through
 * `ctx.goals.get` on the resolved live agent, which is the authoritative
 * registry state, and the resume itself passes a `{id, revision}` ref that the
 * goal domain validates. A stale candidate can only be rejected
 * (`GOAL_STALE_REVISION` / `GOAL_NOT_FOUND`), never applied.
 *
 * @module @logictan/dsh-goal-resume
 */

import {
  cachedGoalFacts,
  dedupeByGoalId,
  isEligible,
  isResumable,
  liveGoalFacts,
} from './candidates.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'goal-resume';

/**
 * Services this plugin cannot run without. All four are mounted by `dsh-base`.
 *
 * The two the pass also needs — the archive set and the session controller —
 * are deliberately NOT here: they are mounted by `dsh-web-app` only, and a
 * missing injected service does not degrade a plugin, it silently skips its
 * entire `apply`. They are read with `ctx.get(...)` at pass time instead, so a
 * profile without them simply finds nothing to do.
 */
export const inject = ['agents', 'goals', 'sessionQuery', 'sessionProjectionCache'];

/** Delay before the pass, long enough for the corpus, cache, and registry. */
const STARTUP_DELAY_MS = 30_000;

/**
 * Run the startup pass once, after {@link STARTUP_DELAY_MS}.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      runPass(ctx).catch((error) => {
        ctx.logger.error(`goal-resume: startup pass failed: ${String(error)}`);
      });
    }, STARTUP_DELAY_MS);
    // The host is long-lived; an unreferenced timer cannot keep a shutting-down
    // process alive for the length of the delay.
    timer.unref();
    return () => clearTimeout(timer);
  }, 'goal-resume: startup pass');
}

/**
 * Resume every goal that a restart left active.
 *
 * @param ctx - the plugin context.
 */
async function runPass(ctx) {
  // Both are web-profile mounts. Without the controller there is no way to
  // reopen a stored session, and without the registry the archive filter
  // cannot be honored — the pass does nothing rather than guess.
  const controller = ctx.get('sessionController');
  const registry = ctx.get('workspaceRegistry');
  if (controller === undefined || registry === undefined) {
    ctx.logger.info('goal-resume: session control is not mounted in this profile; nothing to resume');
    return;
  }

  let archived;
  try {
    archived = new Set(registry.archivedSessionIds);
  } catch (error) {
    // The registry is still starting. Reading the archive set is a precondition
    // of the contract, so an unreadable set aborts the pass rather than
    // resuming sessions the human may have archived.
    ctx.logger.warn(`goal-resume: cannot read the archive set; skipping this pass: ${String(error)}`);
    return;
  }

  const records = await ctx.sessionQuery.listSessions();

  const candidates = [];
  for (const record of records) {
    const header = record.header;
    if (!isEligible(header, archived)) continue;
    const facts = cachedGoalFacts(ctx.sessionProjectionCache.cachedSnapshot(header, ['goal']));
    if (!isResumable(facts)) continue;
    candidates.push({ header, goal: facts });
  }

  // A seeded fork and its parent carry one goal id; two round loops over one
  // goal is never wanted, so only one entry per goal survives.
  const targets = dedupeByGoalId(candidates);
  ctx.logger.info(`goal-resume: ${targets.length} stopped goal(s) to resume`);

  for (const target of targets) {
    // Sequential on purpose: a resume boots a whole agent, and one session's
    // failure must never abort the rest of the pass.
    try {
      await resumeOne(ctx, controller, target);
    } catch (error) {
      ctx.logger.warn(`goal-resume: session "${target.header.id}" was not resumed: ${String(error)}`);
    }
  }
}

/**
 * Reopen one stored session and arm its goal.
 *
 * @param ctx - the plugin context.
 * @param controller - the session controller.
 * @param target - the eligible header and its cached goal facts.
 */
async function resumeOne(ctx, controller, target) {
  const sessionId = target.header.id;

  // A live agent was not stopped by the restart — someone is using it — and
  // arming its goal underneath them is not this plugin's business.
  if (ctx.agents.get(sessionId) !== undefined) return;

  const resolved = await controller.resolveAgent(sessionId);
  if ('error' in resolved) {
    ctx.logger.warn(`goal-resume: session "${sessionId}" could not be reopened: ${resolved.error.code}`);
    return;
  }

  // Authoritative re-read: the cache may have lagged, and reopening takes time.
  const live = liveGoalFacts(ctx.goals.get(resolved.agent));
  if (!isResumable(live)) return;
  // Already armed means the round loop is running; `resume` would reject it.
  if (live.activation === 'armed') return;

  ctx.goals.resume(resolved.agent, { id: live.id, revision: live.revision });
  ctx.logger.info(`goal-resume: resumed goal "${live.id}" in session "${sessionId}"`);
}

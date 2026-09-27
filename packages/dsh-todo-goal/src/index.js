/**
 * dsh-todo-goal — automatic session goal for multi-task sessions.
 *
 * The host's goal domain is model- or human-driven: a goal exists because
 * `create_goal` was called or `/goal` was typed. A session that plans more than
 * three tasks without either of those gets no goal, so nothing continues the
 * work across turns. This plugin closes that gap from the host side.
 *
 * The seam is `tools/post-execute`, which runs AFTER the tool body has already
 * appended its own session event. That ordering is the whole reason this
 * listener is safe: `Session.append` rejects a reentrant append while another
 * append is being published, so a goal created from inside `session/event`
 * would throw — the todo write is already durable here, and the goal write is a
 * second, independent append.
 *
 * Creating a goal through `ctx.goals.create` commits it `armed`, which is what
 * makes it more than a label: the round driver queues the next round as soon as
 * the agent goes idle, so the work continues without a further instruction.
 *
 * @module @logictan/dsh-todo-goal
 */

import { activeTodos, renderObjective } from './objective.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'todo-goal';

/** The live agent registry, the goal domain, and the todo projection. */
export const inject = ['agents', 'goals', 'sessionProjections'];

/** The tool whose result is the trigger. */
const TODO_TOOL = 'todo_write';

/** Open tasks required before a session earns a goal — one past "more than three". */
const MIN_OPEN_TASKS = 4;

/** The registered unit key the todo tool projects its whole list into. */
const TODOS_KEY = 'todos';

/**
 * Create the session goal when the recorded work calls for one.
 *
 * Synchronous on purpose: the check and the create must not be separable by a
 * yield. A step may dispatch several `todo_write` calls at once, and each one's
 * post-execute resumes after its own `await`; with a yield between the read and
 * the write, two of them could both see no goal and the second would fail with
 * `GOAL_ALREADY_EXISTS` on an otherwise successful call.
 *
 * @param ctx - the plugin context.
 * @param agent - the agent whose session just recorded a todo list.
 */
function ensureGoal(ctx, agent) {
  // Only a top-level agent owns a session goal; a subagent's todo list is its
  // own working memory and must never arm a round loop over the parent session.
  if (!ctx.agents.roots().includes(agent)) return;

  // An existing goal is never replaced while it is still current: a complete
  // goal is the one phase `create` accepts as a predecessor, so that is the
  // only case that falls through.
  const current = ctx.goals.get(agent);
  if (current !== undefined && current.phase !== 'complete') return;

  const todos = ctx.sessionProjections.stateOf(agent.session, TODOS_KEY);
  if (todos === undefined || todos === null) return;
  if (activeTodos(todos).length < MIN_OPEN_TASKS) return;

  ctx.goals.create(agent, { objective: renderObjective(todos) });
}

/**
 * Watch every tool result for a todo list that has outgrown the threshold.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    // `isError` means the tool body threw, and `todo_write` validates its whole
    // list before appending — so an error result is a list the session never
    // recorded. A downstream `block` is NOT a reason to skip: the body has
    // already appended its event by now, so the work really is recorded.
    if (exec.name === TODO_TOOL && !result.isError) ensureGoal(ctx, exec.agent);
    return decision;
  });
}


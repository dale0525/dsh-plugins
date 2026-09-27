/**
 * The objective text written into an automatically created session goal.
 *
 * The round driver re-sends this objective verbatim in every autonomous round
 * prompt, so it has to do two jobs at once: name the work the session itself
 * recorded, and stay bounded no matter how long the backlog grows. Both are
 * load-bearing — an objective that named nothing would leave the round
 * instruction with no content of its own, and an unbounded one would be echoed
 * into every round of a fifty-task session.
 *
 * @module @logictan/dsh-todo-goal/objective
 */

/** How many open tasks are named before the rest collapse into a count. */
const MAX_NAMED_TASKS = 8;

/**
 * The unfinished part of one todo list.
 *
 * `completed` is the only finished status, so it is the only one filtered out:
 * a task is open whether it is pending or already in progress.
 *
 * @param todos - the whole list as recorded by `todo_write`.
 * @returns the open items, in their recorded order.
 */
export function activeTodos(todos) {
  return todos.filter((todo) => todo.status !== 'completed');
}

/**
 * Render the objective for one list of open tasks.
 *
 * @param todos - the whole list as recorded by `todo_write`.
 * @returns a non-empty objective naming the open work.
 */
export function renderObjective(todos) {
  const active = activeTodos(todos);
  const named = active.slice(0, MAX_NAMED_TASKS);
  const lines = named.map((todo, index) => `${index + 1}. ${todo.content}`);
  const remainder = active.length - named.length;
  if (remainder > 0) lines.push(`+${remainder} more`);
  return [`Continue the ${active.length} open tasks this session recorded:`, ...lines].join('\n');
}


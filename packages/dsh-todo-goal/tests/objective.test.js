/**
 * Acceptance contract for the goal objective this plugin writes.
 *
 * The objective is the ONLY thing the autonomous round loop is told, and it is
 * re-sent verbatim in every round prompt, so two properties are load-bearing:
 * it names the work the session itself recorded, and it stays short enough that
 * a long backlog cannot bloat every round.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { activeTodos, renderObjective } from '../src/objective.js';

const item = (content, status = 'pending') => ({ content, status });

test('only unfinished items count as open work', () => {
  const todos = [item('a'), item('b', 'in_progress'), item('c', 'completed'), item('d')];
  assert.deepEqual(activeTodos(todos).map((todo) => todo.content), ['a', 'b', 'd']);
});

test('the objective names every open task', () => {
  const objective = renderObjective([item('rename the parser'), item('update the fixtures')]);
  assert.match(objective, /rename the parser/);
  assert.match(objective, /update the fixtures/);
  assert.match(objective, /2/);
});

test('a long backlog is truncated with a remainder count', () => {
  const todos = Array.from({ length: 12 }, (_value, index) => item('task ' + index));
  const objective = renderObjective(todos);
  assert.match(objective, /task 0/);
  assert.match(objective, /task 7/);
  assert.doesNotMatch(objective, /task 8/);
  assert.match(objective, /\+4 more/);
});


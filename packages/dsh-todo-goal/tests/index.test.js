/**
 * Acceptance contract for the automatic session goal.
 *
 * The rule this plugin enforces is "more than three tasks of work with no
 * active goal means the session gets one". Every case below pins one half of
 * that sentence against the seams the host actually exposes: the todo
 * projection (what the work is), the live agent registry (who owns it), and
 * the goal service (whether one already exists).
 *
 * The plugin is a listener on `tools/post-execute`, so each case drives the
 * registered handler directly with a tool execution, the tool result, and the
 * downstream decision callback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name } from '../src/index.js';

/** An execution record shaped like the one the tool registry passes to listeners. */
function execFor(toolName, agent) {
  return { callId: 'call-1', name: toolName, arguments: {}, agent };
}

/** A successful tool result. */
const OK = { content: [], isError: false };

/**
 * A Context stub covering exactly the services this plugin reads.
 *
 * `current` is mutable so a case can assert what a create did to later reads.
 */
function harness({ roots = [], current, todos } = {}) {
  const listeners = new Map();
  const created = [];
  const state = { current };
  const ctx = {
    agents: { roots: () => roots },
    goals: {
      get: () => state.current,
      create: (agent, request) => {
        created.push({ agent, request });
        state.current = { id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', objective: request.objective };
        return state.current;
      },
    },
    sessionProjections: { stateOf: () => todos },
    on: (event, handler) => { listeners.set(event, handler); },
  };
  return { ctx, created, listeners };
}

/** Run the registered post-execute listener once. */
async function fire(listeners, exec, result = OK) {
  const handler = listeners.get('tools/post-execute');
  assert.ok(handler, 'the plugin registers a tools/post-execute listener');
  return handler(exec, result, () => Promise.resolve({ kind: 'accept' }));
}

/** Four open tasks: one past the rule's "more than three" boundary. */
const FOUR = [
  { content: 'one', status: 'pending' },
  { content: 'two', status: 'pending' },
  { content: 'three', status: 'pending' },
  { content: 'four', status: 'pending' },
];

test('the plugin declares what it reads', () => {
  assert.equal(name, 'todo-goal');
  assert.deepEqual(inject, ['agents', 'goals', 'sessionProjections']);
});

test('four open tasks with no goal create an armed goal naming the work', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const { ctx, created, listeners } = harness({ roots: [agent], current: undefined, todos: FOUR });
  apply(ctx);

  const decision = await fire(listeners, execFor('todo_write', agent));

  assert.deepEqual(decision, { kind: 'accept' });
  assert.equal(created.length, 1);
  assert.equal(created[0].agent, agent);
  assert.match(created[0].request.objective, /one/);
  assert.match(created[0].request.objective, /four/);
});

test('three open tasks stay below the boundary', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const { ctx, created, listeners } = harness({ roots: [agent], todos: FOUR.slice(0, 3) });
  apply(ctx);

  await fire(listeners, execFor('todo_write', agent));

  assert.deepEqual(created, []);
});

test('completed tasks do not count as open work', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const todos = [...FOUR, { content: 'five', status: 'completed' }];
  const { ctx, created, listeners } = harness({ roots: [agent], todos });
  apply(ctx);

  await fire(listeners, execFor('todo_write', agent));

  assert.equal(created.length, 1);
});

test('an existing non-complete goal is left alone', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const { ctx, created, listeners } = harness({
    roots: [agent],
    current: { id: 'goal-0', revision: 2, phase: 'active', activation: 'disarmed', objective: 'existing' },
    todos: FOUR,
  });
  apply(ctx);

  await fire(listeners, execFor('todo_write', agent));

  assert.deepEqual(created, []);
});

test('a completed goal is replaced', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const { ctx, created, listeners } = harness({
    roots: [agent],
    current: { id: 'goal-0', revision: 3, phase: 'complete', activation: 'disarmed', objective: 'finished' },
    todos: FOUR,
  });
  apply(ctx);

  await fire(listeners, execFor('todo_write', agent));

  assert.equal(created.length, 1);
});

test('a subagent never gets a goal of its own', async () => {
  const agent = { id: 'child-1', session: { id: 'child-1' } };
  const { ctx, created, listeners } = harness({ roots: [], todos: FOUR });
  apply(ctx);

  await fire(listeners, execFor('todo_write', agent));

  assert.deepEqual(created, []);
});

test('a failed todo_write does not create a goal', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const { ctx, created, listeners } = harness({ roots: [agent], todos: FOUR });
  apply(ctx);

  await fire(listeners, execFor('todo_write', agent), { content: [], isError: true });

  assert.deepEqual(created, []);
});

test('an unrelated tool is ignored', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const { ctx, created, listeners } = harness({ roots: [agent], todos: FOUR });
  apply(ctx);

  await fire(listeners, execFor('read', agent));

  assert.deepEqual(created, []);
});

test('a session without the todo projection is ignored', async () => {
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  const { ctx, created, listeners } = harness({ roots: [agent], todos: undefined });
  apply(ctx);

  await fire(listeners, execFor('todo_write', agent));

  assert.deepEqual(created, []);
});


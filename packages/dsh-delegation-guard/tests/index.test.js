/**
 * Acceptance contract for the delegation guard.
 *
 * The plugin enforces three sentences: a seat is never one-shot, a delegating
 * session does not spin, and silence has an upper bound. Every case below pins
 * one half of one sentence against the seams the host actually exposes: the
 * tool registry (what a delegation tool is), the live agent registry (whose
 * child a seat is), and the reminder service (the wait bound).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name } from '../src/index.js';

/** A delegation tool: its output schema declares the continuable outcome. */
const CONTINUABLE_TOOL = {
  output: {
    schema: {
      oneOf: [
        {
          type: 'object',
          properties: {
            kind: { type: 'string', required: true, const: 'background' },
            jobId: { type: 'string', required: true },
          },
        },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', required: true, const: 'continuable' },
            subagentId: { type: 'string', required: true },
          },
        },
      ],
    },
  },
};

/** A tool that shares `run_in_background` but can never produce a seat. */
const PLAIN_TOOL = {
  output: {
    schema: {
      type: 'object',
      properties: { kind: { type: 'string' }, jobId: { type: 'string' } },
    },
  },
};

/** A reminder service that records what the plugin did to it. */
function fakeSchedule() {
  const created = [];
  const deleted = [];
  const stored = [];
  return {
    created,
    deleted,
    stored,
    list: async ({ sessionId }) => stored.filter((record) => record.sessionId === sessionId),
    create: async (sessionId, request) => {
      const record = { id: `schedule-${stored.length + 1}`, sessionId, ...request };
      stored.push(record);
      created.push({ sessionId, request });
      return record;
    },
    delete: async ({ sessionId, id }) => {
      deleted.push({ sessionId, id });
      const index = stored.findIndex((record) => record.id === id);
      if (index >= 0) stored.splice(index, 1);
    },
  };
}

/**
 * A Context stub covering exactly the services this plugin reads.
 *
 * `parents` maps a child session id to its durable parent, which is how the
 * plugin resolves lineage without depending on package-private internals.
 */
function harness({ definitions = {}, parents = {}, schedule } = {}) {
  const listeners = new Map();
  const registered = [];
  const agents = new Map(
    Object.entries(parents).map(([id, parentSession]) => [
      id,
      { session: { header: { parentSession } } },
    ]),
  );
  const ctx = {
    tools: {
      get: (toolName) => definitions[toolName],
      // The host returns the disposer that unregisters the tool; the plugin
      // does not need it, because `register` already ties the tool to the
      // plugin's fiber.
      register: (definition) => {
        registered.push(definition);
        return () => {};
      },
    },
    agents: { get: (id) => agents.get(id) },
    get: (service) => (service === 'schedule' ? schedule : undefined),
    on: (event, handler) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
  };
  apply(ctx);
  return { listeners, registered };
}

/**
 * Run the handlers registered for one event.
 *
 * With a terminal, models the host's `next()`-style waterfall: each handler
 * receives a continuation that runs the rest of the chain, so returning
 * `next()` is a pass-through and only a handler that answers without calling it
 * short-circuits. Without a terminal, the event is a plain notification and
 * every handler runs.
 */
async function fire(listeners, event, ...args) {
  const handlers = listeners.get(event);
  assert.ok(handlers, `no listener registered for ${event}`);
  const [payload, terminal] = args;
  if (terminal === undefined) {
    let last;
    for (const handler of handlers) last = await handler(payload);
    return last;
  }
  const dispatch = (index) =>
    index >= handlers.length ? terminal() : handlers[index](payload, () => dispatch(index + 1));
  return dispatch(0);
}

/** The downstream decision a waterfall listener forwards to. */
const ALLOW = async () => ({ kind: 'allow' });

/** One delegation call carrying an explicit scheduling choice. */
function delegation(name, runInBackground, agent = {}) {
  return { name, arguments: { prompt: 'x', description: 'y', run_in_background: runInBackground }, agent };
}

test('the row id matches the patch row this plugin ships', () => {
  assert.equal(name, 'delegation-guard');
  assert.deepEqual(inject, ['tools', 'agents']);
});

test('refuses the one-shot switch on a delegation tool', async () => {
  const { listeners } = harness({ definitions: { subagent: CONTINUABLE_TOOL } });
  const decision = await fire(listeners, 'tools/pre-execute', delegation('subagent', false), ALLOW);
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /one-shot subagents are banned/i);
  assert.match(decision.reason, /run_in_background/);
});

test('refuses the one-shot switch on a fork delegation too', async () => {
  const { listeners } = harness({ definitions: { subagent_fork: CONTINUABLE_TOOL } });
  const decision = await fire(listeners, 'tools/pre-execute', delegation('subagent_fork', false), ALLOW);
  assert.equal(decision.kind, 'deny');
});

test('leaves an omitted scheduling choice alone', async () => {
  const { listeners } = harness({ definitions: { subagent: CONTINUABLE_TOOL } });
  const call = { name: 'subagent', arguments: { prompt: 'x', description: 'y' }, agent: {} };
  const decision = await fire(listeners, 'tools/pre-execute', call, ALLOW);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('leaves an explicit continuable choice alone', async () => {
  const { listeners } = harness({ definitions: { subagent: CONTINUABLE_TOOL } });
  const decision = await fire(listeners, 'tools/pre-execute', delegation('subagent', true), ALLOW);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('does not misfire on a tool that only shares the parameter name', async () => {
  const { listeners } = harness({ definitions: { bash: PLAIN_TOOL, pwsh: PLAIN_TOOL, workflow: PLAIN_TOOL } });
  for (const toolName of ['bash', 'pwsh', 'workflow']) {
    const decision = await fire(listeners, 'tools/pre-execute', delegation(toolName, false), ALLOW);
    assert.deepEqual(decision, { kind: 'allow' }, `${toolName} must not be gated`);
  }
});

test('does not misfire on an unregistered tool', async () => {
  const { listeners } = harness({ definitions: {} });
  const decision = await fire(listeners, 'tools/pre-execute', delegation('mystery', false), ALLOW);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('arms a bounded checkpoint when a seat starts', async () => {
  const schedule = fakeSchedule();
  const { listeners } = harness({ parents: { 'child-1': 'root-1' }, schedule });
  await fire(listeners, 'subagent/start', { id: 'child-1', runId: 'run-1' });
  assert.equal(schedule.created.length, 1);
  assert.equal(schedule.created[0].sessionId, 'root-1');
  assert.equal(schedule.created[0].request.after_seconds, 600);
  assert.equal(schedule.created[0].request.title, 'subagent checkpoint');
  assert.match(schedule.created[0].request.prompt, /list_agents/);
});

test('keeps at most one checkpoint when a second seat starts', async () => {
  const schedule = fakeSchedule();
  const { listeners } = harness({ parents: { 'child-1': 'root-1', 'child-2': 'root-1' }, schedule });
  await fire(listeners, 'subagent/start', { id: 'child-1' });
  await fire(listeners, 'subagent/start', { id: 'child-2' });
  assert.equal(schedule.stored.length, 1);
  assert.equal(schedule.deleted.length, 1);
});

test('clears the checkpoint once the last seat reports', async () => {
  const schedule = fakeSchedule();
  const { listeners } = harness({ parents: { 'child-1': 'root-1', 'child-2': 'root-1' }, schedule });
  await fire(listeners, 'subagent/start', { id: 'child-1' });
  await fire(listeners, 'subagent/start', { id: 'child-2' });
  await fire(listeners, 'subagent/end', { id: 'child-1', stopReason: 'completed' });
  assert.equal(schedule.stored.length, 1, 'one seat is still running');
  await fire(listeners, 'subagent/end', { id: 'child-2', stopReason: 'completed' });
  assert.equal(schedule.stored.length, 0, 'no seat is left, so no wake-up is owed');
});

test('a start and an end that interleave still converge to one checkpoint', async () => {
  // Lifecycle edges are published by a contained emitter that does NOT await
  // listeners, so a seat that fails fast can publish its end while its own start
  // is still writing storage. The two events are therefore driven concurrently
  // here: the checkpoint must converge on the live-seat count, not on the order
  // the storage writes happen to land in.
  const schedule = fakeSchedule();
  const { listeners } = harness({ parents: { 'child-1': 'root-1' }, schedule });
  const starting = fire(listeners, 'subagent/start', { id: 'child-1' });
  const ending = fire(listeners, 'subagent/end', { id: 'child-1' });
  await Promise.all([starting, ending]);
  assert.equal(schedule.stored.length, 0, 'the seat already reported, so no wake-up is owed');
});

test('a second seat that starts after the first reported re-arms the checkpoint', async () => {
  const schedule = fakeSchedule();
  const { listeners } = harness({ parents: { 'child-1': 'root-1', 'child-2': 'root-1' }, schedule });
  await fire(listeners, 'subagent/start', { id: 'child-1' });
  await fire(listeners, 'subagent/end', { id: 'child-1' });
  assert.equal(schedule.stored.length, 0);
  await fire(listeners, 'subagent/start', { id: 'child-2' });
  assert.equal(schedule.stored.length, 1, 'the new seat is owed its own wake-up');
});

test('a seat that never reports leaves the checkpoint to fire', async () => {
  const schedule = fakeSchedule();
  const { listeners } = harness({ parents: { 'child-1': 'root-1' }, schedule });
  await fire(listeners, 'subagent/start', { id: 'child-1' });
  assert.equal(schedule.stored.length, 1, 'silence must still have an upper bound');
});

test('ignores a seat whose parent is not resolvable', async () => {
  const schedule = fakeSchedule();
  const { listeners } = harness({ schedule });
  await fire(listeners, 'subagent/start', { id: 'orphan' });
  await fire(listeners, 'subagent/end', { id: 'orphan' });
  assert.equal(schedule.created.length, 0);
  assert.equal(schedule.deleted.length, 0);
});

test('gates and tracks even when the reminder service is absent', async () => {
  const { listeners } = harness({ definitions: { subagent: CONTINUABLE_TOOL }, parents: { 'child-1': 'root-1' } });
  await fire(listeners, 'subagent/start', { id: 'child-1' });
  await fire(listeners, 'subagent/end', { id: 'child-1' });
  const decision = await fire(listeners, 'tools/pre-execute', delegation('subagent', false), ALLOW);
  assert.equal(decision.kind, 'deny');
});

// ---------------------------------------------------------------------------
// Per-delegation constraint profiles.
//
// A seat's authority is declared in the delegating instruction itself, as a
// prefix marker, and enforced per call. The default is read-only: an
// unmarked instruction grants no write authority at all.
// ---------------------------------------------------------------------------

/**
 * A live seat whose session carries the instruction the delegator wrote.
 *
 * Mirrors the durable event shape the host records: the instruction is a
 * `user/message` whose source is the user, and the runtime's own user-role
 * notices that follow it are `agent-instructions` / `plugin`.
 */
function seatAgent({ prompt, inheritedEvents = [], id = 'child-1', parentSession = 'root-1' } = {}) {
  const events = [...inheritedEvents];
  const inherited = events.length;
  if (prompt !== undefined) {
    events.push({
      type: 'user/message',
      data: { content: [{ type: 'text', text: prompt }], source: { kind: 'user' } },
    });
    events.push({
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '<system-reminder>runtime notice</system-reminder>' }],
        source: { kind: 'agent-instructions' },
      },
    });
  }
  return {
    session: {
      id,
      // The host marks a seat with `origin` and `delegationDepth`; a bare
      // `parentSession` also appears on forks, which are not seats.
      header: { parentSession, origin: 'subagent', delegationDepth: 1 },
      inheritedEventCount: inherited,
      snapshotEvents: (from = 0) => events.slice(from),
    },
  };
}

/** One call made by a seat. */
function seatCall(agent, toolName, args = {}) {
  return { name: toolName, arguments: args, agent };
}

/** The root session: a header with no delegating parent. */
function rootAgent() {
  return { session: { id: 'root-1', header: {}, inheritedEventCount: 0, snapshotEvents: () => [] } };
}

/**
 * A forked continuation: the host records the predecessor in `parentSession`
 * but the session is not a seat, so no profile may constrain it.
 */
function forkAgent() {
  return {
    session: {
      id: 'fork-1',
      header: { parentSession: 'root-1', delegationDepth: 0 },
      inheritedEventCount: 0,
      snapshotEvents: () => [
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: '[只读] inherited from the fork source' }], source: { kind: 'user' } },
        },
      ],
    },
  };
}

test('an unmarked instruction is read-only, so the default denies every write', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: 'audit the parser and report' });
  const write = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: 'a.js' }), ALLOW);
  assert.equal(write.kind, 'deny');
  const read = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'read', { file_path: 'a.js' }), ALLOW);
  assert.deepEqual(read, { kind: 'allow' });
});

test('the delegating root session is never constrained', async () => {
  const { listeners } = harness();
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    seatCall(rootAgent(), 'write', { file_path: 'a.js' }),
    ALLOW,
  );
  assert.deepEqual(decision, { kind: 'allow' });
});

test('the read-only profile allows reads, research, and reporting', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[只读] survey the codebase' });
  for (const toolName of ['read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search', 'skill']) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, toolName, {}), ALLOW);
    assert.deepEqual(decision, { kind: 'allow' }, toolName + ' must stay available to a read-only seat');
  }
  for (const toolName of ['send_message', 'structured_output', 'todo_write', 'list_agents']) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, toolName, {}), ALLOW);
    assert.deepEqual(decision, { kind: 'allow' }, toolName + ' is how the seat reports back');
  }
});

test('the read-only profile allows the agy mirror but not agy_ask', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[只读] survey the codebase' });
  // agy_tool only replays activity agy already recorded; denying it prevents no
  // side effect and stalls the seat in a retry loop.
  const mirror = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'agy_tool', { run: 'r', step: 1 }), ALLOW);
  assert.deepEqual(mirror, { kind: 'allow' });
  // agy_ask spawns a fresh agy process, which can write files.
  const ask = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'agy_ask', { prompt: 'hi' }), ALLOW);
  assert.equal(ask.kind, 'deny');
});

test('the read-only profile denies commands and file writes', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[只读] survey the codebase' });
  for (const [toolName, args] of [
    ['bash', { command: 'ls' }],
    ['pwsh', { command: 'ls' }],
    ['edit', { file_path: 'a.js' }],
    ['str_replace_editor', { path: 'a.js' }],
  ]) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, toolName, args), ALLOW);
    assert.equal(decision.kind, 'deny', toolName + ' must be refused');
    assert.match(decision.reason, /只读/);
  }
});

test('the read-only profile denies a tool it does not know', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[只读] survey the codebase' });
  const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'mcp__openviking__write', {}), ALLOW);
  assert.equal(decision.kind, 'deny');
});

test('the review profile allows a dry-run command', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[审核] check the diff' });
  for (const command of ['git status', 'git diff --stat', 'git log --oneline -5', 'ls -la', 'terraform plan', 'kubectl get pods']) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'bash', { command }), ALLOW);
    assert.deepEqual(decision, { kind: 'allow' }, command + ' is a read-only command');
  }
});

test('the review profile denies a command that changes anything', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[审核] check the diff' });
  for (const command of ['git commit -m x', 'git push', 'npm publish', 'rm -rf build', 'git add .']) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'bash', { command }), ALLOW);
    assert.equal(decision.kind, 'deny', command + ' must be refused');
  }
});

test('the review profile denies a whitelisted command chained to a mutating one', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[审核] check the diff' });
  for (const command of ['git status && rm -rf build', 'git log | sh', 'git diff > out.txt', 'ls; rm -rf build', 'echo $(rm -rf build)']) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'bash', { command }), ALLOW);
    assert.equal(decision.kind, 'deny', command + ' smuggles a second command');
  }
});

test('the review profile still denies file writes', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[审核] check the diff' });
  const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: 'a.js' }), ALLOW);
  assert.equal(decision.kind, 'deny');
});

test('the edit profile allows a write to an authorized path only', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[编辑: src/a.js, src/b.js] fix the two bugs' });
  for (const path of ['src/a.js', 'src/b.js', './src/a.js', '/repo/src/a.js']) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: path }), ALLOW);
    assert.deepEqual(decision, { kind: 'allow' }, path + ' is authorized');
  }
  for (const path of ['src/c.js', 'src/a.js.bak', 'package.json']) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: path }), ALLOW);
    assert.equal(decision.kind, 'deny', path + ' is outside the authorized set');
  }
});

test('the edit profile scopes the editor tool by its own path argument', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[编辑: src/a.js] fix the bug' });
  const inside = await fire(
    listeners,
    'tools/pre-execute',
    seatCall(agent, 'str_replace_editor', { path: 'src/a.js', command: 'str_replace' }),
    ALLOW,
  );
  assert.deepEqual(inside, { kind: 'allow' });
  const outside = await fire(
    listeners,
    'tools/pre-execute',
    seatCall(agent, 'str_replace_editor', { path: 'src/c.js', command: 'str_replace' }),
    ALLOW,
  );
  assert.equal(outside.kind, 'deny');
});

test('the edit profile does not grant commands', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[编辑: src/a.js] fix the bug' });
  const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'bash', { command: 'git status' }), ALLOW);
  assert.equal(decision.kind, 'deny');
});

test('a forked continuation is not a seat and keeps full authority', async () => {
  const { listeners } = harness();
  const agent = forkAgent();
  for (const [toolName, args] of [
    ['write', { file_path: 'src/anything.js' }],
    ['bash', { command: 'rm -rf build' }],
    ['edit', { file_path: 'src/anything.js' }],
  ]) {
    const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, toolName, args), ALLOW);
    assert.deepEqual(decision, { kind: 'allow' }, `a fork must not be governed: ${toolName}`);
  }
});

test('a forked seat reads its marker after the inherited history', async () => {
  const { listeners } = harness();
  const agent = seatAgent({
    prompt: '[只读] continue the audit',
    inheritedEvents: [
      { type: 'user/message', data: { content: [{ type: 'text', text: '[编辑: src/a.js] the parent instruction' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: {} },
    ],
  });
  const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: 'src/a.js' }), ALLOW);
  assert.equal(decision.kind, 'deny', 'the inherited parent instruction must not grant the fork write authority');
});

test('the English marker spellings are accepted', async () => {
  const { listeners } = harness();
  const edit = seatAgent({ id: 'child-edit', prompt: '[edit: src/a.js] fix it' });
  const allowed = await fire(listeners, 'tools/pre-execute', seatCall(edit, 'write', { file_path: 'src/a.js' }), ALLOW);
  assert.deepEqual(allowed, { kind: 'allow' });
  const review = seatAgent({ id: 'child-review', prompt: '[review] look at it' });
  const dryRun = await fire(listeners, 'tools/pre-execute', seatCall(review, 'bash', { command: 'git diff' }), ALLOW);
  assert.deepEqual(dryRun, { kind: 'allow' });
});

// ---------------------------------------------------------------------------
// The marker must OPEN the instruction.
//
// Scanning the whole instruction for a known marker let a read-only brief that
// merely MENTIONS one grant the authority it was quoted to forbid: the brief
// "never use [编辑: src/a.js]" escalated that seat to write authority. Anchoring
// the marker to the start makes a mention inert.
// ---------------------------------------------------------------------------

test('a marker that does not open the instruction is ignored', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: 'fix the bug in src/a.js\n[编辑: src/a.js]' });
  const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: 'src/a.js' }), ALLOW);
  assert.equal(decision.kind, 'deny', 'a trailing marker must not grant write authority');
});

test('a read-only brief that mentions a marker does not escalate', async () => {
  const { listeners } = harness();
  const quoted = seatAgent({ prompt: 'Never request [编辑: src/a.js]. Report findings only.' });
  const write = await fire(listeners, 'tools/pre-execute', seatCall(quoted, 'write', { file_path: 'src/a.js' }), ALLOW);
  assert.equal(write.kind, 'deny', 'quoting a marker must not grant the authority it forbids');
  const review = seatAgent({ prompt: 'Note that [审核] is not granted here. Report.' });
  const command = await fire(listeners, 'tools/pre-execute', seatCall(review, 'bash', { command: 'git status' }), ALLOW);
  assert.equal(command.kind, 'deny', 'mentioning the review marker must not grant dry-run commands');
});

test('leading whitespace before the marker is tolerated', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '\n\n  [编辑: src/a.js] fix it' });
  const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: 'src/a.js' }), ALLOW);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('an unrecognized bracket before the marker makes the marker inert', async () => {
  const { listeners } = harness();
  const agent = seatAgent({ prompt: '[重要] [编辑: src/a.js] fix it' });
  const decision = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'write', { file_path: 'src/a.js' }), ALLOW);
  assert.equal(decision.kind, 'deny', 'only the opening bracket is read, so an unknown one there is not a marker');
});

// ---------------------------------------------------------------------------
// The marker requirement is surfaced on the delegation tool itself.
//
// Root cannot follow a rule it never reads. Prose in AGENTS.md is advisory and
// was demonstrably missed; the tool description is in front of the model at the
// moment it decides to delegate.
// ---------------------------------------------------------------------------

/** Run one assembly waterfall, whose listener takes (assembly, context, next). */
async function fireAssembly(listeners, assembly, context, terminal) {
  const handlers = listeners.get('system-prompt/assemble');
  assert.ok(handlers, 'no listener registered for system-prompt/assemble');
  const dispatch = (index) =>
    index >= handlers.length ? terminal() : handlers[index](assembly, context, () => dispatch(index + 1));
  return dispatch(0);
}

test('the delegation tool description carries the marker requirement', async () => {
  const { listeners } = harness({ definitions: { subagent: CONTINUABLE_TOOL, bash: PLAIN_TOOL } });
  const assembly = {
    tools: [
      { name: 'subagent', description: 'Delegate a self-contained task.', parameters: {} },
      { name: 'bash', description: 'Run a command.', parameters: {} },
    ],
  };
  const assembled = await fireAssembly(listeners, assembly, { agent: undefined }, async () => assembly);
  const byName = new Map(assembled.tools.map((tool) => [tool.name, tool]));
  assert.match(byName.get('subagent').description, /\[只读\]/, 'the delegation tool must state the markers');
  assert.match(byName.get('subagent').description, /\[编辑: <paths>\]/);
  assert.match(byName.get('subagent').description, /read-only authority/, 'an unmarked prompt is read-only');
  assert.equal(byName.get('bash').description, 'Run a command.', 'a non-delegation tool is untouched');
});

test('repeated assemblies of the same tool set are byte-identical', async () => {
  const { listeners } = harness({ definitions: { subagent: CONTINUABLE_TOOL } });
  const source = () => ({ tools: [{ name: 'subagent', description: 'Delegate a task.', parameters: {} }] });
  const first = await fireAssembly(listeners, source(), { agent: undefined }, async () => source());
  const second = await fireAssembly(listeners, source(), { agent: undefined }, async () => source());
  assert.deepEqual(second, first, 'a stable description keeps the request header from churning every step');
  assert.equal(first.tools[0].description.split('MUST begin').length - 1, 1, 'the requirement appears exactly once');
});
// ---------------------------------------------------------------------------
// Rule 5: the plain-speech mandate at the turn boundary.
//
// The rules governing how an answer is *delivered* lived only in a skill file,
// which the model may never open and which nothing puts in front of it at the
// moment it answers. A registered tool does not fix that: a tool is fetched by
// the model on its own initiative, so it cannot cover "the turn is ending".
//
// `agent/turn-stopping` is the seam that does. The host dispatches it when the
// turn is about to close and the model owes a response, and it is awaited
// before the boundary commits, so a listener that steers sends the model back
// for one more step with the mandate in hand.
// ---------------------------------------------------------------------------

/** One root agent whose turn is stopping. */
function stoppingTurn(agent = rootAgent(), turn = 1) {
  return { agent, turn, signal: { aborted: false } };
}

/** The text this plugin steered into one agent, in order. */
function steered(agent) {
  return (agent.steers ?? []).map((message) => message.content.map((block) => block.text).join(''));
}
/** An agent stub that records what a listener steers into it. */
function steerableAgent(base = rootAgent()) {
  return { ...base, steers: [], steer(message) { this.steers.push(message); } };
}

test('steers the mandate when a root turn is about to deliver an answer', async () => {
  const { listeners } = harness();
  const agent = steerableAgent();
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent));
  const [text] = steered(agent);
  assert.ok(text, 'the turn boundary must carry the mandate');
  assert.match(text, /premise|前提/i, 'restore the missing premise');
  assert.match(text, /plain Chinese|说人话|大白话/i, 'the answer must be plain speech');
  assert.match(text, /CONTEXT\.md/, 'the project vocabulary is named');
  assert.match(text, /broaden|扩大/i, 're-explaining must not widen scope');
});

test('leaves a seat turn alone: the mandate is for answers to the user', async () => {
  const { listeners } = harness();
  const agent = steerableAgent(seatAgent({ prompt: '[只读] survey the codebase' }));
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent));
  assert.deepEqual(steered(agent), [], 'a seat reports to its delegator, not to the user');
});

test('leaves a forked continuation alone: it is not a root session either', async () => {
  const { listeners } = harness();
  const agent = steerableAgent(forkAgent());
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent));
  assert.deepEqual(steered(agent), []);
});

test('steers at most once per turn, so the extra step cannot re-arm it', async () => {
  const { listeners } = harness();
  const agent = steerableAgent();
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent, 1));
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent, 1));
  assert.equal(steered(agent).length, 1, 'a second stop in the same turn must not steer again');
});

test('a later turn gets its own reminder', async () => {
  const { listeners } = harness();
  const agent = steerableAgent();
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent, 1));
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent, 2));
  assert.equal(steered(agent).length, 2, 'each turn delivers its own answer');
});

test('two sessions do not share the once-per-turn guard', async () => {
  const { listeners } = harness();
  const first = steerableAgent();
  const second = steerableAgent({ session: { id: 'root-2', header: {} } });
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(first, 1));
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(second, 1));
  assert.equal(steered(first).length, 1);
  assert.equal(steered(second).length, 1, 'the guard is per session, not global');
});

test('the steered message is a user message the host can accept', async () => {
  const { listeners } = harness();
  const agent = steerableAgent();
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent));
  const [message] = agent.steers;
  assert.equal(message.role, 'user', 'steering accepts a user message');
  assert.ok(Array.isArray(message.content), 'content is block-shaped');
  assert.equal(message.content[0].type, 'text');
  assert.ok(message.source, 'the message carries its producer');
});

test('the steered message is attributed as a notice, not as a human turn', async () => {
  const { listeners } = harness();
  const agent = steerableAgent();
  await fire(listeners, 'agent/turn-stopping', stoppingTurn(agent));
  const [message] = agent.steers;
  assert.equal(
    message.source.form,
    'notice',
    'without `form: notice` the nudge renders as a prompt the user never wrote',
  );
  assert.ok(message.source.summary, 'a notice must carry its one-line account');
  assert.match(message.source.kind, /^plugin:/, 'producers name themselves as a plugin');
});

test('does not attach the mandate to an unrelated root tool call', async () => {
  const { listeners } = harness();
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    { name: 'bash', arguments: { command: 'ls' }, agent: rootAgent() },
    ALLOW,
  );
  assert.deepEqual(decision, { kind: 'allow' }, 'only the turn boundary carries the mandate');
});

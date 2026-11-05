/**
 * Acceptance contract for the rule guard.
 *
 * The plugin turns the delegation rules into deterministic mechanisms: a seat is
 * never one-shot, a delegating session does not spin, silence has an upper
 * bound, a seat gets only the authority its instruction declares, and a
 * delegation names the child route it runs on. Every case below pins one half of
 * one rule against the seams the host actually exposes: the tool registry (what
 * a delegation tool is), the live agent registry (whose child a seat is), the
 * LLM runtime (what a route can do), and the reminder service (the wait bound).
 *
 * How an answer is written is deliberately not pinned here: it is prose in the
 * operating instructions, not a mechanism this plugin delivers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name } from '../src/index.js';

/**
 * A dsh 0.2.0 delegation tool: its output schema declares the `continuable`
 * outcome next to a one-shot `background` one, and it takes the switch that
 * selects between them.
 */
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
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      description: { type: 'string' },
      run_in_background: { type: 'boolean' },
    },
  },
};

/**
 * A dsh 0.2.1 delegation tool: every call starts an independently managed
 * subagent, so the outcome is `activation` and there is no switch to select.
 */
const ACTIVATION_TOOL = {
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'activation' },
        subagentId: { type: 'string', required: true },
      },
    },
  },
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      description: { type: 'string' },
    },
  },
};

/**
 * A model-selectable delegation tool.
 *
 * On top of the continuable outcome it advertises the child-route fields, which
 * is what makes the route gate apply to it: a delegation that can pick a model
 * must say which one it picked.
 */
const ROUTE_TOOL = {
  ...ACTIVATION_TOOL,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      description: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      reasoning_effort: { type: 'string' },
    },
  },
};

/** A delegation tool whose route advertises no reasoning effort to name. */
const ROUTE_ONLY_TOOL = {
  ...ACTIVATION_TOOL,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
    },
  },
};

/** A tool whose output merely carries a seat constant outside `properties.kind`. */
const CONST_COLLISION_TOOL = {
  output: {
    schema: {
      type: 'object',
      properties: { state: { type: 'string', const: 'activation' }, jobId: { type: 'string' } },
    },
  },
  parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
};

/** A tool with a seat-shaped outcome but no instruction to give the child. */
const SEAT_KIND_WITHOUT_PROMPT = {
  output: {
    schema: {
      type: 'object',
      properties: { kind: { type: 'string', const: 'activation' }, subagentId: { type: 'string' } },
    },
  },
  parameters: { type: 'object', properties: { description: { type: 'string' } } },
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

/** A projection registry stub exposing the host's `todos` unit and nothing else. */
function fakeProjections(todos) {
  return { stateOf: (_session, key) => (key === 'todos' ? todos : undefined) };
}

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
 *
 * `agentScoped` names tools the host registers into an agent's OWN layer rather
 * than the global one, so they resolve only when a scope is passed to
 * `tools.get`. That is the arrangement a preset-composed host actually uses for
 * the delegation tools, and it is what makes the difference between querying the
 * registry with a scope and querying it without one observable here.
 */
function harness({ definitions = {}, parents = {}, schedule, llm, agentScoped = [], projections } = {}) {
  const listeners = new Map();
  const contexts = [];
  const globals = [];
  HARNESS_APPENDED.length = 0;
  HARNESS_REGISTERED.length = 0;
  const hiddenGlobally = new Set(agentScoped);
  const agents = new Map(
    Object.entries(parents).map(([id, parentSession]) => [
      id,
      { session: { header: { parentSession } } },
    ]),
  );
  const ctx = {
    tools: {
      get: (toolName, scope) => {
        if (scope === undefined && hiddenGlobally.has(toolName)) return undefined;
        return definitions[toolName];
      },
      // The host returns the disposer that unregisters the tool; the plugin
      // does not need it, because `register` already ties the tool to the
      // plugin's fiber.
      register: (definition) => {
        globals.push(definition);
        return () => {};
      },
    },
    agents: { get: (id) => agents.get(id) },
    // The host's prompt registry: the plugin registers runtime contexts here,
    // and the stub records each one so a test can render it directly. Orders
    // are recorded by name, because the numeric value belongs to the host.
    systemPrompt: {
      getContextOrder: (contextName) => contextName,
      getSectionOrder: (sectionName) => sectionName,
      context: (definition) => {
        contexts.push(definition);
        return () => {};
      },
      section: (definition) => {
        contexts.push(definition);
        return () => {};
      },
    },
    get: (service) => {
      if (service === 'schedule') return schedule;
      if (service === 'llm') return llm;
      if (service === 'sessionProjections') return projections;
      if (service === 'systemPrompt') return ctx.systemPrompt;
      return undefined;
    },
    on: (event, handler) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
  };
  apply(ctx);
  /**
   * Run the `agent/created` listeners for one agent, which is what registers the
   * agent-scoped todo tool. Tests that need the replacement call this; tests
   * about the gate and the meter do not, because those paths never touch it.
   */
  const createAgent = async (agent) => {
    for (const handler of listeners.get('agent/created') ?? []) await handler({ agent });
    return agent;
  };
  return {
    listeners,
    registered: HARNESS_REGISTERED,
    contexts,
    appended: HARNESS_APPENDED,
    createAgent,
  };
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
  if (args.length === 1 && typeof args[0] === 'function') return args[0]();
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

/**
 * Fire a plain notification that carries more than one argument.
 *
 * `tools/result` publishes `(exec, result)` with no continuation, which the
 * waterfall-shaped `fire` above cannot express.
 */
async function fireNotification(listeners, event, ...payload) {
  const handlers = listeners.get(event);
  assert.ok(handlers, `no listener registered for ${event}`);
  let last;
  for (const handler of handlers) last = await handler(...payload);
  return last;
}

/** The downstream decision a waterfall listener forwards to. */
const ALLOW = async () => ({ kind: 'allow' });

/** One delegation call carrying an explicit scheduling choice. */
function delegation(name, runInBackground, agent = {}) {
  return { name, arguments: { prompt: 'x', description: 'y', run_in_background: runInBackground }, agent };
}

test('the row id matches the patch row this plugin ships', () => {
  assert.equal(name, 'force-rules');
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

test('does not gate a delegation tool that has no one-shot switch', async () => {
  // dsh 0.2.1 removed `run_in_background` and the one-shot path with it, so a
  // call carrying that argument is a model repeating an old parameter, not a
  // request for a path the host still has. Denying it would blame the model for
  // a rule this generation already satisfies by construction.
  const { listeners } = harness({ definitions: { subagent: ACTIVATION_TOOL } });
  const decision = await fire(listeners, 'tools/pre-execute', delegation('subagent', false), ALLOW);
  assert.deepEqual(decision, { kind: 'allow' });
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
/** Session appends observed by {@link rootAgent}, cleared at each harness build. */
const HARNESS_APPENDED = [];

/** Agent-scoped tool registrations made through {@link rootAgent}'s own context. */
const HARNESS_REGISTERED = [];

function rootAgent() {
  return {
    ctx: {
      tools: {
        register: (definition) => {
          HARNESS_REGISTERED.push(definition);
          return () => {};
        },
      },
    },
    session: {
      id: 'root-1',
      header: {},
      inheritedEventCount: 0,
      snapshotEvents: () => [],
      append: (type, data) => {
        HARNESS_APPENDED.push({ type, data });
      },
    },
  };
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
// The delegation route gate.
//
// A delegation that can select a child model must say which one it selected: an
// unnamed route silently inherits whatever the host or the parent session
// defaults to, so the seat does not run on the model the delegator meant, and
// nothing surfaces that until its output is read.
//
// `provider` and `model` are one unit — either half alone identifies no route.
// `reasoning_effort` is required only for a route that advertises efforts: the
// host rejects any effort on a model that has none, so a blanket requirement
// there would be a denial no value could satisfy — a retry loop, not a gate.
// ---------------------------------------------------------------------------

/** An LLM runtime stub answering the one capability question the gate asks. */
function fakeLlm(routes) {
  return {
    resolveModelInfo: async (provider, model) => {
      const info = routes[`${provider}/${model}`];
      if (info === undefined) throw new Error(`LLM provider "${provider}" is not registered`);
      return info;
    },
  };
}

/** One exact route whose model advertises reasoning efforts. */
const EFFORT_ROUTES = {
  'cpa/gemini-3.8-flash-high': {
    provider: 'cpa',
    id: 'gemini-3.8-flash-high',
    name: 'gemini-3.8-flash-high',
    reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' },
  },
};

/** One exact route whose model advertises no reasoning at all. */
const PLAIN_ROUTES = {
  'cpa/plain-model': { provider: 'cpa', id: 'plain-model', name: 'plain-model' },
};

/** One delegation call that names a child route. */
function routeDelegation(args, agent = rootAgent(), toolName = 'subagent') {
  return { name: toolName, arguments: { prompt: 'x', description: 'y', ...args }, agent };
}

test('allows a delegation that names no route, which inherits the parent route', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(EFFORT_ROUTES) });
  const decision = await fire(listeners, 'tools/pre-execute', routeDelegation({}), ALLOW);
  // Measured on dsh 0.2.1-rc.2: an unnamed route is not a defect. The host's
  // `requestedAgentOptions` returns the configured options unchanged when the
  // call names no route field, and with no tool-instance defaults configured the
  // child inherits the parent's provider and model. One live delegation without
  // either field ran on `cpa/deepseek-flash`, the parent's own route.
  assert.deepEqual(decision, { kind: 'allow' }, 'omitting the route inherits the parent, which is a choice');
});

test('refuses a route with only half of it named', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(EFFORT_ROUTES) });
  for (const half of [{ provider: 'cpa' }, { model: 'gemini-3.8-flash-high' }]) {
    const decision = await fire(listeners, 'tools/pre-execute', routeDelegation(half), ALLOW);
    assert.equal(decision.kind, 'deny', `${JSON.stringify(half)} identifies no route on its own`);
  }
});

test('refuses a route field that carries only whitespace, which leaves half a route', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(EFFORT_ROUTES) });
  const decision = await fire(listeners, 'tools/pre-execute', routeDelegation({ provider: 'cpa', model: '   ' }), ALLOW);
  assert.equal(decision.kind, 'deny', 'a blank model leaves provider alone, which identifies no route');
  assert.match(decision.reason, /`model`/);
});

test('allows a blank effort, which the host inherits rather than requiring', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(EFFORT_ROUTES) });
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({ provider: 'cpa', model: 'gemini-3.8-flash-high', reasoning_effort: ' ' }),
    ALLOW,
  );
  assert.deepEqual(decision, { kind: 'allow' }, 'the host inherits the parent effort on an unchanged route');
});

test('allows a route that omits the effort its model advertises', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(EFFORT_ROUTES) });
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({ provider: 'cpa', model: 'gemini-3.8-flash-high' }),
    ALLOW,
  );
  // Requiring the effort forced a route to be named in every call; that is the
  // cost this gate no longer pays. The host resolves the route's own default.
  assert.deepEqual(decision, { kind: 'allow' });
});

test('allows a route that names provider, model, and effort', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(EFFORT_ROUTES) });
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({ provider: 'cpa', model: 'gemini-3.8-flash-high', reasoning_effort: 'high' }),
    ALLOW,
  );
  assert.deepEqual(decision, { kind: 'allow' });
});

test('allows a route whose model advertises no effort to name', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(PLAIN_ROUTES) });
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({ provider: 'cpa', model: 'plain-model' }),
    ALLOW,
  );
  assert.deepEqual(decision, { kind: 'allow' }, 'demanding an effort here would deny every possible value');
});

test('leaves a route this runtime cannot resolve to the host preflight', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm({}) });
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({ provider: 'ghost', model: 'nope' }),
    ALLOW,
  );
  assert.deepEqual(decision, { kind: 'allow' }, 'the host owns the route diagnosis; the gate adds no second one');
});

test('a read-only seat delegates to a read-only seat, including an unmarked prompt', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL }, llm: fakeLlm(EFFORT_ROUTES) });
  for (const prompt of ['survey the tests', '[只读] survey the tests', '[readonly] survey the tests']) {
    const agent = seatAgent({ prompt: '[只读] survey the codebase' });
    const decision = await fire(listeners, 'tools/pre-execute', routeDelegation({ prompt }, agent), ALLOW);
    assert.deepEqual(decision, { kind: 'allow' }, prompt);
  }
});

test('a read-only seat cannot delegate its way into commands or writes', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL } });
  for (const prompt of ['[审核] check the diff', '[review] check the diff', '[编辑: src/a.js] fix it', '[edit: src/a.js] fix it']) {
    const agent = seatAgent({ prompt: '[只读] survey the codebase', id: prompt });
    const decision = await fire(listeners, 'tools/pre-execute', routeDelegation({ prompt }, agent), ALLOW);
    assert.equal(decision.kind, 'deny', prompt);
    assert.match(decision.reason, /exceeds the parent/);
    assert.match(decision.reason, /different non-read-only profile/);
  }
});

test('a review seat delegates to a review or read-only seat, but not to an edit seat', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL } });
  for (const [prompt, allowed] of [
    ['[审核] check the diff', true],
    ['[只读] read the diff', true],
    ['[编辑: src/a.js] fix it', false],
  ]) {
    const agent = seatAgent({ prompt: '[审核] check the codebase', id: prompt });
    const decision = await fire(listeners, 'tools/pre-execute', routeDelegation({ prompt }, agent), ALLOW);
    assert.equal(decision.kind, allowed ? 'allow' : 'deny', prompt);
  }
});

test('an edit seat delegates only within its own authorized paths', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL } });
  for (const [prompt, allowed] of [
    ['[编辑: src/a.js] fix it', true],
    ['[编辑: ./src/a.js] fix it', true],
    ['[只读] read it', true],
    ['[审核] check it', false],
    ['[编辑: src/b.js] fix it', false],
    ['[编辑: src/a.js, src/b.js] fix both', false],
  ]) {
    const agent = seatAgent({ prompt: '[编辑: src/a.js] fix it', id: prompt });
    const decision = await fire(listeners, 'tools/pre-execute', routeDelegation({ prompt }, agent), ALLOW);
    assert.equal(decision.kind, allowed ? 'allow' : 'deny', prompt);
  }
});

test('a seat delegates through subagent_fork with the same authority limit', async () => {
  const { listeners } = harness({ definitions: { subagent_fork: ACTIVATION_TOOL } });
  const agent = seatAgent({ prompt: '[只读] survey the codebase' });
  const allowed = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({ prompt: '[只读] survey the tests' }, agent, 'subagent_fork'),
    ALLOW,
  );
  assert.deepEqual(allowed, { kind: 'allow' });
  const denied = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({ prompt: '[编辑: src/a.js] fix it' }, agent, 'subagent_fork'),
    ALLOW,
  );
  assert.equal(denied.kind, 'deny');
});

test('a tool that merely carries a seat constant is still refused by the allow-list', async () => {
  for (const [toolName, definition] of [
    ['const_collision', CONST_COLLISION_TOOL],
    ['seat_kind_without_prompt', SEAT_KIND_WITHOUT_PROMPT],
  ]) {
    const { listeners } = harness({ definitions: { [toolName]: definition } });
    for (const prompt of ['[只读] survey the codebase', '[审核] check the diff', '[编辑: src/a.js] fix it']) {
      const agent = seatAgent({ prompt, id: prompt });
      const decision = await fire(
        listeners,
        'tools/pre-execute',
        seatCall(agent, toolName, { prompt: 'survey the tests' }),
        ALLOW,
      );
      assert.equal(decision.kind, 'deny', `${toolName} / ${prompt} must not bypass the allow-list`);
      assert.match(decision.reason, /not among the tools it may use/);
    }
  }
});

test('workflow stays unavailable to a seat, and the root delegation is unchanged', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL, workflow: PLAIN_TOOL } });
  const agent = seatAgent({ prompt: '[只读] survey the codebase' });
  const workflow = await fire(listeners, 'tools/pre-execute', seatCall(agent, 'workflow', { script: 'return 1' }), ALLOW);
  assert.equal(workflow.kind, 'deny');
  const root = await fire(listeners, 'tools/pre-execute', routeDelegation({}, rootAgent()), ALLOW);
  assert.deepEqual(root, { kind: 'allow' });
});

test('does not gate a delegation tool that advertises no route fields', async () => {
  const { listeners } = harness({ definitions: { subagent_fork: CONTINUABLE_TOOL } });
  const decision = await fire(listeners, 'tools/pre-execute', routeDelegation({}, rootAgent(), 'subagent_fork'), ALLOW);
  assert.deepEqual(decision, { kind: 'allow' }, 'with no route to name, there is nothing to require');
});

test('does not gate a route-discovering tool that is not a delegation', async () => {
  const { listeners } = harness({
    definitions: { list_subagent_models: { ...PLAIN_TOOL, parameters: ROUTE_TOOL.parameters } },
  });
  const decision = await fire(
    listeners,
    'tools/pre-execute',
    routeDelegation({}, rootAgent(), 'list_subagent_models'),
    ALLOW,
  );
  assert.deepEqual(decision, { kind: 'allow' }, 'discovery must stay callable without naming a route');
});

test('the delegation tool description carries the marker requirement but no route demand', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL, bash: PLAIN_TOOL } });
  const assembly = {
    tools: [
      { name: 'subagent', description: 'Delegate a self-contained task.', parameters: {} },
      { name: 'bash', description: 'Run a command.', parameters: {} },
    ],
  };
  const assembled = await fireAssembly(listeners, assembly, { agent: undefined }, async () => assembly);
  const byName = new Map(assembled.tools.map((tool) => [tool.name, tool]));
  const description = byName.get('subagent').description;
  assert.match(description, /\[只读\]/, 'the marker is still stated where the call is written');
  // The route demand was removed after measurement: it blocked 25 delegations
  // and pushed the model at a discovery output that reads like a model line.
  assert.doesNotMatch(description, /MUST name the child route/, 'the route demand is gone');
  assert.doesNotMatch(description, /list_subagent_models/, 'and so is the discovery prompt it pushed');
  assert.equal(byName.get('bash').description, 'Run a command.', 'a non-delegation tool is untouched');
});

test('the marker requirement lands exactly once across repeated assemblies', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL } });
  const source = () => ({ tools: [{ name: 'subagent', description: 'Delegate a task.', parameters: {} }] });
  const first = await fireAssembly(listeners, source(), { agent: undefined }, async () => source());
  const second = await fireAssembly(listeners, source(), { agent: undefined }, async () => source());
  assert.deepEqual(second, first, 'a stable description keeps the request header from churning every step');
  assert.equal(first.tools[0].description.split('authority marker').length - 1, 1);
});

// ---------------------------------------------------------------------------
// The annotation must resolve the tool in the ASSEMBLY's scope, not the global
// view.
//
// Observed on a real dsh 0.2.1-rc.2 deployment: every delegation tool was
// registered into the agent's own layer (the preset composition installs them
// per agent), so the global view held none of them. The listener read
// `exec.agent` off an assembly entry — a detached `{name, description,
// parameters}` record that carries no agent — fell through to the global view,
// found nothing, and appended nothing. The requirement was therefore absent from
// the request that delegated a real seat, and that seat was silently granted
// read-only authority its instruction never declared.
// ---------------------------------------------------------------------------

test('a delegation tool visible only in the assembly scope still gets the requirement', async () => {
  const { listeners } = harness({
    definitions: { subagent: ROUTE_TOOL },
    agentScoped: ['subagent'],
  });
  const scope = { id: 'agent-scope' };
  const assembly = { tools: [{ name: 'subagent', description: 'Delegate a task.', parameters: {} }] };
  const assembled = await fireAssembly(listeners, assembly, { agent: {}, scope }, async () => assembly);
  assert.match(assembled.tools[0].description, /\[只读\]/, 'the marker requirement reaches the request');
});

test('an assembly with no scope falls back to the calling agent rather than crashing', async () => {
  const { listeners } = harness({ definitions: { subagent: ROUTE_TOOL } });
  const assembly = { tools: [{ name: 'subagent', description: 'Delegate a task.', parameters: {} }] };
  const assembled = await fireAssembly(listeners, assembly, undefined, async () => assembly);
  assert.match(assembled.tools[0].description, /\[只读\]/, 'a scope-less assembly still annotates a globally registered tool');
});

// ---------------------------------------------------------------------------
// The decomposition requirement on `todo_write`.
//
// The rule "decompose before acting, and say who does each line" lives in
// AGENTS.md and in `delivery-discipline`, and was still skipped in practice: a
// 25-minute session never wrote a list, so it never had a line to hand to a
// seat, and the whole task ran single-threaded. The tool description is the one
// place in front of the model at the moment it decides to write the list.
// ---------------------------------------------------------------------------

test('the todo tool description carries the ownership requirement', async () => {
  const { listeners } = harness();
  const assembly = {
    tools: [
      { name: 'todo_write', description: 'Record and update a task list.', parameters: {} },
      { name: 'bash', description: 'Run a command.', parameters: {} },
    ],
  };
  const assembled = await fireAssembly(listeners, assembly, { agent: undefined }, async () => assembly);
  const byName = new Map(assembled.tools.map((tool) => [tool.name, tool]));
  assert.match(byName.get('todo_write').description, /\[root\]/, 'the owner is named where the list is written');
  assert.match(byName.get('todo_write').description, /\[seat: <label>\]/);
  assert.equal(byName.get('bash').description, 'Run a command.', 'an unrelated tool is untouched');
});

test('the todo requirement lands exactly once across repeated assemblies', async () => {
  const { listeners } = harness();
  const source = () => ({ tools: [{ name: 'todo_write', description: 'Record a list.', parameters: {} }] });
  const first = await fireAssembly(listeners, source(), { agent: undefined }, async () => source());
  const second = await fireAssembly(listeners, source(), { agent: undefined }, async () => source());
  assert.deepEqual(second, first, 'a stable description keeps the request header from churning');
  assert.equal(first.tools[0].description.split('[seat: <label>]').length - 1, 1);
});

// ---------------------------------------------------------------------------
// The cost meter.
//
// Observed on a real session: reasoning grew from ~220 characters per step to
// ~9000 while the same unresolved questions were re-derived, and the one input
// that ended it was a runtime line reporting elapsed time — the model settled in
// the very next step. Cost is that same lever for a different quantity. It is
// injected on an interval rather than every step because each reading is a
// durable message; per-step readings would grow the very history they measure.
// ---------------------------------------------------------------------------

/** One settled tool result whose only content is `text`. */
function settled(agent, text) {
  return [{ agent }, { isError: false, value: {}, content: [{ type: 'text', text }] }];
}

/** A pre-step payload for one step of one turn. */
function stepOf(agent, turn = 1) {
  return { agent, turn, step: 1, messages: [], signal: { aborted: false } };
}

/** The downstream decision a pre-step listener forwards to. */
const ENTER = async () => ({ kind: 'enter', messages: [] });

/** Fire one pre-step and return the reading it appended, or undefined. */
async function readingAfter(listeners, agent, turn = 1) {
  const decision = await fire(listeners, 'agent/pre-step', stepOf(agent, turn), ENTER);
  return decision.messages?.length > 0 ? decision.messages.at(-1).content[0].text : undefined;
}

test('a session that has spent nothing is told nothing', async () => {
  const { listeners } = harness();
  assert.equal(await readingAfter(listeners, rootAgent()), undefined);
});

test('the first spending of a turn produces a reading', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(4000)));
  assert.match(await readingAfter(listeners, agent), /Cost of this turn so far/);
});

test('a second reading inside the interval is withheld', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(4000)));
  assert.ok(await readingAfter(listeners, agent), 'the first reading is due');
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(4000)));
  assert.equal(await readingAfter(listeners, agent), undefined, 'the interval is what keeps the meter out of the history');
});

test('the reading names calls, volume, and the open todo count', async () => {
  const { listeners } = harness({
    projections: fakeProjections([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]),
  });
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  const text = await readingAfter(listeners, agent);
  assert.match(text, /1 tool call/, 'the call count is stated');
  assert.match(text, /5K characters returned/, 'the volume is stated in a unit the model can weigh');
  assert.match(text, /2 todos still open/, 'finished work is not counted as open');
});

test('a session with no todo projection omits the todo clause rather than inventing one', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  const text = await readingAfter(listeners, agent);
  assert.doesNotMatch(text, /todos still open/);
  assert.match(text, /1 tool call/);
});

test('an oversized single result is named in the reading', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(30_000)));
  assert.match(await readingAfter(listeners, agent), /largest single result 30K/);
});

test('the reading tells the model what to do with the number', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  assert.match(await readingAfter(listeners, agent), /decide now with what you already have/);
});

test('a rejected step is not given a reading', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  const rejected = await fire(listeners, 'agent/pre-step', stepOf(agent), async () => ({ kind: 'reject' }));
  assert.deepEqual(rejected, { kind: 'reject' });
});

test('a new turn starts its own meter', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  assert.ok(await readingAfter(listeners, agent, 1), 'turn one is metered');
  assert.equal(await readingAfter(listeners, agent, 2), undefined, 'the next turn has spent nothing yet');
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  assert.match(await readingAfter(listeners, agent, 2), /1 tool call/, 'and it counts from zero');
});

test('a disposed session stops being metered', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  await fire(listeners, 'agent/disposed', { agent });
  assert.equal(await readingAfter(listeners, agent), undefined, 'a dead session keeps no counters');
});

test('an oversized result tells the model what to do about it next time', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(30_000)));
  assert.match(await readingAfter(listeners, agent), /have a seat read it and return only the conclusion/);
});

test('a reading without an oversized result does not suggest a seat', async () => {
  const { listeners } = harness();
  const agent = rootAgent();
  await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(5000)));
  assert.doesNotMatch(await readingAfter(listeners, agent), /have a seat read it/);
});

// ---------------------------------------------------------------------------
// The delegation cue, in the runtime-context slot the host reserves for it.
//
// The host allocates `SUBAGENT_DELEGATION` (order 120) and re-assembles it every
// step, but its only contribution reports the depth ceiling -- it says when to
// stop delegating, never when to start. The rule that says when to start lives
// in AGENTS.md, which is injected once per turn and diluted long before the
// decision; measured over 341 sessions, 264 never wrote a todo at all, so a
// requirement placed on the todo tool cannot reach them. This slot is the one
// place that is both step-visible and independent of any tool call.
// ---------------------------------------------------------------------------

test('the delegation cue registers into the host\'s own delegation slot', () => {
  const { contexts } = harness();
  const cue = contexts.find((entry) => entry.name === 'force-rules:delegation-cue');
  assert.ok(cue, 'the cue is registered');
  assert.equal(cue.order, 'SUBAGENT_DELEGATION', 'it shares the host\'s reserved placement');
});

test('the cue states the criterion rather than restating a preference', () => {
  const { contexts } = harness();
  const cue = contexts.find((entry) => entry.name === 'force-rules:delegation-cue');
  const text = cue.text({ agent: rootAgent(), scope: undefined });
  assert.match(text, /three independent sources/i, 'the countable test is stated');
  assert.match(text, /only a conclusion/i, 'the shape of the deliverable is stated');
});

test('the cue names the todo line still owned by root once it has cost something', async () => {
  const { listeners, contexts, registered, createAgent, appended } = harness({
    projections: {
      stateOf: (_session, key) =>
        key !== 'todos'
          ? undefined
          : (appended.filter((event) => event.type === 'todo/write').at(-1)?.data.todos ?? null),
    },
  });
  const agent = rootAgent();
  await createAgent(agent);
  const todo = registered.find((tool) => tool.name === 'todo_write');
  await todo.execute(
    {
      todos: [
        { content: 'survey the build setup', status: 'in_progress', owner: 'root' },
        { content: 'write the workflow', status: 'in_progress', owner: 'seat' },
      ],
    },
    { agent },
  );
  for (let i = 0; i < 12; i++) {
    await fireNotification(listeners, 'tools/result', ...settled(agent, 'x'.repeat(1000)));
  }
  // The cue reads the host projection, which folds the `todo/write` this tool
  // just appended; the harness supplies that fold from the same events.
  const written = appended.find((event) => event.type === 'todo/write');
  const cue = contexts.find((entry) => entry.name === 'force-rules:delegation-cue');
  const text = cue.text({ agent, scope: undefined });
  assert.ok(written, 'the list reached the host');
  assert.match(text, /survey the build setup/, 'the specific line is named');
  assert.doesNotMatch(text, /write the workflow/, 'a line already delegated is not named');
});

test('a session that has not spent anything is given the criterion but not an accusation', async () => {
  const { contexts } = harness({
    projections: fakeProjections([{ content: '[root] survey the build setup', status: 'pending' }]),
  });
  const text = contexts.find((entry) => entry.name === 'force-rules:delegation-cue').text({ agent: rootAgent(), scope: undefined });
  assert.match(text, /three independent sources/i);
  assert.doesNotMatch(text, /survey the build setup/, 'nothing has been spent, so nothing is named');
});

test('a session with no list at all still gets the criterion', () => {
  const { contexts } = harness();
  const text = contexts.find((entry) => entry.name === 'force-rules:delegation-cue').text({ agent: rootAgent(), scope: undefined });
  assert.match(text, /three independent sources/i, 'the 264 sessions that never write a list are exactly who this is for');
});

test('the root decomposition cue stays silent for a child session', () => {
  const { contexts } = harness({ parents: { 'seat-1': 'root-1' } });
  const text = contexts.find((entry) => entry.name === 'force-rules:delegation-cue').text({
    agent: { session: { id: 'seat-1', header: { parentSession: 'root-1' } } },
    scope: undefined,
  });
  assert.equal(text, '');
});

// ---------------------------------------------------------------------------
// Ownership as a schema field rather than a string prefix.
//
// The prefix convention was adopted in form but never in substance: measured
// across 341 sessions, zero wrote `[seat: ...]`, because a prefix inside a free
// text field is a thing to remember while a declared field is a thing to fill.
// The host's todo schema is closed (`additionalProperties: false`), so the only
// way to add a field is to register the tool again in the agent's own scope,
// which shadows the global one.
// ---------------------------------------------------------------------------

test('the todo tool is replaced with one that declares ownership', async () => {
  const { registered, createAgent } = harness();
  await createAgent(rootAgent());
  const todo = registered.find((tool) => tool.name === 'todo_write');
  assert.ok(todo, 'a todo tool is registered for the agent');
  const item = todo.parameters.properties.todos.items;
  assert.deepEqual(item.properties.owner.enum, ['root', 'seat'], 'ownership is a closed choice');
  assert.ok(item.required.includes('owner'), 'and it cannot be left out');
  assert.ok(item.required.includes('content'), 'the original fields survive');
});

test('the replacement writes the host todo snapshot and reports counts', async () => {
  const { registered, appended, createAgent } = harness();
  await createAgent(rootAgent());
  const todo = registered.find((tool) => tool.name === 'todo_write');
  const value = await todo.execute(
    {
      todos: [
        { content: 'survey', status: 'in_progress', owner: 'root' },
        { content: 'workflow', status: 'pending', owner: 'seat' },
      ],
    },
    { agent: rootAgent() },
  );
  assert.equal(appended.length, 1, 'the host projection is fed');
  assert.equal(appended[0].type, 'todo/write');
  assert.deepEqual(value.counts, { pending: 1, inProgress: 1, completed: 0 });
});

test('the snapshot the host stores drops the owner field', async () => {
  const { registered, appended, createAgent } = harness();
  await createAgent(rootAgent());
  const todo = registered.find((tool) => tool.name === 'todo_write');
  await todo.execute({ todos: [{ content: 'survey', status: 'pending', owner: 'root' }] }, { agent: rootAgent() });
  assert.deepEqual(appended[0].data.todos, [{ content: 'survey', status: 'pending' }], 'the host event keeps its own shape');
});

test('the owner survives where the cue can read it', async () => {
  const { registered, contexts, appended, createAgent } = harness();
  await createAgent(rootAgent());
  const todo = registered.find((tool) => tool.name === 'todo_write');
  await todo.execute({ todos: [{ content: 'survey', status: 'pending', owner: 'seat' }] }, { agent: rootAgent() });
  const text = contexts.find((entry) => entry.name === 'force-rules:delegation-cue').text({ agent: rootAgent(), scope: undefined });
  assert.doesNotMatch(text, /survey/, 'a line already owned by a seat is not named as root work');
  assert.ok(appended.length === 1);
});

test('an empty list is still rejected the way the host rejects it', async () => {
  const { registered, createAgent } = harness();
  await createAgent(rootAgent());
  const todo = registered.find((tool) => tool.name === 'todo_write');
  await assert.rejects(
    () => todo.execute({ todos: [{ content: '   ', status: 'pending', owner: 'root' }] }, { agent: rootAgent() }),
    /content/,
  );
});

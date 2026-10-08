/**
 * Acceptance contract for the startup pass itself.
 *
 * The pass is the only place the plugin touches live host state, so these
 * cases pin the three things that make an automatic resume safe: it does
 * nothing at all when the profile cannot support it, it refuses to act on
 * anything the human archived or that is not a real top-level session, and it
 * re-reads the goal from the live registry before arming it — the cached
 * selection is only ever a suggestion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { apply, inject, name } from '../src/index.js';

/** A listed header for an ordinary top-level session. */
function header(overrides = {}) {
  return { id: 'session-1', cwd: '/tmp/work', isSeeded: false, createdAt: 1, version: 4, ...overrides };
}

/** A cached `cachedSnapshot` block holding one active goal. */
function snapshot(goalOverrides = {}, roundsStarted = 0) {
  return {
    asOfSeq: 10,
    values: {
      goal: {
        goal: { id: 'goal-1', revision: 3, objective: 'ship it', phase: 'active', maxGoalRounds: 8, ...goalOverrides },
        roundsStarted,
        createdAt: 1,
        updatedAt: 2,
      },
    },
  };
}

/** A live `ctx.goals.get` view for the same goal. */
function liveGoal(overrides = {}) {
  return {
    id: 'goal-1',
    revision: 3,
    objective: 'ship it',
    phase: 'active',
    maxGoalRounds: 8,
    roundsStarted: 0,
    activation: 'disarmed',
    ...overrides,
  };
}

/**
 * Build a host stub exposing exactly the surface the pass touches.
 *
 * @param options - overrides for the pieces a case needs to steer.
 * @returns the context, recorded effects, and the resume call log.
 */
function harness(options = {}) {
  const {
    records = [header()],
    snapshots = { 'session-1': snapshot() },
    liveAgents = {},
    liveGoals = { 'session-1': liveGoal() },
  } = options;
  // `null` means the service is not mounted in this profile; an omitted key
  // means it is, with the default stub.
  const controller = 'controller' in options
    ? options.controller
    : { resolveAgent: async (id) => ({ agent: { id } }) };
  const registry = 'registry' in options ? options.registry : { archivedSessionIds: [] };

  const resumed = [];
  const logged = [];
  const disposers = [];

  const ctx = {
    logger: {
      info: (message) => logged.push(['info', message]),
      warn: (message) => logged.push(['warn', message]),
      error: (message) => logged.push(['error', message]),
    },
    effect: (execute) => {
      disposers.push(execute());
    },
    get: (service) => {
      // The host returns undefined — never null — for an unmounted service.
      if (service === 'sessionController') return controller ?? undefined;
      if (service === 'workspaceRegistry') return registry ?? undefined;
      return undefined;
    },
    sessionQuery: {
      // The host returns listing records; the pass reads their headers.
      listSessions: async () => records.map((h) => ({ header: h, live: false, persisted: true })),
    },
    sessionProjectionCache: {
      cachedSnapshot: (h) => snapshots[h.id],
    },
    agents: {
      get: (id) => liveAgents[id],
    },
    goals: {
      get: (agent) => liveGoals[agent.id],
      resume: (agent, ref) => {
        resumed.push({ sessionId: agent.id, ref });
      },
    },
  };

  return { ctx, resumed, logged, disposers };
}

/** Drive the pass to completion: fire the delayed timer, then drain microtasks. */
async function runPass(ctx) {
  mock.timers.tick(30_000);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
test.afterEach(() => mock.timers.reset());

test('the plugin row is named for its patch row and injects only base services', () => {
  assert.equal(name, 'goal-resume');
  assert.deepEqual(inject, ['agents', 'goals', 'sessionQuery', 'sessionProjectionCache']);
});

test('the pass waits 30s and does not fire early', async () => {
  const { ctx, resumed } = harness();
  apply(ctx);

  mock.timers.tick(29_999);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumed.length, 0);

  await runPass(ctx);
  assert.equal(resumed.length, 1);
});

test('an active goal in an ordinary session is resumed with its revision', async () => {
  const { ctx, resumed } = harness();
  apply(ctx);
  await runPass(ctx);

  assert.deepEqual(resumed, [{ sessionId: 'session-1', ref: { id: 'goal-1', revision: 3 } }]);
});

test('nothing happens in a profile without session control', async () => {
  const { ctx, resumed, logged } = harness({ controller: null });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
  assert.match(logged.at(-1)[1], /not mounted/);
});

test('nothing happens in a profile without the workspace registry', async () => {
  const { ctx, resumed, logged } = harness({ registry: null });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
  assert.match(logged.at(-1)[1], /not mounted/);
});

test('an unreadable archive set aborts the pass rather than guessing', async () => {
  const registry = {
    get archivedSessionIds() {
      throw new Error('workspace registry is not started yet');
    },
  };
  const { ctx, resumed } = harness({ registry });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('archived sessions are skipped', async () => {
  const { ctx, resumed } = harness({ registry: { archivedSessionIds: ['session-1'] } });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('subagent sessions are skipped', async () => {
  const { ctx, resumed } = harness({ records: [header({ origin: 'subagent' })] });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('a session without a working directory is skipped', async () => {
  const { ctx, resumed } = harness({ records: [header({ cwd: undefined })] });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('paused, blocked, and complete goals are left alone', async () => {
  for (const phase of ['paused', 'blocked', 'complete']) {
    const { ctx, resumed } = harness({ snapshots: { 'session-1': snapshot({ phase }) } });
    apply(ctx);
    await runPass(ctx);
    assert.equal(resumed.length, 0, `${phase} must not resume`);
  }
});

test('a goal whose rounds are spent is left alone', async () => {
  const { ctx, resumed } = harness({ snapshots: { 'session-1': snapshot({ maxGoalRounds: 3 }, 3) } });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('a session that is already live is left to its user', async () => {
  const { ctx, resumed } = harness({ liveAgents: { 'session-1': { id: 'session-1' } } });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('a session that cannot be reopened is skipped', async () => {
  const controller = {
    resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
  };
  const { ctx, resumed, logged } = harness({ controller });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
  assert.match(logged.at(-1)[1], /session\/not-found/);
});

test('a stale cache is overruled by the live goal', async () => {
  // The cache still says active, but the live registry has moved on.
  const { ctx, resumed } = harness({ liveGoals: { 'session-1': liveGoal({ phase: 'complete' }) } });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('an already armed goal is not resumed twice', async () => {
  const { ctx, resumed } = harness({ liveGoals: { 'session-1': liveGoal({ activation: 'armed' }) } });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('a live goal with a spent budget is not resumed', async () => {
  const { ctx, resumed } = harness({
    liveGoals: { 'session-1': liveGoal({ maxGoalRounds: 3, roundsStarted: 3 }) },
  });
  apply(ctx);
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

test('a live goal whose revision moved is resumed at the new revision', async () => {
  const { ctx, resumed } = harness({ liveGoals: { 'session-1': liveGoal({ revision: 9 }) } });
  apply(ctx);
  await runPass(ctx);

  assert.deepEqual(resumed, [{ sessionId: 'session-1', ref: { id: 'goal-1', revision: 9 } }]);
});

test('a fork and its parent resume only once', async () => {
  const { ctx, resumed } = harness({
    records: [header({ id: 'fork', isSeeded: true }), header({ id: 'parent', isSeeded: false })],
    snapshots: { fork: snapshot(), parent: snapshot() },
    liveGoals: { fork: liveGoal(), parent: liveGoal() },
  });
  apply(ctx);
  await runPass(ctx);

  assert.deepEqual(resumed, [{ sessionId: 'parent', ref: { id: 'goal-1', revision: 3 } }]);
});

test('one session failing never aborts the rest of the pass', async () => {
  const controller = {
    resolveAgent: async (id) => {
      if (id === 'bad') throw new Error('reopen exploded');
      return { agent: { id } };
    },
  };
  const { ctx, resumed } = harness({
    controller,
    records: [header({ id: 'bad' }), header({ id: 'good' })],
    snapshots: { bad: snapshot({ id: 'goal-bad' }), good: snapshot({ id: 'goal-good' }) },
    liveGoals: { bad: liveGoal({ id: 'goal-bad' }), good: liveGoal({ id: 'goal-good' }) },
  });
  apply(ctx);
  await runPass(ctx);

  assert.deepEqual(resumed, [{ sessionId: 'good', ref: { id: 'goal-good', revision: 3 } }]);
});

test('a resume rejected by the goal domain is logged, not thrown', async () => {
  const { ctx, resumed } = harness();
  ctx.goals.resume = () => {
    throw new Error('GOAL_STALE_REVISION');
  };
  apply(ctx);

  await runPass(ctx);
  assert.equal(resumed.length, 0);
});

test('teardown cancels a pending pass', async () => {
  const { ctx, disposers, resumed } = harness();
  apply(ctx);

  disposers.forEach((dispose) => dispose());
  await runPass(ctx);

  assert.equal(resumed.length, 0);
});

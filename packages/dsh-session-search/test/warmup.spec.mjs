/**
 * The index must be built at startup, not on the user's first query.
 *
 * The bug this guards, observed on a real machine: the host reconciles only
 * inside `searchSessions`/`searchEvents`, so with `openAt: first-search` the
 * first real query paid the whole cold build inside a tool call that is cut at
 * 30 s. The abort discarded the work, the index stayed at 0 documents across two
 * attempts, and it could never finish.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, warmUp } from '../lib/index.js'

/** A fake context that records subscriptions, like the host's. */
function fakeCtx(engine) {
  const listeners = []
  const injected = []
  return {
    listeners,
    injected,
    on: (event, fn) => { listeners.push({ event, fn }) },
    get: (name) => (name === 'sessionQuery' ? engine : undefined),
    inject: (deps, callback) => { injected.push({ deps, callback }) },
  }
}

test('warmUp issues exactly one search and reports success', async () => {
  const calls = []
  const engine = { searchSessions: async (request) => { calls.push(request); return { items: [] } } }
  assert.equal(await warmUp(engine), 'built')
  assert.equal(calls.length, 1, 'one call is enough: the reconcile runs before the query')
  assert.equal(calls[0].limit, 1, 'the page is kept small; the cost is the reconcile')
})

test('warmUp swallows failure so a broken index cannot break the host', async () => {
  const engine = { searchSessions: async () => { throw new Error('index is corrupt') } }
  assert.equal(await warmUp(engine), 'failed', 'a failure is reported, not thrown')
})

test('apply warms the index when the service is already mounted', async () => {
  const calls = []
  const engine = { searchSessions: async (r) => { calls.push(r); return { items: [] } } }
  apply(fakeCtx(engine))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, 'the build must start at mount, not at the first user query')
})

test('apply waits for a service that mounts later', async () => {
  const calls = []
  const engine = { searchSessions: async (r) => { calls.push(r); return { items: [] } } }
  const ctx = fakeCtx(undefined)
  apply(ctx)
  assert.equal(calls.length, 0, 'nothing to call yet')
  assert.equal(ctx.injected.length, 1, 'it must ask for the service rather than give up')
  assert.deepEqual(ctx.injected[0].deps, { sessionQuery: true })

  // Simulate the host running the callback once the service appears.
  ctx.injected[0].callback({ get: () => engine })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, 'the build starts as soon as the service exists')
})

test('a missing service and a missing inject leave the plugin usable', () => {
  // A bare context has neither; the annotation must still be subscribed.
  const listeners = []
  assert.doesNotThrow(() => apply({ on: (event, fn) => listeners.push({ event, fn }) }))
  assert.ok(listeners.some((l) => l.event === 'system-prompt/assemble'),
    'the annotation must survive an incomplete context')
})

test('apply still prepares the index file', async () => {
  const { existsSync, rmSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'warmup-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    apply(fakeCtx({ searchSessions: async () => ({ items: [] }) }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(existsSync(join(dir, 'session-search', 'index.db')),
      'the file must exist before the host opens it, or auto_vacuum cannot be set')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

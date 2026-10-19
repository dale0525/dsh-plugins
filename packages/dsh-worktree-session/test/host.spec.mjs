/**
 * Tests for the host half.
 *
 * Three contracts matter here, and each is checked against the thing that
 * actually enforces it rather than against a mock of it:
 *
 * - the git plumbing is exercised against throwaway repositories, because what
 *   matters is what git does;
 * - the durable markers are read back from a real `Session` log, because the
 *   whole point is that they survive a restart;
 * - the deferred creation runs through the real `agent/pre-step` listener with
 *   stand-ins only for the host services, because the interesting behaviour is
 *   which of them it reads and in what order.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'

import {
  apply,
  createWorktree,
  ensureGitignoreEntry,
  listWorktrees,
  markWaiting,
  name,
  parseWorktreeList,
  readWorktreeRecords,
  resolveRepoRoot,
  sanitizeName,
} from '../lib/index.js'

const execFileAsync = promisify(execFile)

/** Run git in a repository, ignoring output. */
async function git(cwd, args) {
  return execFileAsync('git', args, { cwd })
}

/** Create a repository with one commit and return its path. */
async function makeRepo(root, label) {
  const dir = join(root, label)
  await fs.mkdir(dir, { recursive: true })
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['config', 'user.email', 'test@example.invalid'])
  await git(dir, ['config', 'user.name', 'Test'])
  await fs.writeFile(join(dir, 'seed.txt'), 'seed\n', 'utf8')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'init'])
  return dir
}

describe('parseWorktreeList', () => {
  it('reads the main checkout and a linked worktree from porcelain output', () => {
    const stdout = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/fix-the-parser',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/fix-the-parser',
      '',
    ].join('\n')

    const entries = parseWorktreeList(stdout)

    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0], {
      path: '/repo',
      head: '1111111111111111111111111111111111111111',
      branch: 'main',
      detached: false,
      isMain: true,
      prunable: false,
      name: 'repo',
    })
    assert.equal(entries[1].path, '/repo/.worktrees/fix-the-parser')
    assert.equal(entries[1].branch, 'fix-the-parser')
    assert.equal(entries[1].isMain, false)
    assert.equal(entries[1].name, 'fix-the-parser')
  })

  it('marks a detached worktree and omits its branch', () => {
    const stdout = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      'detached',
      '',
    ].join('\n')

    const [entry] = parseWorktreeList(stdout)

    assert.equal(entry.detached, true)
    assert.equal(entry.branch, undefined)
  })

  it('marks a prunable worktree whose directory is gone', () => {
    const stdout = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/gone',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')

    const entries = parseWorktreeList(stdout)

    assert.equal(entries[1].prunable, true)
  })

  it('returns nothing for output with no worktree stanza', () => {
    assert.deepEqual(parseWorktreeList(''), [])
    assert.deepEqual(parseWorktreeList('\n\n'), [])
  })
})

describe('sanitizeName', () => {
  it('keeps a clean slug as it is', () => {
    assert.equal(sanitizeName('fix-the-parser'), 'fix-the-parser')
  })

  it('lowercases and collapses punctuation into single hyphens', () => {
    assert.equal(sanitizeName('Fix the Parser!!'), 'fix-the-parser')
    assert.equal(sanitizeName('  add   worktree\tpicker  '), 'add-worktree-picker')
  })

  it('keeps at most four words', () => {
    assert.equal(sanitizeName('one two three four five six'), 'one-two-three-four')
  })

  it('drops a model that answered in another script', () => {
    // Nothing survives, so the caller falls back to a generated name rather
    // than creating a branch whose name is a single hyphen.
    assert.equal(sanitizeName('修复解析器'), '')
    assert.equal(sanitizeName('!!!'), '')
  })

  it('never produces an empty segment or a leading/trailing hyphen', () => {
    const slug = sanitizeName('--a--b--')
    assert.equal(slug, 'a-b')
    assert.equal(/-{2}/.test(slug), false)
  })

  it('stays inside a length a branch name can carry', () => {
    assert.ok(sanitizeName('a'.repeat(200)).length <= 60)
  })
})

describe('git plumbing against real repositories', () => {
  let root

  before(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'dsh-worktree-'))
  })

  after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('lists only the main checkout before any worktree exists', async () => {
    const repo = await makeRepo(root, 'plain')
    const worktrees = await listWorktrees(repo)

    assert.equal(worktrees.length, 1)
    assert.equal(worktrees[0].isMain, true)
    assert.equal(worktrees[0].branch, 'main')
  })

  it('creates a worktree under the repository and ignores it', async () => {
    const repo = await makeRepo(root, 'create')

    const result = await createWorktree(repo)

    assert.equal(result.ok, true)
    const created = result.value
    assert.equal(created.repoRoot, await fs.realpath(repo))
    assert.equal(created.gitignoreAdded, true)
    assert.match(created.branch, /^wt-[0-9a-f]{6}$/)
    assert.equal(created.path, join(created.repoRoot, '.worktrees', created.branch))

    // The directory is a real checkout of the same commit.
    const stat = await fs.stat(created.path)
    assert.equal(stat.isDirectory(), true)

    const listed = await listWorktrees(created.path)
    assert.equal(listed.length, 2)
    assert.equal(listed[1].path, created.path)
    assert.equal(listed[1].branch, created.branch)

    // The ignore entry is what keeps the new directory out of `git status`.
    const gitignore = await fs.readFile(join(created.repoRoot, '.gitignore'), 'utf8')
    assert.equal(gitignore, '.worktrees/\n')
    const { stdout } = await git(created.repoRoot, ['status', '--porcelain'])
    assert.equal(stdout.includes('.worktrees/'), false)
  })

  it('creates the branch the caller named', async () => {
    const repo = await makeRepo(root, 'named')

    const result = await createWorktree(repo, 'fix-the-parser')

    assert.equal(result.ok, true)
    assert.equal(result.value.branch, 'fix-the-parser')
    assert.equal(result.value.path, join(await fs.realpath(repo), '.worktrees', 'fix-the-parser'))
  })

  it('suffixes a name whose branch already exists instead of failing', async () => {
    // A model-named branch collides with an earlier conversation often enough
    // that the collision is the ordinary case, not an error.
    const repo = await makeRepo(root, 'collision')
    const first = await createWorktree(repo, 'same-name')
    assert.equal(first.ok, true)

    const second = await createWorktree(repo, 'same-name')

    assert.equal(second.ok, true)
    assert.equal(second.value.branch, 'same-name-2')
    assert.notEqual(second.value.path, first.value.path)
  })

  it('resolves the repository root even when run from inside a linked worktree', async () => {
    const repo = await makeRepo(root, 'root-from-linked')
    const result = await createWorktree(repo)
    assert.equal(result.ok, true)

    const fromMain = await resolveRepoRoot(repo)
    const fromLinked = await resolveRepoRoot(result.value.path)

    assert.equal(fromMain, await fs.realpath(repo))
    assert.equal(fromLinked, await fs.realpath(repo))
  })

  it('does not duplicate an ignore entry that is already present', async () => {
    const repo = await makeRepo(root, 'ignore-idempotent')
    await fs.writeFile(join(repo, '.gitignore'), 'node_modules/\n.worktrees/\n', 'utf8')

    assert.equal(await ensureGitignoreEntry(repo, '.worktrees'), false)

    const text = await fs.readFile(join(repo, '.gitignore'), 'utf8')
    assert.equal(text, 'node_modules/\n.worktrees/\n')
  })

  it('creates the ignore file when the repository has none', async () => {
    const repo = await makeRepo(root, 'ignore-missing')

    assert.equal(await ensureGitignoreEntry(repo, '.worktrees'), true)
    assert.equal(await fs.readFile(join(repo, '.gitignore'), 'utf8'), '.worktrees/\n')
  })

  it('adds a trailing newline before appending to an unterminated file', async () => {
    const repo = await makeRepo(root, 'ignore-no-newline')
    await fs.writeFile(join(repo, '.gitignore'), 'node_modules/', 'utf8')

    assert.equal(await ensureGitignoreEntry(repo, '.worktrees'), true)
    assert.equal(await fs.readFile(join(repo, '.gitignore'), 'utf8'), 'node_modules/\n.worktrees/\n')
  })

  it('refuses to create a worktree outside a repository', async () => {
    const dir = join(root, 'not-a-repo')
    await fs.mkdir(dir, { recursive: true })

    const result = await createWorktree(dir)

    assert.equal(result.ok, false)
    assert.equal(result.error, 'not a git repository')
  })

  it('always records the ignore entry, since the parent is inside the repository', async () => {
    const repo = await makeRepo(root, 'ignore-always')

    const result = await createWorktree(repo)

    assert.equal(result.ok, true)
    assert.equal(result.value.gitignoreAdded, true)
    assert.equal(await fs.readFile(join(repo, '.gitignore'), 'utf8'), '.worktrees/\n')
  })
})

describe('durable markers', () => {
  it('reads a waiting marker back from a real Session log', () => {
    const session = Session.create('session-markers-1')
    markWaiting(session, '/repo')

    assert.deepEqual(readWorktreeRecords(session), { waiting: { from: '/repo' } })
  })

  it('re-arms a Session when a later waiting marker supersedes a creation marker', () => {
    const session = Session.create('session-markers-2')
    markWaiting(session, '/repo')
    appendPluginRecord(session, 'plugin:worktree-session/creation', { name: 'first-task' })
    markWaiting(session, '/repo')

    assert.deepEqual(readWorktreeRecords(session), { waiting: { from: '/repo' } })
  })

  it('stops owing a worktree once its creation marker lands', () => {
    // The regression: the waiting marker outlived the creation, so the
    // composer kept reading "worktree pending" after the checkout existed.
    const session = Session.create('session-markers-2b')
    markWaiting(session, '/repo')
    appendPluginRecord(session, 'plugin:worktree-session/creation', { name: 'first-task' })

    assert.deepEqual(readWorktreeRecords(session), { creation: { name: 'first-task' } })
  })

  it('ignores records whose payload an older build wrote differently', () => {
    const session = Session.create('session-markers-3')
    appendPluginRecord(session, 'plugin:worktree-session/waiting', { from: 42 })
    appendPluginRecord(session, 'plugin:worktree-session/creation', { name: null })

    assert.deepEqual(readWorktreeRecords(session), {})
  })

  it('ignores unrelated plugin records in the same log', () => {
    const session = Session.create('session-markers-4')
    appendPluginRecord(session, 'plugin:other-plugin/state', { from: '/elsewhere' })

    assert.deepEqual(readWorktreeRecords(session), {})
  })
})

describe('row identity', () => {
  it('declares the row id the patch file mounts', () => {
    assert.equal(name, 'worktree-session')
  })
})

/* ------------------------------------------------------------ pre-step flow */

/** A context whose `effect` runs its callback at once, as cordis does. */
function makeCtx(services = {}) {
  const registered = []
  const waits = []
  const listeners = []
  return {
    registered,
    waits,
    listeners,
    ctx: {
      get: (key) => services[key],
      on: (event, handler) => listeners.push({ event, handler }),
      inject: (names, callback) => waits.push({ names, callback }),
      effect: (callback) => {
        callback()
      },
      logger: { info: () => {}, warn: () => {} },
      // Deliberately no `sessions` property: cordis resolves a service through
      // `ctx.get(name)` unless the fiber declared it in `inject`, and reading an
      // un-injected property throws. A stub that exposes `sessions` directly
      // hides that contract, which is exactly how a route that only works in
      // tests shipped.
      ...services,
    },
  }
}

/** One user message as the loop hands it to pre-step. */
function humanMessage(text) {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** A message no human wrote, which must never name a branch. */
function noticeMessage(text) {
  return { source: { kind: 'plugin:test' }, content: [{ type: 'text', text }] }
}

/**
 * Run the registered `agent/pre-step` listener once.
 *
 * @returns the decision the listener answered with, after the deferred work ran.
 */
async function runPreStep(ctx, { agent, messages, turn = 1, step = 1, signal = new AbortController().signal }) {
  const listener = ctx.__harness.listeners.find((entry) => entry.event === 'agent/pre-step')
  const decision = { kind: 'enter', messages }
  return listener.handler({ agent, messages, turn, step, signal }, async () => decision)
}

/** Wire `apply` to a stub context and return the handle the helpers read. */
function mount(services) {
  const harness = makeCtx(services)
  harness.ctx.__harness = harness
  apply(harness.ctx)
  return harness
}

/** A Session carrying a waiting marker, as the composer would leave it. */
function waitingSession(id = 'session-flow-1') {
  const session = Session.create(id)
  markWaiting(session, '/repo')
  return session
}

/** An Agent stand-in: the route plus the live Session. */
function makeAgent(session, options = { provider: 'p', model: 'm' }) {
  return { session, options }
}

/** An LLM stand-in answering one fixed slug. */
function llmAnswering(text) {
  return {
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text }
      },
    }),
  }
}

describe('deferred worktree creation', () => {
  it('creates the branch, commits the name first, and moves the Session', async () => {
    const session = waitingSession()
    const agent = makeAgent(session)
    const created = []
    const moved = []
    const harness = mount({
      llm: llmAnswering('fix-the-parser'),
      worktrees: {
        create: (owner, request) => {
          created.push({ owner, request })
          return Promise.resolve({ path: '/repo/.worktrees/fix-the-parser', branch: request.name })
        },
      },
      workingDirectory: {
        get: () => '/repo',
        set: (owner, path) => {
          moved.push(path)
          return Promise.resolve(path)
        },
      },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Fix the parser please')] })

    assert.equal(created.length, 1)
    assert.equal(created[0].owner, agent)
    assert.equal(created[0].request.name, 'fix-the-parser')
    // The host service moved the Session itself, so the plugin must not.
    assert.deepEqual(moved, [])
    // The creation marker settles the waiting one: the checkout exists, so the
    // Session no longer owes a worktree and the picker stops saying so.
    assert.deepEqual(readWorktreeRecords(session), { creation: { name: 'fix-the-parser' } })
  })

  it('commits the chosen name before Git runs, so a resume reuses it', async () => {
    const session = waitingSession()
    const agent = makeAgent(session)
    let seenAtCreation
    const harness = mount({
      llm: llmAnswering('fix-the-parser'),
      worktrees: {
        create: () => {
          // A resumed turn would read this back and stop here.
          seenAtCreation = readWorktreeRecords(session)
          return Promise.resolve({ path: '/repo/.worktrees/fix-the-parser', branch: 'fix-the-parser' })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Fix the parser')] })

    assert.deepEqual(seenAtCreation.creation, { name: 'fix-the-parser' })
  })

  it('falls back to its own git path when the host mounts no worktree service', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'dsh-worktree-flow-'))
    try {
      const repo = await makeRepo(root, 'fallback')
      const session = Session.create('session-flow-2')
      markWaiting(session, repo)
      const agent = makeAgent(session)
      const moved = []
      const harness = mount({
        llm: llmAnswering('fallback-task'),
        workingDirectory: {
          get: () => repo,
          set: (owner, path) => {
            moved.push(path)
            return Promise.resolve(path)
          },
        },
      })

      await runPreStep(harness.ctx, { agent, messages: [humanMessage('Do the fallback task')] })

      assert.equal(moved.length, 1)
      assert.equal(moved[0], join(await fs.realpath(repo), '.worktrees', 'fallback-task'))
      assert.equal((await fs.stat(moved[0])).isDirectory(), true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('generates a name when no model route is configured', async () => {
    const session = waitingSession('session-flow-3')
    const agent = makeAgent(session, {})
    const created = []
    const harness = mount({
      worktrees: {
        create: (owner, request) => {
          created.push(request.name)
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: request.name })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Anything')] })

    assert.equal(created.length, 1)
    assert.match(created[0], /^worktree-[0-9a-f]{6}$/)
  })

  it('generates a name when the model answers something unusable', async () => {
    const session = waitingSession('session-flow-4')
    const agent = makeAgent(session)
    const created = []
    const harness = mount({
      llm: llmAnswering('修复解析器'),
      worktrees: {
        create: (owner, request) => {
          created.push(request.name)
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: request.name })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('修复解析器')] })

    assert.match(created[0], /^worktree-[0-9a-f]{6}$/)
  })

  it('generates a name when the naming call fails', async () => {
    const session = waitingSession('session-flow-5')
    const agent = makeAgent(session)
    const created = []
    const harness = mount({
      llm: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            throw new Error('route down')
          },
        }),
      },
      worktrees: {
        create: (owner, request) => {
          created.push(request.name)
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: request.name })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Anything')] })

    assert.match(created[0], /^worktree-[0-9a-f]{6}$/)
  })

  it('does nothing on a later turn or step', async () => {
    const session = waitingSession('session-flow-6')
    const agent = makeAgent(session)
    let calls = 0
    const harness = mount({
      llm: llmAnswering('nope'),
      worktrees: {
        create: () => {
          calls += 1
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: 'x' })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Later')], turn: 2 })
    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Later')], step: 2 })

    assert.equal(calls, 0)
  })

  it('does nothing for a Session that owes no worktree', async () => {
    const session = Session.create('session-flow-7')
    const agent = makeAgent(session)
    let calls = 0
    const harness = mount({
      llm: llmAnswering('nope'),
      worktrees: {
        create: () => {
          calls += 1
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: 'x' })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Ordinary conversation')] })

    assert.equal(calls, 0)
  })

  it('does nothing once the name is already committed', async () => {
    // This is the resume case: the marker proves the work was started, so a
    // retried step must not mint a second branch.
    const session = waitingSession('session-flow-8')
    appendPluginRecord(session, 'plugin:worktree-session/creation', { name: 'already-chosen' })
    const agent = makeAgent(session)
    let calls = 0
    const harness = mount({
      llm: llmAnswering('nope'),
      worktrees: {
        create: () => {
          calls += 1
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: 'x' })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [humanMessage('Retry')] })

    assert.equal(calls, 0)
  })

  it('does nothing when the step carries no human text to name', async () => {
    const session = waitingSession('session-flow-9')
    const agent = makeAgent(session)
    let calls = 0
    const harness = mount({
      llm: llmAnswering('nope'),
      worktrees: {
        create: () => {
          calls += 1
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: 'x' })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    await runPreStep(harness.ctx, { agent, messages: [noticeMessage('context only')] })

    assert.equal(calls, 0)
  })

  it('leaves the turn running in the original directory when creation fails', async () => {
    // The requirement this pins: a worktree is a convenience, so a git failure
    // must not fail the turn. The decision passes through untouched.
    const session = waitingSession('session-flow-10')
    const agent = makeAgent(session)
    const harness = mount({
      llm: llmAnswering('doomed'),
      worktrees: {
        create: () => Promise.reject(new Error('git is not installed')),
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })

    const decision = await runPreStep(harness.ctx, { agent, messages: [humanMessage('Anything')] })

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1)
  })

  it('leaves the turn running when this deployment cannot move a Session', async () => {
    const session = waitingSession('session-flow-11')
    const agent = makeAgent(session)
    let calls = 0
    const harness = mount({
      llm: llmAnswering('nope'),
      worktrees: {
        create: () => {
          calls += 1
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: 'x' })
        },
      },
    })

    const decision = await runPreStep(harness.ctx, { agent, messages: [humanMessage('Anything')] })

    assert.equal(decision.kind, 'enter')
    assert.equal(calls, 0)
  })

  it('passes a rejected step through without doing any work', async () => {
    const session = waitingSession('session-flow-12')
    const agent = makeAgent(session)
    let calls = 0
    const harness = mount({
      llm: llmAnswering('nope'),
      worktrees: {
        create: () => {
          calls += 1
          return Promise.resolve({ path: '/repo/.worktrees/x', branch: 'x' })
        },
      },
      workingDirectory: { get: () => '/repo', set: (owner, path) => Promise.resolve(path) },
    })
    const listener = harness.listeners.find((entry) => entry.event === 'agent/pre-step')

    const decision = await listener.handler(
      { agent, messages: [humanMessage('Anything')], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'reject' }),
    )

    assert.equal(decision.kind, 'reject')
    assert.equal(calls, 0)
  })
})

describe('route mounting', () => {
  it('waits for the Web server and the trust fence instead of reading them at apply time', () => {
    // Both services' plugins may activate after this one, so a service read
    // during apply can legitimately be undefined — which is exactly how the
    // routes were silently dropped before.
    const harness = mount({})

    assert.deepEqual(harness.registered, [])
    assert.equal(harness.waits.length, 1)
    assert.deepEqual(harness.waits[0].names, ['webServer', 'connection'])
  })

  it('registers both routes once the services are available', () => {
    const harness = mount({})

    harness.waits[0].callback({
      webServer: {
        register: (route) => {
          harness.registered.push(route)
          return () => {}
        },
      },
      connection: { requestRejection: () => undefined },
      effect: (callback) => {
        callback()
      },
    })

    assert.deepEqual(
      harness.registered.map((route) => route.path),
      ['/api/dsh-worktree/status', '/api/dsh-worktree/prepare'],
    )
  })

  it('stays inert, without throwing, when no Web server ever appears', () => {
    const harness = mount({})

    assert.deepEqual(harness.registered, [])
    assert.equal(typeof harness.waits[0].callback, 'function')
  })

  it('registers the pre-step listener even with no Web server at all', () => {
    // The listener is the plugin's whole purpose; a deployment with no Web UI
    // must still get it.
    const harness = mount({})

    assert.deepEqual(
      harness.listeners.map((entry) => entry.event),
      ['agent/pre-step'],
    )
  })
})

describe('request fence', () => {
  /**
   * Mount the routes against a recording fence and drive one request through
   * the route at `path`.
   *
   * The fence belongs to the composition's `connection` service, so what these
   * tests pin is the plugin's half of that contract: it asks the composition
   * instead of deciding for itself, and it honours the verdict.
   */
  function harness(rejection, services = {}) {
    const registered = []
    const seen = []
    const mounted = mount(services)
    mounted.waits[0].callback({
      webServer: {
        register: (route) => {
          registered.push(route)
          return () => {}
        },
      },
      connection: {
        requestRejection: (request) => {
          seen.push(request)
          return rejection
        },
      },
      effect: (callback) => {
        callback()
      },
    })

    const responses = []
    return {
      seen,
      responses,
      async call(path, { method = 'GET', url = path, body } = {}) {
        const route = registered.find((candidate) => candidate.path === path)
        const request = {
          method,
          url,
          headers: { host: '192.168.123.230:10000' },
          async *[Symbol.asyncIterator]() {
            if (body !== undefined) yield Buffer.from(body)
          },
        }
        const response = {
          statusCode: undefined,
          headers: undefined,
          payload: undefined,
          writeHead(status, headers) {
            this.statusCode = status
            this.headers = headers
          },
          end(payload) {
            this.payload = payload
          },
        }
        responses.push(response)
        await route.handler(request, response)
        return response
      },
    }
  }

  it('asks the composition fence, not a loopback literal of its own', async () => {
    // A LAN browser is not loopback, and the deployment declares its LAN
    // authority to `connection` — which is why the verdict has to come from
    // there. A plugin-local loopback check answered 403 to every LAN client.
    const probe = harness(undefined)

    await probe.call('/api/dsh-worktree/status', { url: '/api/dsh-worktree/status?cwd=/repo' })

    assert.equal(probe.seen.length, 1)
    assert.equal(probe.seen[0].headers.host, '192.168.123.230:10000')
  })

  it('answers the fence verdict and never reaches the handler', async () => {
    const probe = harness(403)

    const response = await probe.call('/api/dsh-worktree/status', { url: '/api/dsh-worktree/status?cwd=/repo' })

    assert.equal(response.statusCode, 403)
    assert.deepEqual(JSON.parse(response.payload), { error: 'forbidden' })
  })

  it('reports an unauthenticated browser as 401 rather than 403', async () => {
    const probe = harness(401)

    const response = await probe.call('/api/dsh-worktree/prepare', { method: 'POST', body: '{}' })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(JSON.parse(response.payload), { error: 'unauthorized' })
  })

  it('proceeds to the handler when the fence accepts', async () => {
    const probe = harness(undefined)

    const response = await probe.call('/api/dsh-worktree/status', { url: '/api/dsh-worktree/status?cwd=/definitely-not-a-repository' })

    assert.equal(response.statusCode, 200)
    assert.equal(JSON.parse(response.payload).isRepo, false)
  })
})

describe('prepare route', () => {
  /** Mount the routes over a Session store holding one Session. */
  function prepareHarness({ session, workingDirectory = { get: () => '/repo', set: () => Promise.resolve('/repo') } }) {
    const registered = []
    const mounted = mount({
      workingDirectory,
      sessions: { get: (id) => (id === session.id ? session : undefined) },
    })
    mounted.waits[0].callback({
      webServer: {
        register: (route) => {
          registered.push(route)
          return () => {}
        },
      },
      connection: { requestRejection: () => undefined },
      effect: (callback) => {
        callback()
      },
    })
    return async (body) => {
      const route = registered.find((candidate) => candidate.path === '/api/dsh-worktree/prepare')
      const response = {
        statusCode: undefined,
        payload: undefined,
        writeHead(status) {
          this.statusCode = status
        },
        end(payload) {
          this.payload = payload
        },
      }
      await route.handler(
        {
          method: 'POST',
          url: '/api/dsh-worktree/prepare',
          headers: { host: '127.0.0.1:10000' },
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(body))
          },
        },
        response,
      )
      return response
    }
  }

  it('records the waiting marker on the Session the composer created', async () => {
    const session = Session.create('session-prepare-1')
    const post = prepareHarness({ session })

    const response = await post({ sessionId: session.id, from: '/repo' })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(readWorktreeRecords(session), { waiting: { from: '/repo' } })
  })

  it('refuses a Session the host does not know', async () => {
    const session = Session.create('session-prepare-2')
    const post = prepareHarness({ session })

    const response = await post({ sessionId: 'session-unknown', from: '/repo' })

    assert.equal(response.statusCode, 404)
  })

  it('refuses a request with no directory', async () => {
    const session = Session.create('session-prepare-3')
    const post = prepareHarness({ session })

    const response = await post({ sessionId: session.id })

    assert.equal(response.statusCode, 400)
  })

  it('refuses when this deployment cannot move a Session', async () => {
    const session = Session.create('session-prepare-4')
    const registered = []
    const mounted = mount({ sessions: { get: () => session } })
    mounted.waits[0].callback({
      webServer: {
        register: (route) => {
          registered.push(route)
          return () => {}
        },
      },
      connection: { requestRejection: () => undefined },
      effect: (callback) => {
        callback()
      },
    })
    const route = registered.find((candidate) => candidate.path === '/api/dsh-worktree/prepare')
    const response = {
      statusCode: undefined,
      payload: undefined,
      writeHead(status) {
        this.statusCode = status
      },
      end(payload) {
        this.payload = payload
      },
    }
    await route.handler(
      {
        method: 'POST',
        url: '/api/dsh-worktree/prepare',
        headers: { host: '127.0.0.1:10000' },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ sessionId: session.id, from: '/repo' }))
        },
      },
      response,
    )

    assert.equal(response.statusCode, 409)
    assert.deepEqual(readWorktreeRecords(session), {})
  })
})

describe('status route', () => {
  it('reports the pending intent of the Session it was asked about', async () => {
    const session = Session.create('session-status-1')
    markWaiting(session, '/repo')
    const registered = []
    const mounted = mount({
      workingDirectory: { get: () => '/repo', set: () => Promise.resolve('/repo') },
      sessions: { get: (id) => (id === session.id ? session : undefined) },
    })
    mounted.waits[0].callback({
      webServer: {
        register: (route) => {
          registered.push(route)
          return () => {}
        },
      },
      connection: { requestRejection: () => undefined },
      effect: (callback) => {
        callback()
      },
    })
    const route = registered.find((candidate) => candidate.path === '/api/dsh-worktree/status')
    const response = {
      statusCode: undefined,
      payload: undefined,
      writeHead(status) {
        this.statusCode = status
      },
      end(payload) {
        this.payload = payload
      },
    }
    await route.handler(
      {
        method: 'GET',
        url: '/api/dsh-worktree/status?cwd=/definitely-not-a-repository&sessionId=' + session.id,
        headers: { host: '127.0.0.1:10000' },
        async *[Symbol.asyncIterator]() {},
      },
      response,
    )

    const body = JSON.parse(response.payload)
    assert.equal(body.waiting, true)
    assert.equal(body.deferred, true)
  })

  it('reports no pending intent for a Session without one', async () => {
    const session = Session.create('session-status-2')
    const registered = []
    const mounted = mount({
      sessions: { get: (id) => (id === session.id ? session : undefined) },
    })
    mounted.waits[0].callback({
      webServer: {
        register: (route) => {
          registered.push(route)
          return () => {}
        },
      },
      connection: { requestRejection: () => undefined },
      effect: (callback) => {
        callback()
      },
    })
    const route = registered.find((candidate) => candidate.path === '/api/dsh-worktree/status')
    const response = {
      statusCode: undefined,
      payload: undefined,
      writeHead(status) {
        this.statusCode = status
      },
      end(payload) {
        this.payload = payload
      },
    }
    await route.handler(
      {
        method: 'GET',
        url: '/api/dsh-worktree/status?cwd=/definitely-not-a-repository&sessionId=' + session.id,
        headers: { host: '127.0.0.1:10000' },
        async *[Symbol.asyncIterator]() {},
      },
      response,
    )

    const body = JSON.parse(response.payload)
    assert.equal(body.waiting, false)
    // No working-directory service in this deployment, so the menu must not
    // offer a flow that has nowhere to land.
    assert.equal(body.deferred, false)
  })
})

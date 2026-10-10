/**
 * Tests for the host half's git plumbing.
 *
 * The pure parser is checked against git's real porcelain output, and the
 * create/ignore paths are exercised against throwaway repositories — the
 * contract that matters is "what git actually does", not a mock of it.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

import {
  apply,
  createWorktree,
  ensureGitignoreEntry,
  listWorktrees,
  name,
  parseWorktreeList,
  resolveRepoRoot,
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
      'worktree /repo/.worktrees/wt-abc123',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/wt-abc123',
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
    assert.equal(entries[1].path, '/repo/.worktrees/wt-abc123')
    assert.equal(entries[1].branch, 'wt-abc123')
    assert.equal(entries[1].isMain, false)
    assert.equal(entries[1].name, 'wt-abc123')
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

describe('row identity', () => {
  it('declares the row id the patch file mounts', () => {
    assert.equal(name, 'worktree-session')
  })
})

describe('route mounting', () => {
  /** A context whose `effect` runs its callback at once, as cordis does. */
  function makeCtx() {
    const registered = []
    const waits = []
    return {
      registered,
      waits,
      ctx: {
        get: () => undefined,
        inject: (names, callback) => waits.push({ names, callback }),
        effect: (callback) => {
          callback()
        },
      },
    }
  }

  it('waits for the Web server and the trust fence instead of reading them at apply time', () => {
    // Both services' plugins may activate after this one, so a service read
    // during apply can legitimately be undefined — which is exactly how the
    // routes were silently dropped before.
    const { registered, waits, ctx } = makeCtx()

    apply(ctx)

    assert.deepEqual(registered, [])
    assert.equal(waits.length, 1)
    assert.deepEqual(waits[0].names, ['webServer', 'connection'])
  })

  it('registers both routes once the services are available', () => {
    const { registered, waits, ctx } = makeCtx()

    apply(ctx)
    waits[0].callback({
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

    assert.deepEqual(
      registered.map((route) => route.path),
      ['/api/dsh-worktree/status', '/api/dsh-worktree/create'],
    )
  })

  it('stays inert, without throwing, when no Web server ever appears', () => {
    const { registered, waits, ctx } = makeCtx()

    apply(ctx)

    assert.deepEqual(registered, [])
    assert.equal(typeof waits[0].callback, 'function')
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
  function harness(rejection) {
    const registered = []
    const seen = []
    const waits = []
    apply({
      get: () => undefined,
      inject: (names, callback) => waits.push({ names, callback }),
      effect: (callback) => {
        callback()
      },
    })
    waits[0].callback({
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

    const response = await probe.call('/api/dsh-worktree/create', { method: 'POST', body: '{}' })

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

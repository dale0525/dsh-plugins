/**
 * dsh-worktree-session — host half.
 *
 * Owns the git plumbing behind the composer's worktree picker: resolving the
 * repository a Session's `cwd` belongs to, listing its linked worktrees,
 * creating one, and keeping the repository's `.gitignore` in step with where
 * worktrees are put. The browser half only talks to these routes; it never
 * shells out to git itself, because a browser cannot and because the
 * repository root has to be resolved from the same `cwd` the tools use.
 *
 * The routes are registered on the optional `webServer` service and fenced by
 * the optional `connection` service, both awaited through a nested `inject`
 * instead of being named in the top-level `inject` list — naming them would
 * turn "no Web UI" into "this plugin never loads".
 *
 * The fence is the composition's, never this plugin's own: `connection` owns
 * the Host/Origin trust policy (loopback plus the LAN authorities the
 * deployment declares) and the browser authentication that goes with it. A
 * plugin-local loopback check cannot see those declared authorities, so it
 * answers 403 to every LAN browser — which is exactly the bug this delegation
 * fixes. The routes are `exact`, so they sit in front of Connection's `/api`
 * prefix route and have to ask for the same verdict themselves.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pull the Cordis Context augmentations (webServer / connection) and
// the WebRoute contract without any runtime import.
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/* ------------------------------------------------------------------ layout */

/**
 * Repository-relative directory holding this plugin's worktrees.
 *
 * A constant rather than a setting: worktrees live inside the repository they
 * belong to, at a path that is predictable from the repository alone. The
 * `.gitignore` entry below is what keeps them out of the parent's status.
 */
const WORKTREE_PARENT = '.worktrees'

export const name = 'worktree-session'

/**
 * No required services: `webServer` is optional and awaited through a nested
 * `inject`, and cordis supplies `logger` itself.
 */
export const inject: string[] = []

/* -------------------------------------------------------------- git plumbing */

/** One linked worktree as `git worktree list --porcelain` describes it. */
export interface WorktreeEntry {
  /** Absolute path of the worktree's checkout directory. */
  readonly path: string
  /** Commit the worktree currently has checked out. */
  readonly head: string
  /** Short branch name, absent on a detached worktree. */
  readonly branch?: string
  /** Whether the worktree is on a detached HEAD. */
  readonly detached: boolean
  /** Whether this is the repository's main checkout (git lists it first). */
  readonly isMain: boolean
  /** Whether git considers the worktree stale (its directory is gone). */
  readonly prunable: boolean
  /** Last path segment — the worktree's directory name. */
  readonly name: string
}

/** Outcome of one git invocation. */
interface GitResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Cap on captured git output (a large `worktree list` still fits easily). */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options: { cwd: string; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>

/**
 * Run one git command, reporting failure as data rather than throwing.
 *
 * This is a real untrusted boundary — git may be absent, the directory may not
 * be a repository, and the command may legitimately fail — so the caller
 * decides what a failure means instead of an exception unwinding the request.
 * @param cwd - directory to run in.
 * @param args - git arguments.
 * @returns captured output plus whether the command succeeded.
 */
async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES })
    return { ok: true, stdout, stderr }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? String(error),
    }
  }
}

/**
 * Parse `git worktree list --porcelain` output into entries.
 *
 * The format is blank-line-separated stanzas of `key value` lines. Git lists
 * the main checkout first, which is what makes the first entry's path the
 * repository root even when this runs from inside a linked worktree.
 * @param stdout - raw porcelain output.
 * @returns one entry per worktree, main checkout first.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: { path?: string; head?: string; branch?: string; detached?: boolean; prunable?: boolean } | undefined

  const flush = (): void => {
    if (current?.path === undefined) return
    const path = current.path
    const segments = path.split('/')
    entries.push({
      path,
      head: current.head ?? '',
      ...(current.branch === undefined ? {} : { branch: current.branch }),
      detached: current.detached === true,
      isMain: entries.length === 0,
      prunable: current.prunable === true,
      name: segments[segments.length - 1] ?? path,
    })
    current = undefined
  }

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length) }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'detached') current.detached = true
    else if (line.startsWith('prunable')) current.prunable = true
  }
  flush()
  return entries
}

/**
 * List the worktrees of the repository containing `cwd`.
 * @param cwd - any directory inside the repository, including a linked worktree.
 * @returns the worktrees, main checkout first; empty when `cwd` is not in a repository.
 */
export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const result = await runGit(cwd, ['worktree', 'list', '--porcelain'])
  if (!result.ok) return []
  return parseWorktreeList(result.stdout)
}

/**
 * Resolve the repository root for a directory.
 *
 * Taken from the main checkout's entry rather than `rev-parse --show-toplevel`,
 * because that command answers with the *linked* worktree's path when run from
 * inside one — which is exactly the case this plugin creates.
 * @param cwd - any directory inside the repository.
 * @returns the main checkout's absolute path, or undefined outside a repository.
 */
export async function resolveRepoRoot(cwd: string): Promise<string | undefined> {
  const worktrees = await listWorktrees(cwd)
  return worktrees[0]?.path
}

/**
 * Append an ignore entry to the repository's `.gitignore` unless it is there.
 *
 * Matched as a whole line rather than through `git check-ignore`, so the answer
 * is "does this repository's own file say so" — a global ignore that happens to
 * cover the path would otherwise suppress the entry the user asked for.
 * @param repoRoot - repository root holding the `.gitignore`.
 * @param entry - repository-relative directory to ignore.
 * @returns whether the file was changed.
 */
export async function ensureGitignoreEntry(repoRoot: string, entry: string): Promise<boolean> {
  const file = join(repoRoot, '.gitignore')
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    // A missing .gitignore is the ordinary first-run case, not a failure.
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }
  const wanted = new Set([entry, `${entry}/`])
  if (text.split(/\r?\n/).some((line) => wanted.has(line.trim()))) return false
  const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`
  await fs.writeFile(file, `${prefix}${entry}/\n`, 'utf8')
  return true
}

/** Result of a worktree creation. */
export interface CreatedWorktree {
  /** Absolute path of the new worktree. */
  readonly path: string
  /** Short branch created for it. */
  readonly branch: string
  /** Repository root the worktree belongs to. */
  readonly repoRoot: string
  /** Whether the repository's `.gitignore` gained an entry. */
  readonly gitignoreAdded: boolean
}

/** Attempts to find a free directory/branch pair before giving up. */
const NAME_ATTEMPTS = 5

/**
 * Create a linked worktree inside the repository's worktree parent directory.
 *
 * The directory and branch are named from a short random id, not from the
 * conversation: the Session that will occupy this worktree has to exist before
 * its first message does, and a Session's `cwd` is fixed at birth. The
 * human-facing name comes from DSH's own first-prompt Session titling.
 * @param cwd - directory inside the target repository.
 * @returns the created worktree, or an error message explaining the refusal.
 */
export async function createWorktree(
  cwd: string,
): Promise<{ ok: true; value: CreatedWorktree } | { ok: false; error: string }> {
  const worktrees = await listWorktrees(cwd)
  const repoRoot = worktrees[0]?.path
  if (repoRoot === undefined) return { ok: false, error: 'not a git repository' }

  const targetParent = join(repoRoot, WORKTREE_PARENT)
  const takenBranches = new Set(worktrees.map((entry) => entry.branch).filter((b): b is string => b !== undefined))
  const takenPaths = new Set(worktrees.map((entry) => entry.path))

  let created: { path: string; branch: string } | undefined
  let lastError = ''
  for (let attempt = 0; attempt < NAME_ATTEMPTS && created === undefined; attempt += 1) {
    const id = `wt-${randomBytes(3).toString('hex')}`
    const path = join(targetParent, id)
    if (takenBranches.has(id) || takenPaths.has(path)) continue
    // The leaf is git's to create, but a missing parent would make it fail.
    await fs.mkdir(targetParent, { recursive: true })
    const result = await runGit(repoRoot, ['worktree', 'add', '-b', id, path, 'HEAD'])
    if (result.ok) {
      created = { path, branch: id }
      break
    }
    lastError = result.stderr.trim() || 'git worktree add failed'
  }
  if (created === undefined) {
    return { ok: false, error: lastError || `could not find a free worktree name under ${targetParent}` }
  }

  // The parent is inside the repository by construction, so it always has an
  // entry to record.
  const gitignoreAdded = await ensureGitignoreEntry(repoRoot, relative(repoRoot, targetParent).split(/[\\/]/).join('/'))

  return { ok: true, value: { path: created.path, branch: created.branch, repoRoot, gitignoreAdded } }
}

/* ---------------------------------------------------------- trust fence */

/**
 * Ask the composition whether one request may be served.
 *
 * `connection.requestRejection` is the deployment's single trust fence: it
 * applies the Host/Origin checks (loopback plus the LAN authorities the
 * deployment declares) and the browser authentication that rides with them.
 * This plugin answers with the verdict instead of re-deriving it, because the
 * declared LAN authorities live in `connection`'s config and a local check
 * cannot see them.
 * @param connection - the composition's Connection service.
 * @param req - the incoming request.
 * @param res - the response, written to when the request is refused.
 * @returns whether the request was refused.
 */
function refuseUntrusted(
  connection: HostConnectionHandle,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  writeJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
  return true
}

/* ---------------------------------------------------------------- responses */

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Cap on JSON request bodies (these requests carry only a directory path). */
const MAX_JSON_BODY_BYTES = 64 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Read one non-empty string field from a request body. */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/* ------------------------------------------------------------------ routes */

/** API prefix shared with the browser half. */
export const API = {
  status: '/api/dsh-worktree/status',
  create: '/api/dsh-worktree/create',
} as const

/**
 * Build the plugin's HTTP routes.
 * @param connection - the composition's Connection service, whose trust fence
 * every request is put through before the route's own work begins.
 * @returns the routes to register.
 */
export function makeRoutes(connection: HostConnectionHandle): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: API.status,
      handler: async (req, res) => {
        if (refuseUntrusted(connection, req, res)) return
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const cwd = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cwd')
        if (cwd === null || cwd === '') {
          writeJson(res, 400, { error: 'cwd is required' })
          return
        }
        const worktrees = await listWorktrees(cwd)
        const repoRoot = worktrees[0]?.path
        writeJson(res, 200, {
          isRepo: repoRoot !== undefined,
          repoRoot: repoRoot ?? null,
          worktrees,
        })
      },
    },
    {
      kind: 'exact',
      path: API.create,
      handler: async (req, res) => {
        if (refuseUntrusted(connection, req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const cwd = body === undefined ? undefined : stringField(body, 'cwd')
        if (cwd === undefined) {
          writeJson(res, 400, { error: 'cwd is required' })
          return
        }
        const result = await createWorktree(cwd)
        if (!result.ok) {
          writeJson(res, 409, { error: result.error })
          return
        }
        writeJson(res, 200, result.value)
      },
    },
  ]
}

/**
 * Mount the plugin's routes when a Web server and a trust fence are present.
 *
 * Both services are awaited through one nested `inject` rather than read with
 * `ctx.get` at apply time. A composed row order does not imply an activation
 * order, so a plain read can legitimately see `undefined` and silently drop
 * the routes; waiting on the services is the pattern the host's own Web-facing
 * plugins use. Keeping the `inject` nested (rather than in the top-level
 * `inject` list) is what lets a deployment with no Web UI still load this
 * plugin. `connection` is required alongside `webServer` on purpose: these
 * routes sit in front of Connection's `/api` prefix route, so serving them
 * without its fence would serve them unfenced.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = makeRoutes(webCtx.connection).map((route) => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'worktree-session: routes')
  })
}

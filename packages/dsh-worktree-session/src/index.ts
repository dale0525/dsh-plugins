/**
 * dsh-worktree-session — host half.
 *
 * Defers a worktree choice to the first message of a conversation.
 *
 * A Session's `cwd` is immutable, so "work in a worktree" cannot be a decision
 * made while an existing Session runs. It is made *before* the first message
 * instead: the composer creates a blank Session in the current Workspace and
 * records a waiting marker on it. When that Session's first step is proposed,
 * this plugin moves the Session's working directory into a checkout — either one
 * it creates, named from the user's own message with one auxiliary model call,
 * or the one the user picked, which already existed. The `working-directory`
 * service appends the durable change and its notice, so the model sees the new
 * directory on that same step. The Session keeps its original `cwd`, which is
 * why it stays in its Workspace group while its tools run in the worktree.
 *
 * Two markers make the decision durable and idempotent: the waiting marker says
 * "a worktree is owed" (and, when the user picked an existing checkout, which
 * one), the creation marker says "the intent is settled". The name is committed
 * *before* Git runs, so a turn that is resumed or retried reuses the same name
 * instead of minting a second branch.
 *
 * Both markers are experimental plugin records, not Session event types: an
 * event type this build does not know would make the stored log unreadable, so
 * plugin state rides `appendPluginRecord`, which marks the record ignorable and
 * keeps the log interpretable by any harness.
 *
 * Every optional host service is read with `ctx.get` at call time, never named
 * in `inject`: naming one would turn "this deployment does not mount it" into
 * "this plugin never loads". Without `workingDirectory` there is no way to move
 * a Session, so the whole deferred flow stays off and the menu reports it.
 *
 * The routes are registered on the optional `webServer` service and fenced by
 * the optional `connection` service, both awaited through a nested `inject` for
 * the same reason. The fence is the composition's, never this plugin's own:
 * `connection` owns the Host/Origin trust policy and the browser authentication
 * that goes with it, and a plugin-local loopback check cannot see the LAN
 * authorities the deployment declares. The routes are `exact`, so they sit in
 * front of Connection's `/api` prefix route and have to ask for the same
 * verdict themselves.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, SessionId, type Session } from '@deepseek-ai/dsh-session'
// Type-only: pull the Cordis Context augmentations (webServer / connection) and
// the WebRoute contract without any runtime import.
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/* ------------------------------------------------------------------ layout */

/**
 * Repository-relative directory holding this plugin's worktrees.
 *
 * Only used when the host mounts no worktree service of its own. A constant
 * rather than a setting: worktrees live inside the repository they belong to,
 * at a path predictable from the repository alone.
 */
const WORKTREE_PARENT = '.worktrees'

export const name = 'worktree-session'

/**
 * No required services: every host service this plugin touches is optional and
 * read through `ctx.get` at call time, and cordis supplies `logger` itself.
 */
export const inject: string[] = []

/* -------------------------------------------------- optional host services */

/**
 * The host's working-directory service, as this plugin uses it.
 *
 * Declared structurally rather than imported so that a host generation without
 * it still loads this plugin; the service is what decides whether a Session can
 * be moved at all.
 */
interface WorkingDirectoryService {
  /** The directory a Session's tools currently run in. */
  get(session: Session): string
  /**
   * Move one Session, committing the change and its notice.
   * @param agent - Session owner whose context asserts liveness.
   * @param path - absolute directory to move into.
   * @param signal - cancellation of the lookup and publication.
   * @returns the directory in force afterwards.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
}

/**
 * The host's worktree service, as this plugin uses it.
 *
 * Mounted by the host's experimental worktree bundle, so it is often absent;
 * this plugin then falls back to its own Git plumbing.
 */
interface WorktreeService {
  /**
   * Create a branch and its checkout, then move the calling Session into it.
   * @param agent - caller whose directory selects the source repository.
   * @param request - new branch name and base revision.
   * @param signal - cancellation of lookup, creation, and publication.
   * @returns the created checkout and branch.
   */
  create(
    agent: Agent,
    request?: { name?: string; from?: string },
    signal?: AbortSignal,
  ): Promise<{ path: string; branch: string }>
}

/* ------------------------------------------------------------------ markers */

/**
 * Record type saying a worktree is owed to this Session.
 *
 * `from` is the directory the Session was created in, kept so the intent stays
 * readable without re-deriving it from the immutable header. `target` names a
 * checkout that already exists — the user picked a branch they already have —
 * so the first step moves the Session there instead of creating a second
 * checkout of the same branch.
 */
const WAITING = 'plugin:worktree-session/waiting'

/**
 * Record type saying this Session's worktree intent is settled.
 *
 * Committed before Git runs: a resumed or retried first step then reuses the
 * same name instead of minting a second branch, and a failed creation is not
 * retried forever. For a checkout that already existed there was no name to
 * choose, so `name` carries its directory name — the marker's meaning is "the
 * intent is settled", and the picker reads it as "nothing is owed any more".
 */
const CREATION = 'plugin:worktree-session/creation'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:worktree-session/waiting': { from: string; target?: string }
    'plugin:worktree-session/creation': { name: string }
  }
}

/** What the log currently says about this Session's worktree. */
export interface WorktreeRecords {
  /** Directory the Session was created in, when a worktree is owed. */
  readonly waiting?: { readonly from: string; readonly target?: string }
  /** Branch name already chosen, when one was. */
  readonly creation?: { readonly name: string }
}

/**
 * Fold one Session's worktree markers out of its log.
 *
 * Record payloads are validated here rather than trusted: a restored log may
 * carry what an earlier build of this plugin wrote, which is the documented
 * contract for plugin records. The two markers are sequential, not cumulative:
 * a waiting marker re-arms the Session and a creation marker settles it, so
 * only the LAST of the two is in force. A later waiting marker supersedes an
 * earlier creation marker (asking for a second worktree), and a creation
 * marker supersedes the waiting marker it was written for (the checkout now
 * exists, so nothing is owed).
 * @param session - Session whose log to read.
 * @returns the markers still in force.
 */
export function readWorktreeRecords(session: Session): WorktreeRecords {
  let waiting: { from: string; target?: string } | undefined
  let creation: { name: string } | undefined
  for (const event of session.snapshotEvents()) {
    const record = pluginRecordOf(event)
    if (record === undefined) continue
    if (record.type === WAITING) {
      const data = record.data as { from?: unknown; target?: unknown }
      if (typeof data.from !== 'string') continue
      const target = data.target
      waiting = {
        from: data.from,
        ...(typeof target === 'string' && target !== '' ? { target } : {}),
      }
      creation = undefined
      continue
    }
    if (record.type === CREATION) {
      const name = (record.data as { name?: unknown }).name
      if (typeof name === 'string') {
        creation = { name }
        waiting = undefined
      }
    }
  }
  return { ...(waiting === undefined ? {} : { waiting }), ...(creation === undefined ? {} : { creation }) }
}

/**
 * Record that this Session owes a worktree.
 * @param session - the blank Session the composer created.
 * @param from - directory the Session was created in.
 * @param target - an existing checkout to move into instead of creating one.
 */
export function markWaiting(session: Session, from: string, target?: string): void {
  appendPluginRecord(session, WAITING, target === undefined ? { from } : { from, target })
}

/* ------------------------------------------------- main checkout guard */

/**
 * Producer identity stamped on every notice this guard injects.
 *
 * The plugin's own name, so one transcript attributes the warning to the plugin
 * that raised it rather than to the harness.
 */
const PLUGIN_SOURCE = { kind: 'plugin:worktree-session' } as const

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:worktree-session': {
      kind: 'plugin:worktree-session'
      form: 'notice'
      summary: string
    }
  }
}

/** The host's filesystem service, as this guard uses it. */
interface FileSystemService {
  /**
   * Name the OS path a target stands for.
   *
   * Required rather than optional: without it the target key is opaque by
   * contract, and guessing a path from it would be a guess about a backend this
   * plugin does not own. Backends own target identity, so the answer is already
   * canonical — that is, it can be compared against a resolved checkout path.
   */
  processPath(target: unknown): string
}

/**
 * One checkout as this guard compares it.
 *
 * Paths are canonicalised, so that a repository reached through a symlink and
 * the spelling git recorded name the same checkout.
 */
interface Checkout {
  /** Absolute, symlink-resolved path. */
  readonly path: string
  /** Whether this is the repository's main checkout. */
  readonly isMain: boolean
}

/**
 * The two filesystem intent waterfalls, announced before a mutation lands.
 *
 * Declared here rather than imported because `@deepseek-ai/dsh-fs` is not a
 * dependency of this package: a host generation without that service must still
 * load this plugin, and it then simply never fires these events. Where the
 * service is installed, its own declarations merge with these.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'fs/write-intent'(target: unknown, actor: unknown, next: () => unknown): unknown
    'fs/edit-intent'(target: unknown, actor: unknown, next: () => unknown): unknown
  }
}

/**
 * Whether `child` is `parent` or lies beneath it.
 *
 * Compared with `relative`, the same way the local backend answers its own
 * `contains`: a sibling whose name merely starts with the parent's does not
 * count, and neither does a `..` escape.
 */
function containsPath(parent: string, child: string): boolean {
  const rest = relative(parent, child)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/**
 * Resolve symlinks in a directory, falling back to the directory itself.
 *
 * Git records the spelling a checkout was created with, which need not be the
 * one a Session reaches it by — on macOS `/var` is a symlink to `/private/var`,
 * so the two spellings of one repository would otherwise compare unequal. A
 * directory that no longer resolves is a pruned worktree, and treating it as
 * itself simply leaves it unmatched.
 * @param path - absolute directory.
 * @returns its canonical form.
 */
async function realpathOf(path: string): Promise<string> {
  try {
    return await fs.realpath(path)
  } catch {
    return path
  }
}

/**
 * The checkout a path belongs to, by the longest containing prefix.
 *
 * Longest wins rather than "first match" because the default worktree parent
 * directory sits *inside* the main checkout: a `.worktrees/<branch>` path is
 * contained by both the main checkout and its own worktree, and only the more
 * specific answer is right. Worktrees outside the repository (git allows them
 * anywhere) are unaffected, since nothing else contains them.
 * @param checkouts - the repository's checkouts, main checkout included.
 * @param candidate - canonical path to attribute.
 * @returns the owning checkout, or undefined when none contains the path.
 */
function owningCheckout(checkouts: readonly Checkout[], candidate: string): Checkout | undefined {
  let found: Checkout | undefined
  for (const checkout of checkouts) {
    if (!containsPath(checkout.path, candidate)) continue
    if (found === undefined || checkout.path.length > found.path.length) found = checkout
  }
  return found
}

/**
 * Build the warning for one mutation of the main checkout.
 * @param main - the main checkout's path.
 * @param worktree - the Session's own worktree.
 * @param target - the path about to be mutated.
 * @param tool - which mutation is under way.
 * @returns the model-facing notice.
 */
function mainCheckoutNotice(
  main: string,
  worktree: string,
  target: string,
  tool: 'write' | 'edit',
): ReturnType<typeof createUserMessage> {
  const text = [
    `This ${tool} targets ${JSON.stringify(target)}, which is in the repository's main checkout at ${JSON.stringify(main)} — not in the worktree this Session works in, ${JSON.stringify(worktree)}.`,
    // Stated as "this notice does not block" rather than "the change was
    // applied": both intents are announced before the write lands, so whether
    // it succeeds is not known yet and the tool call reports that separately.
    'This notice does not block or revert the change.',
    'Proceed only if changing the main checkout is what you intend. If the change belongs in the worktree instead, make it there.',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'notice',
      summary: boundContextSummary(`${tool} outside the worktree: ${target}`),
    },
  })
}

/**
 * Warn the Session when a mutation lands in the main checkout instead.
 *
 * Never blocks: the peers' intent is what the caller receives untouched, and
 * the notice only tells the model where its own change is going, once the
 * decision is already made.
 *
 * A Session only has a "wrong" checkout if it works in a linked worktree, so a
 * Session in the main checkout — and one outside any repository — stays quiet.
 * @param ctx - host plugin context.
 * @param target - the resolved target about to be mutated.
 * @param actor - the opaque tool-execution context, which carries the Agent.
 * @param tool - which mutation is under way.
 */
async function warnMainCheckoutMutation(
  ctx: Context,
  target: unknown,
  actor: unknown,
  tool: 'write' | 'edit',
): Promise<void> {
  const agent = (actor as { agent?: Agent } | undefined)?.agent
  if (agent === undefined) return
  const cwd = (ctx.get('workingDirectory') as WorkingDirectoryService | undefined)?.get(agent.session)
  if (cwd === undefined) return
  const fileSystem = ctx.get('fs') as FileSystemService | undefined
  if (fileSystem === undefined) return

  const worktrees = await listWorktrees(cwd)
  const checkouts = await Promise.all(
    worktrees.map(async (entry): Promise<Checkout> => ({ path: await realpathOf(entry.path), isMain: entry.isMain })),
  )
  const worktree = owningCheckout(checkouts, await realpathOf(cwd))
  // Its own checkout is the main one, so there is no other checkout to warn
  // about: the Session is already editing where it lives.
  if (worktree === undefined || worktree.isMain) return
  // Already canonical: the backend derives a target key from `realpath` of the
  // nearest existing ancestor, so no second resolution is needed here.
  const targetPath = fileSystem.processPath(target)
  // Another worktree or another repository is outside this guard's business.
  const main = owningCheckout(checkouts, targetPath)
  if (main === undefined || !main.isMain) return

  agent.inject(mainCheckoutNotice(main.path, worktree.path, targetPath, tool))
}

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
 * Without a `name` the directory and branch are named from a short random id.
 * With one, the requested name is used as both, suffixed only when it is
 * already taken — a model-named branch can collide with an earlier conversation,
 * and that is the ordinary case rather than a failure.
 * @param cwd - directory inside the target repository.
 * @param name - desired branch and directory name.
 * @returns the created worktree, or an error message explaining the refusal.
 */
export async function createWorktree(
  cwd: string,
  name?: string,
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
    const id = name === undefined ? `wt-${randomBytes(3).toString('hex')}` : attempt === 0 ? name : `${name}-${attempt + 1}`
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

/* -------------------------------------------------------------------- naming */

/** Cap on the user text forwarded to the naming call. */
const MAX_PROMPT_CHARS = 4000

/** Output cap for the naming call; a slug is a few words. */
const MAX_NAME_TOKENS = 24

/** Hard cap on the naming call, so a stalled route cannot hold the first step. */
const NAME_TIMEOUT_MS = 20_000

/** Longest branch name accepted, in characters. */
const MAX_NAME_CHARS = 60

/** The one instruction the naming call carries. */
const NAME_INSTRUCTION = `Name the task in the user's message as a Git branch.
Reply with the name and nothing else: 2-4 lowercase words separated by hyphens, ASCII letters and digits only.
Do not translate, explain, or quote.`

/**
 * Reduce model output to a Git-legal branch name.
 *
 * The result is restricted to `[a-z0-9-]`, which keeps it inside Git's own
 * relative-branch grammar and inside the worktree service's path rule: no
 * separators, no empty segments, nothing that could address another directory.
 * @param text - raw model output.
 * @returns the branch name, empty when nothing usable remained.
 */
export function sanitizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/g, '')
}

/** A name that cannot collide with anything a model would choose. */
function fallbackName(): string {
  return `worktree-${randomBytes(3).toString('hex')}`
}

/**
 * Ask the configured model to name this conversation's branch.
 *
 * The route comes from the Agent's own options, so the call uses the model the
 * user already chose for the conversation instead of a second configuration.
 * Every failure — no route, a failed call, an aborted call, unusable output —
 * answers a random name, because naming must never hold up or break the turn.
 * @param llm - the composition's LLM service, or undefined when absent.
 * @param agent - Session owner supplying the route.
 * @param prompt - the user's first message text.
 * @param signal - the turn's cancellation signal.
 * @returns a Git-legal branch name.
 */
async function chooseName(
  llm: LlmRuntime | undefined,
  agent: Agent,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const provider = agent.options.provider
  const model = agent.options.model
  if (llm === undefined || provider === undefined || model === undefined) return fallbackName()

  const assembler = new BlockAssembler()
  const control = AbortSignal.any([signal, AbortSignal.timeout(NAME_TIMEOUT_MS)])
  try {
    const options: GenerateOptions = {
      provider,
      model,
      system: NAME_INSTRUCTION,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt.slice(0, MAX_PROMPT_CHARS) }],
          source: { kind: 'user' },
        }),
      ],
      maxTokens: MAX_NAME_TOKENS,
      signal: control,
    }
    for await (const chunk of llm.stream(options)) assembler.push(chunk)
  } catch {
    return fallbackName()
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') return fallbackName()
  const slug = sanitizeName(
    assembler
      .blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
  )
  return slug === '' ? fallbackName() : slug
}

/* ------------------------------------------------------------ first message */

/**
 * The first message the user actually wrote.
 *
 * Only `user` sources count: injected context, notices and tool results all
 * arrive as `UserMessage` too, and naming a branch after them would describe
 * the harness rather than the task.
 * @param messages - the batch entering this step.
 * @returns the first non-blank human text, or undefined when there is none.
 */
function firstHumanText(messages: readonly { source: { kind: string }; content: readonly { type: string; text?: string }[] }[]): string | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/* --------------------------------------------------------------- deferred flow */

/**
 * Create the branch and checkout one Session owes, then move it there.
 *
 * Called from the accepted first step. The name is committed to the log before
 * Git runs, so a resumed turn reuses it. A mounted host worktree service is
 * preferred because it also owns the checkout pool and moves the Session
 * itself; otherwise this plugin's own Git path does both.
 * @param ctx - host plugin context.
 * @param agent - the Session's owner.
 * @param name - the chosen branch name.
 * @param cwd - directory to create the checkout from.
 * @param workingDirectory - the service that moves the Session.
 * @param signal - the turn's cancellation signal.
 * @returns the checkout path and branch.
 */
async function createCheckout(
  ctx: Context,
  agent: Agent,
  name: string,
  cwd: string,
  workingDirectory: WorkingDirectoryService,
  signal: AbortSignal,
): Promise<{ path: string; branch: string }> {
  const worktrees = ctx.get('worktrees') as WorktreeService | undefined
  if (worktrees !== undefined) {
    try {
      return await worktrees.create(agent, { name }, signal)
    } catch {
      // The name is the model's, so an existing branch is the ordinary
      // collision; one suffixed retry is enough to make it unique.
      return await worktrees.create(agent, { name: `${name}-${randomBytes(2).toString('hex')}` }, signal)
    }
  }
  const result = await createWorktree(cwd, name)
  if (!result.ok) throw new Error(result.error)
  await workingDirectory.set(agent, result.value.path, signal)
  return { path: result.value.path, branch: result.value.branch }
}

/**
 * Run the deferred worktree choice for one accepted step.
 *
 * Runs only on the first step of the first turn and only when the Session owes a
 * worktree. A `target` in the waiting marker names a checkout that already
 * exists, so the Session is moved there and nothing is created; without one the
 * branch is named after the user's message and a fresh checkout is made.
 *
 * Every failure is reported to the log and swallowed: the turn then runs in the
 * Session's original directory, which is the same place it would have run
 * without this plugin.
 * @param ctx - host plugin context.
 * @param agent - the Session's owner.
 * @param messages - the batch entering this step.
 * @param turn - the open turn number.
 * @param step - the step being proposed.
 * @param signal - the turn's cancellation signal.
 */
async function createDeferredWorktree(
  ctx: Context,
  agent: Agent,
  messages: Parameters<typeof firstHumanText>[0],
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<void> {
  if (turn !== 1 || step !== 1) return
  const session = agent.session
  const records = readWorktreeRecords(session)
  if (records.waiting === undefined || records.creation !== undefined) return

  const workingDirectory = ctx.get('workingDirectory') as WorkingDirectoryService | undefined
  if (workingDirectory === undefined) return

  if (records.waiting.target !== undefined) {
    // An existing checkout needs no name, and asking a model for one would only
    // delay the move. The marker is settled before the move, exactly like the
    // creation path below: the intent is attempted once, and leaving it armed
    // would make the picker keep naming a destination the Session never reaches.
    const target = records.waiting.target
    appendPluginRecord(session, CREATION, { name: basename(target) })
    const moved = await workingDirectory.set(agent, target, signal)
    ctx.logger.info('worktree-session: moved into %s', moved)
    return
  }

  const prompt = firstHumanText(messages)
  if (prompt === undefined) return

  const name = await chooseName(ctx.get('llm'), agent, prompt, signal)
  signal.throwIfAborted()
  appendPluginRecord(session, CREATION, { name })

  const created = await createCheckout(
    ctx,
    agent,
    name,
    workingDirectory.get(session),
    workingDirectory,
    signal,
  )
  ctx.logger.info('worktree-session: created %s at %s', created.branch, created.path)
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
  prepare: '/api/dsh-worktree/prepare',
} as const

/**
 * Build the plugin's HTTP routes.
 * @param ctx - host plugin context, for the Session store and the optional
 * services whose presence decides whether a worktree can be deferred at all.
 * @param connection - the composition's Connection service, whose trust fence
 * every request is put through before the route's own work begins.
 * @returns the routes to register.
 */
export function makeRoutes(ctx: Context, connection: HostConnectionHandle): WebRoute[] {
  /** Whether this deployment can move a Session at all. */
  const deferred = (): boolean => ctx.get('workingDirectory') !== undefined

  /**
   * Resolve one Session by id, or `undefined` when the id names none.
   *
   * Read through `ctx.get` rather than `ctx.sessions`: a route handler runs
   * outside the fiber that injected `sessions` for the pre-step listener, and
   * an un-injected property read on that context throws — the throw surfaces as
   * an empty 400 from the web server, which the composer renders as a failed
   * read. `get` asks the store instead of the property proxy.
   */
  const sessionOf = (sessionId: string | null | undefined): Session | undefined => {
    if (sessionId === null || sessionId === undefined || sessionId === '') return undefined
    const sessions = ctx.get('sessions')
    return sessions === undefined ? undefined : sessions.get(SessionId(sessionId))
  }

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
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const cwd = params.get('cwd')
        if (cwd === null || cwd === '') {
          writeJson(res, 400, { error: 'cwd is required' })
          return
        }
        const worktrees = await listWorktrees(cwd)
        const repoRoot = worktrees[0]?.path
        const sessionId = params.get('sessionId')
        const session = sessionOf(sessionId)
        const records = session === undefined ? undefined : readWorktreeRecords(session)
        writeJson(res, 200, {
          isRepo: repoRoot !== undefined,
          repoRoot: repoRoot ?? null,
          worktrees,
          // A Session can only be moved where the host owns the working
          // directory; the menu hides the deferred item when it cannot.
          deferred: deferred(),
          // Whether this Session already owes a worktree, so the menu can show
          // the pending state instead of offering the same item twice.
          waiting: records?.waiting !== undefined,
          // An existing checkout the Session is waiting to move into, so the
          // control can name it instead of reading "pending" after the pick.
          waitingTarget: records?.waiting?.target ?? null,
        })
      },
    },
    {
      kind: 'exact',
      path: API.prepare,
      handler: async (req, res) => {
        if (refuseUntrusted(connection, req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!deferred()) {
          writeJson(res, 409, { error: 'this deployment cannot move a Session working directory' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = body === undefined ? undefined : stringField(body, 'sessionId')
        const from = body === undefined ? undefined : stringField(body, 'from')
        const target = body === undefined ? undefined : stringField(body, 'target')
        if (sessionId === undefined || from === undefined) {
          writeJson(res, 400, { error: 'sessionId and from are required' })
          return
        }
        const session = sessionOf(sessionId)
        if (session === undefined) {
          writeJson(res, 404, { error: 'session not found' })
          return
        }
        markWaiting(session, from, target)
        writeJson(res, 200, { ok: true })
      },
    },
  ]
}

/**
 * Mount the deferred creation, the main-checkout warning, and the routes.
 *
 * The `agent/pre-step` and `fs/*-intent` listeners are registered
 * unconditionally: they read every optional service through `ctx.get` at call
 * time, so a deployment that mounts none of them still loads this plugin and
 * simply has nothing to do.
 *
 * `webServer` and `connection` are awaited through one nested `inject` rather
 * than read at apply time. A composed row order does not imply an activation
 * order, so a plain read can legitimately see `undefined` and silently drop the
 * routes; waiting on the services is the pattern the host's own Web-facing
 * plugins use. Keeping the `inject` nested is what lets a deployment with no
 * Web UI still load this plugin. `connection` is required alongside `webServer`
 * on purpose: these routes sit in front of Connection's `/api` prefix route, so
 * serving them without its fence would serve them unfenced.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  // File-class mutations are the only ones whose target arrives here already
  // resolved. A shell command's target is the string the model typed, where
  // guessing the paths it touches would warn on `cat` and miss `cd`.
  for (const [event, tool] of [
    ['fs/write-intent', 'write'],
    ['fs/edit-intent', 'edit'],
  ] as const) {
    ctx.on(
      event,
      async (target: unknown, actor: unknown, next: () => unknown) => {
        // A refusal (a stale version, an unread file) arrives as a rejection
        // here and must stay a refusal: nothing is warned about, and the tool
        // call fails exactly as it would without this plugin.
        const intent = await next()
        try {
          await warnMainCheckoutMutation(ctx, target, actor, tool)
        } catch (error) {
          // "Warn, never block" has to hold structurally. `processPath` belongs
          // to a filesystem backend this plugin does not own and may reject a
          // target it did not produce, so a throw here would abort a write the
          // peers just authorised.
          ctx.logger.warn('worktree-session: main checkout warning failed: %o', error)
        }
        return intent
      },
      // Outermost: the deciding peer ends the chain without calling `next()`,
      // so a listener registered behind it would never run.
      { prepend: true },
    )
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      await createDeferredWorktree(
        ctx,
        payload.agent,
        payload.messages,
        payload.turn,
        payload.step,
        payload.signal,
      )
    } catch (error) {
      // The turn must still run: it proceeds in the Session's original
      // directory, which is where it would have run without this plugin.
      ctx.logger.warn('worktree-session: deferred worktree creation failed: %o', error)
    }
    return decision
  })

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => {
      // Routes read the host's Session store and optional services from this
      // plugin's own context; only the two services the nested `inject` waited
      // for come from `webCtx`.
      const disposers = makeRoutes(ctx, webCtx.connection).map((route) => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'worktree-session: routes')
  })
}

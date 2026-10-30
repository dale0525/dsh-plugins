/**
 * Two things the host's session search does not do on its own.
 *
 * 1. **Prepare the index file before the host opens it.** The host creates its
 *    SQLite file lazily, at the first search, and never sets `auto_vacuum` — so
 *    the file starts with `auto_vacuum = 0` and can only ever grow. Rows for
 *    deleted sessions are removed, but the pages stay allocated: measured, a
 *    39 MB index stayed 39 MB after `DELETE FROM docs`. `auto_vacuum` can only
 *    be chosen before the first table exists, so the only way to get a
 *    self-shrinking index is to create the (empty) file first with
 *    `auto_vacuum = FULL`. Verified end to end: the host then opens that file,
 *    builds its own schema, keeps `auto_vacuum = 1`, and a full row delete
 *    shrinks 19.61 MB to 0.01 MB with no further help.
 *
 * 2. **Build the index at startup, not on the user's first query.** The host
 *    builds its index inside `_reconcile`, which it calls only from
 *    `searchSessions` / `searchEvents` — never at mount. With `openAt:
 *    first-search` that means the FIRST real query pays the entire cold build,
 *    synchronously, inside the tool call. Measured on this machine: 206 sessions,
 *    the build needs minutes, the tool call is cut at 30 s, and the abort
 *    discards the work — so the index stayed at 0 documents across two attempts
 *    and would never finish. `openAt: startup` does not help: `[Service.init]`
 *    only calls `_ensureReady`, which opens the file and creates the tables but
 *    does not reconcile anything. So this plugin calls `searchSessions` once,
 *    itself, after mount, with no tool-call deadline over it.
 *
 * 3. **Tell the model the one limit the tokenizer leaves.** A tool description
 *    that promises more than the backend delivers is worse than no description.
 *
 * `FULL` rather than `INCREMENTAL` because it needs no follow-up: the file
 * shrinks during the host's own `DELETE`, and this plugin never has to touch a
 * database the host is using. `INCREMENTAL` was measured to work too (39.21 MB
 * to 0.21 MB) but only after a separate `PRAGMA incremental_vacuum`, which would
 * mean running SQL inside the host's connection — and a full `VACUUM` fails
 * outright when another process holds the write lock (`ERR_SQLITE_ERROR`, with
 * the host's `busy_timeout` at 0).
 *
 * The patch row in `cordis.patch.yml` turns the index on; this half prepares the
 * file and annotates the tools.
 *
 * `systemPrompt` is deliberately NOT injected. Injection means "required", so a
 * host without that service would disable this plugin entirely — losing both
 * halves. This plugin only listens on `system-prompt/assemble`, never calls it.
 *
 * @module @logictan/dsh-session-search
 */

import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Plugin row id; must equal the `id` in `cordis.patch.yml`. */
export const name = 'session-search'

/** The two tools that run a full-text query, and therefore hit the tokenizer limit. */
const SEARCH_TOOLS = new Set(['session_search', 'session_event_search'])

/**
 * Where the index lives. Must match the `path` in `cordis.patch.yml`; the patch
 * cannot import from here, so the two are kept in step by a test.
 */
export function indexPath(): string {
  return dshHomePath('session-search/index.db')
}

/**
 * Create the index file with `auto_vacuum = FULL` if it does not exist yet.
 *
 * Deliberately does nothing when the file is already there: by then the setting
 * is frozen, and rewriting it would mean `VACUUM`, which needs a lock the host
 * may be holding. An existing index therefore keeps whatever mode it was born
 * with — for a file created before this plugin existed, that is `auto_vacuum = 0`,
 * and it will not shrink until it is deleted once and rebuilt.
 *
 * `application_id` is NOT set here: the host treats a file with its id but no
 * tables as its own, and validates the table set on open. An empty file with no
 * id is the shape it accepts for a fresh index.
 *
 * @param path - absolute index path.
 * @returns what happened, for logging and tests.
 */
export function prepareIndex(path: string = indexPath()): 'created' | 'exists' {
  if (existsSync(path)) return 'exists'
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    // Must precede the first table, or it is ignored until a VACUUM.
    db.exec('PRAGMA auto_vacuum = FULL')
    db.exec('PRAGMA journal_mode = WAL')
  } finally {
    db.close()
  }
  return 'created'
}

/**
 * Appended to the search tools' descriptions.
 *
 * Phrased as an instruction the model can act on, not as an apology: the useful
 * behaviour is to rephrase a short CJK query into a longer one, because that is
 * the only way to get an answer under this tokenizer.
 */
export const CJK_LIMIT_NOTE =
  'CJK (Chinese/Japanese/Korean) queries shorter than three characters do not work: the index ' +
  'tokenizer treats a whole run of CJK text as one token, so a two-character query such as ' +
  '「压缩」 finds only the documents where that run happens to be split by punctuation or Latin ' +
  'text, and usually finds nothing. Use three or more characters (「压缩上下文」), or switch to ' +
  'Latin keywords when the same content has them. Queries of three or more characters are exact.'

/**
 * Whether a tool entry is one of the full-text search tools.
 *
 * Matched on the trailing segment of the tool name so a namespaced registration
 * is recognised too, without matching an unrelated tool whose name merely
 * contains the substring.
 *
 * The names come from `@deepseek-ai/dsh-tool-session-query`, which registers five
 * tools: `session_search` and `session_event_search` run full-text queries (and
 * therefore hit the tokenizer limit); `session_trace`, `session_event_trace` and
 * `session_event_read` read by id or seq and never tokenize, so annotating them
 * would be noise. The read-only ones are deliberately excluded.
 *
 * @param tool - one entry of an assembled tool list.
 * @returns true when this entry runs a full-text query.
 */
export function isSessionSearchTool(tool: { name?: unknown }): boolean {
  if (typeof tool.name !== 'string') return false
  const segments = tool.name.split('__')
  return SEARCH_TOOLS.has(segments[segments.length - 1] ?? '')
}

/**
 * Append the CJK limit note to one tool description.
 *
 * Idempotent: re-assembling an already-annotated list must not stack the note,
 * because the host may assemble more than once per step.
 *
 * @param description - the tool's current description.
 * @returns the annotated description.
 */
export function annotate(description: string): string {
  if (description.includes(CJK_LIMIT_NOTE)) return description
  return `${description} ${CJK_LIMIT_NOTE}`
}

/**
 * A query that cannot match anything, used only to make the host reconcile.
 *
 * Any string works — `_reconcile` runs before the query is applied, so the
 * warm-up does not depend on what is searched. This one is chosen to be
 * obviously non-content if it ever shows up in a log.
 */
const WARMUP_QUERY = 'session-search warm-up'

/**
 * Build the index in the background, after mount.
 *
 * Deliberately not awaited by `apply`: mounting must stay instant, and a
 * minutes-long build must never block host startup. The promise is kept only so
 * tests can await it; production ignores the return value.
 *
 * Failure is swallowed on purpose. A broken index must degrade to "search
 * returns nothing", never to "the plugin took the session down" — the host's own
 * tool already surfaces real search errors when the user asks.
 *
 * @param engine - the mounted `sessionQuery` service.
 * @returns a promise that settles when the build finishes or fails.
 */
export async function warmUp(engine: {
  searchSessions: (request: { query: string; limit?: number }) => Promise<unknown>
}): Promise<'built' | 'failed'> {
  try {
    // `limit: 1` keeps the page small; the cost is the reconcile, not the page.
    await engine.searchSessions({ query: WARMUP_QUERY, limit: 1 })
    return 'built'
  } catch {
    return 'failed'
  }
}

/**
 * Prepare the index file, warm the index, and subscribe the annotation.
 *
 * The file is prepared at mount, which runs before the host's own index row
 * opens anything (`openAt: first-search` defers that to the first query), so
 * this is the only moment the setting can still be chosen.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx: {
  on(event: string, listener: (...args: any[]) => unknown): unknown
  get?(name: string): unknown
  inject?(deps: Record<string, unknown>, callback: (scoped: any) => void): unknown
}): void {
  // Never let a filesystem problem here disable the annotation: a read-only
  // home would otherwise take the tool descriptions down with it.
  try {
    prepareIndex()
  } catch {
    // The host will create the file itself, just without auto_vacuum.
  }

  // The service may not be up yet when this row mounts: `sessionQuery` comes
  // from a sibling row. Wait for it instead of assuming order, then build.
  // `get` is absent on a bare test context, which is why it is optional.
  const warm = (engine: unknown) => {
    void warmUp(engine as { searchSessions: (r: { query: string; limit?: number }) => Promise<unknown> })
  }
  const engine = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (engine !== undefined) warm(engine)
  else if (typeof ctx.inject === 'function') {
    // The service comes from a sibling row, so it may not be up when this row
    // mounts. `ctx.inject` runs the callback once it exists, which is the
    // documented way to depend on a service without hard-requiring it.
    ctx.inject({ sessionQuery: true } as any, (scoped: any) => warm(scoped.get('sessionQuery')))
  }

  ctx.on('system-prompt/assemble', async (assembly: any, _context: unknown, next: () => Promise<any>) => {
    const resolved = await next()
    if (!resolved || !Array.isArray(resolved.tools)) return resolved
    let touched = false
    const tools = resolved.tools.map((tool: any) => {
      if (!isSessionSearchTool(tool)) return tool
      touched = true
      return { ...tool, description: annotate(String(tool.description ?? '')) }
    })
    return touched ? { ...resolved, tools } : resolved
  })
}

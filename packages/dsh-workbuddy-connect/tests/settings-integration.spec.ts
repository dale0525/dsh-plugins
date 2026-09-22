/**
 * Host settings integration tests for the 0.1.7-alpha.1 settings redesign.
 *
 * What changed, and why this file looks the way it does:
 *
 *  - `dsh-settings` no longer keeps a namespace registry. There is no
 *    `installSection`, no per-variant section, and no `settings.get(ns)`: the
 *    service derives ONE form per loader entry from that entry's own `Config`,
 *    keyed by the entry id, and `describe()` reports the entry id as `ns`. Both
 *    variants therefore share a single namespace — this package's loader entry
 *    id — instead of one namespace each.
 *  - Every `Config` field is `volatile()`, which is what puts it in that form
 *    AND what makes `settings.update` accept it. A plain field is refused with
 *    `Config field "x" is not volatile`.
 *  - The Loader hands `apply` a `{ get() }` reference per field and commits a
 *    Plugins-page edit into the RUNNING plugin (`loader/volatile-update`)
 *    instead of remounting it, so a value edited after mount takes effect
 *    without a restart.
 *
 * THE REGRESSION GUARD. The toggle used to answer `settings are unavailable`
 * because the plugin called the removed `settings.installSection`, the throw
 * was swallowed, and the write callback was left undefined. The first case
 * below therefore drives the REAL probe-control route end to end — the same
 * request the card sends — and asserts the persisted write, not just that a
 * handler exists. A test that only inspected the schema would have passed on
 * the broken build.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'

/** The plugin row as the Loader mounts it: the entry id is the settings ns. */
const WORKBUDDY_PLUGIN = {
  name: WorkBuddy.name,
  inject: WorkBuddy.inject,
  Config: WorkBuddy.Config,
  apply: WorkBuddy.apply,
}

/** The key the Loader commits a Plugins-page edit through. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Stands in for the Host's `SettingsForms` service, narrowed to the seam the
 * plugin touches: a lazy `update(entryId, patch)`. The plugin reads it through
 * `ctx.get('settings')` rather than an `inject`, so a plain provided instance
 * is what it sees.
 */
class FakeSettings extends Service {
  readonly writes: Array<{ ns: string, patch: Record<string, unknown> }> = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  async update(ns: string, patch: object): Promise<void> {
    this.writes.push({ ns, patch: patch as Record<string, unknown> })
  }
}

/**
 * Collects the routes `apply()` registers, so the tests exercise the plugin's
 * REAL handlers instead of re-mounting them by hand.
 */
class FakeWebServer extends Service {
  readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

const cleanups: Array<() => Promise<void>> = []
let context: Context | undefined
let root: string | undefined

/** Serve captured routes over real HTTP so handlers see real req/res objects. */
async function serve(routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>): Promise<number> {
  const server: Server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404).end('{}'); return }
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return (server.address() as { port: number }).port
}

/** The real fetch, captured before any test stubs it. */
const realFetch = globalThis.fetch.bind(globalThis)

/**
 * Fail every UPSTREAM request while letting the test's own loopback calls to
 * the plugin's routes through: the plugin and the test share one global `fetch`,
 * so a blanket stub would also break the test's own requests to the route under
 * test.
 */
function offlineUpstream(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: unknown) => {
    const url = new URL(String(input))
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      ? await realFetch(input as string, init as RequestInit)
      : await Promise.reject(new Error('offline in tests'))
  }))
}

/** A desktop-shaped credential document for one upstream region. */
function credentialDocument(domain: string): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
  })
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const cleanup of cleanups.splice(0)) await cleanup()
  // `maxRetries`: disposing the fiber stops the sweep timer, but a catalog write
  // already in flight can still land just after it — the directory is then
  // momentarily non-empty and a bare `rm` fails with ENOTEMPTY. Retrying is the
  // documented handling for exactly that transient error, and keeps the failure
  // from being reported as a product defect.
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('WorkBuddy Host settings integration', () => {
  it('persists the context-window toggle through the real probe route, against the entry-keyed namespace', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-toggle-'))
    const aiFile = join(root, 'ai.info')
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    offlineUpstream()

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FakeSettings)
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(WORKBUDDY_PLUGIN, {})
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })

    const settings = ctx.get('settings') as unknown as FakeSettings
    const routes = (ctx.get('webServer') as unknown as FakeWebServer).routes
    const port = await serve(routes)

    // The key travels on the status document the card already fetches; this is
    // how the real card learns it.
    const status = await (await fetch(`http://127.0.0.1:${port}/plugins/dsh-workbuddy-connect/ai/status`)).json() as { probeKey?: string }
    expect(status.probeKey).toBeTypeOf('string')

    const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-workbuddy-connect/ai/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': status.probeKey! },
      body: JSON.stringify({ action: 'set-maximum-context-window', enabled: false }),
    })
    // THE REGRESSION. The broken build answered
    // `{state:'failed',reason:'settings are unavailable'}` here.
    expect(await response.json()).toEqual({ state: 'updated' })

    // The write named the LOADER ENTRY ID — which on 0.1.7-alpha.1 is also the
    // settings namespace — and carried the field the form renders.
    expect(settings.writes).toEqual([
      { ns: 'llm-workbuddy', patch: { useMaximumContextWindow: false } },
    ])
    expect(WorkBuddy.WORKBUDDY_SETTINGS_NS).toBe(WorkBuddy.name)
  })

  it('exposes both variants on the one entry-keyed namespace and keeps their rosters separate', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-dual-'))
    vi.stubEnv('DSH_HOME', root)
    // One real-shaped credential per product, in separate files. The upstream
    // fetch is stubbed to fail so the assertion covers the per-variant fallback
    // rosters rather than depending on the network.
    const cnFile = join(root, 'cn.info')
    const aiFile = join(root, 'ai.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WORKBUDDY_PLUGIN, {})

    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })

    // Both providers carry their own display name — the model group heading the
    // picker renders — and the SAME settings namespace. On 0.1.7-alpha.1 that
    // string is the loader entry id, and the Models page resolves it against the
    // entries the Host serves; the two variants are two products behind one row,
    // so a second id would be undispatched.
    expect(ctx.llm.listConfigurableProviders()).toEqual(expect.arrayContaining([
      { provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'llm-workbuddy', settingsPath: [], declared: false },
      { provider: 'workbuddy-ai', displayName: 'WorkBuddy AI', settingsNs: 'llm-workbuddy', settingsPath: [], declared: false },
    ]))

    // The two variants must not share a roster: the international models are
    // not reachable through the CN provider, and vice versa. A shared fallback
    // list would misdescribe one of them (different rates, windows, and
    // declared efforts).
    const cn = (await ctx.llm.listModels('workbuddy')).map(model => model.id)
    const ai = (await ctx.llm.listModels('workbuddy-ai')).map(model => model.id)
    expect(cn).toContain('minimax-m3')
    expect(ai).not.toContain('minimax-m3')
    expect(ai).toContain('gpt-5.6-luna')
    expect(cn).not.toContain('gpt-5.6-luna')
  })

  it('applies an edit committed into the running plugin without a remount', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-context-live-'))
    const aiFile = join(root, 'ai.info')
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(WORKBUDDY_PLUGIN, {})
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })

    // The schema default is on, so a profile that never touched the setting
    // resolves at the model's largest declared window.
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)

    // Commit an opt-out into the RUNNING plugin exactly as the Loader does for a
    // Plugins-page edit: through the live reference, with no remount. If the
    // value were captured at mount — or read from a snapshot — the model would
    // keep resolving at 1M and the toggle would look saved but do nothing.
    const live = fiber.config as unknown as Record<string, Record<symbol, (value: unknown) => void>>
    live['useMaximumContextWindow']![VOLATILE_WRITE]!(false)
    // Every value is committed before dispatch (the Loader's own contract), and
    // the event is what re-applies the settings a store or catalog cached.
    ctx.emit('loader/volatile-update', [['useMaximumContextWindow']])
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
    })
  })

  /**
   * With no credential present, a variant exposes nothing. This is the
   * deliberate behaviour change the plan calls out: the CN provider used to
   * publish 15 fallback models to a signed-out user, which offered models that
   * could only fail on the first message.
   */
  it('hides a variant with no usable credential while still registering it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-empty-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent-ai.info'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WORKBUDDY_PLUGIN, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])

    // The provider directory entry survives: the group is hidden by having no
    // models, not by unregistering, so a later sign-in needs no restart.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .toEqual(expect.arrayContaining(['workbuddy', 'workbuddy-ai']))
  })

  /**
   * A credential for the other product is refused, and the refusal is what the
   * card shows. Silently treating it as "signed out" would send the user to
   * re-authenticate when the actual fix is a file path.
   */
  it('refuses a cross-product credential instead of using it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-cross-'))
    vi.stubEnv('DSH_HOME', root)
    // The CN file is handed to the international provider, which is exactly the
    // misconfiguration a user can produce with authFileAI / the env var.
    const crossFile = join(root, 'wrong.info')
    await writeFile(crossFile, credentialDocument('copilot.tencent.com'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', crossFile)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WORKBUDDY_PLUGIN, {})

    const models = await (async () => {
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-ai')
      })
      return ctx.llm.listModels('workbuddy-ai')
    })()
    // Refused, so the group stays hidden rather than serving a roster the token
    // cannot actually reach.
    expect(models).toEqual([])
  })
})

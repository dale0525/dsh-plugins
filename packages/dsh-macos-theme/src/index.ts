/**
 * dsh-macos-theme — host half.
 *
 * The theme itself is browser-only: DSH resolves a theme through the client
 * `ctx.theme` service, whose token layers are inline CSS variables on
 * `document.body`, and the browser half ships via exports["./client"].
 *
 * The one host-side job is serving the chat typeface. Fira Code and LXGW WenKai
 * Mono are bundled with this package and delivered over HTTP rather than
 * inlined into `lib/client.js` (which would add ~1.7 MB to every client bundle
 * and to the module-loader payload). They cannot be served through the host's
 * `/plugins/` route either: that route is owned by `dsh-client-modules` and
 * serves only whitelisted `client*.js` bundles.
 *
 * So this half registers its own `prefix` route at {@link FONT_PREFIX}. It is
 * deliberately not under `/api`, because the host's trust fence
 * (`@deepseek-ai/dsh-client-connection`) registers `/api` as a *prefix* route and
 * the webserver checks the exact table before the prefix table — a plugin route
 * under `/api` would sort ahead of the fence and bypass it entirely. Instead the
 * fence is consulted per request, see {@link apply}.
 *
 * The second host-side job is trimming the `session/list` response, see
 * {@link SESSION_LIST_TRIM}.
 *
 * @module @logictan/dsh-macos-theme
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'

import Schema from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

/** Cordis companion plugin name. Must equal this plugin's `cordis.patch.yml` row id. */
export const name = 'macos-theme'

/**
 * Configuration surface of the theme.
 *
 * Exported from the package ENTRY, because that is where the settings service
 * looks (`entry.fiber.runtime.Config`); a schema exported only from a subpath
 * would be invisible and the plugin's row would simply have no form. The field
 * is `volatile()` so it stays editable without a remount — the Loader then
 * hands the browser half a live form instead of a frozen value.
 *
 * The value is read by the BROWSER half, not here: the chat typeface is applied
 * through CSS the browser half injects. The host half only declares the field,
 * so the two halves must agree on the key name.
 */
export const Config = Schema.object({
  /**
   * Whether the bundled Fira Code + LXGW WenKai Mono replace the host's chat
   * typeface. On by default, because the bundled faces are the whole point of
   * the design; turning it off restores the host's own font stack untouched.
   *
   * `comment` is the label the settings page renders and `description` the
   * sentence under it. They live here rather than in the browser half because
   * the card renders the schema: a label written in the card would be a second
   * place to keep in step, and the page would show the bare key if this one
   * were missing.
   */
  replaceChatFont: Schema.boolean()
    .default(true)
    .comment('替换字体')
    .description('用插件自带的 Fira Code + 落霞孤鹜等宽替换对话、代码块与输入框的字体。字体随插件一起提供，不依赖访问设备上装没装——关掉后恢复 DSH 原来的字体。')
    .volatile(),
})

/** Prefix the browser half's `@font-face` rules point at. Never under `/api`. */
const FONT_PREFIX = '/dsh-macos-theme/fonts'

/**
 * The served font files, keyed by exact request path segment.
 *
 * An exact-match map rather than a path join: the request segment *is* the key,
 * so no name that is not listed here can ever reach the filesystem, and there is
 * no traversal to defend against.
 */
const FONT_FILES = new Map<string, string>([
  ['FiraCode-VF.woff2', 'font/woff2'],
  ['LXGWWenKaiMono-GB.woff2', 'font/woff2'],
  ['LXGWWenKaiMono-Medium-GB.woff2', 'font/woff2'],
])

/** Resolved next to this module's build output (`lib/`), so `../assets/fonts/`. */
const FONT_DIR = new URL('../assets/fonts/', import.meta.url)

/**
 * Projection keys the SESSION LIST is allowed to keep.
 *
 * `session/list` returns every visible Session with its whole projection block,
 * and the block is what a conversation needs — not what a list row needs. On
 * this machine that is 3.1 MB for 1875 Sessions, of which `turnOutline` alone
 * (one entry per turn, `prompt` and `response` text included) is 1.0 MB,
 * `imageLimits` 233 KB and `modelSelection` 197 KB. A row shows a title, a
 * timestamp and a running dot.
 *
 * The kept keys are the ones a list row or the rail actually reads. Everything
 * else arrives again, in full, from the per-Session projection stream when the
 * Session is opened — `useProjection` subscribes to the OPEN conversation, so
 * trimming the list cannot starve the chat view.
 */
const SESSION_LIST_KEEP = ['title', 'workingDirectory', 'sessionListMetadata', 'subagentCatalog', 'agentPreset', 'subagent', 'subagentTiming'] as const

/**
 * Head script that trims each `session/list` response before the app parses it.
 *
 * A head injection, not a plugin-side `fetch` wrapper: the RPC transport binds
 * `globalThis.fetch` when its module initialises, so a wrapper installed later
 * from this plugin's browser half never sees the call. Measured — a patch from
 * the plugin observed 4 calls (all an unrelated plugin's polling) while the real
 * `session/list` went through untouched. `webserver/index-inject` rows render
 * into `<head>` ahead of every application script, which is the only placement
 * that wins that race.
 *
 * It must stay a no-op on anything unexpected: a response that is not the
 * envelope it recognises, a failed parse, or an absent `items` array is returned
 * untouched, because a broken list would cost far more than 2 MB.
 */
function sessionListTrimScript(): string {
  return `(() => {
  const KEEP = ${JSON.stringify(SESSION_LIST_KEEP)}
  const native = globalThis.fetch
  if (typeof native !== 'function') return
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const pending = native.apply(this, arguments)
    if (url.indexOf('/api/session/list') < 0) return pending
    return pending.then((response) => {
      if (!response.ok) return response
      return response.clone().text().then((text) => {
        let trimmed = text
        try {
          const body = JSON.parse(text)
          const items = body && body.result && body.result.value && body.result.value.items
          if (!Array.isArray(items)) return response
          for (const item of items) {
            const values = item && item.projections && item.projections.values
            if (!values || typeof values !== 'object') continue
            for (const key of Object.keys(values)) {
              if (KEEP.indexOf(key) < 0) delete values[key]
            }
          }
          trimmed = JSON.stringify(body)
        } catch {
          return response
        }
        return new Response(trimmed, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      })
    })
  }
})()`
}

/**
 * Page budget this plugin asks for when the chat loads older history.
 *
 * The app opens a Session with `maxMessages: 500` and keeps it for every
 * "load older" page. Measured on a 28 MB Session at one fixed `beforeSeq`, that
 * budget returns 3993 KB / 1675 records, of which a handful of long assistant
 * messages dominate; the same page at 120/50 is 1415 KB / 766 records. `hasMore`
 * stays true either way, so the reader simply pages a few more times.
 *
 * Both numbers move together on purpose: the Host's `paginate` validates
 * `turnWindow.minMessages <= maxMessages` and rejects the request otherwise, so
 * lowering only the cap would make every page fail. `minTurns: 2` is kept
 * because it is what stops a page on a Turn boundary instead of mid-turn.
 */
const HISTORY_PAGE_BUDGET = { maxMessages: 120, turnWindow: { minMessages: 50, minTurns: 2 } } as const

/**
 * Head script that lowers the history-page budget on the way out.
 *
 * This is a request rewrite, not a response trim: `session/page` takes the page
 * budget as a parameter, so asking for less is both smaller on the wire and
 * cheaper on the Host than receiving 9 MB and discarding most of it.
 *
 * Head injection for the same reason as the list trim — the RPC transport binds
 * `globalThis.fetch` at module initialisation, so anything installed from this
 * plugin's browser half misses the call entirely.
 *
 * Every path that is not the exact request it knows about is forwarded
 * untouched: a body that fails to parse, a body without `payload.args.request`,
 * or an error while re-encoding. A dropped page would leave the reader unable
 * to scroll back at all, which is far worse than one large page.
 */
function historyPageBudgetScript(): string {
  return `(() => {
  const BUDGET = ${JSON.stringify(HISTORY_PAGE_BUDGET)}
  const native = globalThis.fetch
  if (typeof native !== 'function') return
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.indexOf('/api/session/page') < 0) return native.apply(this, arguments)
    const body = init && typeof init.body === 'string' ? init.body : null
    if (body === null) return native.apply(this, arguments)
    let rewritten
    try {
      const message = JSON.parse(body)
      const request = message && message.payload && message.payload.args && message.payload.args.request
      if (!request || typeof request !== 'object') return native.apply(this, arguments)
      if (typeof request.maxMessages !== 'number') return native.apply(this, arguments)
      request.maxMessages = BUDGET.maxMessages
      request.turnWindow = BUDGET.turnWindow
      rewritten = JSON.stringify(message)
    } catch {
      return native.apply(this, arguments)
    }
    return native.call(this, input, { ...init, body: rewritten })
  }
})()`
}

interface ServedFont {
  readonly body: Buffer
  readonly etag: string
}

/**
 * Read each font at most once, and only when it is first requested.
 *
 * The two files total ~1.7 MB, so they are held in memory after the first hit
 * rather than re-read per request; reading lazily keeps plugin load free of I/O.
 * The ETag is derived from size and mtime, which is what makes the revalidating
 * `cache-control` below correct across a plugin upgrade that changes the file.
 */
const fontCache = new Map<string, Promise<ServedFont>>()

function loadFont(file: string): Promise<ServedFont> {
  const cached = fontCache.get(file)
  if (cached !== undefined) return cached
  const pending = (async (): Promise<ServedFont> => {
    const url = new URL(file, FONT_DIR)
    const [body, info] = await Promise.all([readFile(url), stat(url)])
    return { body, etag: `"${info.size}-${Math.floor(info.mtimeMs)}"` }
  })()
  fontCache.set(file, pending)
  return pending
}

/** One response, always with the hardening headers this route wants. */
function respond(res: ServerResponse, status: number, headers: Record<string, string>, body?: Buffer): void {
  res.writeHead(status, { 'referrer-policy': 'no-referrer', ...headers })
  res.end(body)
}

/**
 * Host plugin body — serve the bundled chat typeface.
 *
 * `webServer` is injected scoped rather than declared as a top-level `inject`
 * entry: an unsatisfiable `inject` silently drops the *whole* plugin (the
 * browser half included), and a host that composes no webserver should lose only
 * the fonts, not the theme.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: FONT_PREFIX,
          handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
            // Consulted per request, never captured: the fence is an optional
            // service, and reading it fresh is what lets a host that composes
            // none fail closed instead of taking the plugin down at load.
            const connection = webCtx.get('connection') as HostConnectionHandle | undefined
            const rejection = connection?.requestRejection(req)
            if (rejection !== undefined || connection === undefined) {
              respond(res, 403, { 'content-type': 'text/plain; charset=utf-8' })
              return
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              respond(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
              return
            }
            const segment = new URL(req.url ?? '/', 'http://dsh.invalid').pathname.slice(FONT_PREFIX.length + 1)
            const type = FONT_FILES.get(segment)
            if (type === undefined) {
              respond(res, 404, { 'content-type': 'text/plain; charset=utf-8' })
              return
            }
            let font: ServedFont
            try {
              font = await loadFont(segment)
            } catch {
              respond(res, 404, { 'content-type': 'text/plain; charset=utf-8' })
              return
            }
            const headers = {
              'content-type': type,
              etag: font.etag,
              // Revalidate rather than serve blind: the URL carries no version,
              // so a long `max-age` would pin a stale font after an upgrade.
              'cache-control': 'no-cache',
            }
            if (req.headers['if-none-match'] === font.etag) {
              respond(res, 304, headers)
              return
            }
            respond(res, 200, headers, req.method === 'HEAD' ? undefined : font.body)
          },
        }),
      'macos-theme: fonts',
    )
  })

  /* The list-payload trim rides the webserver's own injection hook, which the
     theme plugin also uses, so it needs no route and no trust fence of its own:
     it only adds markup to index responses the Host already decided to serve.
     Registered unconditionally rather than inside the `webServer` scope, because
     `index-inject` is an event, not a service — injecting `webServer` for it
     would turn "no webserver here" into "no theme at all". `ctx.on` already
     returns the disposer cordis ties to this plugin's fiber, so it is called
     directly, exactly as every Host listener of this event does. */
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({ kind: 'script', placement: 'head', text: sessionListTrimScript() })
    table.push({ kind: 'script', placement: 'head', text: historyPageBudgetScript() })
  })
}

/**
 * Host half of dsh-better-reasoning-effort.
 *
 * One job: settings auto-adaptation. Whenever the `llm-pi-ai` section gains a
 * hand-declared model that carries no `reasoningEfforts`, fill one in from the
 * knowledge base + protocol inference (see {@link suggestEfforts}). The fill
 * is a *suggestion* written to the user layer — the user can still edit it on
 * the Models page — and a model that already declares efforts, or an explicit
 * `false`, is never touched. All interactive editing (per-model editors and
 * per-model auto-adapt) lives in the browser half, which reuses the same
 * knowledge base as a pure module.
 *
 * ## Reading the pi-ai section (0.1.7-alpha.1 and later)
 *
 * The host no longer has a per-namespace settings registry. `dsh-settings` now
 * derives one configuration FORM per active loader entry from that entry's own
 * `Config` schema, keyed by the entry id, and `describe()` is the only read —
 * the former `settings.get(namespace)` is gone. This plugin's reads and writes
 * therefore address the pi-ai ENTRY (`llm-pi-ai`), which is the same string the
 * old settings namespace used, so the wire namespace and the entry id coincide.
 * See {@link piEntry} for the read and {@link Config} for why this plugin's own
 * schema now doubles as its configuration surface.
 *
 * @module dsh-better-reasoning-effort
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer service merge into this program's Context.
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { AUTOFILL_CONFIG_PATH, PI_AI_NS, PLUGIN_ID, PROBE_PATH } from './constants.js'
import { suggestEfforts } from './knowledge.js'
import type { ReasoningEfforts } from './knowledge.js'
import { resolveGuardEffort } from './guard.js'
import { isRecord, looksLikeCompatRefusal, routeFactsOf } from './shared.js'
// The knowledge-base patch builder lives in its own module: the browser half
// builds the SAME patch from its own idle-time read, so one suggestion can
// never produce two different documents.
import { buildAutofillPatch, stripNewCompatKeysDeep } from './autofill.js'

/** Re-exported so the package entry keeps naming the patch builder. */
export { buildAutofillPatch }

/**
 * The `settings` service as the 0.1.7-alpha.1 host provides it — the
 * `SettingsForms` class — declared structurally instead of imported.
 *
 * Two reasons, both load-bearing:
 *
 *  1. This workspace type-checks against the 0.1.6-alpha.2 harness generation
 *     while the deployed host is 0.1.7-alpha.1. `@deepseek-ai/dsh-settings`
 *     types `ctx.settings` through a `declare module '@deepseek-ai/cordis'`
 *     merge, and the 0.1.6 merge describes the REMOVED registry: it types
 *     `settings.get(namespace)` as callable — the very call that stopped
 *     existing and produced `settings.get is not a function` at boot. A
 *     generation-pinned import would therefore re-hide the bug it caused.
 *  2. The two members below are the whole seam this plugin touches, so a host
 *     change to that seam lands as a compile error HERE rather than as a
 *     mistyped call that only fails at runtime.
 */
interface SettingsFormsLike {
  /** One descriptor per ACTIVE loader entry, keyed by entry id in `ns`. */
  describe(): SettingsDescriptorLike[]
  /** Merge editable fields into the entry's config; `ns` is the entry id. */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** One entry's descriptor, as `SettingsForms.describe()` reports it. */
interface SettingsDescriptorLike {
  /** Loader entry id — the string that used to name a settings namespace. */
  ns: string
  /** Schema-resolved config of the entry. */
  value?: unknown
  /** Raw user layer as stored (the profile patch's own `config` block). */
  user?: unknown
  /** Revision fencing the next write. */
  revision: number
}

/** Stable plugin id, matching the cordis.patch.yml row and the bundle id. */
export const name = PLUGIN_ID

/**
 * Hard dependencies: the loader waits for these before calling apply.
 *
 * `settings` still names a real service on 0.1.7-alpha.1 — it is the
 * `SettingsForms` service now (see {@link piEntry}) rather than the removed
 * per-namespace registry, but the name is unchanged, so this declaration
 * survives the generation boundary untouched. That is also why this plugin
 * never showed up as `pending (waiting for service: …)` in the boot audit.
 */
export const inject = ['settings']

/**
 * The loader entry that owns the pi-ai settings section, which is also the key
 * its configuration form is filed under.
 *
 * 0.1.7-alpha.1 removed the settings-namespace registry: `dsh-settings` now
 * derives a form from `entry.fiber.runtime.Config`, keyed by the loader entry
 * id (`SettingsForms.describe()` reports it as `ns`). The two identities
 * coincide here because the base bundle mounts the owning package as
 * `- id: llm-pi-ai` (`@deepseek-ai/dsh-base/cordis.patch.yml`), and that row's
 * `Config` is the `providers` schema this plugin reads and fills.
 */
const PI_NS = PI_AI_NS

/**
 * Exponential backoff for the boot fill: llm-pi-ai may register its namespace
 * well after this plugin on a slow start, and registration emits no event of
 * its own — the schedule must outlast a realistically slow profile instead of
 * giving up after a few flat seconds.
 */
const BOOT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

/** Probe fetch budget: a gateway that cannot answer /models in 15s will not answer the composer either. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Plugin configuration — and, as of the 0.1.7-alpha.1 settings redesign, the
 * ONE schema behind every configuration surface.
 *
 * `dsh-settings` no longer keeps a namespace registry: it derives the
 * Plugins-page form for a loader entry from that entry's own `Config`, keyed by
 * the entry id (this package's {@link name}). Marking every field `volatile()`
 * is what puts it in that form — a field left plain still configures the plugin
 * through `cordis.patch.yml`, but the Plugins page could neither show nor edit
 * it, and `SettingsForms.describe()` would silently skip the whole entry.
 *
 * The row's `config` in `cordis.patch.yml` is therefore no longer a
 * "composition layer" the plugin merges a settings section over: it IS the
 * entry's config, and the Plugins page edits that same entry. One layer, no
 * precedence rule left to get wrong.
 */
export interface Config {
  /** Auto-fill undeclared pi-ai models on boot and after settings updates (default true). */
  autofill?: boolean
  /**
   * Whether the auto-fill above also fills the input-modality declaration
   * (default true). Effort auto-fill is governed by {@link autofill} alone.
   */
  modalityAutofill?: boolean
  /** Upstream fetch timeout for the raw /models probe route, in milliseconds (default 15000). */
  probeTimeoutMs?: number
  /**
   * Boot-fill retry backoff schedule in milliseconds; an empty list means
   * "try exactly once" (default [1000, 2000, 4000, 8000, 16000, 30000]).
   */
  bootRetryDelaysMs?: number[]
  /**
   * Rewrite effort-less calls to forced-thinking ladders into the ladder's
   * vendor default (default true). Only the request class that today becomes
   * `thinking: {type: disabled}` on a ladder that cannot switch thinking off
   * is rewritten (issue #2); everything else passes through byte-identical.
   */
  defaultGuard?: boolean
}

/**
 * Schemastery schema: Cordis validates the row config and fills defaults before
 * apply().
 *
 * The explicit `Schema<Config>` annotation is load-bearing, not decoration: a
 * bare `export const Config = Schema.object({…})` fails to emit declarations
 * (TS2742) whenever two schemastery copies are in the program, which is exactly
 * the situation here — the profile ships one copy and this package's
 * `dependencies` entry pulls its own `^3.18.3`.
 *
 * `.volatile()` needs schemastery ≥ 3.18.3, and the marker survives the copy
 * boundary because the reference protocol is `Symbol.for('cosmokit.volatile.write')`
 * and the host's `volatileForm` / `isVolatilePath` duck-type `meta.volatile`.
 */
export const Config: Schema<Config> = Schema.object({
  autofill: Schema.boolean().default(true).volatile(),
  modalityAutofill: Schema.boolean().default(true).volatile(),
  probeTimeoutMs: Schema.natural().min(1).default(PROBE_TIMEOUT_MS).volatile(),
  bootRetryDelaysMs: Schema.array(Schema.natural().min(1)).default([...BOOT_RETRY_DELAYS_MS]).volatile(),
  defaultGuard: Schema.boolean().default(true).volatile(),
})

/**
 * A live reference to one volatile field, as the Loader hands it to `apply`.
 *
 * Declared structurally rather than imported: `Volatile` is a `cordis` 4.0.3
 * export while this package declares `^4.0.2`, so naming the vendor type here
 * would narrow the peer range for a cosmetic gain.
 */
export interface ConfigRef<T> {
  /** The field's value right now; re-read on every call. */
  get(): T
}

/** Resolved config: every field carries its validated default. */
type ResolvedConfig = Required<Config>

/**
 * The live references `apply` receives, one per {@link Config} field.
 *
 * Cordis's Loader replaces every `volatile()` field of a plugin's `Config` with
 * a reference of this shape, so a value the user edits on the Plugins page is
 * committed into the RUNNING plugin (`loader/volatile-update`) instead of
 * remounting it. Reading through `.get()` at the point of use is therefore what
 * makes an edit take effect without a restart — see {@link currentConfig}.
 */
export type ConfigRefs = { [K in keyof ResolvedConfig]: ConfigRef<ResolvedConfig[K]> }

interface CredentialsService {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/** WHATWG-parse a Host/Origin authority (`host` or `host:port`). */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG special scheme: parsing yields a hostname or throws,
    // and normalizes casing the raw header keeps. Note the hostname of an
    // IPv6 authority KEEPS its brackets (`[::1]`) — the literal check below
    // deliberately matches on the colon.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a parsed hostname is an IP literal (IPv4 dotted quad, or IPv6 whose
 * brackets URL parsing already stripped). A browser fills Host from the URL it
 * believes it is talking to, so a DNS-rebound page ALWAYS carries the
 * attacker's domain here — it can never produce an IP-literal Host short of
 * the user genuinely navigating to that IP.
 */
function isIpLiteralHostname(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
}

/**
 * Browser trust fence for the probe route. It mirrors the core /api fence's
 * DEFENSE (packages/client/connection/src/api-request-trust.ts) minus one
 * feature: there is no `trustedHosts` escape hatch yet.
 *
 *   - Cross-site requests are refused outright; a same-origin/same-site
 *     marker never ADMITS anything by itself.
 *   - An attached Origin must name exactly this authority; the literal
 *     `null` (sandboxed iframe, file: page) is refused.
 *   - The Host fence binds every request and is the rebinding defense:
 *     only loopback names and IP literals are answered. A rebound page
 *     names the attacker's DOMAIN in Host even though the socket lands on
 *     this server, so named hosts are always 403.
 *
 * The route proxies only endpoints the user's own settings already name, but
 * it does so with the stored credential attached — so it must not be callable
 * from elsewhere. LAN deployments serving the GUI under a DOMAIN name get 403
 * here by design (IP-literal LAN hosts keep working); see README known
 * limitations until a trustedHosts seam exists.
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const secFetchSite = req.headers['sec-fetch-site']
  if (secFetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    if (origin === 'null') return false
    try {
      if (new URL(origin).host !== hostUrl.host) return false
    } catch {
      return false
    }
  }
  const hostname = hostUrl.hostname.toLowerCase()
  return isLoopbackHostname(hostname) || isIpLiteralHostname(hostname)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * A URL safe to echo in responses: a baseURL may carry userinfo
 * (https://user:pass@host), and failure messages must never repeat it.
 */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return raw
  }
}

/**
 * Probe-listing URL, mirroring the harness's own model discovery:
 * OpenAI-compatible protocols list at
 * `{baseURL}/models`; Anthropic Messages uses its native route at
 * `{root}/v1/models?limit=1000`, where the root is the base without trailing
 * slashes and without one trailing `/v1` segment (gateway documentation
 * publishes both spellings of the same root). Only this listing URL
 * normalizes that segment.
 */
function probeListingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/** Protocols whose model listing this module can read (the harness discovery set). */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page accepted by Anthropic's public endpoint. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Compose the raw-models probe request's headers, mirroring the discipline of
 * the harness's own model discovery: the provider
 * profile's configured request headers form the base (deployment-owned
 * credentials like `x-api-key` ride along), `accept` is always JSON, and a
 * resolved credential's Bearer overwrites a profile `authorization` — which
 * survives only when no credential resolves (a route may authenticate through
 * its configured headers alone). Anthropic Messages answers through
 * `x-api-key` plus a fixed `anthropic-version`, and its Bearer arm is never
 * used (a profile `authorization` survives untouched there, exactly as the
 * official discovery leaves it). Entries Fetch would refuse are dropped
 * rather than failing the probe. Harness attribution headers are deliberately
 * not sent — this is a same-origin diagnostic, not a harness request.
 * @param profileHeaders - the profile's raw `headers` dict (simply absent
 *   on older documents).
 * @param apiKey - the resolved credential, when one resolved.
 * @param api - the profile's wire protocol.
 */
export function composeProbeHeaders(
  profileHeaders: unknown,
  apiKey: string | undefined,
  api: string,
): Record<string, string> {
  const headers = new Headers()
  if (isRecord(profileHeaders)) {
    for (const [name, value] of Object.entries(profileHeaders)) {
      if (typeof value !== 'string') continue
      try {
        headers.set(name, value)
      } catch {
        // Unrepresentable as a Fetch header: skip the entry, keep probing.
      }
    }
  }
  headers.set('accept', 'application/json')
  if (api === 'anthropic-messages') {
    headers.set('anthropic-version', ANTHROPIC_VERSION)
    if (apiKey !== undefined) headers.set('x-api-key', apiKey)
  } else if (apiKey !== undefined) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }
  return Object.fromEntries(headers.entries())
}

/**
 * Read a listing reply body, refusing one that outgrows the ceiling (the same
 * bound the official discovery applies). A declared length is checked first
 * so an honest server is turned away without transferring anything; the
 * accumulated total is what actually enforces the bound.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error(`${displayUrl(url)} overshoots the ${MAX_RESPONSE_BYTES}-byte listing ceiling`)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error(`${displayUrl(url)} overshoots the ${MAX_RESPONSE_BYTES}-byte listing ceiling`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/** Largest listing reply the probe accepts (same bound as official discovery). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * Normalize a supported listing reply into one entry array, mirroring the
 * official parser: the standard `data` array takes precedence; the
 * enriched `models` map uses each property key as the endpoint-facing id
 * (the nested `id` only falls back for an empty key — gateways may put a
 * canonical identity there instead of the alias they accept on requests);
 * only object-valued map entries are models, and entries without a usable id
 * are dropped. Returns undefined when the listing names neither shape.
 */
function listingEntries(body: unknown): Record<string, unknown>[] | undefined {
  const listing = isRecord(body) ? body : {}
  const data = listing['data']
  if (Array.isArray(data)) return data.filter(isRecord)
  const models = listing['models']
  if (isRecord(models)) {
    return Object.entries(models)
      .filter(([, raw]) => isRecord(raw))
      .map(([key, raw]) => {
        // The map key is the endpoint-facing id, but an EMPTY key falls back
        // to the entry's own id exactly as the official parser's
        // label(key, entry.id) does — gateways may put the canonical identity
        // there instead of the alias they accept on requests.
        const entry = raw as Record<string, unknown>
        const ownId = typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : ''
        return { ...entry, id: key.length > 0 ? key : ownId }
      })
      .filter(entry => typeof entry['id'] === 'string' && entry['id'].length > 0)
  }
  return undefined
}

/**
 * The llm-service surface the default-guard wraps: only the two dispatch
 * entries, typed structurally so no new dependency is needed.
 */
interface LlmDispatchLike {
  prepareCall(config: Record<string, unknown>, signal?: unknown): Promise<Record<string, unknown>>
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

/**
 * Fill one call config with the vendor default when it names no effort and
 * its declared ladder cannot switch thinking off (issue #2).
 *
 * Reads the resolved pi-ai section (never the user layer -- this only reads).
 * Fails open: any unreadable shape returns the config untouched, reproducing
 * today's behavior exactly.
 */
function guardCallConfig(cfg: Record<string, unknown>, section: unknown): Record<string, unknown> {
  try {
    if (typeof cfg['reasoningEffort'] !== 'undefined') return cfg
    const provider = cfg['provider']
    const modelId = cfg['model']
    if (typeof provider !== 'string' || typeof modelId !== 'string') return cfg
    if (!isRecord(section)) return cfg
    const providers = section['providers']
    if (!isRecord(providers)) return cfg
    const profile = providers[provider]
    if (!isRecord(profile)) return cfg
    const rawModels = profile['models']
    if (!Array.isArray(rawModels)) return cfg
    const row = rawModels.find((candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate['id'] === modelId)
    if (row === undefined || !isRecord(row['reasoningEfforts'])) return cfg
    const profileDefault = typeof profile['reasoning'] === 'string' ? profile['reasoning'] : undefined
    const facts = routeFactsOf({ providers: { [provider]: profile } }, provider)
    const suggestion = suggestEfforts(modelId, facts)
    const level = resolveGuardEffort({
      declared: row['reasoningEfforts'] as ReasoningEfforts,
      vendorDefault: suggestion.defaultEffort,
      profileDefault,
      requested: undefined,
    })
    return level === undefined ? cfg : { ...cfg, reasoningEffort: level }
  } catch {
    return cfg
  }
}

/**
 * Apply the plugin: autofill undeclared models on boot, guard effort-less calls
 * on forced-thinking ladders, and serve the browser half's probe route.
 *
 * @param ctx - host context.
 * @param config - the live references the Loader hands over, one per
 *   {@link Config} field (every field is `volatile()`, so none arrives as a
 *   plain value). Read through {@link currentConfig} at the point of use.
 */
export function apply(ctx: Context, config: ConfigRefs): void {
  /**
   * The effective configuration, resolved fresh at every use.
   *
   * Cordis commits a Plugins-page edit into the RUNNING plugin
   * (`loader/volatile-update`) rather than remounting it, so a value captured
   * once at mount would make the page's own save a silent no-op. Every gate
   * below therefore reads the flag when it decides, not when it was installed:
   * `autofill` is re-checked per pass, `defaultGuard` per call, and
   * `probeTimeoutMs` per request.
   */
  const currentConfig = (): ResolvedConfig => ({
    autofill: config.autofill.get(),
    modalityAutofill: config.modalityAutofill.get(),
    probeTimeoutMs: config.probeTimeoutMs.get(),
    bootRetryDelaysMs: config.bootRetryDelaysMs.get(),
    defaultGuard: config.defaultGuard.get(),
  })

  // Module-level `inject` already guarantees the settings service; using it
  // directly (instead of a redundant inner ctx.inject) keeps one dependency
  // declaration as the single source of truth.
  const settings = (ctx as unknown as { settings: SettingsFormsLike }).settings

  /**
   * The pi-ai entry's descriptor, or undefined while that entry is not
   * readable.
   *
   * This is the 0.1.7-alpha.1 replacement for the removed
   * `settings.get(namespace)`. A settings namespace is no longer a value store
   * with a getter: it is a FORM, derived from `entry.fiber.runtime.Config` and
   * keyed by the loader entry id, and `describe()` is the only read. The
   * descriptor carries the resolved config as `value`, the raw layers as
   * `user` / `base`, and the revision that fences the next write.
   *
   * An undefined answer is also how an entry that is not ready yet presents
   * itself — `describe()` skips entries whose fiber has not reached `active`,
   * whose `Config` is not reachable from the package entry, or that declares no
   * volatile field at all. That is precisely the "not registered yet" state the
   * boot retry below waits out.
   */
  const piEntry = (): SettingsDescriptorLike | undefined =>
    settings.describe().find(entry => entry.ns === PI_NS)

  // The probe route (registered below) reads the pi-ai section through this
  // closure slot.
  const piSection = (): unknown => piEntry()?.value

  // The autofill machinery is installed unconditionally and the `autofill`
  // switch is read per pass (see {@link autofillOnce}): gating the install on
  // the value at mount would make a Plugins-page edit one-way, since the boot
  // schedule it controls would already exist -- or not -- for the rest of the
  // fiber's life. This block only scopes the helpers.
  {
    /** One autofill pass; resolves false while the pi-ai entry is not readable. */
    const autofillOnce = async (): Promise<boolean> => {
      // A disabled fill is "settled", not "not ready": returning false here
      // would put the boot retry into a backoff loop for a plugin that has
      // nothing to do. The check is live, so turning the switch off on the
      // Plugins page stops the next pass without a restart.
      const resolved = currentConfig()
      if (!resolved.autofill) return true
      const descriptor = piEntry()
      if (!isRecord(descriptor?.value)) return false
      // Build the patch from the RAW USER layer, never the resolved value:
      // the fill merges into the user document, and building from the
      // resolved view would materialize schema defaults / composition-base
      // models into it wholesale the moment pi-ai grows such layers for its
      // profile. An entry whose user section holds no providers has
      // nothing this plugin may fill.
      const user = descriptor?.user
      const userProviders = isRecord(user) && isRecord(user['providers']) ? user['providers'] : undefined
      if (userProviders === undefined) return true
      const fullPatch = buildAutofillPatch(userProviders, () => true, { modalities: resolved.modalityAutofill }, descriptor?.revision ?? 0)
      if (fullPatch === undefined) return true
      // Optimistic lock: only write while the entry has not moved past this
      // read. The fill is a background suggestion -- losing the race to a
      // user edit is fine; a later boot, or the browser half's idle pass,
      // simply fills whatever is still undeclared. Without the lock every fill
      // would bump the revision and invalidate the one the settings page read,
      // surfacing as SettingsConflictError on the next user save.
      try {
        await settings.update(PI_NS, fullPatch, descriptor?.revision)
      } catch (error) {
        const msg = String(error instanceof Error ? error.message : error)
        if (!looksLikeCompatRefusal(msg)) throw error
        const stripped = stripNewCompatKeysDeep(fullPatch)
        if (stripped === undefined) throw error
        await settings.update(PI_NS, stripped, piEntry()?.revision)
      }
      return true
    }

    /** Auto-fill must never break the settings pipeline; log and move on. */
    const logFailure = (error: unknown): void => {
      console.error(`[dsh-better-reasoning-effort] autofill failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Pending boot-retry timers, cleared with the fiber (a disposed plugin
    // must not fire into a torn-down service graph).
    const timers = new Set<ReturnType<typeof setTimeout>>()
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }, 'dsh-better-reasoning-effort: boot-fill retries')

    // Fill once at boot for models declared before this plugin was installed,
    // backing off exponentially while llm-pi-ai has not registered yet. The
    // schedule is read per attempt, so a Plugins-page edit to it applies to the
    // retries that have not fired yet.
    const bootFill = (attempt: number): void => {
      void autofillOnce().then((ready) => {
        const delays = currentConfig().bootRetryDelaysMs
        if (ready || attempt >= delays.length) return
        const timer = setTimeout(() => {
          timers.delete(timer)
          bootFill(attempt + 1)
        }, delays[attempt])
        timers.add(timer)
      }, logFailure)
    }
    bootFill(0)

    // Deliberately NOT re-run on `settings/updated`. The boot pass is safe
    // (no settings surface is open yet); a fill the moment a commit lands is
    // not: the official Models card freezes its own revision baseline while it
    // is open, so a background write there makes the user's very next save in
    // that card fail with `settings/conflict` and their edit reads as lost
    // (issue #7). The browser half carries the running complement instead: it
    // builds this SAME patch and writes it on its idle pass, once no card is
    // open. A headless composition has no editing surface to break and no
    // browser half either -- boot covers it.
  }

  // Default-guard (issue #2): wrap the llm dispatch entries so effort-less
  // calls to forced-thinking ladders ride the ladder's vendor default instead
  // of the wire's off-equivalent. Deferred inject: the wrap lands whenever
  // the llm service registers, and ctx.effect restores the originals on
  // dispose (disable/HMR leaves no trace).
  //
  // The wrap is installed unconditionally and the switch is read per call: a
  // `defaultGuard` edit on the Plugins page must take effect without a restart,
  // and installing the wrap lazily from a live flag would leave a plugin
  // switched off at mount permanently unwrapped. With the switch off the
  // wrapper hands the original arguments straight through, so the deployment
  // that disabled it sees the same call it always did.
  ctx.inject(['llm'], (llmCtx) => {
    const llm = (llmCtx as unknown as { llm?: unknown }).llm as LlmDispatchLike | undefined
    if (llm === undefined || typeof llm.prepareCall !== 'function' || typeof llm.stream !== 'function') return
    // Unbound originals: restore assigns back the exact references, and
    // dispatch keeps the service as receiver through .call.
    const origPrepare = llm.prepareCall
    const origStream = llm.stream
    const guarded = (callConfig: Record<string, unknown>): Record<string, unknown> =>
      currentConfig().defaultGuard ? guardCallConfig(callConfig, piSection()) : callConfig
    llm.prepareCall = (callConfig, signal) => origPrepare.call(llm, guarded(callConfig), signal)
    llm.stream = (options) => origStream.call(llm, guarded(options))
    ctx.effect(() => () => {
      llm.prepareCall = origPrepare
      llm.stream = origStream
    }, 'dsh-better-reasoning-effort: default-guard')
  })

  // Same-origin probe route: the browser half's Auto-adapt asks the endpoint's
  // RAW /models listing through here, because the sanctioned llm wire call
  // strips reasoning signals host-side. The credential resolves server-side
  // and never echoes back; only routes the user's own settings name are
  // reachable, and the trust fence rejects cross-site callers.
  ctx.inject(['webServer'], (webServerCtx) => {
    ctx.effect(
      () =>
        webServerCtx.webServer.register({
          kind: 'exact',
          path: PROBE_PATH,
          handler: async (req, res) => {
            if (!isTrustedRequest(req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://x')
            const route = url.searchParams.get('route') ?? ''
            const section = piSection()
            const profile = isRecord(section) && isRecord(section['providers'])
              ? section['providers'][route]
              : undefined
            if (!isRecord(profile)) {
              sendJson(res, 400, { ok: false, error: `no llm-pi-ai provider route "${route}"` })
              return
            }
            const baseURL = typeof profile['baseURL'] === 'string' ? profile['baseURL'] : ''
            if (baseURL.length === 0) {
              sendJson(res, 400, { ok: false, error: `provider route "${route}" has no baseURL` })
              return
            }
            // The profile's wire protocol selects the listing route and the
            // credential arm, exactly as the official discovery decides them:
            // only the protocols whose listing this mirror can read are
            // interrogated; everything else reports that it cannot.
            const api = typeof profile['api'] === 'string' ? profile['api'] : ''
            if (api.length === 0) {
              sendJson(res, 400, {
                ok: false,
                error: `provider route "${route}" names no API protocol to interrogate`,
              })
              return
            }
            if (!LISTABLE_PROTOCOLS.has(api)) {
              sendJson(res, 400, {
                ok: false,
                error: `protocol "${api}" cannot be interrogated; enter this provider's models by hand`,
              })
              return
            }
            const apiKeyEnv = typeof profile['apiKeyEnv'] === 'string' ? profile['apiKeyEnv'] : undefined
            const listingURL = probeListingUrl(baseURL, api)
            let apiKey: string | undefined
            if (apiKeyEnv !== undefined) {
              try {
                const credentials = ctx.get('credentials') as CredentialsService | undefined
                const hit = credentials === undefined ? undefined : await credentials.resolve(apiKeyEnv)
                apiKey = hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0
                  ? hit.value
                  : undefined
              } catch {
                // Unresolvable credential: probe unauthenticated rather than fail.
              }
            }
            try {
              const upstream = await fetch(listingURL, {
                method: 'GET',
                // Header composition mirrors the harness's own model discovery:
                // the profile's configured request headers ride
                // along, so a deployment that authenticates through a custom
                // header probes here exactly as it lists officially — and an
                // Anthropic endpoint answers through x-api-key + a fixed
                // anthropic-version instead of a Bearer.
                headers: composeProbeHeaders(profile['headers'], apiKey, api),
                // A probe carries the user's stored credential, so it must
                // reach exactly the authority the profile names: Fetch's
                // default would FOLLOW a cross-origin redirect, and the
                // headers composed here (`x-api-key`, a profile's own auth
                // header) are not stripped on that hop the way `authorization`
                // is. Official discovery keeps the default; this route is
                // stricter on purpose, and the cost is bounded — a gateway
                // that lists only behind a redirect yields no endpoint
                // evidence, so Auto-adapt falls back to the knowledge base /
                // protocol inference, the path every unanswerable endpoint
                // takes.
                redirect: 'error',
                signal: AbortSignal.timeout(currentConfig().probeTimeoutMs),
              })
              if (!upstream.ok) {
                const hint = upstream.status === 401 || upstream.status === 403 ? '; check the API key' : ''
                sendJson(res, 502, { ok: false, error: `${displayUrl(listingURL)} answered ${upstream.status}${hint}` })
                return
              }
              const text = await readBounded(upstream, listingURL)
              let body: unknown
              try {
                body = JSON.parse(text) as unknown
              } catch {
                sendJson(res, 502, { ok: false, error: `${displayUrl(listingURL)} answered with a malformed JSON body` })
                return
              }
              // The official parser accepts the standard `data` array and the
              // enriched `models` map; entries are passed through verbatim so
              // the browser half sees the raw capability signals the sanctioned
              // wire call strips.
              const entries = listingEntries(body)
              if (entries === undefined) {
                sendJson(res, 502, {
                  ok: false,
                  error: `${displayUrl(listingURL)} model listing has neither a "data" array nor a "models" object`,
                })
                return
              }
              sendJson(res, 200, { ok: true, url: displayUrl(listingURL), data: entries })
            } catch (error) {
              sendJson(res, 502, {
                ok: false,
                error: `could not reach ${displayUrl(listingURL)}: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          },
        }),
      'dsh-better-reasoning-effort: raw-models probe route',
    )

    // The autofill switches, for the browser half that runs the running
    // complement. Read-only and same-origin only, like the probe above: a
    // `dsh.client` declaration carries no plugin config, so without this route
    // a deployment configured `autofill: false` would still be written to from
    // the settings page.
    ctx.effect(
      () =>
        webServerCtx.webServer.register({
          kind: 'exact',
          path: AUTOFILL_CONFIG_PATH,
          handler: async (req, res) => {
            if (!isTrustedRequest(req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            // Read live: the browser half polls this route to decide whether
            // its running auto-fill complement may write, so a Plugins-page
            // toggle must be visible to it on the next poll, not the next boot.
            const resolved = currentConfig()
            sendJson(res, 200, {
              ok: true,
              data: { autofill: resolved.autofill, modalityAutofill: resolved.modalityAutofill },
            })
          },
        }),
      'dsh-better-reasoning-effort: autofill config route',
    )
  })
}

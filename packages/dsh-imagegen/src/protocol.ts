/**
 * Wire contract shared by the host and client halves of dsh-imagegen: the
 * settings namespace, the route paths, and the generate payload/result shapes.
 * Pure types + constants 鈥?safe for the client bundle to inline.
 */

/** Settings namespace this plugin owns (host settings seam + bridge). */
export const IMAGEGEN_SETTINGS_NAMESPACE = 'imagegen'

/** Published package version shared by the host updater and the client UI. */
export const PLUGIN_VERSION = '1.5.13'

/** Same-origin route family (loopback-only, mirroring the dsh-ssh fence). */
export const SETTINGS_API = {
  describe: '/api/dsh-imagegen/settings/describe',
  mutate: '/api/dsh-imagegen/settings/mutate',
} as const

/** Subscription account login and status routes. */
export const SUBSCRIPTION_API = {
  status: '/api/dsh-imagegen/subscription/status',
  login: '/api/dsh-imagegen/subscription/login',
} as const

/** Official/subscription-backed image providers. */
export const SUBSCRIPTION_PROVIDERS = ['chatgpt-sub', 'grok-sub', 'google-sub', 'openrouter-sub'] as const
export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number]

/** Transport protocol a channel uses to reach its gateway. */
export type ChannelProtocol = 'images' | 'chat-completions'

/** Stored preference: auto keeps old channels on images unless the URL is explicit. */
export type ChannelProtocolPreference = 'auto' | ChannelProtocol

/** Whether an endpoint URL explicitly names an OpenAI-compatible chat route. */
export function isChatCompletionsUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  try {
    return /\/chat\/completions\/?$/.test(new URL(trimmed).pathname)
  } catch {
    return /\/chat\/completions\/?$/.test(trimmed.split(/[?#]/, 1)[0] ?? '')
  }
}

/** Whether a stored value is one of the accepted protocol preferences. */
export function isChannelProtocolPreference(value: unknown): value is ChannelProtocolPreference {
  return value === 'auto' || value === 'images' || value === 'chat-completions'
}

/** Resolve a channel preference without changing legacy behavior by default. */
export function resolveChannelProtocol(apiUrl: string, preference: ChannelProtocolPreference | undefined = 'auto'): ChannelProtocol {
  if (preference === 'images' || preference === 'chat-completions') return preference
  return isChatCompletionsUrl(apiUrl) ? 'chat-completions' : 'images'
}

/** Subscription channels with a fixed image model. */
export const DEFAULT_SUBSCRIPTION_MODELS: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'gpt-image-2.5-flare',
  'grok-sub': 'grok-imagine-image-2.0',
  'google-sub': 'gemini-3-pro-image',
  'openrouter-sub': 'google/gemini-3-pro-image',
}

/** Human-facing provider names used in status and errors. */
export const SUBSCRIPTION_PROVIDER_DISPLAY_NAMES: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'ChatGPT 订阅',
  'grok-sub': 'Grok 订阅',
  'google-sub': 'Google 订阅',
  'openrouter-sub': 'OpenRouter 账号',
}

/** Interfaces that are supported experimentally and should be labelled in the UI. */
export const EXPERIMENTAL_SUBSCRIPTION_PROVIDERS: ReadonlySet<SubscriptionProvider> = new Set(['chatgpt-sub', 'google-sub'])

/** Whether a raw string names one of the subscription providers. */
export function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return typeof value === 'string' && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value)
}

/** The image-generation proxy route. */
export const GENERATE_API = '/api/dsh-imagegen/generate'

/** Host-mediated OpenAI-compatible prompt enhancement endpoints. */
export const PROMPT_ENHANCE_API = {
  models: '/api/dsh-imagegen/prompt-enhance/models',
  enhance: '/api/dsh-imagegen/prompt-enhance',
} as const

/** Host-mediated candidate discovery for the configured image API. */
export const IMAGE_MODEL_API = {
  models: '/api/dsh-imagegen/image-models',
} as const

/** Host-served built-in provider catalog (channels the user can instantiate). */
export const PRESETS_API = '/api/dsh-imagegen/presets' as const

/** Loopback-only image reader for Agent tool-result previews. */
export const AGENT_IMAGE_API = '/api/dsh-imagegen/agent-image' as const

/** Store the current composer image for the direct edit_image command. */
export const CONVERSATION_IMAGE_API = '/api/dsh-imagegen/conversation-image' as const

/** Host-resident generation queue endpoints. */
export const TASK_API = {
  submit: '/api/dsh-imagegen/tasks/submit',
  list: '/api/dsh-imagegen/tasks/list',
  get: '/api/dsh-imagegen/tasks/get',
  cancel: '/api/dsh-imagegen/tasks/cancel',
  retry: '/api/dsh-imagegen/tasks/retry',
} as const

/** Generation modes. */
export type GenerateMode = 'text' | 'edit'

/** A client → host generate request (what the panel collects). */
export interface GenerateRequest {
  /** text-to-image (images/generations) or image-to-image (images/edits). */
  mode: GenerateMode
  /**
   * User-facing model name (an alias from the channel's model catalog). The
   * host maps it onto the configured channel and fills `upstream` with the
   * real id before the engine sees it.
   */
  model: string
  /** The prompt. Upstream providers may impose their own length limits. */
  prompt: string
  /** Canvas size as an aspect ratio: 'auto' or e.g. '1:1' / '16:9' / '21:9'.
   *  The host maps it onto each model's own vocabulary (aspect_ratio for Grok
   *  and Nano Banana, resolution-tier size for Seedream, the closest pixel size for
   *  OpenAI-compatible endpoints). */
  size: string
  /** Clarity tier: 'auto' | '1k' | '2k' | '4k'. The host maps it onto the
   *  model's own vocabulary (resolution for Grok, image_size for Nano Banana,
   *  and size for Seedream,
   *  Nano Banana, quality for OpenAI). */
  quality: string
  /** Number of images, 1-4. */
  n: number
  /**
   * Passthrough detail parameter: '' (omit), 'standard', or 'high'. Some
   * gpt-image-2 gateways expose it; official OpenAI endpoints reject unknown
   * parameters, so the UI defaults to '' (omit).
   */
  detail: string
  /** Reference image as a data URL (edit mode only). */
  image?: string
  /** Additional reference images as data URLs (edit mode only). The first
   *  image stays in `image`; providers that accept several references get them
   *  all, single-reference providers see `image` alone. */
  images?: string[]
  /** Original reference-image name, retained in the history entry. */
  refName?: string
  /** Channel this request targets (the host falls back to the default when
   *  absent, and re-routes by model alias when the alias lives elsewhere). */
  channelId?: string
  /** Channel display name snapshot, kept on the history entry (host-filled). */
  channel?: string
  /** Upstream model id actually sent to the gateway (host-filled from the
   *  alias mapping; defaults to `model` when absent). */
  upstream?: string
}

/** One generated image, normalized host-side to base64 so the browser never
 *  has to fetch the upstream (no CORS, no key exposure). */
export interface GeneratedImage {
  /** Raw base64 payload (no data: prefix). */
  b64: string
  /** MIME type of the payload, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** Successful generate outcome. */
export interface GenerateResult {
  images: GeneratedImage[]
}

/**
 * One model mapping in a channel's catalog: the display alias the user, the
 * panel, and the Agent see, and the upstream model id actually sent to the
 * gateway. The alias defaults to the upstream id but can be renamed freely.
 */
export interface ModelMapping {
  /** User-facing model name (defaults to the upstream id). */
  alias: string
  /** Upstream model id sent to the gateway. */
  id: string
}

/**
 * One configured image channel (provider). Secrets never live here — the API
 * key is stored at `channelSecrets.<channelId>` in the settings document so
 * whole-array writes can never clobber keys the user did not re-enter.
 */
export interface ChannelConfig {
  /** Stable channel id (the channelSecrets dict is keyed by it). */
  id: string
  /** Preset provider id this channel was created from ('' = custom). */
  preset: string
  /** Display name shown in the list, the panel, and Agent guidance. */
  name: string
  /** OpenAI-compatible base URL, or the exact generation URL when apiUrlFull is true. */
  apiUrl: string
  /** Use apiUrl verbatim instead of appending /images/generations or /images/edits. */
  apiUrlFull: boolean
  /** Request protocol; 'auto' infers chat-completions from an exact chat URL. */
  protocol?: ChannelProtocolPreference
  /** Authentication source; absent means the legacy API-key path. */
  auth?: 'api-key' | 'subscription'
  /** Subscription provider when auth is subscription. */
  subscription?: SubscriptionProvider
  /** The channel's model catalog (alias → upstream id). */
  models: ModelMapping[]
}

/** One built-in provider as the settings card consumes it. */
export interface PresetProviderView {
  id: string
  name: string
  apiUrl: string
  hint: string
  models: ModelMapping[]
  /** Set for subscription-backed presets. */
  subscription?: SubscriptionProvider
  /** True when the subscription relies on an undocumented interface. */
  experimental?: boolean
}

export type GenerationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface GenerationTask {
  id: string
  request: GenerateRequest
  status: GenerationTaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: GenerateResult
  error?: string
}

/**
 * Wire shape for the queue poll. Reference-image and result payloads stay
 * host-side; the client hydrates a completed task once through TASK_API.get.
 */
export interface GenerationTaskSummary extends Omit<GenerationTask, 'result'> {
  resultAvailable: boolean
}

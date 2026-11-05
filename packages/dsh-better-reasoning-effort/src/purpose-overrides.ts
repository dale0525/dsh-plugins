import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Pure contract shared by the purpose-model editor and its tests.
 *
 * The editor reads every selectable model from the RAW USER layer of
 * `llm-pi-ai.providers`, never from the resolved catalog: the resolved view
 * mixes shipped and catalog-discovered entries into the same shape, so it
 * cannot answer "which models did this deployment configure".
 */

/** Namespaces whose plugin rows own one auxiliary model selection. */
export const PURPOSE_NAMESPACES = {
  compaction: 'verbatim-compaction-purpose',
  worktreeBranch: 'worktree-session',
} as const

/** A purpose the editor exposes; the stored row key is different on purpose. */
export type Purpose = 'compaction' | 'worktreeBranch'

/** The three optional scalars stored on each owning plugin's Config row. */
export interface PurposeOverride {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** One model the user configured on a provider route. */
export interface ConfiguredModel {
  provider: string
  model: string
  efforts: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined

/**
 * Read user-configured models, paired with their provider route.
 *
 * `reasoningEfforts` may be `false`, a dict of level → wire value, or absent;
 * only dict keys are selectable levels. The resolved `value` layer is never
 * consulted, because it contains built-in/catalog models with no provenance.
 */
export function configuredModelsOf(describeValue: unknown): ConfiguredModel[] {
  const namespaces = isRecord(describeValue) && Array.isArray(describeValue['namespaces'])
    ? describeValue['namespaces']
    : []
  const namespace = namespaces.find((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry['ns'] === 'llm-pi-ai')
  if (namespace === undefined || !isRecord(namespace['user'])) return []
  const providers = namespace['user']['providers']
  if (!isRecord(providers)) return []

  const out: ConfiguredModel[] = []
  for (const [provider, rawProfile] of Object.entries(providers)) {
    if (provider.length === 0 || !isRecord(rawProfile) || !Array.isArray(rawProfile['models'])) continue
    for (const rawModel of rawProfile['models']) {
      if (!isRecord(rawModel)) continue
      const model = nonEmptyString(rawModel['id'])
      if (model === undefined) continue
      const declared = rawModel['reasoningEfforts']
      const efforts = isRecord(declared) ? Object.keys(declared) : []
      out.push({ provider, model, efforts })
    }
  }
  return out
}

/** The effort levels of one configured provider/model pair. */
export function effortsOf(models: readonly ConfiguredModel[], provider: string, model: string): string[] {
  return models.find(entry => entry.provider === provider && entry.model === model)?.efforts ?? []
}

/** Read one namespace's stored override from its resolved `value` layer. */
export function overrideOf(describeValue: unknown, namespace: string): PurposeOverride {
  const namespaces = isRecord(describeValue) && Array.isArray(describeValue['namespaces'])
    ? describeValue['namespaces']
    : []
  const row = namespaces.find((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry['ns'] === namespace)
  const value = isRecord(row) && isRecord(row['value']) ? row['value'] : {}
  return {
    ...(typeof value['provider'] === 'string' && value['provider'] !== '' ? { provider: value['provider'] } : {}),
    ...(typeof value['model'] === 'string' && value['model'] !== '' ? { model: value['model'] } : {}),
    ...(typeof value['reasoningEffort'] === 'string' && value['reasoningEffort'] !== ''
      ? { reasoningEffort: value['reasoningEffort'] }
      : {}),
  }
}

/** The revision that fences the next mutate for one namespace. */
export function revisionOf(describeValue: unknown, namespace: string): number | undefined {
  const namespaces = isRecord(describeValue) && Array.isArray(describeValue['namespaces'])
    ? describeValue['namespaces']
    : []
  const row = namespaces.find((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry['ns'] === namespace && typeof entry['revision'] === 'number')
  return isRecord(row) && typeof row['revision'] === 'number' ? row['revision'] : undefined
}

/** All data the footer editor needs from one settings describe answer. */
export interface PurposeState {
  models: ConfiguredModel[]
  overrides: Record<Purpose, PurposeOverride>
  revisions: Record<Purpose, number | undefined>
  writable: boolean
}

/** Build the editor's complete state from one describe answer. */
export function purposeStateOf(describeValue: unknown): PurposeState {
  const writable = typeof describeValue === 'object' && describeValue !== null
    && (describeValue as { writable?: unknown })['writable'] === true
  return {
    models: configuredModelsOf(describeValue),
    overrides: {
      compaction: overrideOf(describeValue, PURPOSE_NAMESPACES.compaction),
      worktreeBranch: overrideOf(describeValue, PURPOSE_NAMESPACES.worktreeBranch),
    },
    revisions: {
      compaction: revisionOf(describeValue, PURPOSE_NAMESPACES.compaction),
      worktreeBranch: revisionOf(describeValue, PURPOSE_NAMESPACES.worktreeBranch),
    },
    writable,
  }
}

/** An override's provider/model must both be present to form a route. */
export function pairedRoute(override: PurposeOverride): { provider: string; model: string } | undefined {
  const provider = nonEmptyString(override.provider)
  const model = nonEmptyString(override.model)
  return provider !== undefined && model !== undefined ? { provider, model } : undefined
}

/** Apply an override to a base call. An incomplete pair leaves the route alone. */
export function applyPurposeOverride<T extends Record<string, unknown>>(
  options: T,
  override: PurposeOverride,
): T {
  const route = pairedRoute(override)
  const effort = nonEmptyString(override.reasoningEffort)
  if (route === undefined && effort === undefined) return options
  return {
    ...options,
    ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  } as T
}

/** Path-addressed edits that store exactly one purpose override, unsetting blanks. */
export function purposeOps(override: PurposeOverride): SettingsPathOpView[] {
  const route = pairedRoute(override)
  const provider = route?.provider
  const model = route?.model
  const effort = nonEmptyString(override.reasoningEffort)
  return (['provider', 'model', 'reasoningEffort'] as const).flatMap<SettingsPathOpView>((field) => {
    const value = field === 'provider' ? provider : field === 'model' ? model : effort
    return value === undefined
      ? [{ op: 'unset', path: [field] }]
      : [{ op: 'set', path: [field], value }]
  })
}

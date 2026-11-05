import Schema from '@deepseek-ai/schemastery'

/** Settings namespace for the optional model override used by compaction. */
export const name = 'verbatim-compaction-purpose'

/** A live reference Cordis hands over for a volatile Config field. */
export interface ConfigRef<T> { get(): T }

/** The three editable scalars; empty strings mean "follow the chat model". */
export const Config = Schema.object({
  provider: Schema.string().default('').volatile(),
  model: Schema.string().default('').volatile(),
  reasoningEffort: Schema.string().default('').volatile(),
})

/** The shape of the live configuration Cordis passes to the plugin. */
export interface PurposeConfig {
  provider?: ConfigRef<string>
  model?: ConfigRef<string>
  reasoningEffort?: ConfigRef<string>
}

/**
 * The compaction engine runs inside isolated preset groups, while this
 * settings row lives in the root realm. A module-level live reference is the
 * one channel both halves can see without registering a second service.
 */
let liveConfig: PurposeConfig | undefined

export function setLiveConfig(config: PurposeConfig): void {
  liveConfig = config
}

export function getLiveConfig(): PurposeConfig | undefined {
  return liveConfig
}

/** Root-realm settings row. It registers no service. */
export function apply(_ctx: unknown, config: PurposeConfig): void {
  setLiveConfig(config)
}

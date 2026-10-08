/**
 * The mapping from credential-backed settings paths to credential refs.
 *
 * This is a pure module on purpose. The settings bridge (`routes.ts`) must
 * classify a submitted path as credential-backed *before* it decides whether to
 * forward it to the settings seam, and it must reach the same verdict on a host
 * that composes no credential provider — otherwise a key write would fall
 * through to the settings document, which is exactly the plaintext leak this
 * mapping exists to prevent. So the mapping is a pure function that needs no
 * provider, and `routes.ts` can import it without a cycle back into `index.ts`.
 *
 * `role('secret')` is NOT protection: it redacts a value from settings *reads*,
 * while the plaintext still lands in `cordis.patch.yml`, which the config-sync
 * `plugins` adapter exports verbatim.
 */

/** Credential reference holding the prompt-enhancement endpoint's API key. */
export const PROMPT_KEY_REF = 'DSH_IMAGEGEN_PROMPT_KEY'

/**
 * The credential ref holding one channel's API key.
 *
 * The channel id is folded into the ref name because refs must match
 * `/^[A-Za-z_][A-Za-z0-9_]*$/` — a channel id is usually a UUID, whose hyphens
 * are outside that grammar. The fold is lossy in principle (two ids differing
 * only in punctuation collide), but ids are generated UUIDs, so the
 * transformation is injective over the values actually in use.
 *
 * @param channelId - the channel's stable id.
 * @returns the credential reference name.
 */
export function channelKeyRef(channelId: string): string {
  return `DSH_IMAGEGEN_CHANNEL_${channelId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * The credential ref backing a settings path, or `undefined` when the path is an
 * ordinary config field that belongs in the settings document.
 *
 * Only the two key-bearing families are diverted. The legacy flat `apiKey` field
 * is deliberately NOT diverted: it is a plaintext field being retired, so its
 * `unset` must reach the settings seam to actually delete the stored value.
 *
 * @param path - a settings path op's path segments.
 * @returns the credential ref, or `undefined` for a config field.
 */
export function credentialRefForPath(path: readonly string[]): string | undefined {
  if (path.length === 1 && path[0] === 'promptApiKey') return PROMPT_KEY_REF
  if (path.length === 2 && path[0] === 'channelSecrets' && path[1] !== undefined && path[1] !== '') {
    return channelKeyRef(path[1])
  }
  return undefined
}

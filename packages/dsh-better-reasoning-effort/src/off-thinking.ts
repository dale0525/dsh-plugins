/**
 * Off-effort wire completion, PURE half: what to add to a request body whose
 * effort is "off", and which routes have such an off level at all.
 *
 * Why this exists: pi-ai dispatches "thinking off" by `compat.thinkingFormat`
 * and emits exactly ONE spelling — `reasoning_effort: <off value>` for the
 * openai branch, `thinking: {type: 'disabled'}` for the deepseek branch. A
 * gateway in front of several upstreams does not always honour the same one:
 * measured against magpie, `reasoning_effort: 'none'` alone sometimes left the
 * upstream thinking (the reasoning content then ate the whole token budget),
 * while `thinking: {type: 'disabled'}` reliably stopped it.
 *
 * So a request whose effort is off carries BOTH spellings. Only the second one
 * is added here, and only where the route already declares an off wire value:
 * a route that says nothing about reasoning is left byte-identical, because a
 * `thinking` field is a 400 on upstreams that do not know it.
 *
 * @module dsh-better-reasoning-effort/off-thinking
 */

import { isRecord } from './shared.js'

/** origin → the off wire values its routes declare. */
export interface OffWireIndex {
  byOrigin: Map<string, string[]>
}

/** The `thinking` value that means "do not think", as deepseek-style APIs spell it. */
export const THINKING_DISABLED = { type: 'disabled' } as const

/** An empty index, for the "no route declares an off level" case. */
export function emptyOffWireIndex(): OffWireIndex {
  return { byOrigin: new Map() }
}

/** The off wire values one route's models declare, deduplicated. */
function offValuesOf(profile: Record<string, unknown>): string[] {
  const models = profile['models']
  if (!Array.isArray(models)) return []
  const values: string[] = []
  for (const model of models) {
    if (!isRecord(model)) continue
    const efforts = model['reasoningEfforts']
    if (!isRecord(efforts)) continue
    const off = efforts['off']
    if (typeof off === 'string' && off !== '' && !values.includes(off)) values.push(off)
  }
  return values
}

/**
 * Build the origin index from the resolved `providers` dict of the pi-ai
 * namespace.
 *
 * Keyed by the endpoint's origin for the same reason the user-agent index is:
 * the fetch seam sees a URL and nothing else, and an origin compare cannot be
 * fooled by a host being a prefix of another.
 * @param providers - the `llm-pi-ai` providers dict, as stored.
 * @returns the index; routes with no endpoint or no off value are absent.
 */
export function buildOffWireIndex(
  providers: Record<string, Record<string, unknown>>,
): OffWireIndex {
  const index = emptyOffWireIndex()
  for (const profile of Object.values(providers)) {
    const values = offValuesOf(profile)
    if (values.length === 0) continue
    const endpoint = typeof profile['baseURL'] === 'string' ? profile['baseURL'] : undefined
    if (endpoint === undefined) continue
    let origin: string
    try {
      origin = new URL(endpoint).origin
    } catch {
      // A relative or malformed endpoint is not an origin this seam can match.
      continue
    }
    const existing = index.byOrigin.get(origin) ?? []
    for (const value of values) if (!existing.includes(value)) existing.push(value)
    index.byOrigin.set(origin, existing)
  }
  return index
}

/**
 * The body a request should carry: the caller's own fields, plus
 * `thinking: {type: 'disabled'}` when its effort already resolved to one of the
 * route's off wire values and no thinking field is present.
 *
 * A body that names any OTHER effort is returned unchanged: that request is
 * asking to think, and the off spelling would contradict it.
 * @param body - the parsed JSON request body.
 * @param offValues - the off wire values the route declares.
 * @returns the body to send, or undefined when nothing should change.
 */
export function withOffThinking(
  body: Record<string, unknown>,
  offValues: readonly string[],
): Record<string, unknown> | undefined {
  if (body['thinking'] !== undefined) return undefined
  const effort = body['reasoning_effort']
  if (typeof effort !== 'string' || !offValues.includes(effort)) return undefined
  return { ...body, thinking: { ...THINKING_DISABLED } }
}

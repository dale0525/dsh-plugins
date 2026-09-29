/**
 * Provider-agnostic reasoning strip.
 *
 * The harness records an assistant turn losslessly: a `reasoning` content block
 * holds the provider's own chain of thought, and `source.replayState` holds the
 * native replay metadata that describes it. Both are replayed verbatim on the
 * next request. A provider that treats reasoning as a first-class replay field
 * then re-reads its own earlier thinking as though it were fresh context, which
 * is what produces degenerate "Okay. / Now. / Tool call." continuation loops.
 *
 * This plugin removes the reasoning block -- and the replay block describing it
 * -- from every assistant message just before an adapter sees the request. The
 * session log, the transcript and the UI keep the reasoning; only what is sent
 * upstream changes. Removing a block that carried nothing else leaves an empty
 * message, which is dropped: `Session.deriveEventMessage` already returns
 * `null` for zero-length assistant content, so the request stays a pure
 * function of the session log.
 *
 * The seam is `LlmRuntime.forAdapter`, the host's own last rewrite before
 * adapter dispatch. It is the only seam that can rewrite `messages` at all:
 *
 *   - the `llm/stream` waterfall cannot. `cordis`'s `waterfall` closes over
 *     its argument list, so `next(replacement)` silently discards it, and a
 *     loop-built request arrives deep-frozen besides.
 *   - `prepared.stream` cannot. `LlmRuntime.prepareCall` returns an
 *     `Object.freeze`d object, so the property cannot be replaced.
 *
 * `forAdapter` sits below both, so the `llm/stream` waterfall -- and with it
 * the loop-built request invariant and every consumer that keys off
 * `isAgentLoopRequest` -- still observes the untouched, marked request, while
 * every adapter, including one that never goes through `prepareCall`, sees the
 * stripped history. `callConfigEquals` does not compare `messages`, so the
 * prepared-call guard is not tripped.
 *
 * @module @logictan/dsh-reasoning-strip
 */
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Cordis companion plugin name. Must equal this plugin's `cordis.patch.yml` row id. */
export const name = 'reasoning-strip'

/** The runtime this plugin rewrites requests on. */
export const inject = ['llm']

/**
 * One assistant message as it appears in durable history.
 *
 * Spelled as the exported `AssistantMessage` rather than an `Extract` over
 * `Message`: the type is exported by every supported generation, while
 * `Message` is a plain interface before 0.1.7 and an `Extract` over it
 * collapses to `never`.
 */
type AssistantHistoryMessage = AssistantMessage

/**
 * One entry of a request's message list, spelled through `GenerateOptions`
 * rather than by name.
 *
 * The two supported generations disagree about what that list holds: 0.1.7
 * widens it to `RequestMessage` (a union including identity-free user input),
 * while earlier generations keep it at `Message`. Indexing the field resolves
 * to whichever is correct for the installed generation.
 */
type RequestEntry = GenerateOptions['messages'][number]

/** The private adapter boundary this plugin wraps, structurally. */
interface AdapterBoundary {
  forAdapter(options: GenerateOptions, adapter: unknown): GenerateOptions
}

/** Narrow a request entry to an assistant history message. */
function isAssistant(message: RequestEntry): message is AssistantHistoryMessage {
  return (message as { role?: unknown }).role === 'assistant'
}

/** Read the replay block list, when the state carries one at all. */
function readBlocks(state: unknown): readonly unknown[] | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const blocks = (state as { blocks?: unknown }).blocks
  return Array.isArray(blocks) ? blocks : undefined
}

/**
 * Rebuild one message's replay metadata so it describes the stripped content.
 *
 * Replay blocks are positional: an adapter recombines them with the durable
 * content by index and rejects the pair when the lengths differ. Dropping the
 * reasoning content block without dropping its replay block therefore degrades
 * the whole message to provider-neutral history. Removing both in one pass
 * keeps the arrays aligned, so the surviving blocks keep full replay fidelity.
 *
 * @param source - the message's original model source.
 * @param content - the message's content before stripping, in order.
 * @returns a replacement source, or `undefined` when the original already fits.
 */
function realignReplay(source: AssistantHistoryMessage['source'], content: readonly ContentBlock[]): AssistantHistoryMessage['source'] | undefined {
  const state = source.replayState
  if (state === undefined) return undefined
  const blocks = readBlocks(state)
  if (blocks === undefined || blocks.length !== content.length) {
    // The metadata describes the pre-strip content and cannot be realigned.
    // Replaying metadata that no longer matches would be rejected downstream,
    // so drop it and let this one message travel as provider-neutral history.
    return { kind: 'model', provider: source.provider, model: source.model }
  }
  const aligned: unknown[] = []
  for (let index = 0; index < content.length; index += 1) {
    if (content[index]?.type === 'reasoning') continue
    aligned.push(blocks[index])
  }
  return {
    kind: 'model',
    provider: source.provider,
    model: source.model,
    replayState: { ...(state as Record<string, unknown>), blocks: aligned },
  }
}

/**
 * Strip the reasoning block from one assistant message.
 *
 * @param message - the assistant message to rewrite.
 * @returns the original message when it carries no reasoning, a frozen stripped
 *   replacement when it does, or `undefined` when stripping leaves it empty.
 */
function stripAssistant(message: AssistantHistoryMessage): AssistantHistoryMessage | undefined {
  const content = message.content
  if (!content.some((block) => block.type === 'reasoning')) return message
  const kept = content.filter((block) => block.type !== 'reasoning')
  if (kept.length === 0) return undefined
  const source = realignReplay(message.source, content)
  return freezeMessage(source === undefined ? { ...message, content: kept } : { ...message, content: kept, source })
}

/**
 * Strip replayed reasoning from every assistant message in one request.
 *
 * @param options - the request an adapter is about to receive.
 * @returns the original object when nothing was stripped, so an untouched
 *   request keeps its identity, or a replacement carrying the stripped history.
 */
function stripRequest(options: GenerateOptions): GenerateOptions {
  let changed = false
  const messages: GenerateOptions['messages'] = []
  for (const message of options.messages) {
    if (!isAssistant(message)) {
      messages.push(message)
      continue
    }
    const stripped = stripAssistant(message)
    if (stripped === message) {
      messages.push(message)
      continue
    }
    changed = true
    if (stripped !== undefined) messages.push(stripped)
  }
  if (!changed) return options
  const next = { ...options, messages }
  return Object.isFrozen(options) ? Object.freeze(next) : next
}

/**
 * Install the strip on the adapter boundary of the `llm` service.
 *
 * @param ctx - the plugin context carrying the `llm` service.
 * @throws when the host does not expose the boundary, which would otherwise
 *   make this plugin a silent no-op.
 */
export function apply(ctx: Context): void {
  const llm = ctx.llm as unknown as AdapterBoundary
  const original = llm.forAdapter
  if (typeof original !== 'function') {
    throw new Error('@logictan/dsh-reasoning-strip: the llm service exposes no forAdapter adapter boundary')
  }
  llm.forAdapter = function (this: AdapterBoundary, options: GenerateOptions, adapter: unknown): GenerateOptions {
    return stripRequest(original.call(this, options, adapter))
  }
  ctx.effect(() => () => {
    llm.forAdapter = original
  }, 'reasoning-strip:forAdapter')
}

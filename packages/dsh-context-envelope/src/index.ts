/**
 * Context envelope for last-user-message readers.
 *
 * The harness sends a turn as several user-role messages: the user's own
 * words first, then the notes it adds for the model -- `Current runtime
 * context. ...` from `dsh-system-prompt`, `Time sampled while preparing
 * turn N, step M: ...` from `dsh-time-context`. Those notes are plain text,
 * so a gateway that decides a turn by the last user message *with words of
 * the user's* reads a timestamp where the ask should be. In magpie that is
 * `when="message ..."` and the intent classifier, both of which resolve
 * through `lastSaid`/`userWords`: they skip a `<system-reminder>` block,
 * but they cannot recognise these notes by their text, because the skipped
 * prefix list is upstream's and does not carry DSH's (issue #6968). The
 * turn is then routed to the group's default member, and the classifier is
 * asked about a timestamp.
 *
 * This plugin puts each note into that block before the request leaves the
 * harness, so those readers skip it while the model still reads it.
 *
 * A gateway condition of the other shape, magpie's `when="last ..."`, is
 * deliberately NOT served here: `lastUserTexts` takes the last user
 * message's text as the client sent it, reminders and all, so no wrapping
 * on this side can move it out of that condition's way. An agent that must
 * satisfy such a condition has to keep its notes out of the last user
 * message entirely.
 *
 * The notes stay separate messages with their own ids. Merging them into
 * the ask's message would be the cheaper rewrite, but magpie derives a
 * conversation's identity from the bytes of its opening user message
 * (`conversationID`): a timestamp inside that message changes the id every
 * turn, which drops the conversation's affinity and its cached prefix. The
 * ask also stays the first user message byte for byte, so `turn` counting,
 * `firstWords` and the cache key are all untouched.
 *
 * The seam is `LlmRuntime.forAdapter`, the host's own last rewrite before
 * adapter dispatch, and for the same reason `dsh-reasoning-strip` uses it:
 * the `llm/stream` waterfall closes over its argument list, so
 * `next(replacement)` is discarded, and a loop-built request arrives
 * deep-frozen besides.
 *
 * @module @logictan/dsh-context-envelope
 */
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Cordis companion plugin name. Must equal this plugin's `cordis.patch.yml` row id. */
export const name = 'context-envelope'

/** The runtime this plugin rewrites requests on. */
export const inject = ['llm']

/**
 * The `Message.source.kind` of the notes this plugin wraps.
 *
 * Both are declared by the host packages that emit them, and both are
 * user-role messages whose text the user never typed. `skill-catalog` is
 * deliberately absent: `dsh-tool-skill` already sends its catalog inside a
 * `<system-reminder>`, so wrapping it again would nest the tag.
 */
const NOTE_KINDS = new Set(['runtime-context', 'time-context'])

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'

/**
 * One entry of a request's message list, spelled through `GenerateOptions`
 * rather than by name; the supported generations disagree about what that
 * list holds.
 */
type RequestEntry = GenerateOptions['messages'][number]

/** The private adapter boundary this plugin wraps, structurally. */
interface AdapterBoundary {
  forAdapter(options: GenerateOptions, adapter: unknown): GenerateOptions
}

/** Read the producer-declared source kind off one request entry. */
function sourceKind(message: RequestEntry): unknown {
  const source = (message as { source?: { kind?: unknown } }).source
  return typeof source === 'object' && source !== null ? source.kind : undefined
}

/** Narrow a request entry to a user-role note this plugin wraps. */
function isNote(message: RequestEntry): boolean {
  if ((message as { role?: unknown }).role !== 'user') return false
  const kind = sourceKind(message)
  return typeof kind === 'string' && NOTE_KINDS.has(kind)
}

/**
 * Wrap one note's text into a reminder block.
 *
 * A note that already opens with the tag is left alone, so a second pass
 * (this plugin mounted twice, or a host that adopts the framing itself)
 * cannot nest the block.
 *
 * @param text - the note's model-facing text, as the producer wrote it.
 * @returns the text inside a reminder block.
 */
function envelope(text: string): string {
  if (text.startsWith(OPEN)) return text
  // The closing tag is what ends a block; text carrying one would end this
  // one early and leave the rest of the note looking like the user's words.
  return `${OPEN}\n${text.replaceAll(CLOSE, '<\\/system-reminder>')}\n${CLOSE}`
}

/**
 * Wrap every text block of one note message.
 *
 * Blocks stay blocks rather than being joined into one: the pi-ai route
 * flattens a message's text blocks with no separator between them, so
 * joining here would run two notes together on the wire.
 *
 * @param message - the note message to rewrite.
 * @returns the original entry when it needs nothing, or a frozen
 *   replacement carrying the wrapped blocks.
 */
function wrapNote(message: RequestEntry): RequestEntry {
  const entry = message as unknown as { content: readonly ContentBlock[] }
  let changed = false
  const blocks = entry.content.map((block) => {
    if (block.type !== 'text') return block
    const text = envelope(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  if (!changed) return message
  return freezeMessage({ ...(message as unknown as Record<string, unknown>), content: blocks } as never) as RequestEntry
}

/**
 * Wrap the harness's own context notes in one request.
 *
 * @param options - the request an adapter is about to receive.
 * @returns the original object when there were no notes, so an untouched
 *   request keeps its identity, or a replacement carrying wrapped notes.
 */
function wrapRequest(options: GenerateOptions): GenerateOptions {
  let changed = false
  const messages = options.messages.map((message) => {
    if (!isNote(message)) return message
    const wrapped = wrapNote(message)
    if (wrapped === message) return message
    changed = true
    return wrapped
  })
  if (!changed) return options
  const next = { ...options, messages }
  return Object.isFrozen(options) ? Object.freeze(next) : next
}

/**
 * Install the envelope on the adapter boundary of the `llm` service.
 *
 * @param ctx - the plugin context carrying the `llm` service.
 * @throws when the host does not expose the boundary, which would otherwise
 *   make this plugin a silent no-op.
 */
export function apply(ctx: Context): void {
  const llm = ctx.llm as unknown as AdapterBoundary
  const original = llm.forAdapter
  if (typeof original !== 'function') {
    throw new Error('@logictan/dsh-context-envelope: the llm service exposes no forAdapter adapter boundary')
  }
  llm.forAdapter = function (this: AdapterBoundary, options: GenerateOptions, adapter: unknown): GenerateOptions {
    return wrapRequest(original.call(this, options, adapter))
  }
  ctx.effect(() => () => {
    llm.forAdapter = original
  }, 'context-envelope:forAdapter')
}
/**
 * Tells the model the one limit the host's session search still has.
 *
 * The patch row in `cordis.patch.yml` turns the index on; this half exists only
 * because a tool description that promises more than the backend delivers is
 * worse than no description. The host's `session_search` and
 * `session_event_search` tools advertise a full-text query, which is true for
 * Latin text and for CJK text of three or more characters, and false below
 * that: the FTS5 `unicode61`
 * tokenizer treats a whole run of CJK as one token, so a two-character query
 * like `压缩` matches only documents where that run happens to be split by
 * punctuation or Latin text. Measured on a real 4.8M-character corpus, the
 * two-character queries returned 0-89 of the 2-253 documents a `LIKE` scan
 * finds, while every query of three or more characters returned exactly what
 * `LIKE` finds.
 *
 * The annotation is applied at `system-prompt/assemble` rather than by shipping
 * a skill: the constraint belongs to two tools, and a skill would put it in the
 * catalog where it competes with every other skill for the model's attention.
 *
 * `systemPrompt` is deliberately NOT injected. Injection means "required", so a
 * host without that service would disable this plugin entirely — losing the
 * annotation. The host's own listeners subscribe the same way without injecting
 * it, and this plugin never calls the service, only listens.
 *
 * @module @logictan/dsh-session-search
 */

/** Plugin row id; must equal the `id` in `cordis.patch.yml`. */
export const name = 'session-search'

/** The two tools that run a full-text query, and therefore hit the tokenizer limit. */
const SEARCH_TOOLS = new Set(['session_search', 'session_event_search'])

/**
 * Appended to the search tool's description.
 *
 * Phrased as an instruction the model can act on, not as an apology: the useful
 * behaviour is to rephrase a short CJK query into a longer one, because that is
 * the only way to get an answer under this tokenizer.
 */
export const CJK_LIMIT_NOTE =
  'CJK (Chinese/Japanese/Korean) queries shorter than three characters do not work: the index ' +
  'tokenizer treats a whole run of CJK text as one token, so a two-character query such as ' +
  '「压缩」 finds only the documents where that run happens to be split by punctuation or Latin ' +
  'text, and usually finds nothing. Use three or more characters (「压缩上下文」), or switch to ' +
  'Latin keywords when the same content has them. Queries of three or more characters are exact.'

/**
 * Whether a tool entry is the session search tool.
 *
 * Matched on the trailing segment of the tool name so a namespaced registration
 * is recognised too, without matching an unrelated tool whose name merely
 * contains the substring.
 *
 * The names come from `@deepseek-ai/dsh-tool-session-query`, which registers five
 * tools: `session_search` and `session_event_search` run full-text queries (and
 * therefore hit the tokenizer limit); `session_trace`, `session_event_trace` and
 * `session_event_read` read by id or seq and never tokenize, so annotating them
 * would be noise. The read-only ones are deliberately excluded.
 *
 * @param tool - one entry of an assembled tool list.
 * @returns true when this entry is the session search tool.
 */
export function isSessionSearchTool(tool: { name?: unknown }): boolean {
  if (typeof tool.name !== 'string') return false
  const segments = tool.name.split('__')
  return SEARCH_TOOLS.has(segments[segments.length - 1] ?? '')
}

/**
 * Append the CJK limit note to one tool description.
 *
 * Idempotent: re-assembling an already-annotated list must not stack the note,
 * because the host may assemble more than once per step.
 *
 * @param description - the tool's current description.
 * @returns the annotated description.
 */
export function annotate(description: string): string {
  if (description.includes(CJK_LIMIT_NOTE)) return description
  return `${description} ${CJK_LIMIT_NOTE}`
}

/**
 * Subscribe the annotation to prompt assembly.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx: {
  on(event: string, listener: (...args: any[]) => unknown): unknown
}): void {
  ctx.on('system-prompt/assemble', async (assembly: any, _context: unknown, next: () => Promise<any>) => {
    const resolved = await next()
    if (!resolved || !Array.isArray(resolved.tools)) return resolved
    let touched = false
    const tools = resolved.tools.map((tool: any) => {
      if (!isSessionSearchTool(tool)) return tool
      touched = true
      return { ...tool, description: annotate(String(tool.description ?? '')) }
    })
    return touched ? { ...resolved, tools } : resolved
  })
}

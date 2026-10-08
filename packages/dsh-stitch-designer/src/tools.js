/**
 * Adaptation of Google Stitch's own MCP tool descriptors to DSH ToolRuntime
 * definitions.
 *
 * This module is the whole reason the plugin exists as a host-side MCP host
 * rather than a dependency on `@deepseek-ai/dsh-mcp-client`: Stitch's tool
 * vocabulary is not the closed subset `dsh-tools` accepts, and the bridge has
 * to decide field by field what to keep and what to drop.
 *
 * Two measured facts drive every choice here (probed against the live
 * `tools/list` of 2026-10-08, all 15 tools):
 *
 *  - `parameters` is passed through VERBATIM. `ToolRuntime.register` validates
 *    only `output.schema`; it never inspects `definition.parameters`. Stitch's
 *    input schemas carry `$defs` / `$ref` / `x-google-*` (11 of 15 fail
 *    `assertSupportedJsonSchema`), so routing them through `defineTool` — which
 *    validates its `parameters` at construction — would throw for 11 tools.
 *    Registering the raw schema is therefore not a shortcut, it is the only
 *    shape that keeps the upstream contract intact for the model.
 *  - `output.schema` IS validated, both at registration and again on every
 *    result (`createSuccessResult`). 13 of Stitch's 15 advertised
 *    `outputSchema`s are outside the accepted subset, so they must be dropped
 *    to the loose envelope below — the same fallback
 *    `@deepseek-ai/dsh-mcp-client`'s `supportedOutputSchema` performs.
 *
 * @module @logictan/dsh-stitch-designer/tools
 */
import { createHash } from 'node:crypto';

import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;

/**
 * Derive the model-facing public name for one Stitch tool.
 *
 * Byte-for-byte the same rule `dsh-mcp-client` applies, because the names are
 * the model's existing vocabulary: this plugin replaces the retired
 * `mcp-stitch` row, and every prompt, note and habit that names
 * `mcp__stitch__generate_screen_from_text` has to keep working. The clean case
 * is `mcp__<serverName>__<rawName>` verbatim; when character replacement or
 * truncation changes it, a 12-hex-char SHA-256 of the identity is appended so
 * two distinct Stitch tools can never collapse onto one public name.
 *
 * @param serverName - stable local namespace; `stitch` reproduces the retired row.
 * @param rawName - Stitch's own tool name.
 * @returns the globally unique, model-facing ToolRuntime name.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Keep an advertised output schema only if the runtime accepts it.
 *
 * Stitch's richer schemas (`$defs`, `x-google-*`, `not`) are rejected by
 * `assertSupportedJsonSchema`; the loose envelope in {@link createOutput} is
 * what the tool falls back to. Dropping the schema loses no information the
 * model can act on — the text projection carries the payload either way — but
 * keeping an unsupported one would make registration throw.
 *
 * @param candidate - the upstream `outputSchema`, if any.
 * @returns the schema when supported, otherwise `undefined`.
 */
export function supportedOutputSchema(candidate) {
  if (candidate === undefined) return undefined;
  try {
    assertSupportedJsonSchema(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Project ordered MCP content blocks into one plain-text string.
 *
 * Stitch returns only `text` blocks (measured across all 15 tools), so the
 * text run is simply joined. A non-text block is reported positionally rather
 * than silently dropped, which is what makes a future image-returning tool
 * visible instead of empty.
 *
 * @param content - the MCP `content` array.
 * @returns the joined text.
 */
export function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      const type = block !== null && typeof block === 'object' && typeof block.type === 'string' ? block.type : 'unknown';
      return `[${type} content is not projected to text]`;
    })
    .join('\n');
}

/**
 * Build the canonical result schema and its text projection.
 *
 * The envelope is fixed because `createSuccessResult` validates every returned
 * value against it: `content` is always present, and `structuredContent` is
 * required exactly when a structured schema was kept. With no structured
 * schema the value carries `content` alone and the text projection is the whole
 * model-visible result.
 *
 * @param structuredSchema - an accepted upstream schema, or `undefined`.
 * @returns the `output` field of a ToolRuntime definition.
 */
export function createOutput(structuredSchema) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: extractText(value.content) }];
    },
  };
}

/**
 * Adapt one upstream Stitch tool descriptor to a ToolRuntime definition.
 *
 * `parameters` is the raw upstream `inputSchema` (see the module note). The
 * result is unregistered; the caller owns registration lifetime.
 *
 * @param options - upstream descriptor fields plus the raw-result callback.
 * @returns the ToolRuntime definition.
 */
export function createToolDefinition(options) {
  const { name, description, inputSchema, outputSchema, call, timeoutMs } = options;
  return {
    name,
    description,
    parameters: inputSchema,
    output: createOutput(supportedOutputSchema(outputSchema)),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    async execute(args, exec) {
      const result = await call(typeof args === 'object' && args !== null ? args : {}, exec);
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = extractText(content);
      if (result?.isError === true) throw new Error(text);
      return {
        content,
        ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      };
    },
  };
}

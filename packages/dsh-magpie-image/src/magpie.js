/**
 * Transport to magpie's image MCP endpoint.
 *
 * magpie speaks stateless Streamable HTTP JSON-RPC: every request carries its
 * own `Authorization: Bearer <key>`, and `tools/list` works without a preceding
 * `initialize` (measured 2026-11-07). The server does echo an `mcp-session-id`
 * header, but no follow-up request needs it — a bare `tools/call` succeeds — so
 * a plain `fetch` is the entire client and there is no session to maintain.
 *
 * The ONE place this differs from Stitch is size: an image request body carries
 * a base64 reference and is regularly several megabytes, and magpie answers an
 * oversized reference with a readable `file too large` inside the tool result
 * rather than an HTTP error. That is why there is no client-side byte cap here:
 * a cap would have to duplicate the provider's own limit and would fail with a
 * less accurate message.
 *
 * @module @logictan/dsh-magpie-image/magpie
 */

/** magpie's image MCP endpoint. */
export const MCP_URL = 'https://hub.logiconsole.com/mcp/magpie/image';

/**
 * Default per-call budget. magpie answers within about 20 seconds or hands back
 * an id to poll with `generation_result`, so this covers the wait plus upload of
 * a multi-megabyte reference.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000;

/**
 * One JSON-RPC round trip.
 *
 * @param options - endpoint, API key, method, params, timeout and abort signal.
 * @returns the JSON-RPC result.
 * @throws when the HTTP request fails, the response is not a JSON-RPC envelope,
 * or the envelope carries an error.
 */
async function rpc(options) {
  const { url, apiKey, method, params, timeoutMs, signal } = options;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`magpie ${method} failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
  }
  const envelope = await response.json();
  if (envelope?.error !== undefined) {
    const message = envelope.error?.message ?? JSON.stringify(envelope.error);
    throw new Error(`magpie ${method} failed: ${message}`);
  }
  if (envelope?.result === undefined) {
    throw new Error(`magpie ${method} returned no result`);
  }
  return envelope.result;
}

/**
 * Create a magpie client bound to one key-resolution callback.
 *
 * The key is read through a callback rather than captured, because the
 * credential can be set or replaced while the process runs — a captured string
 * would keep signing with a revoked key until the next restart.
 *
 * @param options - key resolver, endpoint override and per-call timeout.
 * @returns `callTool`.
 */
export function createMagpieClient(options = {}) {
  const { resolveApiKey, url = MCP_URL, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS } = options;

  return {
    /**
     * Invoke one magpie tool by its raw name.
     *
     * @param name - magpie's own tool name.
     * @param args - the tool arguments.
     * @param exec - the tool execution context, whose signal is honoured.
     * @returns the raw MCP result (`content`, `structuredContent`, `isError`).
     */
    async callTool(name, args, exec) {
      const apiKey = await resolveApiKey();
      if (typeof apiKey !== 'string' || apiKey === '') {
        throw new Error(
          'The magpie API key is not configured. Set it on the Plugins page as MAGPIE_API_KEY — it is the same gateway key the magpie provider uses.',
        );
      }
      return rpc({ url, apiKey, method: 'tools/call', params: { name, arguments: args }, timeoutMs, signal: exec?.signal });
    },
  };
}
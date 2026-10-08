/**
 * Transport to Google Stitch's MCP endpoint.
 *
 * Stitch speaks stateless Streamable HTTP JSON-RPC: every request carries its
 * own `X-Goog-Api-Key`, no session id is issued or echoed, and the response is
 * always `application/json` — never an SSE stream (measured 2026-10-08 for
 * `initialize`, `tools/list` and `tools/call`). A plain `fetch` is therefore
 * the entire client; there is no handshake to maintain and no session to
 * resume, which is also why `tools/list` works without a preceding
 * `initialize`.
 *
 * @module @logictan/dsh-stitch-designer/stitch
 */

/** Stitch's MCP endpoint. */
export const MCP_URL = 'https://stitch.googleapis.com/mcp';

/** Default per-call budget: `generate_screen_from_text` is long-running. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000;

/**
 * One JSON-RPC round trip.
 *
 * @param options - endpoint, API key, method, params, timeout and abort signal.
 * @returns the JSON-RPC envelope.
 * @throws when the HTTP request fails or the response is not a JSON-RPC envelope.
 */
async function rpc(options) {
  const { url, apiKey, method, params, timeoutMs, signal } = options;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Stitch ${method} failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
  }
  const envelope = await response.json();
  if (envelope?.error !== undefined) {
    const message = envelope.error?.message ?? JSON.stringify(envelope.error);
    throw new Error(`Stitch ${method} failed: ${message}`);
  }
  if (envelope?.result === undefined) {
    throw new Error(`Stitch ${method} returned no result`);
  }
  return envelope.result;
}

/**
 * Create a Stitch client bound to one key-resolution callback.
 *
 * The key is read through a callback rather than captured, because the
 * credential can be set or replaced while the process runs — a captured string
 * would keep signing with a revoked key until the next restart.
 *
 * @param options - key resolver, endpoint override and per-call timeout.
 * @returns `listTools` and `callTool`.
 */
export function createStitchClient(options = {}) {
  const {
    resolveApiKey,
    url = MCP_URL,
    timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS,
  } = options;

  const requireKey = async () => {
    const apiKey = await resolveApiKey();
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new Error(
        'Stitch API key is not configured. Open Settings → Plugins → stitch-designer and paste a key from https://stitch.withgoogle.com (avatar → Stitch Settings → API key).',
      );
    }
    return apiKey;
  };

  return {
    /**
     * List the server's tools.
     *
     * @param signal - optional abort signal.
     * @returns the upstream tool descriptors.
     */
    async listTools(signal) {
      const result = await rpc({ url, apiKey: await requireKey(), method: 'tools/list', params: {}, timeoutMs, signal });
      return Array.isArray(result?.tools) ? result.tools : [];
    },

    /**
     * Invoke one Stitch tool by its raw name.
     *
     * @param name - Stitch's own tool name.
     * @param args - the tool arguments.
     * @param exec - the tool execution context, whose signal is honoured.
     * @returns the raw MCP result (`content`, `structuredContent`, `isError`).
     */
    async callTool(name, args, exec) {
      return rpc({
        url,
        apiKey: await requireKey(),
        method: 'tools/call',
        params: { name, arguments: args },
        timeoutMs,
        signal: exec?.signal,
      });
    },
  };
}

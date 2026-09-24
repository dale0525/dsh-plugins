// MCP reverse bridge (v0.2): lets the spawned agy process call DSH-side
// tools. Design: the plugin runs a loopback-only HTTP endpoint
// (127.0.0.1, ephemeral port, bearer token) exposing tool schemas and
// execution; a tiny standalone stdio MCP server (dist/bridge.mjs, plain
// node, zero deps) is registered in the managed agy HOME's
// .gemini/config/mcp_config.json and forwards MCP tool calls to that
// endpoint. Loopback + token keeps the surface private to this machine
// and this plugin. (The workspace .mcp.json is NOT read by agy — verified
// against the real CLI; only $HOME/.gemini/config/mcp_config.json is.)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const MCP_SERVER_KEY = 'dsh-tools'

/** Minimal structural view of the DSH agent registry we need. */
export interface AgentsServiceLike {
  get(id: string): unknown
}

/** Minimal structural view of the DSH tool registry we need. */
export interface ToolsServiceLike {
  schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  execute(input: {
    callId: string
    name: string
    arguments: unknown
    signal: AbortSignal
    /**
     * The agent on whose behalf the call runs. The registry reads
     * `agent.session.header.cwd` to place fs and bash tools in the session
     * workspace, and the subagent tool refuses to run without it.
     */
    agent?: unknown
  }): Promise<unknown>
}

/** MCP tool names are [a-zA-Z0-9_-]; DSH names may contain dots. */
export function toMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export interface McpBridge {
  /** Absolute path of the bridge script (dist/bridge.mjs). */
  bridgeScript: string
  /** Bearer token the bridge script must present. */
  token: string
  /** Base URL of the loopback endpoint. */
  url: string
  port: number
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

/** Best-effort extraction of readable text from an execution result. */
function resultText(result: unknown): string {
  if (result === null || result === undefined) return ''
  const r = result as { content?: unknown; output?: unknown; text?: unknown }
  if (Array.isArray(r.content)) {
    const parts: string[] = []
    for (const b of r.content) {
      const blk = b as { type?: string; text?: unknown }
      if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof r.text === 'string') return r.text
  if (typeof r.output === 'string') return r.output
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/**
 * Start the loopback endpoint. Resolves once listening. The tools service
 * may arrive later (optional service): pass a thunk.
 */
export function startMcpBridge(opts: {
  bridgeScript: string
  tools: () => ToolsServiceLike | undefined
  /**
   * Resolves the agent registry. Each agy run carries its own session id in the
   * bridge process's env, which the script forwards as a request header, so the
   * bridge can attribute a dispatch to the agent whose turn it is.
   */
  agents?: () => AgentsServiceLike | undefined
  allowlist: () => string
  log?: (msg: string) => void
}): Promise<McpBridge> {
  const token = randomBytes(24).toString('hex')
  // The tool registry dereferences exec.signal on every dispatch — it reads
  // `signal.aborted` and forwards the signal to the tool body — so a call
  // without one throws before the tool runs. This is the caller-owned
  // cancellation for every call the bridge makes.
  const calls = new AbortController()
  let callSeq = 0
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const auth = String(req.headers['authorization'] ?? '')
      if (auth !== 'Bearer ' + token) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      if ((req.method === 'GET' || req.method === 'POST') && (url === '/tools' || url === '/mcp/tools')) {
        const svc = opts.tools()
        if (!svc) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        const allow = opts.allowlist().split(',').map((s) => s.trim()).filter(Boolean)
        const allowSet = new Set(allow)
        const seen = new Set<string>()
        const tools = svc.schemas()
          .filter((t) => allow.length === 0 || allowSet.has(t.name))
          .filter((t) => {
            // internal transports and our own ask tool are not bridgeable
            if (t.name === 'run_code' || t.name === 'agy_ask') return false
            const mapped = toMcpName(t.name)
            if (seen.has(mapped)) return false // collision after mapping
            seen.add(mapped)
            return true
          })
          .map((t) => ({
            name: toMcpName(t.name),
            dshName: t.name,
            description: t.description,
            inputSchema: { type: 'object', ...t.parameters },
          }))
        sendJson(res, 200, { tools })
        return;
      }
      if (req.method === 'POST' && (url === '/call' || url === '/mcp/call')) {
        const body = await readBody(req)
        let parsed: { dshName?: unknown; arguments?: unknown } = {}
        try {
          parsed = JSON.parse(body) as typeof parsed
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const svc = opts.tools()
        if (!svc) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        const dshName = typeof parsed.dshName === 'string' ? parsed.dshName : ''
        if (dshName === '' || dshName === 'run_code' || dshName === 'agy_ask') {
          sendJson(res, 400, { error: 'bad tool name' })
          return;
        }
        callSeq++
        const sessionId = String(req.headers['x-dsh-session'] ?? '')
        // A session with no live agent resolves to undefined; the dispatch then
        // behaves exactly as it did before attribution existed.
        const agent = sessionId === '' ? undefined : opts.agents?.()?.get(sessionId)
        try {
          const result = await svc.execute({
            callId: 'agy-mcp-' + callSeq,
            name: dshName,
            arguments: parsed.arguments ?? {},
            signal: calls.signal,
            agent,
          })
          sendJson(res, 200, { ok: true, text: resultText(result) })
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e) })
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' })
    })().catch(() => {
      try { sendJson(res, 500, { error: 'internal' }) } catch { /* closed */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      opts.log?.('mcp bridge listening on 127.0.0.1:' + port)
      resolve({
        bridgeScript: opts.bridgeScript,
        token,
        url: 'http://127.0.0.1:' + port,
        port,
        close: () => new Promise<void>((done) => {
          calls.abort()
          server.close(() => done())
        }),
      })
    })
  })
}

/** agy's own MCP config path inside one managed HOME. */
export function mcpConfigPath(home: string): string {
  return join(home, '.gemini', 'config', 'mcp_config.json')
}

/**
 * Merge our server entry into a config document, preserving every foreign
 * server. Callers pass whatever they read from disk, or null when the file
 * does not exist.
 *
 * A document that does not parse is returned BYTE-IDENTICAL rather than
 * replaced: this file is agy's own (users keep other servers in it, and agy
 * may accept JSON the strict parser rejects), so a config the plugin cannot
 * understand is left for its owner instead of being flattened.
 */
export function mergeMcpConfig(previous: string | null, bridge: McpBridge): string {
  let root: Record<string, unknown> = {}
  if (previous !== null) {
    try {
      const v: unknown = JSON.parse(previous)
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return previous
      root = v as Record<string, unknown>
    } catch {
      return previous
    }
  }
  const servers = (root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : {}) as Record<string, unknown>
  servers[MCP_SERVER_KEY] = {
    type: 'stdio',
    command: process.execPath,
    args: [bridge.bridgeScript],
    env: {
      DSH_MCP_URL: bridge.url,
      DSH_MCP_TOKEN: bridge.token,
    },
    disabled: false,
  }
  root.mcpServers = servers
  return JSON.stringify(root, null, 2) + '\n'
}

/**
 * Add mcp(<server>) to an existing settings.json's permissions.allow.
 *
 * Only plan mode consults permissions.allow; the default 'skip' mode already
 * passes every tool, so this is a compatibility fallback for users who
 * switched to plan mode — not a knob. Returns the new document, or null when
 * nothing changed. A file that does not parse is left alone.
 */
export function allowMcpServer(previous: string): string | null {
  let root: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(previous)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    root = v as Record<string, unknown>
  } catch {
    return null
  }
  const rule = 'mcp(' + MCP_SERVER_KEY + ')'
  const permissions = (root.permissions && typeof root.permissions === 'object' && !Array.isArray(root.permissions)
    ? root.permissions
    : {}) as Record<string, unknown>
  const allow = Array.isArray(permissions.allow) ? permissions.allow : []
  if (allow.some((x) => x === rule)) return null
  permissions.allow = [...allow, rule]
  root.permissions = permissions
  return JSON.stringify(root, null, 2) + '\n'
}

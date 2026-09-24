import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { allowMcpServer, mergeMcpConfig, mcpConfigPath, startMcpBridge, toMcpName, type ToolsServiceLike } from '../src/host/mcp-bridge.ts'
import { stageImages, sweepDir, stagedPath, defaultMediaDir } from '../src/host/media.ts'
import { inlineFiles, schemaArgs } from '../src/host/oneshot.ts'

const here = dirname(fileURLToPath(import.meta.url))

const fakeTools: ToolsServiceLike = {
  schemas: () => [
    { name: 'bash', description: 'run a shell command', parameters: { properties: { command: { type: 'string' } } } },
    { name: 'read', description: 'read a file', parameters: { properties: { path: { type: 'string' } } } },
    { name: 'run_code', description: 'internal transport', parameters: {} },
    { name: 'agy_ask', description: 'our own ask tool', parameters: {} },
  ],
  execute: async (input) => ({ content: [{ type: 'text', text: 'ran ' + input.name + ' ok' }] }),
}

test('mcp bridge: loopback endpoint serves tools and executes calls', async () => {
  const bridge = await startMcpBridge({
    bridgeScript: resolve(here, '../dist/bridge.mjs'),
    tools: () => fakeTools,
    allowlist: () => '',
  })
  try {
    // no token -> 401
    const anon = await fetch(bridge.url + '/tools')
    assert.equal(anon.status, 401)
    // with token -> tool list, internal ones filtered
    const res = await fetch(bridge.url + '/tools', { headers: { authorization: 'Bearer ' + bridge.token } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { tools: Array<{ name: string; dshName: string }> }
    const names = body.tools.map((t) => t.dshName)
    assert.ok(names.includes('bash') && names.includes('read'))
    assert.ok(!names.includes('run_code') && !names.includes('agy_ask'))
    // execute round trip
    const call = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ dshName: 'bash', arguments: { command: 'echo hi' } }),
    })
    const callBody = (await call.json()) as { ok: boolean; text: string }
    assert.equal(callBody.ok, true)
    assert.match(callBody.text, /ran bash ok/)
    // allowlist filters
  } finally {
    await bridge.close()
  }
})

test('mcp bridge: allowlist restricts the served set', async () => {
  const bridge = await startMcpBridge({
    bridgeScript: resolve(here, '../dist/bridge.mjs'),
    tools: () => fakeTools,
    allowlist: () => 'read',
  })
  try {
    const res = await fetch(bridge.url + '/tools', { headers: { authorization: 'Bearer ' + bridge.token } })
    const body = (await res.json()) as { tools: Array<{ dshName: string }> }
    assert.deepEqual(body.tools.map((t) => t.dshName), ['read'])
  } finally {
    await bridge.close()
  }
})

test('mcp bridge: every dispatch carries a live AbortSignal', async () => {
  // The DSH registry dereferences exec.signal on every dispatch (`signal.aborted`,
  // plus forwarding it into the tool body). A call without one throws before the
  // tool runs, so the bridge must supply a real signal — and it must still be
  // live at dispatch time, not an already-aborted placeholder.
  const seen: Array<AbortSignal | undefined> = []
  const tools = {
    schemas: () => [{ name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } }],
    execute: async (input: { signal: AbortSignal }) => {
      seen.push(input.signal)
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }
  const bridge = await startMcpBridge({
    bridgeScript: resolve(here, '../dist/bridge.mjs'),
    tools: () => tools as never,
    allowlist: () => '',
  })
  try {
    const call = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ dshName: 'bash', arguments: { command: 'echo hi' } }),
    })
    assert.equal(((await call.json()) as { ok: boolean }).ok, true)
  } finally {
    await bridge.close()
  }
  assert.equal(seen.length, 1)
  assert.ok(seen[0] instanceof AbortSignal, 'execute must receive a real AbortSignal')
  assert.equal(seen[0]!.aborted, true, 'closing the bridge must abort the caller signal')
})

test('mcp bridge: attributes each dispatch to the calling session agent', async () => {
  // agy spawns one bridge process per run, so the session id travels in that
  // process's env and reaches the bridge as a request header. Without it the
  // registry has no agent: read/write/glob/grep silently run in the backend
  // default cwd, bash in process.cwd(), and subagent throws.
  const agent = { id: 'agent-1' }
  const seen: Array<unknown> = []
  const tools = {
    schemas: () => [{ name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } }],
    execute: async (input: { agent?: unknown }) => {
      seen.push(input.agent)
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }
  const bridge = await startMcpBridge({
    bridgeScript: resolve(here, '../dist/bridge.mjs'),
    tools: () => tools as never,
    agents: () => ({ get: (id: string) => (id === 'sess-1' ? agent : undefined) }) as never,
    allowlist: () => '',
  })
  const call = async (session: string): Promise<void> => {
    const res = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
        'x-dsh-session': session,
      },
      body: JSON.stringify({ dshName: 'bash', arguments: { command: 'echo hi' } }),
    })
    assert.equal(((await res.json()) as { ok: boolean }).ok, true)
  }
  try {
    await call('sess-1')
    // A session with no live agent must resolve to undefined, never to some
    // other agent that happens to be registered.
    await call('sess-gone')
  } finally {
    await bridge.close()
  }
  assert.equal(seen.length, 2)
  assert.equal(seen[0], agent)
  assert.equal(seen[1], undefined)
})

test('mcp bridge script forwards DSH_AGY_SESSION as the session header', async () => {
  // The whole attribution chain in one test: the plugin sets the var on the agy
  // spawn, agy hands its env to the stdio server, the script turns it into the
  // header the loopback endpoint resolves the agent from.
  const agent = { id: 'agent-e2e' }
  const seen: Array<unknown> = []
  const tools = {
    schemas: () => [{ name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } }],
    execute: async (input: { agent?: unknown }) => {
      seen.push(input.agent)
      return { content: [{ type: 'text', text: 'ran bash ok' }] }
    },
  }
  const bridge = await startMcpBridge({
    bridgeScript: resolve(here, '../dist/bridge.mjs'),
    tools: () => tools as never,
    agents: () => ({ get: (id: string) => (id === 'sess-e2e' ? agent : undefined) }) as never,
    allowlist: () => '',
  })
  const child = spawn(process.execPath, [bridge.bridgeScript], {
    env: { ...process.env, DSH_MCP_URL: bridge.url, DSH_MCP_TOKEN: bridge.token, DSH_AGY_SESSION: 'sess-e2e' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines: string[] = []
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (d: string) => { for (const l of d.split('\n')) if (l.trim() !== '') lines.push(l) })
  const waitFor = async (pred: (msg: Record<string, unknown>) => boolean, ms = 5000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + ms
    for (;;) {
      const idx = lines.findIndex((l) => { try { return pred(JSON.parse(l) as Record<string, unknown>) } catch { return false } })
      if (idx >= 0) return JSON.parse(lines[idx]!) as Record<string, unknown>
      if (Date.now() > deadline) throw new Error('timeout waiting for bridge reply; got: ' + lines.join(' | '))
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    await waitFor((m) => m.id === 1)
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: { command: 'echo hi' } } }) + '\n')
    const call = await waitFor((m) => m.id === 2)
    const content = (call.result as { content: Array<{ text: string }> }).content
    assert.match(content[0]!.text, /ran bash ok/)
  } finally {
    child.kill()
    await bridge.close()
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0], agent, 'DSH_AGY_SESSION must reach execute() as the resolved agent')
})

test('mcp bridge script speaks JSON-RPC over stdio end to end', async () => {
  const bridge = await startMcpBridge({
    bridgeScript: resolve(here, '../dist/bridge.mjs'),
    tools: () => fakeTools,
    allowlist: () => '',
  })
  const child = spawn(process.execPath, [bridge.bridgeScript], {
    env: { ...process.env, DSH_MCP_URL: bridge.url, DSH_MCP_TOKEN: bridge.token },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines: string[] = []
  let closed = false
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (d: string) => { for (const l of d.split('\n')) if (l.trim() !== '') lines.push(l) })
  child.on('exit', () => { closed = true })
  const send = (obj: unknown): void => { child.stdin!.write(JSON.stringify(obj) + '\n') }
  const waitFor = async (pred: (msg: Record<string, unknown>) => boolean, ms = 5000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + ms
    for (;;) {
      const idx = lines.findIndex((l) => { try { return pred(JSON.parse(l) as Record<string, unknown>) } catch { return false } })
      if (idx >= 0) return JSON.parse(lines[idx]!) as Record<string, unknown>
      if (Date.now() > deadline) throw new Error('timeout waiting for bridge reply; got: ' + lines.join(' | '))
      if (closed) throw new Error('bridge exited early; got: ' + lines.join(' | '))
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const init = await waitFor((m) => m.id === 1)
    assert.equal((init.result as { serverInfo?: { name?: string } }).serverInfo?.name, 'dsh-agy-link-bridge')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const list = await waitFor((m) => m.id === 2)
    const tools = (list.result as { tools: Array<{ name: string }> }).tools
    assert.ok(tools.some((t) => t.name === 'bash'))
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: { command: 'echo hi' } } })
    const call = await waitFor((m) => m.id === 3)
    const content = (call.result as { content: Array<{ type: string; text: string }> }).content
    assert.equal(content[0]?.type, 'text')
    assert.match(content[0]!.text, /ran bash ok/)
  } finally {
    child.kill()
    await bridge.close()
  }
})

test('mergeMcpConfig targets agy own config and preserves foreign servers', async () => {
  const bridge = await startMcpBridge({
    bridgeScript: '/opt/bridge.mjs',
    tools: () => undefined,
    allowlist: () => '',
  })
  try {
    // agy reads MCP servers from $HOME/.gemini/config/mcp_config.json — the
    // workspace .mcp.json it used to be written to is never read.
    assert.equal(mcpConfigPath('/home/u'), join('/home/u', '.gemini', 'config', 'mcp_config.json'))
    const merged = JSON.parse(mergeMcpConfig(JSON.stringify({ mcpServers: { other: { command: 'x' } } }), bridge)) as {
      mcpServers: Record<string, { command?: string; args?: string[]; disabled?: boolean; env?: Record<string, string> }>
    }
    assert.ok(merged.mcpServers.other, 'foreign server preserved')
    const ours = merged.mcpServers['dsh-tools']
    assert.ok(ours && ours.command === process.execPath)
    assert.equal(ours.disabled, false)
    assert.equal(ours.env?.DSH_MCP_URL, bridge.url)
    // A config the plugin cannot parse is returned untouched, not flattened.
    const opaque = '{ "mcpServers": { /* hand-written */ } }'
    assert.equal(mergeMcpConfig(opaque, bridge), opaque)
    // No file yet is the normal first-run case.
    assert.ok(JSON.parse(mergeMcpConfig(null, bridge)).mcpServers['dsh-tools'])
    // An existing but EMPTY file is the same case, not an opaque document:
    // agy leaves a zero-byte mcp_config.json behind, and honouring it as
    // "foreign" would leave the bridge unconfigured forever.
    assert.ok(JSON.parse(mergeMcpConfig('', bridge)).mcpServers['dsh-tools'])
    assert.ok(JSON.parse(mergeMcpConfig('\n', bridge)).mcpServers['dsh-tools'])
  } finally {
    await bridge.close()
  }
})

test('allowMcpServer adds the bridge rule once and leaves broken files alone', () => {
  assert.equal(allowMcpServer('{}'), JSON.stringify({ permissions: { allow: ['mcp(dsh-tools)'] } }, null, 2) + '\n')
  const existing = JSON.stringify({ permissions: { allow: ['read_file'] }, other: 1 })
  const next = allowMcpServer(existing)
  assert.deepEqual((JSON.parse(next as string) as { permissions: { allow: string[] } }).permissions.allow, ['read_file', 'mcp(dsh-tools)'])
  assert.equal((JSON.parse(next as string) as { other: number }).other, 1)
  assert.equal(allowMcpServer(next as string), null, 'already allowed is a no-op')
  assert.equal(allowMcpServer('not json'), null)
})

test('toMcpName maps illegal characters', () => {
  assert.equal(toMcpName('a.b/c'), 'a_b_c')
  assert.equal(toMcpName('plain-name_1'), 'plain-name_1')
})

// ---- media staging ----

test('stageImages writes files and builds prompt lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-media-'))
  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const res = await stageImages({
      dir,
      key: 'sess-1',
      images: [
        { attachmentId: 'a1', mediaType: 'image/png', bytes: png.length, width: 10, height: 20, name: 'shot.png' },
        { attachmentId: 'a2', mediaType: 'image/jpeg', bytes: png.length, width: 5, height: 5 },
        { attachmentId: 'dead', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 },
      ],
      readImage: async (ref) => (ref.attachmentId === 'dead' ? null : png),
      maxImages: 4,
      maxBytes: 1024,
    })
    assert.equal(res.staged.length, 2)
    assert.equal(res.skipped, 1)
    assert.ok(res.promptSuffix.includes('[image attached: "shot.png"'))
    const p0 = res.staged[0]!
    assert.equal(p0.path, join(dir, 'sess-1-0.png'))
    const written = await readFile(p0.path)
    assert.deepEqual(written, png)
    // unreadable image -> note line, still counts as skipped
    assert.ok(res.promptSuffix.includes('image unavailable'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stageImages enforces count and byte caps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-media-'))
  try {
    const png = Buffer.alloc(16, 1)
    const res = await stageImages({
      dir,
      key: 'k',
      images: [
        { attachmentId: 'a', mediaType: 'image/png', bytes: 16, width: 1, height: 1 },
        { attachmentId: 'b', mediaType: 'image/png', bytes: 9999, width: 1, height: 1 },
      ],
      readImage: async () => png,
      maxImages: 2,
      maxBytes: 100,
    })
    // first staged; second over byte cap
    assert.equal(res.staged.length, 1)
    assert.equal(res.skipped, 1)
    assert.ok(res.promptSuffix.includes('exceeds mediaMaxBytes'))
    // count cap: two fine images, maxImages 1
    const res2 = await stageImages({
      dir,
      key: 'k2',
      images: [
        { attachmentId: 'x', mediaType: 'image/png', bytes: 16, width: 1, height: 1 },
        { attachmentId: 'y', mediaType: 'image/png', bytes: 16, width: 1, height: 1 },
      ],
      readImage: async () => png,
      maxImages: 1,
      maxBytes: 100,
    })
    assert.equal(res2.staged.length, 1)
    assert.equal(res2.skipped, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweepDir removes only stale files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-sweep-'))
  try {
    const fresh = join(dir, 'fresh.png')
    const stale = join(dir, 'stale.png')
    await writeFile(fresh, 'x')
    await writeFile(stale, 'x')
    const now = Date.now()
    // stale: mtime 2h ago, ttl 1h
    const old = new Date(now - 2 * 3600_000)
    await (await import('node:fs/promises')).utimes(stale, old, old)
    const removed = await sweepDir(dir, 3600_000, now)
    assert.equal(removed, 1)
    let freshGone = false
    try { await readFile(fresh) } catch { freshGone = true }
    assert.equal(freshGone, false)
    // ttl<=0 disables
    assert.equal(await sweepDir(dir, 0), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stagedPath and defaultMediaDir are deterministic', () => {
  assert.equal(stagedPath('/m', 'k', 2, 'image/jpeg'), join('/m', 'k-2.jpg'))
  assert.equal(defaultMediaDir('/s'), join('/s', 'media'))
})

// ---- file inlining + schema ----

test('inlineFiles inlines textual files, skips binary and missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-inline-'))
  try {
    const txt = join(dir, 'notes.md')
    const bin = join(dir, 'blob.bin')
    await writeFile(txt, '# hello\nworld')
    await writeFile(bin, Buffer.from([0, 1, 2, 3, 0, 5, 0, 7, 8, 9, 0, 0, 0]))
    const out = await inlineFiles('Q:', [txt, bin, join(dir, 'nope.txt')], dir)
    assert.ok(out.includes('Q:'))
    assert.ok(out.includes('# hello'))
    assert.ok(out.includes('--- file: ' + txt))
    assert.ok(out.includes('binary file'))
    assert.ok(out.includes('unreadable'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('schemaArgs writes a temp schema file and cleans up', async () => {
  const { args, cleanup } = await schemaArgs({ type: 'object', properties: { a: { type: 'string' } } })
  try {
    assert.equal(args[0], '--json-schema')
    const file = args[1]!
    assert.match(file, /agy-schema-/)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { properties: unknown }
    assert.ok(parsed.properties)
  } finally {
    await cleanup()
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

// Exercise the actual scope owner, not a manual bridge.close() call.
test('disposing a ready plugin clears background timers and closes MCP', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ready-disposal-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = new Context()
  const listeners = t.mock.method(Server.prototype, 'listen')
  const intervals = t.mock.method(globalThis, 'setInterval')
  const timeouts = t.mock.method(globalThis, 'setTimeout')
  const clearIntervals = t.mock.method(globalThis, 'clearInterval')
  const clearTimeouts = t.mock.method(globalThis, 'clearTimeout')
  try {
    ctx.plugin({ name: 'ready-disposal-host', apply(c: Context) {
      c.provide('llm', { registerAdapter() { return () => undefined } })
      c.provide('commands', { register() { return () => undefined } })
    } })
    const servicesDeadline = Date.now() + 2000
    while (!ctx.get('commands')) {
      assert.ok(Date.now() < servicesDeadline, 'host services did not register')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    apply(ctx, { enabled: true, mcpBridge: true, workspaceRoot: dir, agyBin: '/nonexistent/agy-test' })
    const listening = (): Server[] => listeners.mock.calls
      .map(call => call.result)
      .filter(server => server?.listening) as Server[]
    const deadline = Date.now() + 2000
    while (listening().length === 0) {
      assert.ok(Date.now() < deadline, 'bridge did not start listening')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const servers = listening()
    assert.equal(servers.length, 1)
    const sweeps = intervals.mock.calls.filter(c => Number(c.arguments[1]) >= 60000)
    const boot = timeouts.mock.calls.find(c => Number(c.arguments[1]) === 5000)
    assert.equal(sweeps.length, 2)
    assert.ok(boot)
    for (const call of [...sweeps, boot]) assert.equal((call.result as NodeJS.Timeout).hasRef(), false)
    await ctx.fiber.dispose()
    assert.ok(servers.every(server => !server.listening))
    for (const call of sweeps) assert.ok(clearIntervals.mock.calls.some(c => c.arguments[0] === call.result))
    assert.ok(clearTimeouts.mock.calls.some(c => c.arguments[0] === boot.result))
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

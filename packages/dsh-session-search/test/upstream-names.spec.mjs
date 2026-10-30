/**
 * Guards the one failure mode that is invisible in the source: the tool names
 * this plugin matches are copied from another package. If the host renames them,
 * nothing throws — the annotation simply stops being applied, and the model goes
 * back to believing a two-character CJK query works. This test mounts the REAL
 * `@deepseek-ai/dsh-tool-session-query` and asserts the matched set is exactly
 * its two full-text tools.
 *
 * Skips (rather than fails) when the host package is not installed, so the
 * repository stays testable on a machine without DSH.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { isSessionSearchTool } from '../lib/index.js'

const available = await import('@deepseek-ai/dsh-tool-session-query').then(
  (module) => module,
  () => undefined,
)

test('the matched tool names exist upstream', { skip: available === undefined && 'host package not installed' }, async () => {
  const ctx = new Context()
  const registered = []
  await ctx.plugin((c) => {
    c.provide('tools')
    c.set('tools', { register: (tool) => registered.push(tool) })
    c.provide('systemPrompt')
    c.set('systemPrompt', { section: () => {}, getSectionOrder: () => 100 })
    c.provide('sessionQuery')
    c.set('sessionQuery', {
      searchSessions: async () => ({ items: [] }),
      searchEvents: async () => ({ items: [] }),
    })
    c.provide('sessionProjections')
    c.set('sessionProjections', { register: () => () => {} })
  })
  ctx.plugin(available, {})
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.ok(registered.length > 0, 'the host tool package must register its tools')
  const matched = registered.filter((tool) => isSessionSearchTool(tool)).map((tool) => tool.name)
  assert.deepEqual(
    matched.sort(),
    ['session_event_search', 'session_search'],
    'a rename upstream would silently stop the annotation from being applied',
  )
})

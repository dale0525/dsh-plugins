import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CJK_LIMIT_NOTE, annotate, apply, isSessionSearchTool, name } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
/** The YAML body only: comments deliberately quote the values this file replaces. */
const body = patch.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

test('the index row overrides the host row by id instead of inserting', () => {
  assert.match(body, /^- id: session-query-sqlite$/m,
    'matching the host id is what merges config into the existing row')
  const inserted = body.match(/- insert:\n([\s\S]*)/)
  assert.ok(inserted, 'the tool needs an insert row')
  assert.doesNotMatch(inserted[1], /session-query-sqlite/,
    'a second backend row would register sessionQuery twice and throw')
})

test('the index is durable and opens on first search', () => {
  assert.match(body, /openAt: first-search/)
  assert.doesNotMatch(body, /openAt: never/,
    'openAt: never makes every full-text call throw SESSION_QUERY_SEARCH_DISABLED')
  assert.match(body, /path: !!js dshHomePath\('session-search\/index\.db'\)/,
    'a durable path is what makes the index survive a restart')
  assert.doesNotMatch(body, /path: ':memory:'/,
    ':memory: would rebuild the whole corpus on every process start')
})

test('the index row keeps the host package name', () => {
  const indexRow = body.slice(body.indexOf('- id: session-query-sqlite'))
  const upToNextRow = indexRow.slice(0, indexRow.indexOf('\n- ', 1) + 1 || undefined)
  assert.doesNotMatch(upToNextRow, /name:/, 'only config changes; the name stays the host package')
})

test('the search tool is mounted, since the web profile does not mount it', () => {
  assert.match(body, /name: '@deepseek-ai\/dsh-tool-session-query'/,
    'without this row no session_search tool exists and the index is unreachable')
})

test('the tool is a plain top-level row, not an isolated group', () => {
  assert.doesNotMatch(body, /isolate:/,
    'an isolated group gets its own empty sessionQuery realm and the tool stays pending')
})

test('the plugin mounts its own host half', () => {
  // The bug this guards: the patch opened the index and mounted the host's tool,
  // but never mounted THIS package, so `apply()` never ran and the annotation was
  // silently dead. A patch-only test cannot see that; this one can.
  assert.match(body, /- id: session-search\n\s+name: '@logictan\/dsh-session-search'/,
    'without this row apply() never runs: no index preparation, no annotation')
})

test('the plugin row id equals the host half name', () => {
  assert.equal(name, 'session-search',
    'the loader keys mounted rows by id and hard-crashes on a duplicate')
  assert.match(body, /- id: session-search\n\s+name: '@logictan\/dsh-session-search'/,
    'the row id and export const name must be the same string')
})

test('the index path in the patch matches indexPath()', () => {
  // The patch cannot import from src, so the two literals are kept in step here.
  const literal = body.match(/path: !!js dshHomePath\('([^']+)'\)/)
  assert.ok(literal, 'the patch must set a durable path')
  assert.equal(literal[1], 'session-search/index.db',
    'indexPath() prepares this exact file; a mismatch would prepare nothing the host uses')
})

test('the note states the limit and what to do instead', () => {
  assert.match(CJK_LIMIT_NOTE, /three characters/)
  assert.match(CJK_LIMIT_NOTE, /压缩上下文/, 'a concrete long query shows the workaround')
  assert.match(CJK_LIMIT_NOTE, /Latin/, 'the fallback keyword route is named')
})

test('the note is appended, and appending twice changes nothing', () => {
  const once = annotate('Literal full-text query over prior session history.')
  assert.ok(once.startsWith('Literal full-text query'))
  assert.ok(once.includes(CJK_LIMIT_NOTE))
  assert.equal(annotate(once), once, 'annotation must be idempotent')
})

test('both full-text tools are recognised, and only those', () => {
  // Names taken from @deepseek-ai/dsh-tool-session-query, which registers five.
  assert.ok(isSessionSearchTool({ name: 'session_search' }))
  assert.ok(isSessionSearchTool({ name: 'session_event_search' }))
  assert.ok(isSessionSearchTool({ name: 'mcp__x__session_search' }))
  // These read by id or seq and never tokenize, so they must stay untouched.
  assert.ok(!isSessionSearchTool({ name: 'session_trace' }))
  assert.ok(!isSessionSearchTool({ name: 'session_event_trace' }))
  assert.ok(!isSessionSearchTool({ name: 'session_event_read' }))
  assert.ok(!isSessionSearchTool({ name: 'session_search_extra' }))
  assert.ok(!isSessionSearchTool({ name: 'web_search' }))
  assert.ok(!isSessionSearchTool({}))
})

test('assembly annotates only the search tool', async () => {
  let listener
  apply({ on: (event, fn) => { if (event === 'system-prompt/assemble') listener = fn } })
  assert.ok(listener, 'the plugin must subscribe to prompt assembly')
  const assembly = {
    tools: [
      { name: 'session_search', description: 'Search prior sessions in the caller workspace.' },
      { name: 'web_search', description: 'Search the web.' },
    ],
  }
  const resolved = await listener(assembly, {}, async () => assembly)
  const byName = Object.fromEntries(resolved.tools.map((tool) => [tool.name, tool.description]))
  assert.ok(byName.session_search.includes(CJK_LIMIT_NOTE), 'the search tool carries the note')
  assert.equal(byName.web_search, 'Search the web.', 'other tools are untouched')
})

test('assembly returns the input untouched when the tool is absent', async () => {
  let listener
  apply({ on: (event, fn) => { if (event === 'system-prompt/assemble') listener = fn } })
  const assembly = { tools: [{ name: 'web_search', description: 'Search the web.' }] }
  assert.equal(await listener(assembly, {}, async () => assembly), assembly)
})

test('assembly tolerates an assembly with no tools', async () => {
  let listener
  apply({ on: (event, fn) => { if (event === 'system-prompt/assemble') listener = fn } })
  const assembly = { prompt: 'no tools here' }
  assert.equal(await listener(assembly, {}, async () => assembly), assembly)
})

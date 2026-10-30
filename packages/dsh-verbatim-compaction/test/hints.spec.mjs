/**
 * The per-turn hint block fed to the summarizer.
 *
 * These tests exist because the first hand-rolled version of this got the
 * failure signal wrong: it matched /error/i against the serialized tool result,
 * and every one of 347 results matched — because tool output routinely contains
 * the word "error" (grep misses, compiler logs, stack traces in file dumps). The
 * model was then told "all 347 results failed" and dutifully reported that the
 * whole turn was a failure. The only trustworthy signal is `data.isError`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectHints, isErrorResult } from '../lib/index.js'

// Real logs carry tool calls as blocks inside `assistant/message`; there is no
// standalone `tool/call` event type in what `digestSource` emits. The fixture
// matches that, because a fixture with the wrong shape passes while the real
// path silently finds nothing — which is exactly what happened.
const call = (name, args) => ({
  type: 'assistant/message',
  seq: 1,
  data: { message: { role: 'assistant', content: [{ type: 'tool-call', name, arguments: JSON.stringify(args) }] } },
})
const result = (text, isError) => ({
  type: 'tool/result',
  seq: 2,
  data: { message: { role: 'tool', isError, content: [{ type: 'text', text }] } },
})

test('a result is a failure only when isError is literally true', () => {
  assert.equal(isErrorResult(result('boom', true)), true)
  assert.equal(isErrorResult(result('boom', false)), false)
  // The trap: the text says "error" but the flag does not.
  assert.equal(isErrorResult(result('Error: no matches found', false)), false,
    'matching the text was the bug that mislabelled 347 successful results')
  assert.equal(isErrorResult(result('error', undefined)), false)
  assert.equal(isErrorResult({ type: 'tool/result', seq: 1, data: {} }), false)
})

test('hints carry the call description, not the whole command', () => {
  const hints = collectHints([
    call('bash', { command: 'cd /x && python3 -c "long script…"', description: 'Summarize built-in sources' }),
  ])
  assert.match(hints, /bash/)
  assert.match(hints, /Summarize built-in sources/)
  assert.doesNotMatch(hints, /long script/, 'the command body is noise; the description is the signal')
})

test('hints fall back to a short command head when there is no description', () => {
  const hints = collectHints([call('bash', { command: 'git status --short' })])
  assert.match(hints, /git status --short/)
})

test('only failing results contribute an error line', () => {
  const ok = collectHints([call('bash', { description: 'a' }), result('Error: no matches found', false)])
  assert.doesNotMatch(ok, /ERR/, 'a non-failing result must not be reported as an error')

  const bad = collectHints([call('bash', { description: 'a' }), result('command not found: foo', true)])
  assert.match(bad, /ERR/)
  assert.match(bad, /command not found/)
})

test('hints are bounded so one huge turn cannot blow the budget', () => {
  const many = []
  for (let i = 0; i < 500; i++) many.push(call('bash', { description: `step ${i}` }))
  const hints = collectHints(many)
  assert.ok(hints.length < 12000, `hints must stay bounded, got ${hints.length}`)
})

test('an empty turn produces no hints', () => {
  assert.equal(collectHints([]), '')
})

test('the extraction call carries request, prose and tool trace separately', async () => {
  // The model can only report an outcome if it is told what was asked, what the
  // assistant said, and what the tools did. The first hand-built version dropped
  // the user request entirely (it filtered on `data.turn`, which user messages do
  // not carry) and the extraction degenerated into a guess about tool names.
  const { buildExtractionMaterial } = await import('../lib/index.js')
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: '修好这个 bug' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '找到原因了' }] } } },
    call('bash', { description: 'Run the failing test' }),
  ]
  const material = buildExtractionMaterial(events, '找到原因了')
  assert.match(material, /修好这个 bug/, 'the user request must reach the model')
  assert.match(material, /找到原因了/, 'the assistant prose must reach the model')
  assert.match(material, /Run the failing test/, 'the tool trace must reach the model')
})

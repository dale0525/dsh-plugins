/**
 * The per-turn hint block fed to the summarizer.
 *
 * One line per call, carrying the call's own `description` (or a short command
 * head). `ask_user_question` is not listed: it and its answer are rendered from
 * the log into `## Answers`, so a hint would only invite the model to restate the
 * exchange. Nothing is read out of a tool result here: results are the bulk of
 * the log, and the earlier attempt to mine them for failures was wrong twice over
 * — `/error/i` matched 347 successful results in one turn, and even the
 * trustworthy `data.isError` flag only ever produced a transport string
 * ("命令超过 600 秒未结束") that no later turn used.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectHints } from '../lib/index.js'

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

test('a failing result contributes nothing to the hints', () => {
  // The `ERR <first line>` line was removed with the digest's `errors:` trailer:
  // a failure's first line is the transport or exit status, and the model never
  // turned it into anything a later turn used.
  const hints = collectHints([call('bash', { description: 'a' }), result('command not found: foo', true)])
  assert.doesNotMatch(hints, /ERR/)
  assert.doesNotMatch(hints, /command not found/)
  // The call's own description still reaches the model, so the attempt is visible.
  assert.match(hints, /TOOL bash: a/)
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

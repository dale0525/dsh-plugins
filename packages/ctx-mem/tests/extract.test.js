/**
 * Acceptance contract for src/extract.js — verbatim hard-fact extraction.
 *
 * All fixtures are hand-built plain objects that mirror the shapes emitted by
 * the installed DSH host. No network, no filesystem, no real session.
 *
 * The load-bearing promise under test: every value in `files`, `commands` and
 * `errors` is copied byte-for-byte out of the input. Hard facts must survive
 * compaction unchanged, so these tests assert with `assert.equal` / `deepEqual`
 * rather than substring checks wherever corruption could hide.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractFacts } from '../src/extract.js'
import { regionOf } from '../src/region.js'

/** An assistant tool call, as it appears in an `assistant/message` content block. */
function callBlock(id, name, args) {
  return {
    type: 'tool-call',
    id,
    name,
    // The host stores default-mode call arguments as a JSON string.
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  }
}

/** An `assistant/message` event carrying `blocks` as its content. */
function assistantMsg(seq, blocks) {
  return { type: 'assistant/message', seq, data: { message: { role: 'assistant', content: blocks } } }
}

/** A `tool/result` event for `callId`, with `text` as its single text block. */
function toolResult(seq, callId, text, isError = false) {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
      },
    },
  }
}

/** A `tool/ptc-dispatch` event — the authoritative record of a PTC sub-call. */
function dispatch(seq, { rootCallId, subCallId, name, args, isError = false, text = '' }) {
  return {
    type: 'tool/ptc-dispatch',
    seq,
    data: {
      rootCallId,
      parentCallId: rootCallId,
      subCallId,
      name,
      arguments: args,
      isError,
      content: text === '' ? [] : [{ type: 'text', text }],
    },
  }
}

/** A `user/message` event — note the message is `event.data` itself, not `data.message`. */
function userMsg(seq, text, source) {
  const event = { type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }] } }
  if (source !== undefined) event.data.source = source
  return event
}

/**
 * Build a region object shaped like the one src/region.js returns, but with the
 * fields supplied by hand. Most cases here test the extractor's own rules and do
 * not need region recovery; `realRegion` below covers the integration shape.
 */
function stubRegion(own, dispatchesByRoot = new Map()) {
  return {
    seqs: own.map((event) => event.seq),
    startSeq: own.length > 0 ? own[0].seq : null,
    endSeq: own.length > 0 ? own[own.length - 1].seq : null,
    own,
    dispatchesByRoot,
  }
}

/**
 * Recover a region through the real `src/region.js` from an index-aligned event
 * log — the exact path production uses. Used where the *shape* `regionOf`
 * produces is what is under test, so a hand-built stub cannot paper over a
 * container the real implementation never emits.
 *
 * @param {Array<object>} events Index-aligned events (`events[seq].seq === seq`).
 * @returns {object} The region.
 */
function realRegion(events) {
  const session = {
    seq: events.length,
    eventAt: (seq) => events[seq],
    snapshotEvents: (from, toExclusive) => events.slice(from, toExclusive),
    // Mirrors the host's `deriveEventMessage`: message-producing events derive
    // to their message, every log-only event (tool/ptc-dispatch, tool/call,
    // turn/start, ...) derives to null.
    deriveEventMessage: (event) => {
      switch (event.type) {
        case 'user/message':
          return event.data
        case 'assistant/message':
          return event.data.message
        case 'tool/result':
          return event.data.message
        default:
          return null
      }
    },
  }
  const messages = events.map((event) => session.deriveEventMessage(event)).filter(Boolean)
  return regionOf(session, { messages })
}

test('A1 — PTC dispatches are authoritative and suppress run_code source parsing', () => {
  const callId = 'call_ptc_1'
  // The decoy lives in the run_code program; it was never actually dispatched.
  const code = "const r = await tools.bash({ command: 'DECOY' })\nreturn r"
  const own = [
    assistantMsg(1, [callBlock(callId, 'run_code', { code })]),
    dispatch(2, { rootCallId: callId, subCallId: 'sub_1', name: 'bash', args: { command: 'ls -la' } }),
  ]
  const region = stubRegion(own, new Map([[callId, [own[1]]]]))

  const facts = extractFacts(region)

  assert.deepEqual(facts.commands, ['ls -la'])
  assert.equal(facts.commands.includes('DECOY'), false, 'source parsing must not run when dispatches exist')
  assert.deepEqual(facts.files, [])
  assert.deepEqual(facts.errors, [])
  assert.deepEqual(facts.intents, [])
})

test('A1c — a dispatch in the region suppresses fallback source parsing', () => {
  // Guards against double-counting: the dispatches are what Path A reads, so the
  // decoy in the program source must stay out of `commands` either way.
  //
  // The region comes from the real `regionOf`, not a hand-built stub: it is the
  // production caller, and it derives `dispatchesByRoot` from the same events,
  // so this pins the shape the extractor actually receives. The trailing
  // `tool/result` is what puts the log-only dispatch inside the recovered
  // [startSeq, endSeq] range — without a later surface event the dispatch would
  // fall outside the region entirely.
  const callId = 'call_ptc_own_only'
  const code = "await tools.bash({ command: 'DECOY' })"
  const events = [
    assistantMsg(0, [callBlock(callId, 'run_code', { code })]),
    dispatch(1, { rootCallId: callId, subCallId: 'sub_own', name: 'bash', args: { command: 'ls -la' } }),
    toolResult(2, callId, 'sub-call ok'),
  ]

  const region = realRegion(events)
  assert.ok(region.dispatchesByRoot.has(callId), 'the dispatch must be inside the recovered range')

  const facts = extractFacts(region)

  assert.deepEqual(facts.commands, ['ls -la'])
  assert.equal(facts.commands.includes('DECOY'), false, 'source parsing must not run when a dispatch exists')
})

test('A1b — fallback source parsing recovers sub-calls when no dispatch was logged', () => {
  const code = "await tools.bash({ command: 'ls -la' })"
  const own = [assistantMsg(1, [callBlock('call_ptc_2', 'run_code', { code })])]

  const facts = extractFacts(stubRegion(own))

  assert.deepEqual(facts.commands, ['ls -la'])
})

test('A3 — fallback preserves a command containing inner double quotes', () => {
  // Fixture 1: a double-quoted literal whose inner quotes are backslash-escaped.
  const escapedCode = 'await tools.bash({ command: "echo \\"=== plugins ===\\"" })'
  assert.ok(escapedCode.includes('\\"'), 'fixture must contain escaped inner quotes')

  const escapedFacts = extractFacts(
    stubRegion([assistantMsg(1, [callBlock('call_ptc_3', 'run_code', { code: escapedCode })])]),
  )

  // The rejected implementation is the quote-excluding character class
  // /command\s*:\s*['"]([^'"]*)['"]/ — it stops at the first inner quote and
  // silently emits the corrupted command `echo `.
  assert.equal(escapedFacts.commands[0], 'echo "=== plugins ==="')

  // Fixture 2: a single-quoted literal carrying raw inner double quotes — the
  // form that `[^'"]*` truncates most visibly.
  const rawCode = "await tools.bash({ command: 'echo \"=== plugins ===\"' })"
  const rawFacts = extractFacts(
    stubRegion([assistantMsg(1, [callBlock('call_ptc_4', 'run_code', { code: rawCode })])]),
  )

  assert.equal(rawFacts.commands[0], 'echo "=== plugins ==="')
})

test('A3c — fallback ignores a non-literal value instead of fabricating a command', () => {
  // A non-literal value (a variable or bare identifier) is not a command we can
  // recover verbatim, so it must not be emitted at all. The rejected
  // implementation widens the OPENING delimiter to `([\s\S])`, which lets any
  // character open a match and then fabricates a command out of the middle of
  // the expression: `command: cmd` yields `b`, `command: aba` yields `b`.
  // That is the same silent corruption the paired-quote backreference exists to
  // prevent, so the opening character must stay restricted to a real quote.
  for (const expression of ['cmd', 'aba', 'process.env.CMD', 'args[0]']) {
    const code = `await tools.bash({ command: ${expression} })`
    const facts = extractFacts(
      stubRegion([assistantMsg(1, [callBlock('call_ptc_nonliteral', 'run_code', { code })])]),
    )

    assert.deepEqual(
      facts.commands,
      [],
      `a non-literal ${expression} must yield no command, not a fragment`,
    )
  }
})

test('A2 — default mode: a plain tool call plus its result yields the file path', () => {
  const own = [
    assistantMsg(1, [callBlock('call_read_1', 'read', '{"file_path":"/tmp/a.txt"}')]),
    toolResult(2, 'call_read_1', 'file contents here'),
  ]

  const facts = extractFacts(stubRegion(own))

  assert.ok(facts.files.includes('/tmp/a.txt'), 'files must contain /tmp/a.txt')
  assert.deepEqual(facts.errors, [])
})

test('A2b — mixed region: PTC and default-mode facts are extracted together', () => {
  const ptcCallId = 'call_mixed_ptc'
  const own = [
    assistantMsg(1, [callBlock(ptcCallId, 'run_code', { code: "await tools.bash({ command: 'ls -la' })" })]),
    dispatch(2, { rootCallId: ptcCallId, subCallId: 'sub_mixed', name: 'bash', args: { command: 'ls -la' } }),
    assistantMsg(3, [callBlock('call_mixed_read', 'read', { file_path: '/tmp/b.txt' })]),
    toolResult(4, 'call_mixed_read', 'file contents here'),
  ]
  const region = stubRegion(own, new Map([[ptcCallId, [own[1]]]]))

  const facts = extractFacts(region)

  assert.deepEqual(facts.commands, ['ls -la'])
  assert.ok(facts.files.includes('/tmp/b.txt'))
})

test('A3b — a command with spaces, $VAR and a # comment round-trips byte-exactly', () => {
  // The tab between `-e` and `hello` is a literal TAB character, as a shell line would have.
  const command = 'cd /tmp && echo -e "hello\tworld" $VAR # trailing comment'
  const own = [
    assistantMsg(1, [callBlock('call_verbatim', 'bash', { command })]),
    toolResult(2, 'call_verbatim', 'hello\tworld'),
  ]

  const facts = extractFacts(stubRegion(own))

  assert.equal(facts.commands[0], command)
})

test('isError is authoritative — flag, text pattern, and clean result', () => {
  const ptcRoot = 'call_err_ptc'
  const own = [
    // (a) PTC dispatch marked failed by the host.
    assistantMsg(1, [callBlock(ptcRoot, 'run_code', { code: 'await tools.bash({ command: "cat /nope" })' })]),
    dispatch(2, {
      rootCallId: ptcRoot,
      subCallId: 'sub_err',
      name: 'bash',
      args: { command: 'cat /nope' },
      isError: true,
      text: 'cat: /nope: no such file\nmore detail',
    }),
    // (b) clean result — isError false and text matches nothing.
    assistantMsg(3, [callBlock('call_ok', 'bash', { command: 'echo hi' })]),
    toolResult(4, 'call_ok', 'hi'),
    // (c) isError false but the first line matches the error pattern.
    assistantMsg(5, [callBlock('call_pat', 'bash', { command: 'ls /missing' })]),
    toolResult(6, 'call_pat', 'ls: cannot access /missing: No such file or directory', false),
  ]

  const facts = extractFacts(stubRegion(own, new Map([[ptcRoot, [own[1]]]])))

  assert.equal(facts.errors.length, 2, `expected exactly 2 errors, got ${JSON.stringify(facts.errors)}`)
  assert.ok(
    facts.errors.includes('bash: cat: /nope: no such file'),
    `missing dispatch error in ${JSON.stringify(facts.errors)}`,
  )
  assert.ok(
    facts.errors.includes('bash: ls: cannot access /missing: No such file or directory'),
    `missing pattern-detected error in ${JSON.stringify(facts.errors)}`,
  )
  for (const entry of facts.errors) {
    assert.equal(entry.includes('hi'), false, 'clean result must not become an error')
  }
})

test('intents — genuine user messages only, verbatim', () => {
  const own = [
    userMsg(1, 'Refactor the parser and keep output byte-identical.', { kind: 'user' }),
    userMsg(2, 'tool output masquerading as a user row', { kind: 'tool' }),
    userMsg(3, 'plugin-injected checkpoint row', { kind: 'plugin' }),
  ]

  const facts = extractFacts(stubRegion(own))

  assert.deepEqual(facts.intents, ['Refactor the parser and keep output byte-identical.'])
})

test('intents — the framework rows the host injects are not user intents', () => {
  // Every kind below is a real `user/message` source the installed host emits,
  // observed across 200 archived sessions. Only `kind: "user"` is a human
  // message; the host's own predicate is exactly that
  // (`dsh-api-session-controller`: `source.kind === "user"`), and the Chat UI
  // projects every other kind as `role: "inject"`.
  //
  // This is not cosmetic. `agent-instructions` carries the whole AGENTS.md body
  // and `skill-catalog` the whole skill list — together ~10K characters in the
  // session that exposed this. Classifying them as intents made the checkpoint
  // dump both verbatim into `### User Intents`, burying the actual request.
  const own = [
    userMsg(1, 'Fix the flaky test.', { kind: 'user' }),
    userMsg(2, '## 1. 核心沟通与行为准则 …', { kind: 'agent-instructions', form: 'instructions' }),
    userMsg(3, 'A skill is a reusable set of task-specific instructions.', { kind: 'skill-catalog', form: 'catalog' }),
    userMsg(4, 'recalled context from another session', { kind: 'session-reference' }),
    userMsg(5, 'a subagent finished', { kind: 'subagent-settled' }),
    userMsg(6, 'a relayed agent message', { kind: 'agent-message' }),
    userMsg(7, 'invoke this skill', { kind: 'skill-invocation' }),
    userMsg(8, 'no source at all'),
  ]

  const facts = extractFacts(stubRegion(own))

  // The source-less row stays: the host always sets a source, so a missing one
  // means a hand-built or legacy event, and dropping a possible human turn is
  // the worse failure. Only an explicit non-user kind is excluded.
  assert.deepEqual(facts.intents, ['Fix the flaky test.', 'no source at all'])
})

test('intents — the whole framework row is dropped, not just its prefix', () => {
  // Guard against a "strip the <system-reminder> wrapper" fix: the wrapper is
  // presentation, and a row whose body has no wrapper at all must still be
  // excluded. The exclusion is by source kind, not by text.
  const own = [userMsg(1, 'unwrapped AGENTS.md body with no tags at all', { kind: 'agent-instructions' })]
  assert.deepEqual(extractFacts(stubRegion(own)).intents, [])
})

test('errors — a failed bash command is detected behind its [stderr] wrapper', () => {
  // The host reports a nonzero exit as a MARKER IN THE BODY, not as `isError`
  // (`dsh-tool-bash`: "A nonzero command exit is reported, not failed"), and it
  // prefixes captured stderr with a literal `[stderr]` line (`dsh-bash-local`).
  // So the first line of a real failure is the wrapper, and the error text sits
  // on the next one. Reading only the first line loses the error entirely —
  // exactly the hard fact this backend exists to preserve.
  const own = [
    assistantMsg(1, [callBlock('call_fail', 'bash', { command: 'ls /nonexistent-probe' })]),
    toolResult(2, 'call_fail', '[stderr]\nls: /nonexistent-probe: No such file or directory\n[exit code: 1]', false),
  ]

  const facts = extractFacts(stubRegion(own))

  assert.deepEqual(
    facts.errors,
    ['bash: ls: /nonexistent-probe: No such file or directory'],
    'the wrapped error text must be extracted, not the [stderr] marker',
  )
})

test('errors — a nonzero exit with no stderr text is still an error', () => {
  // No `[stderr]` wrapper at all: the only signal is the exit-code marker.
  const own = [
    assistantMsg(1, [callBlock('call_code', 'bash', { command: 'exit 3' })]),
    toolResult(2, 'call_code', 'some stdout\n[exit code: 3]', false),
  ]

  const facts = extractFacts(stubRegion(own))

  assert.equal(facts.errors.length, 1, `expected one error, got ${JSON.stringify(facts.errors)}`)
  assert.ok(facts.errors[0].startsWith('bash: '), facts.errors[0])
})

test('errors — a clean wrapped result is not an error', () => {
  // `[stderr]` alone must not be treated as an error signal: plenty of commands
  // write progress noise to stderr and still exit 0.
  const own = [
    assistantMsg(1, [callBlock('call_noise', 'bash', { command: 'git fetch' })]),
    toolResult(2, 'call_noise', 'stdout line\n[stderr]\nwarning: redirecting to https://example.com', false),
  ]

  assert.deepEqual(extractFacts(stubRegion(own)).errors, [])
})

test('ordering — commands follow seq order and duplicates are kept', () => {
  const own = [
    assistantMsg(1, [callBlock('call_ord_1', 'run_code', { code: 'await tools.bash({ command: "first" })' })]),
    dispatch(2, { rootCallId: 'call_ord_1', subCallId: 'sub_a', name: 'bash', args: { command: 'echo a' } }),
    assistantMsg(3, [callBlock('call_ord_2', 'run_code', { code: 'await tools.bash({ command: "second" })' })]),
    dispatch(4, { rootCallId: 'call_ord_2', subCallId: 'sub_b', name: 'bash', args: { command: 'echo b' } }),
    dispatch(5, { rootCallId: 'call_ord_2', subCallId: 'sub_c', name: 'bash', args: { command: 'echo a' } }),
  ]
  const dispatchesByRoot = new Map([
    ['call_ord_1', [own[1]]],
    ['call_ord_2', [own[3], own[4]]],
  ])

  const facts = extractFacts(stubRegion(own, dispatchesByRoot))

  assert.deepEqual(facts.commands, ['echo a', 'echo b', 'echo a'])
})

test('degenerate input — empty region and unparsable arguments never throw', () => {
  const empty = extractFacts(stubRegion([]))
  assert.deepEqual(empty, { intents: [], files: [], commands: [], errors: [] })

  assert.deepEqual(extractFacts(undefined), { intents: [], files: [], commands: [], errors: [] })

  const malformed = stubRegion([assistantMsg(1, [callBlock('call_bad', 'read', '{not valid json')])])
  assert.doesNotThrow(() => extractFacts(malformed))
  assert.deepEqual(extractFacts(malformed), { intents: [], files: [], commands: [], errors: [] })
})

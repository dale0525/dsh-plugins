/**
 * Automatic retry of a model response that never arrived intact.
 *
 * Two shapes of that kill the turn the same way: the adapter classifies the
 * failure `PI_AI_ERROR`, `agent-loop` turns the failed finish into a thrown
 * `LlmError`, and the user sees `本轮运行失败`. The request itself was
 * well-formed in both, so the same request usually succeeds on a second attempt —
 * this is the one failure class where re-sending is the fix rather than a silent
 * re-bill.
 *
 *  1. A body `JSON.parse` rejected — a V8 signature carrying `JSON at position N`.
 *  2. A stream the upstream closed before it carried anything usable.
 *
 * The rule is deliberately NARROW, and the population below is measured rather
 * than guessed: across this machine's `~/.dsh/sessions` the JSON-parse failures
 * are 20 distinct failed steps over 19 error turns, ALL `PI_AI_ERROR`, every one
 * carrying a V8 `JSON.parse` signature. `PI_AI_ERROR` alone is NOT the predicate
 * — the same adapter reports it for `Too many pending requests, please retry
 * later` and `Provider finish_reason: error`, neither of which is an interrupted
 * body and neither of which should be retried. Nor is the message alone the
 * predicate: an upstream 400 whose error BODY quotes a JSON error must not be
 * re-sent, which is why the code and a signature are required together.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../lib/index.js'
import { Config } from '../lib/index.js'
import { configRefs, refs } from './helpers/refs.mjs'

/** The JSON-parse messages actually observed in the session store. */
const PARSE_FAILURES = [
  'Unexpected non-whitespace character after JSON at position 319 (line 2 column 1)',
  'Unterminated string in JSON at position 215 (line 1 column 215)',
  "Expected ',' or '}' after property value in JSON at position 123 (line 1 column 124)",
]

/**
 * The stream-terminated-early messages actually observed in the session store.
 *
 * Measured once (`session-3e13c85e`, turn 3 step 10): the upstream minted
 * `upstream stream closed before any chunk carried finish_reason` and the
 * adapter, whose transport pattern matches only `stream ended`, fell through to
 * `PI_AI_ERROR` — so neither the guard nor the host's own retry claimed it and
 * the turn died. The near-identical `Stream ended without finish_reason` IS
 * classified `TRANSPORT` and was retried 42 times out of 42 by the host, which is
 * why the two are treated as one class here.
 */
const INTERRUPTED_STREAMS = ['upstream stream closed before any chunk carried finish_reason']

/**
 * A JSON.parse rejection the rule deliberately does NOT match.
 *
 * It is the one shape V8 reports WITHOUT a position, and it was measured ZERO
 * times across this machine's session store. That is not a gap in coverage of
 * the truncation class: real truncation surfaced 11 times as
 * `Unterminated string in JSON at position …`, which IS matched. Matching an
 * unobserved phrasing would be speculation, so the anchor stays on the
 * positional form every measured failure actually carries.
 */
const UNMEASURED_JSON_ERROR = 'Unexpected end of JSON input'

/** The `PI_AI_ERROR` messages that are neither parse failures nor interrupted streams. */
const OTHER_PI_AI_ERRORS = [
  'Too many pending requests, please retry later (request id: 202609081744453134208618268d9d6PpXbtNGN)',
  'Provider finish_reason: error',
]

/** A Cordis-shaped context recording both listeners the guard installs. */
function fakeContext(agent) {
  const stream = []
  const requestError = []
  return {
    // The real cordis Context always provides inject; the double must too.
    inject: () => {},
    on(name, listener) {
      if (name === 'llm/stream') stream.push(listener)
      else if (name === 'agent/request-error') requestError.push(listener)
    },
    logger: { warn() {}, debug() {} },
    agents: { get: () => agent },
    get: () => undefined,
    stream,
    requestError,
  }
}

/**
 * Mount the guard and expose its `agent/request-error` listener.
 *
 * `next` is counted rather than stubbed away: the waterfall contract is that a
 * listener which declines must delegate, so "did downstream get a turn" is the
 * observable difference between declining and swallowing the failure.
 */
function mount(config = {}) {
  const agent = {}
  const ctx = fakeContext(agent)
  plugin.apply(ctx, configRefs(config))

  assert.equal(ctx.stream.length, 1, 'apply() must still register exactly one llm/stream listener')
  assert.equal(
    ctx.requestError.length,
    1,
    'apply() must register exactly one agent/request-error listener',
  )

  const listener = ctx.requestError[0]
  const calls = { next: 0 }
  const next = async () => {
    calls.next += 1
    return undefined
  }

  return {
    agent,
    calls,
    listener,
    /** Deliver one failure the way `agent-loop` dispatches it. */
    fire: (failure, overrides = {}) =>
      listener({ agent, turn: 0, step: 1, provider: 'pi-ai', failure, ...overrides }, next),
  }
}

/* -------------------------------------------------------------------------- */
/* the retry                                                                  */
/* -------------------------------------------------------------------------- */

test('every measured JSON-parse failure is retried', async () => {
  for (const message of PARSE_FAILURES) {
    const { fire, calls } = mount()
    assert.deepEqual(
      await fire({ code: 'PI_AI_ERROR', message }),
      { kind: 'retry' },
      'must retry: ' + message,
    )
    assert.equal(calls.next, 0, 'a handled failure must not reach downstream recovery')
  }
})

test('every measured interrupted stream is retried', async () => {
  // `Stream ended without finish_reason` is the measured sibling: the host's own
  // retry classifies it `TRANSPORT` and re-sent it 42 times out of 42, so a
  // `PI_AI_ERROR` carrying that wording is the same failure and must not fall
  // between the two mechanisms the way the `closed` wording did.
  for (const message of [...INTERRUPTED_STREAMS, 'Stream ended without finish_reason']) {
    const { fire, calls } = mount()
    assert.deepEqual(
      await fire({ code: 'PI_AI_ERROR', message }),
      { kind: 'retry' },
      'must retry: ' + message,
    )
    assert.equal(calls.next, 0, 'a handled failure must not reach downstream recovery')
  }
})

test('an interrupted stream under any other code is delegated', async () => {
  for (const code of ['SERVER', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'INVALID_REQUEST']) {
    const { fire, calls } = mount()
    assert.equal(
      await fire({ code, message: INTERRUPTED_STREAMS[0] }),
      undefined,
      'must not retry a ' + code + ' failure',
    )
    assert.equal(calls.next, 1)
  }
})

test('the retry is bounded by the shipped default', async () => {
  // The default must be finite: a provider that corrupts EVERY body would
  // otherwise be re-billed forever, which is the failure this cap exists for.
  const { fire, calls } = mount()
  const failure = { code: 'PI_AI_ERROR', message: PARSE_FAILURES[0] }

  assert.deepEqual(await fire(failure), { kind: 'retry' })
  assert.deepEqual(await fire(failure), { kind: 'retry' })
  assert.equal(await fire(failure), undefined, 'the budget must run out')
  assert.equal(calls.next, 1, 'the exhausted failure is handed downstream once')
})

test('the cap is configurable', async () => {
  const { fire } = mount({ maxRequestRetries: 1 })
  const failure = { code: 'PI_AI_ERROR', message: PARSE_FAILURES[1] }

  assert.deepEqual(await fire(failure), { kind: 'retry' })
  assert.equal(await fire(failure), undefined)
})

test('the budget is per step, so the next step starts fresh', async () => {
  // `agent-loop` re-runs the failed step inside its own loop, so (turn, step) is
  // the identity of "this attempt". Without the reset, one bad step would exhaust
  // the budget for the whole turn.
  const { fire } = mount({ maxRequestRetries: 1 })
  const failure = { code: 'PI_AI_ERROR', message: PARSE_FAILURES[0] }

  assert.deepEqual(await fire(failure, { step: 1 }), { kind: 'retry' })
  assert.equal(await fire(failure, { step: 1 }), undefined)
  assert.deepEqual(await fire(failure, { step: 2 }), { kind: 'retry' })
})

test('the budget is per agent', async () => {
  const { fire, listener, calls } = mount({ maxRequestRetries: 1 })
  const failure = { code: 'PI_AI_ERROR', message: PARSE_FAILURES[0] }
  const other = {}

  assert.deepEqual(await fire(failure), { kind: 'retry' })
  assert.equal(await fire(failure), undefined)

  const next = async () => {
    calls.next += 1
    return undefined
  }
  assert.deepEqual(
    await listener({ agent: other, turn: 0, step: 1, provider: 'pi-ai', failure }, next),
    { kind: 'retry' },
    'a second agent must not inherit the first one\u2019s spent budget',
  )
})

/* -------------------------------------------------------------------------- */
/* what must NOT be retried                                                   */
/* -------------------------------------------------------------------------- */

test('a PI_AI_ERROR that is not an interrupted response is delegated', async () => {
  for (const message of OTHER_PI_AI_ERRORS) {
    const { fire, calls } = mount()
    assert.equal(
      await fire({ code: 'PI_AI_ERROR', message }),
      undefined,
      'must not retry: ' + message,
    )
    assert.equal(calls.next, 1, 'a declined failure must be handed downstream')
  }
})

test('a JSON-parse message under any other code is delegated', async () => {
  // An upstream 400 whose error body quotes a JSON error reaches the adapter as
  // the upstream's own code; re-sending it would just repeat the 400.
  for (const code of ['SERVER', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'INVALID_REQUEST', 'UNKNOWN']) {
    const { fire, calls } = mount()
    assert.equal(
      await fire({ code, message: PARSE_FAILURES[0] }),
      undefined,
      'must not retry a ' + code + ' failure',
    )
    assert.equal(calls.next, 1)
  }
})

test('the unmeasured, position-less parse message is delegated', async () => {
  const { fire, calls } = mount()
  assert.equal(await fire({ code: 'PI_AI_ERROR', message: UNMEASURED_JSON_ERROR }), undefined)
  assert.equal(calls.next, 1)
})

test('a downstream retry decision is passed through', async () => {
  // The waterfall is shared: `llm-retry` sits behind the guard and may authorize
  // the retry itself. Declining must not swallow its answer.
  const { listener, agent } = mount()
  const decided = { kind: 'retry' }
  const answer = await listener(
    { agent, turn: 0, step: 1, provider: 'pi-ai', failure: { code: 'RATE_LIMIT', message: '429' } },
    async () => decided,
  )
  assert.equal(answer, decided, 'the downstream decision must be returned unchanged')
})

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

test('retryRequestFailures false turns the retry off', async () => {
  const { fire, calls } = mount({ retryRequestFailures: false })
  assert.equal(await fire({ code: 'PI_AI_ERROR', message: PARSE_FAILURES[0] }), undefined)
  assert.equal(calls.next, 1)
})

test('the switch is read live, so an edit applies without a remount', async () => {
  const live = refs({})
  const agent = {}
  const ctx = fakeContext(agent)
  plugin.apply(ctx, live.refs)
  const listener = ctx.requestError[0]
  const next = async () => undefined
  const failure = { code: 'PI_AI_ERROR', message: PARSE_FAILURES[0] }
  const fire = () => listener({ agent, turn: 0, step: 1, provider: 'pi-ai', failure }, next)

  assert.deepEqual(await fire(), { kind: 'retry' })
  live.set('retryRequestFailures', false)
  assert.equal(await fire(), undefined, 'a disabled switch must take effect on the next call')
})

test('the retry fields are part of the schema and default to on', () => {
  const parsed = new Config({})
  assert.equal(parsed.retryRequestFailures.get(), true, 'the retry ships enabled')
  assert.equal(parsed.maxRequestRetries.get(), 2, 'the shipped budget is small and finite')
  assert.equal(Config.dict.retryRequestFailures.meta?.volatile, true)
  assert.equal(Config.dict.maxRequestRetries.meta?.volatile, true)
})

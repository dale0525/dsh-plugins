import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeConfigFields } from '../src/client/config-schema.ts'

/**
 * The projection is tested against real `schema.toJSON()` envelopes, captured
 * verbatim from the three plugins that ship a `Config` today, plus hand-written
 * envelopes for the node types those three do not happen to use.
 *
 * The captured ones matter because this module's entire job is agreeing with
 * the Host's wire shape: a hand-written fixture for every case would only prove
 * the walker agrees with itself, and the shape was read off `Schema#toJSON()`
 * rather than guessed. The extra cases below were produced the same way, by
 * serializing the schema shown next to each one.
 *
 * The source `.ts` is imported directly: the built `lib/client.js` is wrapped in
 * the loader's `__ModuleLoader__.load` and is not an importable module.
 */

/** `Schema.object({ replaceChatFont: Schema.boolean().default(true).volatile() })` */
const MACOS_THEME = {
  uid: 3,
  refs: {
    2: { type: 'boolean', meta: { default: true, volatile: true } },
    3: { type: 'object', meta: { default: {} }, dict: { replaceChatFont: 2 } },
  },
}

/** The tail of `dsh-loop-guard`'s schema: a number, a union of literals, a string. */
const LOOP_GUARD = {
  uid: 107,
  refs: {
    38: { type: 'number', meta: { min: 0, max: 1, default: 0.8, volatile: true } },
    41: { type: 'const', meta: { required: true }, value: 'warn' },
    43: { type: 'const', meta: { required: true }, value: 'steer' },
    45: { type: 'const', meta: { required: true }, value: 'cancel' },
    47: { type: 'union', meta: { default: 'steer', volatile: true }, list: [41, 43, 45] },
    54: { type: 'string', meta: { default: 'thinking-loop', volatile: true } },
    107: {
      type: 'object',
      meta: { default: {} },
      dict: { similarityThreshold: 38, escalate: 47, cancelCause: 54 },
    },
  },
}

/** `Schema.object({ key: Schema.string().role('secret').default('') })` */
const SECRET = {
  uid: 3,
  refs: {
    2: { type: 'string', meta: { role: 'secret', default: '' } },
    3: { type: 'object', meta: { default: {} }, dict: { key: 2 } },
  },
}

/** `Schema.object({ names: Schema.array(Schema.string()).default(['a']) })` */
const STRING_LIST = {
  uid: 5,
  refs: {
    3: { type: 'string', meta: {} },
    4: { type: 'array', meta: { default: ['a'] }, inner: 3 },
    5: { type: 'object', meta: { default: {} }, dict: { names: 4 } },
  },
}

test('projects a boolean field', () => {
  assert.deepEqual(describeConfigFields(MACOS_THEME), [
    { key: 'replaceChatFont', label: 'replaceChatFont', kind: 'boolean', fallback: true },
  ])
})

test('projects a number field with its bounds', () => {
  const fields = describeConfigFields(LOOP_GUARD)
  assert.deepEqual(fields[0], {
    key: 'similarityThreshold',
    label: 'similarityThreshold',
    kind: 'number',
    min: 0,
    max: 1,
    fallback: 0.8,
  })
})

test('projects a union of literals as a choice', () => {
  const fields = describeConfigFields(LOOP_GUARD)
  const escalate = fields[1]
  assert.equal(escalate.kind, 'select')
  assert.deepEqual(
    escalate.options.map((o) => o.value),
    ['warn', 'steer', 'cancel'],
  )
  assert.equal(escalate.fallback, 'steer')
})

test('projects a plain string field', () => {
  const fields = describeConfigFields(LOOP_GUARD)
  assert.equal(fields[2].kind, 'string')
  assert.equal(fields[2].secret, false)
  assert.equal(fields[2].fallback, 'thinking-loop')
})

test('marks a role=secret string as a secret field', () => {
  const fields = describeConfigFields(SECRET)
  assert.equal(fields[0].kind, 'string')
  assert.equal(fields[0].secret, true)
})

test('projects a list of plain strings', () => {
  const fields = describeConfigFields(STRING_LIST)
  assert.equal(fields[0].kind, 'string-list')
  assert.deepEqual(fields[0].fallback, ['a'])
})

test('declines a list whose inner node is not a string', () => {
  // `dsh-better-reasoning-effort` ships `Schema.array(Schema.natural())`. The
  // list editor edits strings, so projecting it would render a control that
  // silently rewrites numbers as text — declining is the correct answer.
  const envelope = {
    uid: 3,
    refs: {
      2: { type: 'number', meta: { step: 1, min: 1 } },
      4: { type: 'array', meta: { default: [] }, inner: 2 },
      3: { type: 'object', meta: { default: {} }, dict: { delays: 4 } },
    },
  }
  assert.deepEqual(describeConfigFields(envelope), [])
})

test('keeps the schema declaration order', () => {
  const fields = describeConfigFields({
    uid: 4,
    refs: {
      1: { type: 'boolean', meta: { default: false } },
      4: {
        type: 'object',
        meta: { default: {} },
        dict: { zeta: 1, alpha: 1, mid: 1 },
      },
    },
  })
  assert.deepEqual(
    fields.map((f) => f.key),
    ['zeta', 'alpha', 'mid'],
  )
})

test('uses comment as the label and description as the sentence', () => {
  const fields = describeConfigFields({
    uid: 3,
    refs: {
      2: { type: 'boolean', meta: { default: true, comment: '替换字体', description: '关掉即恢复' } },
      3: { type: 'object', meta: { default: {} }, dict: { f: 2 } },
    },
  })
  assert.equal(fields[0].label, '替换字体')
  assert.equal(fields[0].description, '关掉即恢复')
})

test('declines anything that is not a top-level object', () => {
  assert.deepEqual(describeConfigFields(undefined), [])
  assert.deepEqual(describeConfigFields(null), [])
  assert.deepEqual(describeConfigFields({}), [])
  // A bare leaf schema has no fields to lay out.
  assert.deepEqual(describeConfigFields({ uid: 1, refs: { 1: { type: 'boolean', meta: {} } } }), [])
})

test('projects every field of the two schemas captured in full', () => {
  // Field counts read off the live schemas: better-reasoning-effort declares 6,
  // loop-guard declares 18. This is the guard that fires if the Host's envelope
  // shape moves under us.
  const betterReasoning = {
    uid: 25,
    refs: {
      2: { type: 'boolean', meta: { default: true, volatile: true } },
      5: { type: 'boolean', meta: { default: true, volatile: true } },
      11: { type: 'number', meta: { step: 1, min: 1, default: 15000, volatile: true } },
      15: { type: 'number', meta: { step: 1, min: 1 } },
      18: { type: 'array', meta: { default: [1000, 2000], volatile: true }, inner: 15 },
      21: { type: 'boolean', meta: { default: true, volatile: true } },
      24: { type: 'boolean', meta: { default: true, volatile: true } },
      25: {
        type: 'object',
        meta: { default: {} },
        dict: { autofill: 2, modalityAutofill: 5, probeTimeoutMs: 11, bootRetryDelaysMs: 18, defaultGuard: 21, uaOverride: 24 },
      },
    },
  }
  // Five of six render: `bootRetryDelaysMs` is an array of numbers, declined above.
  assert.equal(describeConfigFields(betterReasoning).length, 5)
  assert.equal(describeConfigFields(LOOP_GUARD).length, 3)
})

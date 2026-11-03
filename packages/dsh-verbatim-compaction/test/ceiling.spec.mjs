import assert from 'node:assert/strict'
import test from 'node:test'

import { DIGEST_TOKEN_CEILING, foldGroupStarts, renderDigest } from '../lib/index.js'

/**
 * A synthetic session long enough to cross `DIGEST_TOKEN_CEILING`.
 *
 * Real sessions on this machine top out at 70 human messages and an 8050-token
 * digest, so the ceiling is only reachable in the future. These tests are the
 * only way to exercise it: the condensation path decides what a very long
 * session keeps.
 *
 * @param turns - number of user requests, each carrying an extraction.
 * @returns events and the extraction map keyed by `turnKey`.
 */
function longSession(turns) {
  const events = []
  const extracted = new Map()
  let seq = 0
  for (let index = 0; index < turns; index += 1) {
    const turn = index + 1
    events.push({
      type: 'user/message', seq: (seq += 1), time: seq, surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: `第${turn}轮请求：按规范处理 ${turn}` }], source: { kind: 'user' } },
    })
    events.push({
      type: 'assistant/message', seq: (seq += 1), time: seq, surfaceOp: 'append',
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'PROSE' }] } },
    })
    extracted.set(`${index}:0`, {
      did: [`第${turn}轮做完了实现`, `第${turn}轮补了边界`],
      concluded: [`第${turn}轮确认了根因`, `第${turn}轮的方案成立`],
      overturned: [`第${turn}轮推翻了旧判断`],
      asked: [{ question: `第${turn}轮按哪个方案继续？`, options: ['先验证前提再动手', '直接按方案改'] }],
    })
  }
  return { events, extracted }
}

test('an extraction block is never cut mid-line, however tight the budget', () => {
  // The budget used to be spent by slicing each block at a character cap. Because
  // `## Asked` is the block's last section, it was the first thing the slice ate:
  // at 490 turns every question lost its option list, rendering as `  1.` with
  // nothing after it. A half-line is worse than an absent line — it reads as data.
  for (const turns of [300, 490, 700, 1200]) {
    const { events, extracted } = longSession(turns)
    const text = renderDigest(events, DIGEST_TOKEN_CEILING, extracted)
    assert.ok(
      !/…\(\+\d+ chars\)/.test(text),
      `no extraction may be character-sliced at ${turns} turns`,
    )
  }
})

test('a question keeps its options under any budget', () => {
  // Budgets far below the digest, so the ladder actually runs. 490 turns renders
  // 79113 characters against an 80000 budget and never degrades — the earlier
  // version of this test asserted on that no-op and passed for the wrong reason.
  for (const turns of [700, 1200]) {
    for (const budget of [DIGEST_TOKEN_CEILING, 12000, 8000, 4000]) {
      const { events, extracted } = longSession(turns)
      const text = renderDigest(events, budget, extracted)
      // Every surviving Asked keeps its full option list, and no option line is
      // ever cut: a numbered item with nothing after it reads as data.
      for (const match of text.matchAll(/^- (.+继续？)\n((?:  \d\. .+\n?)+)/gm)) {
        assert.ok(match[2].includes('1. '), `at ${turns}/${budget} a question lost its options`)
        assert.ok(match[2].includes('2. '), `at ${turns}/${budget} a question kept only one option`)
      }
      assert.ok(
        !/…\(\+\d+ chars\)/.test(text),
        `at ${turns}/${budget} an extraction was character-sliced`,
      )
    }
  }
})

test('sections drop in priority order: Overturned, then Concluded, then Did', () => {
  // Each level must be a prefix of the next: a block may never lose `Concluded`
  // while keeping `Overturned`, or lose `Did` while keeping `Concluded`. The
  // ladder is only meaningful if it is monotone in what it keeps.
  for (const turns of [300, 490, 700, 1200]) {
    const { events, extracted } = longSession(turns)
    const text = renderDigest(events, DIGEST_TOKEN_CEILING, extracted)
    for (const block of text.split('### assistant').slice(1)) {
      const hasOverturned = block.includes('## Overturned')
      const hasConcluded = block.includes('## Concluded')
      const hasDid = block.includes('## Did')
      assert.ok(
        !hasOverturned || (hasConcluded && hasDid),
        `at ${turns} turns a block kept Overturned without Concluded and Did`,
      )
      assert.ok(!hasConcluded || hasDid, `at ${turns} turns a block kept Concluded without Did`)
    }
  }
})

test('a condensed block replaces the turns it covers instead of deleting them', () => {
  // Over budget, the oldest turns are folded into one condensed block rather than
  // dropped. Dropping loses what those turns established; condensing keeps a
  // statement of it in a fraction of the room. The condensed block must say which
  // turns it covers so a later turn can tell "not mentioned" from "folded in".
  const turns = 700
  const { events, extracted } = longSession(turns)
  const condensed = new Map([['0:0', { text: 'CONDENSED-EARLY-WORK', covers: 100 }]])
  const text = renderDigest(events, DIGEST_TOKEN_CEILING, extracted, condensed)

  assert.ok(text.includes('CONDENSED-EARLY-WORK'), 'the condensed text must appear')
  assert.ok(
    /condensed from sections 1-100\b/.test(text),
    'the condensed block must name the sections it covers',
  )
  // The turns it covers keep their user lines: a request is a standing constraint
  // that does not expire when the work it asked for is folded up.
  assert.ok(text.includes('第1轮请求：按规范处理 1'), 'the covered user line must survive')
  // Their individual blocks are gone — that is the room the condensation buys.
  assert.ok(
    !text.includes('第1轮确认了根因'),
    'a covered turn must not also render its own block',
  )
})

test('a digest that fits renders no condensed block', () => {
  // The renderer applies whatever map it is given, so this pins the *renderer's*
  // behaviour, not `summarize`'s decision to build one. The string is matched
  // against the format the renderer actually emits — the earlier version asserted
  // on 'condensed from turn', which never appears, so it could not fail.
  const { events, extracted } = longSession(20)
  const text = renderDigest(events, DIGEST_TOKEN_CEILING, extracted)
  assert.ok(text.length <= DIGEST_TOKEN_CEILING * 4, 'the fixture must fit for this test to mean anything')
  assert.ok(!text.includes('## Condensed'), 'a fitting digest must not be condensed')

  // And the same fixture with a map does render one, so the assertion above is not
  // vacuous: it distinguishes the two cases.
  const condensed = new Map([['0:0', { text: 'FOLDED', covers: 10 }]])
  assert.ok(
    renderDigest(events, DIGEST_TOKEN_CEILING, extracted, condensed).includes('## Condensed'),
    'the same fixture with a map must render the block',
  )
})

test('folding the whole history always fits inside the budget', () => {
  // The loop's terminal state: with every section folded, the digest is the user
  // lines plus one paragraph. It must fit, or `condenseOldest` would fold through
  // the entire history without ever converging.
  //
  // Bounded at 2000 turns because the user lines are what remains and they are
  // never folded — at 3000 the requests alone total 54786 characters against an
  // 80000-character budget, so no fold can help. That limit is the budget itself,
  // not this mechanism: a session with that many requests has more standing
  // constraints than the digest can hold, whatever the layout.
  for (const turns of [700, 1200, 2000]) {
    const { events, extracted } = longSession(turns)
    // Built the way `condenseOldest` builds it: one entry per group of
    // `CONDENSE_GROUP` sections, keyed by that group's first section. A single
    // `covers: turns` entry is a shape the engine never produces.
    const condensed = new Map()
    for (let start = 0; start < turns; start += 100) {
      condensed.set(`${start}:0`, { text: 'CONDENSED', covers: Math.min(100, turns - start) })
    }
    const text = renderDigest(events, DIGEST_TOKEN_CEILING, extracted, condensed)
    assert.ok(
      text.length <= DIGEST_TOKEN_CEILING * 4,
      `${turns} turns overflowed when fully folded: ${text.length} > ${DIGEST_TOKEN_CEILING * 4}`,
    )
  }
})

test('folding is monotone: each group folded never grows the digest', () => {
  // `condenseOldest` grows the covered prefix and stops at the first size that
  // fits, so the size must fall as more is folded. If one group could grow the
  // digest, the walk would have no guaranteed end.
  //
  // The folded text is sized to the measured 8.2% ratio rather than to a constant:
  // a fixed string longer than the blocks it replaces would grow the digest, which
  // says nothing about the real fold.
  const turns = 700
  const { events, extracted } = longSession(turns)
  // Entries accumulate the way the engine accumulates them: one per group, each
  // keyed by its own first section. The earlier version varied a single entry's
  // `covers`, which produces one heading instead of seven.
  //
  // Folded text is sized to the measured 8.2% ratio rather than to a constant: a
  // fixed string longer than the blocks it replaces would grow the digest, which
  // says nothing about the real fold.
  const condensed = new Map()
  let previous = Infinity
  for (let groups = 1; groups <= 7; groups += 1) {
    condensed.set(`${(groups - 1) * 100}:0`, { text: 'C'.repeat(Math.round(100 * 170 * 0.082)), covers: 100 })
    const size = renderDigest(events, DIGEST_TOKEN_CEILING, extracted, condensed).length
    assert.ok(size <= previous, `folding ${groups * 100} sections grew the digest: ${previous} -> ${size}`)
    assert.ok(size > 0)
    previous = size
  }
  // Seven groups of seven-hundred sections covers the whole history, so the fold
  // must have brought it under budget by then.
  assert.ok(
    previous <= DIGEST_TOKEN_CEILING * 4,
    `folding the whole history still overflows: ${previous}`,
  )
})


test('the fold walk reaches the end of the history, however it divides', () => {
  // `condenseOldest` steps through `foldGroupStarts`. The earlier form bounded its
  // outer loop at `covered < sections.length` while the inner slice ended at
  // `covered`, so the last group was never folded — and at 100 sections or fewer
  // the loop body never ran at all, leaving an overflowing session with no fold
  // available. Both boundaries are pinned here, against the real function.
  assert.deepEqual(foldGroupStarts(0), [], 'no sections means no fold')
  assert.deepEqual(foldGroupStarts(50), [0], 'a 50-section session must still be foldable')
  assert.deepEqual(foldGroupStarts(100), [0])
  assert.deepEqual(foldGroupStarts(250), [0, 100, 200], 'the last partial group must be reached')
  assert.deepEqual(
    foldGroupStarts(700),
    [0, 100, 200, 300, 400, 500, 600],
    'the final group must not be skipped',
  )
  // Every section falls inside exactly one group, so no section is left unfolded
  // when the walk completes.
  for (const count of [1, 50, 100, 101, 250, 700, 1201]) {
    const covered = foldGroupStarts(count).reduce(
      (sum, start) => sum + Math.min(100, count - start), 0,
    )
    assert.equal(covered, count, `the walk over ${count} sections leaves a gap`)
  }
})

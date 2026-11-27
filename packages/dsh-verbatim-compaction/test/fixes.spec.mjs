import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import VerbatimCompactionEngine, {
  buildExtractionMaterial,
  buildSections,
  foldGroupStarts,
  parseExtraction,
  renderDigest,
  shadowedSeqs,
} from '../lib/index.js'

const userEv = (seq, text, source = { kind: 'user' }) => ({
  type: 'user/message',
  seq,
  time: seq,
  surfaceOp: 'append',
  data: { id: `u-${seq}`, role: 'user', content: [{ type: 'text', text }], source },
})

const goalEv = (seq, text) => userEv(seq, text, { kind: 'goal' })

const assistantEv = (seq, text, turn = 1, toolCalls = []) => ({
  type: 'assistant/message',
  seq,
  time: seq,
  surfaceOp: 'append',
  data: {
    turn,
    step: 1,
    message: {
      id: `a-${seq}`,
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...toolCalls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
      ],
      source: { kind: 'model', provider: 'main-prov', model: 'main-mod', replayState: null },
    },
    stream: [],
  },
})

const toolResultEv = (seq, toolCallId, text, isError = false) => ({
  type: 'tool/result',
  seq,
  time: seq,
  surfaceOp: 'append',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: `tr-${seq}`,
      role: 'tool',
      toolCallId,
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: toolCallId },
      ...(isError ? { isError: true } : {}),
    },
  },
})

const requestHeaderEv = (seq = 0, provider = 'main-prov', model = 'main-mod') => ({
  type: 'request/header',
  seq,
  time: seq,
  data: { reason: 'initial', header: { config: { provider, model } } },
})

function makeSession(events, id = 'fixes-fixture') {
  const expanded = []
  let activeTurn = 0
  let stepCounter = 0
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      if (activeTurn > 0) expanded.push({ type: 'turn/end', seq: 0, time: 0, data: { turn: activeTurn, reason: { kind: 'completed' } } })
      activeTurn = ev.data?.turn ?? activeTurn + 1
      expanded.push(ev)
      continue
    }
    if (ev.type === 'assistant/message') {
      const turn = ev.data?.turn ?? (activeTurn || 1)
      if (activeTurn !== turn) {
        if (activeTurn > 0) expanded.push({ type: 'turn/end', seq: 0, time: 0, data: { turn: activeTurn, reason: { kind: 'completed' } } })
        activeTurn = turn
        expanded.push({ type: 'turn/start', seq: 0, time: 0, data: { turn } })
      }
      stepCounter += 1
      const step = ev.data?.step ?? stepCounter
      expanded.push({ type: 'step/start', seq: 0, time: 0, data: { turn, step } })
      expanded.push({ ...ev, data: { ...ev.data, turn, step } })
      expanded.push({ type: 'step/end', seq: 0, time: 0, data: { turn, step } })
      continue
    }
    if (activeTurn === 0 && ev.type === 'user/message') {
      activeTurn = 1
      expanded.push({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    }
    expanded.push(ev)
  }
  const normalized = expanded.map((ev, index) => ({ ...ev, seq: index, time: index + 1 }))
  return Session.create(id, normalized, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
  }, 0)
}

function slotKeysOf(request) {
  const prompt = request.messages[0]?.content?.[0]?.text ?? ''
  return [...prompt.matchAll(/^=== SLOT (\S+) \(turn /gm)].map((m) => m[1])
}

async function makeHarness(options = {}) {
  const ctx = new Context()
  const warnings = options.warnings ?? []
  ctx.logger.warn = (...args) => warnings.push(args.map(String).join(' '))
  const resolveCalls = []
  const streamCalls = []
  await ctx.plugin((c) => {
    c.provide('sessionProjections')
    c.set('sessionProjections', { register: () => () => {} })
    c.provide('sessions')
    c.set('sessions', { flush: async () => true })
    c.provide('llm')
    c.set('llm', {
      resolveModelInfo: async (provider, model) => {
        resolveCalls.push({ provider, model })
        return options.modelInfo?.(provider, model) ?? { provider, id: model, contextWindow: 450000, reasoning: { efforts: ['low', 'high'] } }
      },
      imageRequestPricing: () => undefined,
      stream: async function* stream(request) {
        streamCalls.push(request)
        const res = await options.answer(request, streamCalls.length)
        if (res?.text) yield { type: 'text-delta', text: res.text }
        yield {
          type: 'finish',
          reason: { kind: res?.reason ?? 'stop' },
          ...(res?.usage ? { usage: res.usage } : {}),
        }
      },
    })
  })
  await ctx.plugin(TokenMeter)
  const fork = ctx.plugin(VerbatimCompactionEngine, options.config ?? {})
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(fork.error, undefined, `plugin mount failed: ${fork.error?.message}`)
  const engine = ctx.get('compaction')
  return {
    ctx,
    engine,
    warnings,
    resolveCalls,
    streamCalls,
    stop: () => fork.dispose(),
  }
}

function agentFor(session, provider = 'main-prov', model = 'main-mod') {
  return {
    id: session.id,
    session,
    options: { provider, model },
    runMaintenance: (run) => run(new AbortController().signal),
  }
}

function checkpointTextOf(session) {
  const ev = [...session.snapshotEvents()].reverse().find(
    (e) => e.type === 'user/message' && e.data?.source?.kind === 'compact-checkpoint',
  )
  return (ev?.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

test('fix 1a: persistent extraction cache survives engine restart when cache dir is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-verbatim-cache-'))
  const prev = process.env.DSH_VERBATIM_CACHE_DIR
  process.env.DSH_VERBATIM_CACHE_DIR = dir
  try {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      requestHeaderEv(1),
      userEv(2, 'FIRST-REQUEST'),
      assistantEv(3, 'A'.repeat(2400), 1),
      userEv(4, 'SECOND-REQUEST'),
      assistantEv(5, 'B'.repeat(2400), 2),
    ]
    const h1 = await makeHarness({
      answer: (req) => ({
        text: JSON.stringify({
          slots: slotKeysOf(req).map((key) => ({
            key,
            did: [`did-${key}`],
            concluded: [`concluded-${key}`],
            overturned: [],
            asked: [],
          })),
        }),
      }),
    })
    const s1 = makeSession(events, 'persist-session-1')
    await h1.engine.compactRegion(s1.surface.nodes[0], s1.surface.nodes.at(-1), agentFor(s1))
    assert.equal(h1.streamCalls.length, 1)
    await h1.stop()

    // Second engine instance (simulating restart) on the same session id & content
    const h2 = await makeHarness({
      answer: () => {
        throw new Error('LLM should not be called on persistent cache hit')
      },
    })
    const s2 = makeSession(events, 'persist-session-1')
    await h2.engine.compactRegion(s2.surface.nodes[0], s2.surface.nodes.at(-1), agentFor(s2))
    assert.equal(h2.streamCalls.length, 0)
    assert.ok(checkpointTextOf(s2).includes('concluded-0:0'))
    await h2.stop()
  } finally {
    if (prev === undefined) delete process.env.DSH_VERBATIM_CACHE_DIR
    else process.env.DSH_VERBATIM_CACHE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fix 1b: extraction batches execute with bounded concurrency', async () => {
  const events = [requestHeaderEv(1)]
  let seq = 2
  for (let i = 0; i < 24; i += 1) {
    events.push(userEv(seq++, `REQ-${i}`))
    events.push(assistantEv(seq++, `PROSE-${i} ` + 'x'.repeat(600), i + 1))
  }
  let inFlight = 0
  let maxInFlight = 0
  const h = await makeHarness({
    answer: async (req) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 40))
      inFlight -= 1
      return {
        text: JSON.stringify({
          slots: slotKeysOf(req).map((key) => ({
            key,
            did: [`did-${key}`],
            concluded: [`ok-${key}`],
            overturned: [],
            asked: [],
          })),
        }),
      }
    },
  })
  try {
    const s = makeSession(events, 'conc-session')
    await h.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
    assert.ok(maxInFlight >= 2, `expected concurrent extraction calls, saw maxInFlight=${maxInFlight}`)
  } finally {
    await h.stop()
  }
})

test('fix 1c: general batch failure bisects to isolate bad turn and caps fallback prose head+tail', async () => {
  const longBadProse = `PROSE-HEAD-ANCHOR\n${'m'.repeat(6000)}\nPROSE-TAIL-ANCHOR`
  const events = [
    requestHeaderEv(1),
    userEv(2, 'U0'),
    assistantEv(3, 'A0 '.repeat(400), 1),
    userEv(4, 'U1'),
    assistantEv(5, longBadProse, 2),
    userEv(6, 'U2'),
    assistantEv(7, 'A2 '.repeat(400), 3),
    userEv(8, 'U3'),
    assistantEv(9, 'A3 '.repeat(400), 4),
  ]
  const h = await makeHarness({
    answer: (req) => {
      const keys = slotKeysOf(req)
      if (keys.includes('1:0')) throw new Error('simulated transient/poison failure on slot 1:0')
      return {
        text: JSON.stringify({
          slots: keys.map((key) => ({
            key,
            did: [`ok-${key}`],
            concluded: [],
            overturned: [],
            asked: [],
          })),
        }),
      }
    },
  })
  try {
    const s = makeSession(events, 'bisect-session')
    await h.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
    const digest = checkpointTextOf(s)
    // Sibling turns survived via bisection
    assert.ok(digest.includes('ok-0:0'))
    assert.ok(digest.includes('ok-2:0'))
    assert.ok(digest.includes('ok-3:0'))
    // Failing slot fell back with head + tail preserved and bounded length
    assert.ok(digest.includes('PROSE-HEAD-ANCHOR'))
    assert.ok(digest.includes('PROSE-TAIL-ANCHOR'))
    assert.ok(digest.length < 4800, `expected capped fallback prose, got total digest len=${digest.length}`)
  } finally {
    await h.stop()
  }
})

test('fix 2: write tools extract file_path, path, and apply_patch targets into wrote line', () => {
  const events = [
    userEv(1, 'update files'),
    assistantEv(2, 'done', 1, [
      { id: 'c1', name: 'write', args: { file_path: 'src/a.ts', content: 'x' } },
      { id: 'c2', name: 'edit', args: { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' } },
      { id: 'c3', name: 'write', args: { path: 'src/legacy.ts', content: 'y' } },
      {
        id: 'c4',
        name: 'apply_patch',
        args: { input: '*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b\n*** Add File: src/d.ts\n+hi\n*** End Patch' },
      },
    ]),
  ]
  const digest = renderDigest(events, 5000)
  assert.ok(digest.includes('  wrote: src/a.ts, src/b.ts, src/legacy.ts, src/c.ts, src/d.ts'), digest)
})

test('fix 3: summarize triggers condenseOldest on unclipped overflow, uses smaller CONDENSE_GROUP, and sanitizes folded output', async () => {
  const starts = foldGroupStarts(100)
  assert.ok(starts.length >= 3, `expected CONDENSE_GROUP <= 40 so 100 sections split into >=3 groups, got ${JSON.stringify(starts)}`)
  const events = [requestHeaderEv(1)]
  let seq = 2
  // 50 turns with long prose (2200 chars -> ~27500 shadowed tokens -> budget hits 20000 ceiling = 80000 chars),
  // while extracted blocks are ~1900 chars each (~95000 chars > 80000 chars) to trigger condensation.
  for (let i = 0; i < 50; i += 1) {
    events.push(userEv(seq++, `REQ-${i}`))
    events.push(assistantEv(seq++, `P${i} ` + 'z'.repeat(2200), i + 1))
  }
  let foldCalls = 0
  const h = await makeHarness({
    answer: (req) => {
      const prompt = req.messages[0]?.content?.[0]?.text ?? ''
      if (prompt.includes('=== SLOT ')) {
        return {
          text: JSON.stringify({
            slots: slotKeysOf(req).map((key) => ({
              key,
              did: [`did-${key} ` + 'a'.repeat(700)],
              concluded: [`con-${key} ` + 'b'.repeat(700)],
              overturned: [`ov-${key} ` + 'c'.repeat(500)],
              asked: [],
            })),
          }),
        }
      }
      foldCalls += 1
      return {
        text: '```markdown\n## Dirty Heading\n- folded point one\n- folded point two\n```',
      }
    },
  })
  try {
    const s = makeSession(events, 'condense-trigger')
    await h.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
    assert.ok(foldCalls >= 1, `expected condenseOldest to run, saw foldCalls=${foldCalls}`)
    const digest = checkpointTextOf(s)
    assert.ok(digest.includes('## Condensed (condensed from sections 1-'), digest)
    assert.ok(!digest.includes('## Dirty Heading'), 'condensed output must strip markdown headings')
    assert.ok(!digest.includes('```'), 'condensed output must strip code fences')
  } finally {
    await h.stop()
  }
})

test('fix 4: filters auto todo-continuation goals, blocks malformed goal leak, and unescapes quotes in objective', () => {
  const events = [
    userEv(1, 'REAL-REQUEST'),
    assistantEv(2, 'working on it', 1),
    goalEv(3, '<goal_round>\nObjective: "Continue the 4 open tasks this session recorded:\\n1. [root] step one"\nRound: 1/256\n</goal_round>'),
    assistantEv(4, 'still working', 2),
    goalEv(5, '<goal_round>\nMalformed goal without objective field\n</goal_round>'),
    goalEv(6, '<goal_round>\nObjective: "Fix \\"alpha\\" parser\\nKeep tests green"\nRound: 1/256\n</goal_round>'),
    assistantEv(7, 'fixed alpha', 3),
  ]
  const sections = buildSections(events)
  assert.equal(sections.length, 2, `expected 2 sections (real + valid business goal), got ${sections.length}`)
  assert.equal(sections[0].turns[0].user[0], 'REAL-REQUEST')
  assert.equal(sections[1].turns[0].user[0], 'Fix "alpha" parser\nKeep tests green')
  const digest = renderDigest(events, 5000)
  assert.ok(!digest.includes('Continue the 4 open tasks'))
  assert.ok(!digest.includes('Malformed goal'))
})

test('fix 5: drops stale historical Asked on topic shift and deduplicates Asked already covered by Answers', () => {
  const events = [
    userEv(1, 'Task 1'),
    assistantEv(2, 'proposed options', 1, [
      {
        id: 'q1',
        name: 'ask_user_question',
        args: { questions: [{ id: 'pick', question: 'Which strategy should we use?' }] },
      },
    ]),
    toolResultEv(3, 'q1', JSON.stringify({ answers: [{ id: 'pick', selected: ['Option A'] }] })),
    userEv(4, 'Now let us move on to a completely different long request with plenty of detailed instructions exceeding eighty characters so this is clearly not a short option reply.'),
    assistantEv(5, 'finished task 2 and asked follow-up', 2),
  ]
  const extracted = new Map([
    ['0:0', {
      did: ['checked strategy'],
      concluded: ['strategy A works'],
      overturned: [],
      asked: [
        { question: 'Which strategy should we use?', options: ['Option A', 'Option B'] },
        { question: 'Unrelated stale historical question?', options: ['X', 'Y'] },
      ],
    }],
    ['1:0', {
      did: ['finished task 2'],
      concluded: ['ready'],
      overturned: [],
      asked: [{ question: 'Should we deploy now?', options: ['Yes', 'No'] }],
    }],
  ])
  const digest = renderDigest(events, 5000, extracted)
  // Historical turn 0 followed by a long new request drops stale Asked (and duplicate of Answers)
  assert.ok(!digest.includes('Unrelated stale historical question?'), digest)
  // Answers from turn 0 are kept
  assert.ok(digest.includes('Option A'), digest)
  // Latest open turn 1 keeps its Asked
  assert.ok(digest.includes('Should we deploy now?'), digest)
})

test('fix 6: buildExtractionMaterial preserves head and tail of long user and assistant prose', () => {
  const longUser = `USER-HEAD-MARK\n${'u'.repeat(5000)}\nUSER-TAIL-MARK`
  const longProse = `PROSE-HEAD-MARK\n${'p'.repeat(8000)}\nPROSE-TAIL-MARK`
  const material = buildExtractionMaterial([userEv(1, longUser)], longProse)
  assert.ok(material.includes('USER-HEAD-MARK'))
  assert.ok(material.includes('USER-TAIL-MARK'))
  assert.ok(material.includes('PROSE-HEAD-MARK'))
  assert.ok(material.includes('PROSE-TAIL-MARK'))
})

test('fix 7: calls the session route, reports it with usage, and parses lenient JSON', async () => {
  // 7a: lenient parseExtraction
  const messy = 'Here is the note {ignore me}:\n'
    + JSON.stringify([
      {
        key: 'SLOT 0:0 (turn 1)',
        did: 'single string did',
        concluded: ['real finding', '暂无', 'None.'],
        overturned: ['old assumption'],
        asked: [{ question: 'Proceed?', options: ['(1) Yes', 'A. No', '（2） Later'] }],
      },
    ])
    + '\nDone {trailing}.'
  const parsed = parseExtraction(messy)
  const slot = parsed.get('0:0')
  assert.ok(slot, 'expected normalized slot key 0:0')
  assert.deepEqual(slot.did, ['single string did'])
  assert.deepEqual(slot.concluded, ['real finding'])
  assert.deepEqual(slot.asked[0].options, ['Yes', 'No', 'Later'])

  // 7b: the call goes to the route the session is on, and the summary reports it
  const h = await makeHarness({
    modelInfo: () => ({ reasoning: { efforts: ['minimal', 'high'] } }),
    answer: (req) => ({
      text: JSON.stringify({
        slots: slotKeysOf(req).map((key) => ({
          key,
          did: [`did-${key}`],
          concluded: [],
          overturned: [],
          asked: [],
        })),
      }),
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
    }),
  })
  try {
    // The request header's route, not the agent's fallback, is what the session
    // is actually on — the two differ here so the assertion can tell them apart.
    const s = makeSession([
      requestHeaderEv(1, 'hdr-prov', 'hdr-mod'),
      userEv(2, 'REQ'),
      assistantEv(3, 'A'.repeat(5000), 1),
    ], 'session-route')
    await h.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
    assert.deepEqual(h.resolveCalls[0], { provider: 'hdr-prov', model: 'hdr-mod' })
    assert.equal(h.streamCalls[0].provider, 'hdr-prov')
    assert.equal(h.streamCalls[0].model, 'hdr-mod')
    assert.equal(h.streamCalls[0].reasoningEffort, 'minimal')
    const sumEv = s.snapshotEvents().find((e) => e.type === 'compaction/summary')
    assert.equal(sumEv?.data?.provider, 'hdr-prov')
    assert.equal(sumEv?.data?.model, 'hdr-mod')
    assert.equal(sumEv?.data?.usage?.inputTokens, 120)
    assert.equal(sumEv?.data?.usage?.outputTokens, 45)
  } finally {
    await h.stop()
  }
})

test('fix 8: condenses verbose old Answers stems and clips old pasted user inputs while keeping newest verbatim', () => {
  const longStem = `OLD-STEM-START ${'s'.repeat(400)} OLD-STEM-END`
  const oldPaste = `OLD-PASTE-HEAD\n${'x'.repeat(3500)}\nOLD-PASTE-TAIL`
  const newPaste = `NEW-PASTE-HEAD\n${'y'.repeat(3500)}\nNEW-PASTE-TAIL`
  const events = [
    userEv(1, oldPaste),
    assistantEv(2, 'a0', 1, [{ id: 'q0', name: 'ask_user_question', args: { questions: [{ id: 'a', question: longStem }] } }]),
    toolResultEv(3, 'q0', JSON.stringify({ answers: [{ id: 'a', selected: [], custom: 'KEEP-MY-CUSTOM-ANSWER' }] })),
    userEv(4, 'turn 1'),
    assistantEv(5, 'a1', 2),
    userEv(6, 'turn 2'),
    assistantEv(7, 'a2', 3),
    userEv(8, 'turn 3'),
    assistantEv(9, 'a3', 4),
    userEv(10, newPaste),
    assistantEv(11, 'a4', 5),
  ]
  const digest = renderDigest(events, 20000)
  // Old turn 0 answer stem is shortened, user custom answer preserved verbatim
  assert.ok(digest.includes('OLD-STEM-START'))
  assert.ok(!digest.includes('OLD-STEM-END'))
  assert.ok(digest.includes('KEEP-MY-CUSTOM-ANSWER'))
  // Old turn 0 paste is head+tail clipped
  assert.ok(digest.includes('OLD-PASTE-HEAD'))
  assert.ok(digest.includes('OLD-PASTE-TAIL'))
  assert.ok(!digest.includes('x'.repeat(3000)))
  // Newest turn 4 paste stays 100% verbatim
  assert.ok(digest.includes(newPaste))
})

test('fix 9: single-turn tool-heavy subagent session includes sampled tool results in extraction material', () => {
  const events = [userEv(1, '[只读] Research AX3000T flashing guide')]
  let seq = 2
  for (let i = 0; i < 12; i += 1) {
    const cid = `tc-${i}`
    events.push(assistantEv(seq++, '', 1, [{ id: cid, name: 'web_fetch', args: { url: `https://example.com/${i}` } }]))
    events.push(toolResultEv(seq++, cid, `Fetched doc ${i}: KEY-FINDING-${i}`))
  }
  const material = buildExtractionMaterial(events, 'checking sources', { includeToolResults: true })
  assert.ok(material.includes('KEY-FINDING-11'), material)
})

test('fix 10: leading goal or orphan assistant does not cause off-by-one extraction misalignment', async () => {
  // 10a: leading business goal
  const goalFirst = [
    requestHeaderEv(1),
    goalEv(2, '<goal_round>\nObjective: "BUSINESS-GOAL-A"\nRound: 1/256\n</goal_round>'),
    assistantEv(3, 'G'.repeat(2000), 1),
    userEv(4, 'FOLLOWUP-USER-B'),
    assistantEv(5, 'U'.repeat(2000), 2),
  ]
  const sections = buildSections(goalFirst)
  assert.equal(sections.length, 2, `expected 2 sections without phantom empty section, got ${sections.length}`)
  const h = await makeHarness({
    answer: (req) => ({
      text: JSON.stringify({
        slots: slotKeysOf(req).map((key) => {
          const prompt = req.messages[0].content[0].text
          const re = new RegExp(`=== SLOT ${key.replace(':', '\\:')} \\([^)]+\\) ===\\n([\\s\\S]*?)(?=\\n=== SLOT |\\n\\nReply with ONE JSON)`)
          const body = re.exec(prompt)?.[1] ?? ''
          const tag = body.includes('BUSINESS-GOAL-A') ? 'EXTRACTED-FOR-GOAL-A' : body.includes('FOLLOWUP-USER-B') ? 'EXTRACTED-FOR-USER-B' : 'WRONG'
          return { key, did: [tag], concluded: [], overturned: [], asked: [] }
        }),
      }),
    }),
  })
  try {
    const s = makeSession(goalFirst, 'goal-first-align')
    await h.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
    const digest = checkpointTextOf(s)
    const goalIdx = digest.indexOf('BUSINESS-GOAL-A')
    const goalExtIdx = digest.indexOf('EXTRACTED-FOR-GOAL-A')
    const userIdx = digest.indexOf('FOLLOWUP-USER-B')
    const userExtIdx = digest.indexOf('EXTRACTED-FOR-USER-B')
    assert.ok(goalIdx >= 0 && goalExtIdx > goalIdx && goalExtIdx < userIdx, digest)
    assert.ok(userExtIdx > userIdx, digest)
  } finally {
    await h.stop()
  }

  // 10b: leading orphan assistant before first user
  const orphanFirst = [
    assistantEv(1, 'orphan intro', 1),
    userEv(2, 'FIRST-USER'),
    assistantEv(3, 'reply', 2),
  ]
  const sOrphan = buildSections(orphanFirst)
  assert.equal(sOrphan.length, 2)
  assert.equal(sOrphan[0].turns[0].assistant[0], 'orphan intro')
  assert.equal(sOrphan[1].turns[0].user[0], 'FIRST-USER')
})

test('fix 11: shadowedSeqs handles non-message surface events and Turn drops dead tools map', () => {
  const bySeq = new Map([
    [1, { type: 'system/message', seq: 1, time: 1, surfaceOp: 'append', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } }],
    [2, userEv(2, 'hello')],
    [3, { type: 'custom/marker', seq: 3, time: 3, surfaceOp: 'append', data: {} }],
    [4, assistantEv(4, 'world', 1)],
    [5, userEv(5, 'retained')],
  ])
  const fakeSession = {
    surface: { nodes: [1, 2, 3, 4, 5] },
    eventAt: (seq) => bySeq.get(seq),
  }
  const input = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ],
  }
  const seqs = shadowedSeqs(fakeSession, input)
  assert.deepEqual(seqs, [2, 3, 4])

  // Dead turn.tools field removed
  const secs = buildSections([userEv(1, 'hi'), assistantEv(2, 'ok', 1, [{ id: 'c1', name: 'bash', args: { command: 'ls' } }])])
  assert.equal('tools' in secs[0].turns[0], false)
})

test('review regressions: tool-heavy auto-detection invalidates cache on new tool/result', async () => {
  const prevCache = process.env.DSH_VERBATIM_CACHE_DIR
  process.env.DSH_VERBATIM_CACHE_DIR = 'off'
  try {
    // Build a single-turn tool-heavy session (>120 tool calls so hint list hits MAX_HINTS_PER_TURN).
    const buildEvents = (tailResultText) => {
      const evs = [requestHeaderEv(0), userEv(1, 'Scan the entire repo and report failures')]
      let seq = 2
      for (let i = 1; i <= 125; i += 1) {
        const callId = `tc-${i}`
        evs.push(assistantEv(seq++, i === 1 ? 'Starting scan' : '', 1, [{ id: callId, name: 'read', args: { file_path: `/f/${i}.ts` } }]))
        const resText = i === 125 ? tailResultText : `ok-${i}`
        evs.push(toolResultEv(seq++, callId, resText, false))
      }
      // Retained tail message so compact has something before it
      evs.push(assistantEv(seq++, 'Still scanning', 1))
      return evs
    }

    const prompts = []
    let calls = 0
    const h = await makeHarness({
      answer: async (req) => {
        calls += 1
        prompts.push(req.messages[0]?.content?.[0]?.text ?? '')
        const keys = slotKeysOf(req)
        return {
          text: JSON.stringify({
            slots: keys.map((key) => ({ key, did: [`pass-${calls}`], concluded: [`seen-${calls}`], overturned: [], asked: [] })),
          }),
        }
      },
    })
    try {
      const s1 = makeSession(buildEvents('FOUND: first-finding-token'), 'tool-heavy-1')
      await h.engine.compactRegion(s1.surface.nodes[0], s1.surface.nodes.at(-1), agentFor(s1))
      assert.equal(calls, 1, `unexpected calls=${calls}, warnings=${JSON.stringify(h.warnings)}`)
      assert.ok(prompts[0].includes('KEY TOOL RESULTS ('), 'single-turn tool-heavy session should include sampled tool results')
      assert.ok(prompts[0].includes('first-finding-token'))

      // Second compaction with same prose and same first 120 hints, but changed 125th tool/result
      const s2 = makeSession(buildEvents('FOUND: second-finding-token'), 'tool-heavy-1')
      await h.engine.compactRegion(s2.surface.nodes[0], s2.surface.nodes.at(-1), agentFor(s2))
      assert.equal(calls, 2, 'cache key must reflect sampled tool results and invalidate when new tool/result arrives')
      assert.ok(prompts[1].includes('second-finding-token'))
    } finally {
      await h.stop()
    }
  } finally {
    if (prevCache === undefined) delete process.env.DSH_VERBATIM_CACHE_DIR
    else process.env.DSH_VERBATIM_CACHE_DIR = prevCache
  }
})

test('review regressions: lenient JSON ignores stray [1] and recovers nested object inside invalid braces', () => {
  const withFootnote = '注 [1]: {"slots":[{"key":"0:0","did":["parsed-after-footnote"],"concluded":[],"overturned":[],"asked":[]}]}'
  const m1 = parseExtraction(withFootnote)
  assert.deepEqual(m1.get('0:0')?.did, ['parsed-after-footnote'])

  const withInvalidOuter = '{result: {"slots":[{"key":"0:0","did":["nested-ok"],"concluded":[],"overturned":[],"asked":[]}]}}'
  const m2 = parseExtraction(withInvalidOuter)
  assert.deepEqual(m2.get('0:0')?.did, ['nested-ok'])
})

test('review regressions: call timeout does not trigger binary-split retry storm and truncated complete batch is not re-run', async () => {
  const prevTimeout = process.env.DSH_VERBATIM_CALL_TIMEOUT_MS
  const prevCache = process.env.DSH_VERBATIM_CACHE_DIR
  process.env.DSH_VERBATIM_CALL_TIMEOUT_MS = '60'
  process.env.DSH_VERBATIM_CACHE_DIR = 'off'
  try {
    // Case A: hung stream times out once per batch without binary-splitting into 2^k retries
    let timeoutCalls = 0
    const h1 = await makeHarness({
      answer: async (req) => {
        timeoutCalls += 1
        await new Promise((resolve, reject) => {
          if (req.signal?.aborted) { reject(new Error('aborted')); return }
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return { text: '{}' }
      },
    })
    try {
      const events = [requestHeaderEv(0)]
      let seq = 1
      for (let t = 1; t <= 4; t += 1) {
        events.push(userEv(seq++, `turn ${t}`))
        events.push(assistantEv(seq++, `answer ${t} `.repeat(800), t))
      }
      events.push(userEv(seq++, 'retained tail'))
      const s = makeSession(events, 'timeout-no-split')
      await h1.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
      assert.equal(timeoutCalls, 1, 'transport/timeout failure must not recursively binary-split the batch')
    } finally {
      await h1.stop()
    }

    // Case B: truncated response that already parsed every slot in the batch does not re-run
    process.env.DSH_VERBATIM_CALL_TIMEOUT_MS = '5000'
    let truncCalls = 0
    const h2 = await makeHarness({
      answer: async (req) => {
        truncCalls += 1
        const keys = slotKeysOf(req)
        return {
          text: JSON.stringify({
            slots: keys.map((key) => ({ key, did: [`ok-${key}`], concluded: [], overturned: [], asked: [] })),
          }),
          reason: 'max-tokens',
        }
      },
    })
    try {
      const events = [requestHeaderEv(0)]
      let seq = 1
      for (let t = 1; t <= 3; t += 1) {
        events.push(userEv(seq++, `turn ${t}`))
        events.push(assistantEv(seq++, `answer ${t} `.repeat(300), t))
      }
      events.push(userEv(seq++, 'retained tail'))
      const s = makeSession(events, 'truncated-complete')
      await h2.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
      assert.equal(truncCalls, 1, 'already-parsed truncated batch should not re-extract all slots')
    } finally {
      await h2.stop()
    }
  } finally {
    if (prevTimeout === undefined) delete process.env.DSH_VERBATIM_CALL_TIMEOUT_MS
    else process.env.DSH_VERBATIM_CALL_TIMEOUT_MS = prevTimeout
    if (prevCache === undefined) delete process.env.DSH_VERBATIM_CACHE_DIR
    else process.env.DSH_VERBATIM_CACHE_DIR = prevCache
  }
})

test('review regressions: T1 bills clipped older paste without starving earlier constraints and preserves latest real user when goal follows', () => {
  const hugePaste = `PASTE-HEAD\n${'x'.repeat(50_000)}\nPASTE-TAIL`
  const longLatestUser = `LATEST-HEAD\n${'y'.repeat(3200)}\nLATEST-TAIL`
  const events = [
    userEv(1, 'STANDING-CONSTRAINT: never drop this rule'),
    assistantEv(2, 'ack', 1),
    userEv(3, hugePaste),
    assistantEv(4, 'ack paste', 2),
    userEv(5, longLatestUser),
    assistantEv(6, 'working', 3),
    goalEv(7, 'Objective: "Ship v2 safely"'),
    assistantEv(8, 'shipping', 4),
  ]
  const extracted = new Map([
    ['0:0', { did: ['noted constraint'], concluded: [], overturned: [], asked: [] }],
    ['1:0', { did: ['read paste'], concluded: [], overturned: [], asked: [] }],
    ['2:0', { did: ['started latest'], concluded: [], overturned: [], asked: [] }],
    ['3:0', { did: ['shipping'], concluded: [], overturned: [], asked: [] }],
  ])
  // Budget 4000 tokens (16k chars) easily fits clipped paste (~2.2k) + standing constraint + latest real user (~3.2k),
  // whereas billing the unclipped 50k paste would starve earlier turns.
  const digest = renderDigest(events, 4000, extracted)
  assert.ok(digest.includes('STANDING-CONSTRAINT: never drop this rule'), 'earlier short standing constraint must not be starved by clipped historical paste')
  assert.ok(digest.includes('PASTE-HEAD') && digest.includes('PASTE-TAIL'), 'older paste should keep head and tail once without double clipping')
  assert.equal((digest.match(/chars omitted/g) ?? []).length, 1, 'older paste should only be clipped once')
  assert.ok(digest.includes(longLatestUser), 'latest real user request must remain unclipped even when a goal section follows')
})

test('review regressions: short reply keeps non-duplicate Asked while dedupe strips exact short Chinese duplicates', () => {
  const events = [
    userEv(1, 'Start'),
    assistantEv(2, 'asked two things', 1, [
      {
        id: 'q-short',
        name: 'ask_user_question',
        args: { questions: [{ id: 'c', question: '继续吗？' }] },
      },
    ]),
    toolResultEv(3, 'q-short', JSON.stringify({ answers: [{ id: 'c', selected: ['继续'] }] })),
    userEv(4, '1'),
    assistantEv(5, 'done', 2),
  ]
  const extracted = new Map([
    ['0:0', {
      did: ['checked'],
      concluded: [],
      overturned: [],
      asked: [
        { question: '继续吗？', options: ['继续', '停止'] },
        { question: '选哪个方案？', options: ['方案一', '方案二'] },
      ],
    }],
    ['1:0', { did: ['done'], concluded: [], overturned: [], asked: [] }],
  ])
  const digest = renderDigest(events, 5000, extracted)
  assert.ok(digest.includes('选哪个方案？'), 'short reply (<=80 chars) must keep non-duplicate historical Asked')
  assert.ok(!digest.includes('## Asked\n- 继续吗？'), 'exact short Chinese duplicate already in Answers must be deduped from Asked')
  assert.ok(digest.includes('## Answers\n- 继续吗？'), 'Answers entry itself must remain')
})

test('review regressions: corrupt disk cache entries with missing arrays are ignored safely', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'verbatim-corrupt-cache-'))
  const prevCache = process.env.DSH_VERBATIM_CACHE_DIR
  process.env.DSH_VERBATIM_CACHE_DIR = cacheDir
  try {
    const sessionId = 'corrupt-cache-sess'
    writeFileSync(
      join(cacheDir, `${sessionId}.json`),
      JSON.stringify({ v: 1, extraction: { 'broken-key': { did: 'not-an-array' } }, condensed: {} }),
      'utf8',
    )
    const h = await makeHarness({
      answer: async (req) => ({
        text: JSON.stringify({
          slots: slotKeysOf(req).map((key) => ({ key, did: ['fresh-extract'], concluded: [], overturned: [], asked: [] })),
        }),
      }),
    })
    try {
      const s = makeSession([
        requestHeaderEv(0),
        userEv(1, 'hello'),
        assistantEv(2, 'detailed analysis output '.repeat(200), 1),
        userEv(3, 'tail'),
      ], sessionId)
      await h.engine.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agentFor(s))
      assert.ok(checkpointTextOf(s).includes('fresh-extract'))
    } finally {
      await h.stop()
    }
  } finally {
    if (prevCache === undefined) delete process.env.DSH_VERBATIM_CACHE_DIR
    else process.env.DSH_VERBATIM_CACHE_DIR = prevCache
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('asked dedupe: strips merged paraphrase combining multiple answered ask_user_question items', () => {
  const events = [
    userEv(1, 'Write zip dedup plan'),
    assistantEv(2, 'plan written', 1, [
      {
        id: 'q-merge',
        name: 'ask_user_question',
        args: {
          questions: [
            {
              id: 'zip_preview',
              question: '新 zip 里那份 preview.jpg（在压缩包内部，不是桶里同级那个）要不要一并删掉？',
              options: [{ label: '删掉（推荐）' }, { label: '保留' }],
            },
            {
              id: 'scope',
              question: '存量回收先做到多大范围？全量 9.14 万个模型约需 12.8 TB 传输。',
              options: [{ label: '先做 top 1000 再决定（推荐）' }, { label: '直接全量跑' }],
            },
          ],
        },
      },
    ]),
    toolResultEv(3, 'q-merge', JSON.stringify({
      answers: [
        { id: 'zip_preview', selected: ['删掉（推荐）'] },
        { id: 'scope', selected: ['直接全量跑'] },
      ],
    })),
    userEv(4, '对文档做一次 /blind-review'),
    assistantEv(5, 'started review', 2),
  ]
  const extracted = new Map([
    ['0:0', {
      did: ['wrote zip-texture-dedup.md'],
      concluded: ['server-side multipart copy is unsupported'],
      overturned: [],
      asked: [{
        question: '是否删除 zip 内 preview.jpg 与存量是否全量执行',
        options: ['删掉 zip 内 preview', '保留 zip 内 preview', '存量全量执行', '先 top 1000 试跑'],
      }],
    }],
    ['1:0', { did: ['started review'], concluded: [], overturned: [], asked: [] }],
  ])
  const digest = renderDigest(events, 5000, extracted)
  assert.ok(digest.includes('## Answers'), 'Answers section must remain')
  assert.ok(!digest.includes('## Asked'), `merged paraphrase of Answers must be stripped from Asked:\n${digest}`)
})

test('asked dedupe: strips heavily paraphrased stem when options match answered selection or offered menu', () => {
  const events = [
    userEv(1, 'Align event 4 tone'),
    assistantEv(2, 'options listed', 1, [
      {
        id: 'q-opt-sel',
        name: 'ask_user_question',
        args: {
          questions: [
            {
              id: 'style',
              question: '事件 4 的句均 14.6 字、对白占 42%，你要哪一种对齐方式？',
              options: [{ label: '按事件 1–3 语域整篇重写' }, { label: '保留对白骨架，只补叙述层' }],
            },
            {
              id: 'scope',
              question: '存量回收先做到多大范围？',
              options: [{ label: '先做 top 1000 再决定（推荐）' }, { label: '先只做单个模型的验证' }],
            },
          ],
        },
      },
    ]),
    toolResultEv(3, 'q-opt-sel', JSON.stringify({
      answers: [
        { id: 'style', selected: ['保留对白骨架，只补叙述层'] },
        { id: 'scope', selected: [], custom: '先看效果再定' },
      ],
    })),
    userEv(4, '继续'),
    assistantEv(5, 'done', 2),
  ]
  const extracted = new Map([
    ['0:0', {
      did: ['checked tone'],
      concluded: [],
      overturned: [],
      asked: [
        {
          question: '两条修法选哪条',
          options: ['按事件 1–3 语域重写一遍', '保留对白骨架只补叙述层'],
        },
        {
          question: '两项待定怎么选',
          options: ['先做 top 1000 再决定', '先只做单个模型的验证'],
        },
      ],
    }],
    ['1:0', { did: ['done'], concluded: [], overturned: [], asked: [] }],
  ])
  const digest = renderDigest(events, 5000, extracted)
  assert.ok(digest.includes('## Answers'), 'Answers section must remain')
  assert.ok(!digest.includes('## Asked'), `option-matched paraphrased Asked must be stripped:\n${digest}`)
})

test('asked dedupe: preserves genuinely distinct follow-up prose question sharing a domain noun', () => {
  const events = [
    userEv(1, 'Fix mesh loop and check sample'),
    assistantEv(2, 'fixed loop and wrote sample', 1, [
      {
        id: 'q-distinct',
        name: 'ask_user_question',
        args: {
          questions: [
            {
              id: 'loop',
              question: '我拆掉了两端的 mesh（这是环路的根源），主路由负载已恢复，现在能连上 Unraid 吗？',
              options: [{ label: '能连上，继续' }, { label: '还是连不上' }],
            },
            {
              id: 'sample',
              question: '如果改回叙述主导，是一次性整篇重写，还是先让你看一段样本？',
              options: [{ label: '按事件 1–3 语域整篇重写' }, { label: '先给样本再整篇（推荐）' }],
            },
          ],
        },
      },
    ]),
    toolResultEv(3, 'q-distinct', JSON.stringify({
      answers: [
        { id: 'loop', selected: ['能连上，继续'] },
        { id: 'sample', selected: ['先给样本再整篇（推荐）'] },
      ],
    })),
    userEv(4, '1'),
    assistantEv(5, 'applied', 2),
  ]
  const extracted = new Map([
    ['0:0', {
      did: ['removed loop and produced sample'],
      concluded: [],
      overturned: [],
      asked: [
        { question: 'mesh 是否继续做', options: ['先不动，保持现状可用', '把主路由升级后再做 802.11s'] },
        { question: '样本语域是否认可？', options: ['认可，按此档次铺满整场', '指出过或欠处再调整'] },
      ],
    }],
    ['1:0', { did: ['applied'], concluded: [], overturned: [], asked: [] }],
  ])
  const digest = renderDigest(events, 5000, extracted)
  assert.ok(digest.includes('## Answers'), 'Answers section must remain')
  assert.ok(digest.includes('mesh 是否继续做'), 'distinct follow-up question sharing one noun must survive')
  assert.ok(digest.includes('样本语域是否认可？'), 'distinct follow-up question after sample delivery must survive')
})


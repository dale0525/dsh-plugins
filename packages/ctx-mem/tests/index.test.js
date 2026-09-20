/**
 * Tests for the ctx-mem engine assembly.
 *
 * These pin the acceptance items that belong to the assembly itself: the config
 * split that keeps the host engine's strict key validation from rejecting our
 * own keys, the fill switch (A5), the fill-call cost property (A7), the hard
 * cutoff option (A10), and route resolution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import CtxMemEngine, { name } from '../src/index.js';
import { resolveFillTarget, splitConfig } from '../src/config.js';
import { CAUSAL_SECTIONS } from '../src/causal.js';

/* ------------------------------------------------------------------ helpers */

/** A message-producing event. */
function userMessage(seq, text, source = { kind: 'user' }) {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: { role: 'user', content: [{ type: 'text', text }], source },
  };
}

/** A tool call plus its result, so the region carries real extractable facts. */
function assistantToolCall(seq, id, toolName, args) {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id, name: toolName, arguments: JSON.stringify(args) }],
      },
    },
  };
}

function toolResult(seq, callId, text, isError = false) {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
        source: { kind: 'tool', callId },
      },
    },
  };
}

/**
 * A session exposing exactly the API the engine uses: `seq`, `eventAt`,
 * `snapshotEvents`, `deriveEventMessage`, `requestHeader`, `id`.
 */
function fakeSession(events, route) {
  const derived = new Map();
  for (const event of events) {
    if (event.type === 'user/message') derived.set(event, event.data);
    else if (event.type === 'assistant/message' || event.type === 'tool/result') derived.set(event, event.data.message);
  }
  return {
    id: 'session-test',
    seq: events.length,
    eventAt: (seq) => events[seq],
    snapshotEvents: (from, toExclusive) => events.slice(from, toExclusive),
    deriveEventMessage: (event) => derived.get(event) ?? null,
    requestHeader: () => (route === undefined ? undefined : { config: route }),
  };
}

/** Capture the options of every `ctx.llm.stream()` call and reply with text. */
function capturingContext(replyText = '## Why This Approach\n- filled\n') {
  const calls = [];
  const ctx = new Context();
  ctx.provide('llm', {
    stream(options) {
      calls.push(options);
      return (async function* () {
        if (replyText !== null) yield { type: 'text-delta', text: replyText };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  ctx.provide('tokenMeter', {});
  ctx.provide('sessions', {});
  return { ctx, calls };
}

/**
 * The messages the host actually hands `summarize()`: the DERIVED messages of
 * the region, not the raw events. Passing raw events instead would make the
 * identity map in `regionOf` match nothing, silently yielding an empty region —
 * a fixture that passes for the wrong reason.
 */
function derivedMessages(session, events) {
  return events.map((event) => session.deriveEventMessage(event)).filter((message) => message !== null);
}

/** Total characters of a message's text blocks. */
function messageChars(message) {
  return message.content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0);
}

/** A realistic region: many user turns plus tool calls and results. */
function realisticRegion(turns = 60) {
  const events = [];
  let seq = 0;
  for (let i = 0; i < turns; i += 1) {
    events.push(userMessage(seq++, `Please investigate problem number ${i} in the codebase and report back with detail.`));
    const callId = `call_${i}`;
    events.push(assistantToolCall(seq++, callId, 'read', { file_path: `/repo/src/module-${i}/index.js` }));
    events.push(toolResult(seq++, callId, `contents of module ${i}\n`.repeat(40)));
  }
  return { events, session: fakeSession(events, { provider: 'p', model: 'm' }) };
}

const AGENT = { session: null, options: {} };

/* -------------------------------------------------------------- config split */

test('the config split keeps the host engine from rejecting our own keys', () => {
  const { engineConfig, own } = splitConfig({
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    fillEnabled: false,
    fillProvider: 'vp',
    fillModel: 'vm',
    language: 'en',
    maxCheckpointTokens: 12345,
  });

  assert.deepEqual(Object.keys(engineConfig).sort(), ['retainRatio', 'thresholdRatio']);
  assert.deepEqual(own, {
    fillEnabled: false,
    fillProvider: 'vp',
    fillModel: 'vm',
    language: 'en',
    maxCheckpointTokens: 12345,
  });
})

test('the host engine genuinely rejects our keys, so stripping is required', () => {
  const { ctx } = capturingContext();
  // Verified against the host class directly: passing our key straight through is
  // the defect `splitConfig` prevents. The host validates its own key set and
  // throws on anything else, so every construction would fail without the split.
  assert.throws(
    () => new BasicCompactionEngine(ctx, { fillEnabled: false }),
    /unknown key/,
    'if this stops throwing, splitConfig may be unnecessary — re-verify, do not delete the test blindly',
  );
})

test('the engine constructs with our keys present and applies their defaults', () => {
  const { ctx } = capturingContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  assert.equal(engine.ctxMemConfig.fillEnabled, true);
  assert.equal(engine.ctxMemConfig.fillProvider, '');
  assert.equal(engine.ctxMemConfig.fillModel, '');
  assert.equal(engine.ctxMemConfig.language, 'zh');
  assert.equal(engine.ctxMemConfig.maxCheckpointTokens, 24000);
})

test('A10 — retainTokens: 0 is accepted, enabling the hard cutoff', () => {
  const { ctx } = capturingContext();
  // `retainTokens` is a host key: it must reach the host engine, not our half.
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainTokens: 0 });

  assert.equal(engine.config.retainTokens, 0);
  assert.equal(engine.config.retainRatio, undefined, 'retainTokens must override retainRatio');
})

/* --------------------------------------------------------------- fill switch */

test('A5 — fillEnabled: false issues no model call and emits no causal sections', async () => {
  const { events, session } = realisticRegion(4);
  const { ctx, calls } = capturingContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, fillEnabled: false });

  const result = await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });

  assert.equal(calls.length, 0, 'no model call may be attempted when the fill is disabled');

  const text = result.summary.map((block) => block.text).join('');
  for (const heading of CAUSAL_SECTIONS) {
    assert.ok(!text.includes(heading), `deterministic output must not contain ${heading}`);
  }
  assert.ok(text.includes('## Extracted Facts'), 'the fact skeleton is still emitted');
})

/* ------------------------------------------------------------ cost property */

/**
 * Total characters of all text reachable in a value, walking nested content.
 *
 * A `tool-result` block nests its own `content` array, so a shallow scan of the
 * top-level blocks silently counts zero for every tool result — which would make
 * the cost comparison below pass for the wrong reason.
 */
function nestedTextChars(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + nestedTextChars(item), 0);
  if (value !== null && typeof value === 'object') {
    let total = 0;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'text' && typeof item === 'string') total += item.length;
      else if (key === 'content' || key === 'arguments') total += nestedTextChars(item);
    }
    return total;
  }
  return 0;
}

test('A7 — the fill call sends the skeleton, not the replayed conversation', async () => {
  const { events, session } = realisticRegion(60);
  const { ctx, calls } = capturingContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });

  assert.equal(calls.length, 1, 'exactly one fill call');
  const sent = calls[0].messages.reduce((total, message) => total + messageChars(message), 0);

  // The baseline is what the host engine would have replayed: the region's
  // derived messages, including tool-result text (nested) and tool arguments.
  const replayed = derivedMessages(session, events).reduce(
    (total, message) => total + nestedTextChars(message),
    0,
  );
  assert.ok(replayed > 0, 'baseline must be non-trivial, else the ratio is meaningless');

  // The whole point of the hybrid shape: the request is priced by the skeleton.
  assert.ok(
    sent * 5 <= replayed,
    `fill input (${sent} chars) must be at most 1/5 of the replayed region (${replayed} chars)`,
  );
  // And it must not smuggle the conversation in alongside the skeleton.
  const sentText = calls[0].messages.map((message) => message.content.map((b) => b.text ?? '').join('')).join('\n');
  assert.ok(!sentText.includes('contents of module 0'), 'raw tool output must not be replayed into the fill call');
})

test('A5b — the fill route defaults to the session current route', async () => {
  const { events, session } = realisticRegion(2);
  const { ctx, calls } = capturingContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });

  assert.equal(calls[0].provider, 'p');
  assert.equal(calls[0].model, 'm');
})

test('an explicit fill route overrides the session route', async () => {
  const { events, session } = realisticRegion(2);
  const { ctx, calls } = capturingContext();
  const engine = new CtxMemEngine(ctx, {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    fillProvider: 'vp',
    fillModel: 'vm',
  });

  await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });

  assert.equal(calls[0].provider, 'vp');
  assert.equal(calls[0].model, 'vm');
})

test('the filled checkpoint carries the facts verbatim and the four sections', async () => {
  const events = [
    userMessage(0, 'please read the config'),
    assistantToolCall(1, 'c1', 'read', { file_path: '/repo/alpha.txt' }),
    toolResult(2, 'c1', 'alpha contents'),
  ];
  const session = fakeSession(events, { provider: 'p', model: 'm' });
  const { ctx } = capturingContext('## Why This Approach\n- because\n');
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  const result = await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });
  const text = result.summary.map((block) => block.text).join('');

  assert.ok(text.includes('/repo/alpha.txt'), 'the path is carried verbatim');
  assert.ok(text.includes('## Extracted Facts'));
  for (const heading of CAUSAL_SECTIONS) assert.ok(text.includes(heading), `missing ${heading}`);
})

test('a fill failure is not silently swallowed', async () => {
  const { events, session } = realisticRegion(2);
  const ctx = new Context();
  ctx.provide('llm', {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'X' } } };
      })();
    },
  });
  ctx.provide('tokenMeter', {});
  ctx.provide('sessions', {});
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  await assert.rejects(
    () => engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session }),
    /upstream exploded/,
  );
})

/* ---------------------------------------------------------- route resolution */

test('resolveFillTarget prefers the explicit pair, then the session route, then agent options', () => {
  const own = { fillProvider: 'vp', fillModel: 'vm' };
  const routedAgent = { session: { requestHeader: () => ({ config: { provider: 'rp', model: 'rm' } }) }, options: {} };
  assert.deepEqual(resolveFillTarget(own, routedAgent), { provider: 'vp', model: 'vm' });

  const empty = { fillProvider: '', fillModel: '' };
  assert.deepEqual(resolveFillTarget(empty, routedAgent), { provider: 'rp', model: 'rm' });

  const unroutedAgent = {
    session: { requestHeader: () => undefined },
    options: { provider: 'op', model: 'om' },
  };
  assert.deepEqual(resolveFillTarget(empty, unroutedAgent), { provider: 'op', model: 'om' });

  assert.equal(resolveFillTarget(empty, { session: { requestHeader: () => undefined }, options: {} }), undefined);
})

test('a half-configured fill route falls back rather than sending a broken pair', () => {
  const agent = { session: { requestHeader: () => ({ config: { provider: 'rp', model: 'rm' } }) }, options: {} };
  assert.deepEqual(
    resolveFillTarget({ fillProvider: 'vp', fillModel: '' }, agent),
    { provider: 'rp', model: 'rm' },
  );
})

/* ------------------------------------------------------------------ identity */

test('the plugin row id matches the patch row id', () => {
  assert.equal(name, 'ctx-mem');
})

/* -------------------------------------------------- service-proxy invocation */

/**
 * `summarize()` is never called on the instance in production. The host reaches
 * the backend through the `compaction` service, and cordis hands every service
 * method a SHADOW context as `this` (`createShadowMethod` in cordis'
 * `ReflectService`). That shadow is a `Proxy` wrapping the instance, so a
 * `#private` member is not reachable from it — V8 rejects the brand check with
 * `Receiver must be an instance of class CtxMemEngine`.
 *
 * Calling `engine.summarize(...)` directly, as every other test in this file
 * does, cannot detect that: it passes the real instance as `this`. These two
 * tests go through `ctx.compaction`, the same way the host does.
 */
test('summarize works when reached through the cordis service proxy', async () => {
  const { events, session } = realisticRegion(4);
  const { ctx, calls } = capturingContext();
  new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  const result = await ctx.compaction.summarize(
    { messages: derivedMessages(session, events) },
    { ...AGENT, session },
  );

  assert.equal(calls.length, 1, 'the fill call still happens through the proxy');
  const text = result.summary.map((block) => block.text).join('');
  assert.ok(text.includes('## Extracted Facts'));
})

test('the deterministic path also works through the service proxy', async () => {
  const { events, session } = realisticRegion(4);
  const { ctx, calls } = capturingContext();
  new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, fillEnabled: false });

  const result = await ctx.compaction.summarize(
    { messages: derivedMessages(session, events) },
    { ...AGENT, session },
  );

  assert.equal(calls.length, 0);
  assert.ok(result.summary.map((block) => block.text).join('').includes('## Extracted Facts'));
})

test('a modelPolicies entry overrides the global maxTokens for the fill route', async () => {
  const { events, session } = realisticRegion(2);
  const { ctx, calls } = capturingContext();
  // The session route is p/m; the exact-target entry pins a cap for it.
  const engine = new CtxMemEngine(ctx, {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    maxTokens: 4096,
    modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 512 }],
  });

  const result = await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });

  assert.equal(calls[0].maxTokens, 512, 'the per-route cap must reach the fill call')
  assert.equal(result.maxTokens, 512, 'and must be recorded on the summary result')
})

test('without a modelPolicies entry the global maxTokens is used', async () => {
  const { events, session } = realisticRegion(2);
  const { ctx, calls } = capturingContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 4096 });

  await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });

  assert.equal(calls[0].maxTokens, 4096)
})

test('the fill call is marked as a compaction request', async () => {
  const { events, session } = realisticRegion(2);
  const { ctx, calls } = capturingContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session });

  assert.equal(calls[0].purpose, 'compaction')
})

test('adapter-reported usage is carried onto the summary result', async () => {
  const { events, session } = realisticRegion(2);
  const { ctx } = capturingContext();
  // The adapter emits usage as its own chunk; the engine must surface it rather
  // than dropping it, so the compaction event records what the fill call cost.
  const usage = { inputTokens: 11, outputTokens: 22 }
  const originalStream = ctx.llm.stream
  ctx.llm.stream = (options) =>
    (async function* () {
      yield { type: 'text-delta', text: '## Why This Approach\n- filled\n' }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  void originalStream

  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 })
  const result = await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session })

  assert.deepEqual(result.usage, usage)
})

test('a fill call without a usage chunk omits the key rather than inventing one', async () => {
  const { events, session } = realisticRegion(2);
  const { ctx } = capturingContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 })

  const result = await engine.summarize({ messages: derivedMessages(session, events) }, { ...AGENT, session })

  assert.equal('usage' in result, false)
})

/**
 * Integration tests for the budget-driven checkpoint.
 *
 * These drive the real `summarize()` through a `tokenMeter` stub that prices
 * exactly like the host, and assert the property the host guard enforces: the
 * framed checkpoint must be strictly smaller than the region it replaces.
 *
 * The `capturingContext()` helper in `index.test.js` provides an empty
 * `tokenMeter`, so the engine falls back to the absolute cap there — that path
 * is covered by the render unit tests. These tests cover the path where the
 * region CAN be priced, which is the one that failed in production.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import CtxMemEngine from '../src/index.js';
import { estimateMessage } from './frame-price.js';
import { framePrice } from './frame-price.js';

/* --------------------------------------------------------------- fixtures */

/** A `tokenMeter` shaped like the host service: `estimateMessage` only. */
const METER = { estimateMessage };

/**
 * One turn — a read (a file fact), a bash command (a command fact) and their
 * results — appended to a growing event list.
 *
 * Both a `read` and a `bash` call on purpose: `files` and `commands` are
 * populated by different accessors, so a bash-only fixture would leave `files`
 * empty and let a "files survive" assertion pass vacuously.
 */
function pushTurn(events, seq, index) {
  events.push({
    type: 'user/message',
    seq,
    data: { role: 'user', content: [{ type: 'text', text: `please inspect module ${index} and report the outcome` }] },
  });
  events.push({
    type: 'assistant/message',
    seq: seq + 1,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', name: 'read', arguments: JSON.stringify({ file_path: `/repo/src/module-${index}/index.js` }) }],
      },
    },
  });
  events.push({
    type: 'tool/result',
    seq: seq + 2,
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'text', text: `match on line ${index}\n`.repeat(30) }] }],
      },
    },
  });
  events.push({
    type: 'assistant/message',
    seq: seq + 3,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', name: 'bash', arguments: JSON.stringify({ command: `grep -n "needle-${index}" /repo/src/module-${index}/index.js` }) }],
      },
    },
  });
  events.push({
    type: 'tool/result',
    seq: seq + 4,
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'text', text: `found ${index}\n`.repeat(20) }] }],
      },
    },
  });
  return seq + 5;
}

/** A region whose tool output dominates, so the fact set grows with it. */
function growingRegion(turns) {
  const events = [];
  let seq = 0;
  for (let i = 0; i < turns; i += 1) seq = pushTurn(events, seq, i);
  return events;
}

/** A session exposing the API `regionOf` and `summarize()` use. */
function sessionFor(events) {
  const derived = new Map();
  for (const event of events) {
    if (event.type === 'user/message') derived.set(event, event.data);
    else derived.set(event, event.data.message);
  }
  return {
    id: 'session-budget',
    seq: events.length,
    eventAt: (seq) => events[seq],
    snapshotEvents: (from, toExclusive) => events.slice(from, toExclusive),
    deriveEventMessage: (event) => derived.get(event) ?? null,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };
}

/** A context whose meter prices like the host and whose llm returns `reply`. */
function budgetContext(reply = '## Why This Approach\n- because the guard is not recoverable\n') {
  const calls = [];
  const ctx = new Context();
  ctx.provide('llm', {
    stream(options) {
      calls.push(options);
      return (async function* () {
        yield { type: 'text-delta', text: reply };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  ctx.provide('tokenMeter', METER);
  ctx.provide('sessions', {});
  return { ctx, calls };
}

/**
 * The price the host guard will compute for a result: the framed summary,
 * summing the estimator over every block as `estimateMessage` would.
 */
function guardedPrice(result) {
  const body = result.summary.map((block) => block.text).join('');
  return framePrice(body);
}

/** The denominator the host compares against: the replayed region, minus the leading system message. */
function denominatorOf(events) {
  return events.slice(1).reduce((total, event) => total + estimateMessage(event.data.message ?? event.data), 0);
}

const AGENT = (session) => ({ session, options: {} });

/* ------------------------------------------------------------ the property */

test('A2/A12 — the framed checkpoint is strictly smaller than the region it replaces', async () => {
  for (const turns of [5, 20, 60, 120]) {
    const events = growingRegion(turns);
    const session = sessionFor(events);
    const { ctx } = budgetContext();
    const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

    const messages = events.map((event) => session.deriveEventMessage(event));
    const result = await engine.summarize({ messages }, AGENT(session));

    const denominator = denominatorOf(events);
    const price = guardedPrice(result);
    assert.ok(
      price < denominator,
      `${turns} turns: framed price ${price} must be < denominator ${denominator}`,
    );
  }
})

test('A14 — a large region is bounded by maxCheckpointTokens', async () => {
  // 120 turns puts the floor (intents + files, ~2563) safely under the 4000 cap,
  // so the cap genuinely binds on commands rather than on the untrimmable floor.
  const events = growingRegion(120);
  const session = sessionFor(events);
  const { ctx } = budgetContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, maxCheckpointTokens: 4000 });

  const messages = events.map((event) => session.deriveEventMessage(event));
  const result = await engine.summarize({ messages }, AGENT(session));

  const price = guardedPrice(result);
  assert.ok(price <= 4000 + 102, `framed price ${price} must respect the 4000-token cap (plus frame overhead)`);
  assert.ok(price < denominatorOf(events), 'and must still satisfy the guard');
})

test('A4/A6 vs A14 — intents and files are never trimmed, so they may exceed the cap', async () => {
  // The floor tier is deliberately exempt from the cap: intents and files are
  // the 0.7% of the checkpoint that carries the intent, and the renderer must
  // never silently drop them to satisfy a ceiling. This pins that the cap is
  // NOT a hard guarantee once the floor alone exceeds it.
  const events = growingRegion(400);
  const session = sessionFor(events);
  const { ctx } = budgetContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, maxCheckpointTokens: 1 });

  const messages = events.map((event) => session.deriveEventMessage(event));
  const result = await engine.summarize({ messages }, AGENT(session));
  const text = result.summary.map((block) => block.text).join('');

  assert.ok(text.includes('/repo/src/module-0/index.js'), 'the earliest file fact survives');
  assert.ok(text.includes('please inspect module 0'), 'the earliest intent survives');
  assert.ok(guardedPrice(result) > 1, 'the floor may exceed a cap smaller than the floor itself');
})

test('a lower maxCheckpointTokens never yields a more expensive checkpoint', async () => {
  const events = growingRegion(120);
  const session = sessionFor(events);
  const messages = events.map((event) => session.deriveEventMessage(event));

  const prices = [];
  for (const cap of [20000, 8000, 2000, 1000]) {
    const { ctx } = budgetContext();
    const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, maxCheckpointTokens: cap });
    prices.push(guardedPrice(await engine.summarize({ messages }, AGENT(session))));
  }

  // Non-increasing, not strictly decreasing: when the region's own price is
  // already below a large cap, two different caps legitimately give the same
  // checkpoint — the cap is an upper bound, not a target.
  for (let i = 1; i < prices.length; i += 1) {
    assert.ok(prices[i] <= prices[i - 1], `cap ${i}: price must not rise, got ${JSON.stringify(prices)}`);
  }
  assert.ok(prices[prices.length - 1] < prices[0], `the tightest cap must bite, got ${JSON.stringify(prices)}`);
})

test('the fill call is sent a skeleton that already fits the budget', async () => {
  const events = growingRegion(120);
  const session = sessionFor(events);
  const { ctx, calls } = budgetContext();
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, maxCheckpointTokens: 4000 });

  const messages = events.map((event) => session.deriveEventMessage(event));
  await engine.summarize({ messages }, AGENT(session));

  assert.equal(calls.length, 1, 'exactly one fill call');
  const sent = calls[0].messages[0].content.map((b) => b.text).join('');
  assert.ok(sent.startsWith('## Extracted Facts'), 'the fill call receives the rendered skeleton');
  assert.ok(
    framePrice(sent) <= 4000 + 102,
    `the provisional skeleton must itself respect the cap, got ${framePrice(sent)}`,
  );
})

test('the fact sections reach the checkpoint when the budget is ample', async () => {
  const events = growingRegion(10);
  const session = sessionFor(events);
  const { ctx } = budgetContext('## Why This Approach\n- a cause\n');
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  const messages = events.map((event) => session.deriveEventMessage(event));
  const result = await engine.summarize({ messages }, AGENT(session));
  const text = result.summary.map((block) => block.text).join('');

  assert.ok(text.includes('## Extracted Facts'), 'the skeleton survives');
  assert.ok(text.includes('## Why This Approach'), 'the causal section is appended');
  assert.ok(text.includes('/repo/src/module-0/index.js'), 'an early fact survives');
  assert.ok(text.includes('grep -n'), 'a command survives');
})

test('a degenerate region still renders the floor rather than throwing', async () => {
  const events = growingRegion(400);
  const session = sessionFor(events);
  const { ctx } = budgetContext();
  // An absolute cap below the floor price: the renderer must degrade, not throw.
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, maxCheckpointTokens: 1 });

  const messages = events.map((event) => session.deriveEventMessage(event));
  const result = await engine.summarize({ messages }, AGENT(session));
  const text = result.summary.map((block) => block.text).join('');

  assert.ok(text.startsWith('## Extracted Facts'));
  assert.ok(text.includes('/repo/src/module-0/index.js'), 'intents and files survive even at the floor');
})

test('with no tokenMeter the engine still produces a checkpoint', async () => {
  const events = growingRegion(30);
  const session = sessionFor(events);
  const ctx = new Context();
  ctx.provide('llm', {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '## Why This Approach\n- x\n' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  ctx.provide('tokenMeter', {});
  ctx.provide('sessions', {});
  const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16 });

  const messages = events.map((event) => session.deriveEventMessage(event));
  const result = await engine.summarize({ messages }, AGENT(session));

  assert.ok(result.summary.map((b) => b.text).join('').startsWith('## Extracted Facts'));
})

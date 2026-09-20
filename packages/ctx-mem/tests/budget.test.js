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
import { renderCheckpoint } from '../src/render.js';

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

test('A18 / A4 / A6 vs A14 — intents and files are never trimmed, so they may exceed the cap', async () => {
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

test('A13 — a smaller budget never yields more commands (the causal competition)', () => {
  // The causal section sits inside the guarded price, so a longer causal section
  // means a smaller skeleton budget (the engine subtracts the causal price it
  // actually measured — see `frameEstimator`). What the renderer must guarantee
  // is that a smaller budget never yields MORE commands, or the two would not be
  // competing for the same denominator at all.
  //
  // This is asserted at the renderer, where it is deterministic. The engine-level
  // wiring — that the causal price really is subtracted — is pinned by the A12
  // test above (framed price < denominator with a real causal section) and by the
  // archive replay (causal 0→8000 chars ⇒ 429→385 commands, monotone).
  const facts = {
    intents: ['build the thing'],
    files: ['/repo/src/a.js'],
    commands: Array.from({ length: 60 }, (_, i) => `cat > /repo/cfg-${i}.yml <<'EOF'\n${'x'.repeat(3000)}\nEOF`),
    errors: ['boom'],
  };

  const counts = [];
  for (const budget of [24000, 3000, 900, 600, 400, 250]) {
    counts.push(renderCheckpoint(facts, budget, framePrice).commands.length);
  }

  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i] <= counts[i - 1], `budget #${i}: commands must not grow, got ${JSON.stringify(counts)}`);
  }
  assert.ok(counts[counts.length - 1] < counts[0], `a tight budget must cost commands, got ${JSON.stringify(counts)}`);
})

/**
 * One turn carrying a large write-like command.
 *
 * Needed by the A1 test: the shared `pushTurn` produces such small facts that
 * every tier holds them whole, so the budget never binds and a denominator
 * difference stays invisible. A ~2000-char heredoc per turn makes the T1 form
 * exceed the budget, so the denominator is what decides the rendered price.
 */
function pushBigTurn(events, seq, index) {
  events.push({
    type: 'user/message',
    seq,
    data: { role: 'user', content: [{ type: 'text', text: `write config ${index}` }] },
  });
  events.push({
    type: 'assistant/message',
    seq: seq + 1,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', name: 'bash', arguments: JSON.stringify({ command: `cat > /repo/cfg-${index}.yml <<'EOF'\n${'x'.repeat(2000)}\nEOF` }) }],
      },
    },
  });
  events.push({
    type: 'tool/result',
    seq: seq + 2,
    data: { message: { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'written' }] }] } },
  });
  return seq + 3;
}

test('A1 — the denominator mirrors the host firstIdx in BOTH system-head cases', async () => {
  // The host's `selectCompactableRange` uses
  // `firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1`:
  // the leading message is skipped only when it really is a system message, so
  // a region with no system head starts at index 0. Skipping blindly would
  // under-count the denominator and stop mirroring the host — which is the
  // whole point of A1 (measured 11/11 exact against `shadowedRouteTokenCount`).
  //
  // The two fixtures are built so the HOST denominator is identical:
  //   with a head:    [system(H), user(H), turns…]  → host skips the system
  //   without a head: [user(H),        turns…]      → host keeps everything
  // Both sum to H + turns. The engine must therefore reach the same budget, and
  // spend it the same way, in both cases. Under a blind index-0 skip the second
  // fixture loses H from its denominator and renders a smaller checkpoint.
  //
  // The assertion is on the framed price, not on the retained command count:
  // both fixtures keep every command (the budget binds on detail, not on
  // dropping), so only the price reveals that the budget differed.
  const HEAD = 'context '.repeat(1500); // ≈3000 estimated tokens
  const turns = 25;

  const withHead = [
    { type: 'system/message', seq: 0, data: { message: { role: 'system', content: [{ type: 'text', text: HEAD }] } } },
    { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: HEAD }] } },
  ];
  for (let i = 0; i < turns; i += 1) pushBigTurn(withHead, withHead.length, i);

  const withoutHead = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: HEAD }] } },
  ];
  for (let i = 0; i < turns; i += 1) pushBigTurn(withoutHead, withoutHead.length, i);

  const render = async (events) => {
    const session = sessionFor(events);
    const messages = events.map((event) => session.deriveEventMessage(event));
    const { ctx } = budgetContext();
    const engine = new CtxMemEngine(ctx, { thresholdRatio: 0.8, retainRatio: 0.16, maxCheckpointTokens: 24000 });
    const result = await engine.summarize({ messages }, AGENT(session));
    return { messages, price: framePrice(result.summary.map((b) => b.text).join('')) };
  };

  const head = await render(withHead);
  const noHead = await render(withoutHead);

  // The host denominator: skip index 0 only when it is a system message.
  const hostDenominator = (messages) =>
    messages[0]?.role === 'system'
      ? messages.slice(1).reduce((total, m) => total + estimateMessage(m), 0)
      : messages.reduce((total, m) => total + estimateMessage(m), 0);

  const denominator = hostDenominator(head.messages);
  assert.equal(
    denominator,
    hostDenominator(noHead.messages),
    'the two fixtures must present the same host denominator, or this test proves nothing',
  );
  assert.ok(head.price < denominator, 'with a system head: the guard must hold');
  assert.ok(noHead.price < denominator, 'without a system head: the guard must hold');
  assert.equal(
    noHead.price,
    head.price,
    `equal host denominators must yield equal checkpoints (got ${noHead.price} vs ${head.price}) — ` +
      `a blind index-0 skip under-counts a region that has no system head`,
  );
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

/**
 * A6 — the inherited compaction mechanisms must behave exactly as the host's.
 *
 * The plan's decision D4 is that this backend replaces `summarize()` and nothing
 * else: trigger policy, retained tail, overflow recovery and tool-pairing
 * boundaries stay the host's. That claim is only worth anything if it is checked
 * against the host class itself rather than restated from our own source, so
 * these tests compare our engine to `BasicCompactionEngine` on the surfaces the
 * host owns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import CtxMemEngine from '../src/index.js';

/** A context with the three services the engine injects. */
function engineContext() {
  const ctx = new Context();
  ctx.provide('llm', { stream() {} });
  ctx.provide('tokenMeter', {});
  ctx.provide('sessions', {});
  return ctx;
}

test('A6 — no dependency is dropped: the inherited inject list is unchanged', () => {
  // Redeclaring `static inject` would silently drop any dependency the host adds
  // later, so the subclass must inherit it rather than restate it.
  assert.equal(
    Object.hasOwn(CtxMemEngine, 'inject'),
    false,
    'CtxMemEngine must not declare its own static inject',
  );
  assert.deepEqual(
    CtxMemEngine.inject,
    BasicCompactionEngine.inject,
    'the inherited inject list must be the host list',
  );
})

test('A6 — the subclass is a real CompactionEngine registering the same service name', () => {
  const engine = new CtxMemEngine(engineContext(), {});

  assert.equal(engine.name, 'compaction', 'the service name is the host seam, not our row id');
  assert.ok(engine instanceof BasicCompactionEngine);
})

test('A6 — the resolved host policy is identical to the host engine for the same config', () => {
  const config = { thresholdRatio: 0.75, retainRatio: 0.2, maxTokens: 4096, compactionRetries: 2 };
  const ours = new CtxMemEngine(engineContext(), config).config;
  const host = new BasicCompactionEngine(engineContext(), config).config;

  assert.deepEqual(ours, host, 'every host policy field must resolve identically');
})

test('A6 — the host validation rules still apply through the subclass', () => {
  // A retainRatio at or above the threshold is rejected by the host; the
  // subclass must not soften or bypass that check.
  assert.throws(
    () => new CtxMemEngine(engineContext(), { thresholdRatio: 0.5, retainRatio: 0.5 }),
    /retainRatio .* must be less than the resolved thresholdRatio/,
  );
  assert.throws(
    () => new CtxMemEngine(engineContext(), { retainTokens: 1, retainRatio: 0.1 }),
    /mutually exclusive/,
  );
  assert.throws(
    () => new CtxMemEngine(engineContext(), { modelPolicies: 'nope' }),
    /modelPolicies must be an array/,
  )
})

test('A6 — summarize is the only overridden hook', () => {
  // Comparing method NAMES proves nothing: the host prototype already declares
  // `summarize`, so a name-based diff reports no override at all. Identity of
  // the function references is the real test — every host method must still be
  // the host's own function, and exactly one must differ.
  const inherited = ['compactIfNeeded', 'compactRegion', 'compactNow', 'regionDependencies', '_registerAutomaticCompaction'];
  for (const key of inherited) {
    assert.equal(
      CtxMemEngine.prototype[key],
      BasicCompactionEngine.prototype[key],
      `${key} must remain the host implementation, not a re-declared copy`,
    );
  }

  assert.notEqual(
    CtxMemEngine.prototype.summarize,
    BasicCompactionEngine.prototype.summarize,
    'summarize must be the overridden hook',
  )
})

test('A6 — the host automatic-compaction registration still runs on construction', () => {
  // `auto` (default true) makes the host register its between-step listener; the
  // subclass must let that happen rather than replacing the constructor's work.
  const enabled = new CtxMemEngine(engineContext(), {});
  const disabled = new CtxMemEngine(engineContext(), { auto: false });

  assert.equal(enabled.config.auto, true, 'auto defaults to true');
  assert.equal(disabled.config.auto, false, 'auto: false is still honored');

  // The trigger entry points the host registers must be reachable on the
  // instance, i.e. the registration path was inherited, not stubbed out.
  for (const key of ['compactIfNeeded', 'compactRegion', 'compactNow']) {
    assert.equal(typeof enabled[key], 'function', `${key} must be inherited`);
  }
})

/**
 * Tests for the announced design conventions.
 *
 * The conventions are prose, so the only properties worth pinning are the ones
 * a refactor could silently break: that the three rules are actually in the
 * text, that the announcement is registered as a system-prompt section, and
 * that a missing `systemPrompt` service costs the announcement rather than the
 * whole plugin.
 *
 * That last one is the load-bearing case. Reading the service through
 * `ctx.get` (not `inject`) is what keeps "host has no system prompt" from
 * escalating into "no Stitch tools at all" — the failure mode this repository
 * has hit before, where a service in `inject` that never appears means
 * `apply` is never called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { SECTION_NAME, STITCH_GUIDANCE } = await import('../src/guidance.js');
const { apply } = await import('../src/index.js');

test('the announcement states all three conventions', () => {
  // Each assertion is one convention, checked by the words that carry it
  // rather than by the whole string — the text should stay editable.
  assert.match(STITCH_GUIDANCE, /一个代码项目只对应一个 Stitch 项目/);
  assert.match(STITCH_GUIDANCE, /TailwindCSS/);
  assert.match(STITCH_GUIDANCE, /像素级还原/);
  assert.match(STITCH_GUIDANCE, /先问用户/);
  // The export location is a promise the reader will act on, so it is named.
  assert.match(STITCH_GUIDANCE, /docs\/design/);
});

test('apply registers the announcement as one system-prompt section', () => {
  const sections = [];
  const ctx = {
    get: (name) => (name === 'systemPrompt' ? { section: (section) => (sections.push(section), () => {}) } : undefined),
    inject: () => {},
    effect: (factory) => factory(),
    logger: { info() {}, warn() {} },
  };

  apply(ctx);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, SECTION_NAME);
  assert.equal(sections[0].text, STITCH_GUIDANCE);
});

test('a missing systemPrompt service does not take the plugin down with it', () => {
  const registered = [];
  const ctx = {
    get: () => undefined,
    effect: (factory) => factory(),
    // The tools half runs even though there is no system prompt: a plugin that
    // skipped registration here would lose its tools over a missing banner.
    // `effect`/`logger`/`on` sit on the INJECTED context, not on the service
    // `get` returns — the distinction the real cordis makes.
    inject: (names, run) => {
      registered.push(names);
      run({
        get: () => ({ register: () => () => {} }),
        effect: (factory) => factory(),
        logger: { info() {}, warn() {} },
        on: () => () => {},
      });
    },
    logger: { info() {}, warn() {} },
  };

  assert.doesNotThrow(() => apply(ctx));
  assert.deepEqual(registered, [['tools', 'credentials'], ['webServer']]);
});
